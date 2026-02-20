'use client'

// ---------------------------------------------------------------------------
// CampaignWizard — 3-step modal to configure and send a campaign.
//
// Step 1: Select WhatsApp channel
// Step 2: Set message (template for META_CLOUD, text for others)
// Step 3: Review & send
//
// Security:
//   - confirmation_token echoed back from campaign creation (never guessable)
//   - META_CLOUD enforces template-only messages (text blocked at API level)
//   - Auth via HttpOnly session cookie (sent automatically by browser)
// ---------------------------------------------------------------------------

import { useState, useEffect, useCallback } from 'react'
import { X, ChevronRight, ChevronLeft, Send, Check, AlertCircle, Loader2 } from 'lucide-react'
import { FIRST_CONTACT_TEMPLATES, applyMessageTemplate } from '@/lib/agent-humanizer'
import type { PublicEmpresa } from '@/lib/mask-output'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Channel {
  id: string
  name: string
  provider: 'META_CLOUD' | 'EVOLUTION' | 'UAZAPI'
  status: string
  phone_number: string | null
}

interface SendResult {
  status: 'completed' | 'completed_with_errors' | 'sending'
  batch_sent: number
  batch_failed: number
  remaining_pending: number
  completed: boolean
}

interface Props {
  campaignId: string
  confirmationToken: string
  recipients: PublicEmpresa[]
  searchNicho?: string
  onClose: () => void
  onComplete: (result: SendResult) => void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function providerLabel(p: string) {
  if (p === 'META_CLOUD') return 'Meta Cloud API'
  if (p === 'EVOLUTION') return 'Evolution'
  if (p === 'UAZAPI') return 'UAZAPI'
  return p
}

async function apiPost<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`)
  }
  return res.json()
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function CampaignWizard({
  campaignId,
  confirmationToken,
  recipients,
  searchNicho,
  onClose,
  onComplete,
}: Props) {
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Step 1 state
  const [channels, setChannels] = useState<Channel[]>([])
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null)
  const [channelsLoading, setChannelsLoading] = useState(true)
  // Track whether /confirm was already called — the token is single-use and the
  // campaign leaves 'draft' after the first call, so retrying would 409.
  const [confirmed, setConfirmed] = useState(false)

  // Step 2 state
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(FIRST_CONTACT_TEMPLATES[0].id)
  const [customBody, setCustomBody] = useState(FIRST_CONTACT_TEMPLATES[0].body)
  const [templateName, setTemplateName] = useState('')
  const [templateLang, setTemplateLang] = useState('pt_BR')

  // Derived
  const selectedChannel = channels.find((c) => c.id === selectedChannelId) ?? null
  const isMetaCloud = selectedChannel?.provider === 'META_CLOUD'

  // Sample recipient for preview
  const sample = recipients[0]

  // ---------------------------------------------------------------------------
  // Load channels on mount
  // ---------------------------------------------------------------------------
  useEffect(() => {
    setChannelsLoading(true)
    fetch('/api/whatsapp/channels')
      .then((r) => {
        if (!r.ok) {
          const msg =
            r.status === 401 || r.status === 403
              ? 'Sessao expirada. Faca login novamente.'
              : `Erro ao carregar canais (${r.status})`
          throw new Error(msg)
        }
        return r.json()
      })
      .then((d: { data?: Channel[] }) => {
        setChannels((d.data ?? []).filter((c) => c.status === 'CONNECTED'))
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : 'Nao foi possivel carregar os canais.'),
      )
      .finally(() => setChannelsLoading(false))
  }, [])

  // When template selection changes, update customBody
  useEffect(() => {
    const tmpl = FIRST_CONTACT_TEMPLATES.find((t) => t.id === selectedTemplateId)
    if (tmpl) setCustomBody(tmpl.body)
  }, [selectedTemplateId])

  // ---------------------------------------------------------------------------
  // Step transitions
  // ---------------------------------------------------------------------------

  const goToStep2 = useCallback(async () => {
    if (!selectedChannelId) return
    setLoading(true)
    setError(null)
    try {
      // Confirm campaign only once — token is single-use and campaign leaves 'draft'
      // immediately. Re-calling after a back-navigation would 409.
      if (!confirmed) {
        await apiPost(`/api/campaigns/${campaignId}/confirm`, {
          confirmation_token: confirmationToken,
        })
        setConfirmed(true)
      }
      // Select channel — idempotent; also accepted when status is 'awaiting_message'
      // so the user can change channel after going back from step 2.
      await apiPost(`/api/campaigns/${campaignId}/select-channel`, {
        channel_id: selectedChannelId,
      })
      setStep(2)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro inesperado')
    } finally {
      setLoading(false)
    }
  }, [selectedChannelId, campaignId, confirmationToken, confirmed])

  const goToStep3 = useCallback(async () => {
    if (!selectedChannel) return
    setLoading(true)
    setError(null)
    try {
      if (isMetaCloud) {
        if (!templateName.trim()) throw new Error('Nome do template obrigatorio')
        await apiPost(`/api/campaigns/${campaignId}/set-message`, {
          message_type: 'template',
          message_content: {
            type: 'template',
            name: templateName.trim(),
            language: templateLang,
            body_params: [],
          },
        })
      } else {
        if (!customBody.trim()) throw new Error('Mensagem nao pode estar vazia')
        await apiPost(`/api/campaigns/${campaignId}/set-message`, {
          message_type: 'text',
          message_content: { type: 'text', body: customBody.trim() },
        })
      }
      setStep(3)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro inesperado')
    } finally {
      setLoading(false)
    }
  }, [selectedChannel, isMetaCloud, templateName, templateLang, customBody, campaignId])

  const handleSend = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // Poll /send until the campaign is fully completed. Each call processes up
      // to BATCH_SIZE (100) recipients; campaigns with >100 recipients need
      // multiple calls to finish.
      let accumulated = { batch_sent: 0, batch_failed: 0 }
      let result: SendResult
      do {
        const res = await apiPost<{ data: SendResult }>(
          `/api/campaigns/${campaignId}/send`,
          {},
        )
        result = res.data
        accumulated.batch_sent += result.batch_sent
        accumulated.batch_failed += result.batch_failed
        if (!result.completed) {
          await new Promise((resolve) => setTimeout(resolve, 1500))
        }
      } while (!result.completed)
      onComplete({ ...result, batch_sent: accumulated.batch_sent, batch_failed: accumulated.batch_failed })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao enviar')
    } finally {
      setLoading(false)
    }
  }, [campaignId, onComplete])

  // ---------------------------------------------------------------------------
  // Preview text (for non-Meta)
  // ---------------------------------------------------------------------------
  const previewText = sample
    ? applyMessageTemplate(customBody, {
        razaoSocial: sample.razaoSocial,
        nomeFantasia: sample.nomeFantasia || undefined,
        municipio: sample.municipio,
        nicho: searchNicho,
      })
    : customBody

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="relative w-full max-w-xl rounded-2xl border border-zinc-200 bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-100 px-6 py-4">
          <div>
            <h2 className="text-sm font-semibold text-zinc-900">Primeiro Contato</h2>
            <p className="text-xs text-zinc-500">{recipients.length} destinatarios</p>
          </div>
          <div className="flex items-center gap-4">
            {/* Step indicator */}
            <div className="flex items-center gap-1.5">
              {([1, 2, 3] as const).map((s) => (
                <div
                  key={s}
                  className={`h-2 w-2 rounded-full transition-colors ${
                    step === s
                      ? 'bg-emerald-500'
                      : step > s
                      ? 'bg-emerald-300'
                      : 'bg-zinc-200'
                  }`}
                />
              ))}
            </div>
            <button
              onClick={onClose}
              className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="mx-6 mt-4 flex items-center gap-2 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
            <AlertCircle className="size-4 shrink-0" />
            {error}
          </div>
        )}

        {/* Step 1: Select channel */}
        {step === 1 && (
          <div className="p-6">
            <h3 className="mb-1 text-sm font-medium text-zinc-900">Selecione o canal WhatsApp</h3>
            <p className="mb-4 text-xs text-zinc-500">Apenas canais conectados aparecem aqui.</p>
            {channelsLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="size-5 animate-spin text-zinc-400" />
              </div>
            ) : channels.length === 0 ? (
              <p className="py-6 text-center text-sm text-zinc-500">
                Nenhum canal conectado. Configure em{' '}
                <a href="/whatsapp/canais" className="text-emerald-600 underline">
                  Canais
                </a>
                .
              </p>
            ) : (
              <div className="space-y-2">
                {channels.map((ch) => (
                  <button
                    key={ch.id}
                    onClick={() => setSelectedChannelId(ch.id)}
                    className={`w-full rounded-xl border p-3 text-left transition ${
                      selectedChannelId === ch.id
                        ? 'border-emerald-400 bg-emerald-50 ring-1 ring-emerald-400'
                        : 'border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium text-zinc-900">{ch.name}</p>
                        <p className="text-xs text-zinc-500">
                          {providerLabel(ch.provider)}
                          {ch.phone_number ? ` · ${ch.phone_number}` : ''}
                        </p>
                      </div>
                      {selectedChannelId === ch.id && (
                        <Check className="size-4 text-emerald-500" />
                      )}
                    </div>
                    {ch.provider === 'META_CLOUD' && (
                      <p className="mt-1.5 rounded bg-amber-50 px-2 py-1 text-xs text-amber-700">
                        Template obrigatorio para primeiro contato
                      </p>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Step 2: Set message */}
        {step === 2 && (
          <div className="p-6">
            <h3 className="mb-1 text-sm font-medium text-zinc-900">
              {isMetaCloud ? 'Template oficial (Meta)' : 'Mensagem de primeiro contato'}
            </h3>
            <p className="mb-4 text-xs text-zinc-500">
              {isMetaCloud
                ? 'Informe o nome e idioma do template aprovado na sua conta Meta.'
                : 'Escolha um modelo ou edite livremente. Placeholders: [Nome], [Empresa], [segmento], [cidade].'}
            </p>

            {isMetaCloud ? (
              <div className="space-y-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-700">
                    Nome do template
                  </label>
                  <input
                    value={templateName}
                    onChange={(e) => setTemplateName(e.target.value)}
                    placeholder="ex: primeiro_contato_v1"
                    className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-700">
                    Idioma
                  </label>
                  <select
                    value={templateLang}
                    onChange={(e) => setTemplateLang(e.target.value)}
                    className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-emerald-400"
                  >
                    <option value="pt_BR">pt_BR — Portugues (Brasil)</option>
                    <option value="en_US">en_US — English (US)</option>
                    <option value="es_AR">es_AR — Espanol (Argentina)</option>
                  </select>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {/* Template buttons */}
                <div className="flex flex-wrap gap-2">
                  {FIRST_CONTACT_TEMPLATES.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => setSelectedTemplateId(t.id)}
                      className={`rounded-full border px-3 py-1 text-xs transition ${
                        selectedTemplateId === t.id
                          ? 'border-emerald-400 bg-emerald-50 text-emerald-700'
                          : 'border-zinc-200 text-zinc-600 hover:border-zinc-300'
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>

                {/* Editable message body */}
                <textarea
                  value={customBody}
                  onChange={(e) => setCustomBody(e.target.value)}
                  rows={4}
                  maxLength={4096}
                  className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400"
                />

                {/* Preview with first recipient */}
                {sample && (
                  <div className="rounded-lg bg-zinc-50 px-3 py-2">
                    <p className="mb-1 text-xs font-medium text-zinc-500">Preview (1o destinatario):</p>
                    <p className="text-xs text-zinc-700">{previewText}</p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Step 3: Review & send */}
        {step === 3 && (
          <div className="p-6">
            <h3 className="mb-1 text-sm font-medium text-zinc-900">Revisar e enviar</h3>
            <p className="mb-4 text-xs text-zinc-500">Confira antes de disparar.</p>
            <div className="space-y-2 rounded-xl border border-zinc-200 p-4 text-sm">
              <div className="flex justify-between">
                <span className="text-zinc-500">Destinatarios</span>
                <span className="font-medium text-zinc-900">{recipients.length}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">Canal</span>
                <span className="font-medium text-zinc-900">
                  {selectedChannel?.name} ({selectedChannel && providerLabel(selectedChannel.provider)})
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">Tipo</span>
                <span className="font-medium text-zinc-900">
                  {isMetaCloud ? `Template: ${templateName}` : 'Texto personalizado'}
                </span>
              </div>
              {!isMetaCloud && sample && (
                <div className="mt-2 border-t border-zinc-100 pt-2">
                  <p className="mb-1 text-xs text-zinc-500">Preview:</p>
                  <p className="text-xs text-zinc-700">{previewText}</p>
                </div>
              )}
            </div>
            <p className="mt-3 text-xs text-amber-700">
              Esta acao envia mensagens reais via WhatsApp. Confirme antes de prosseguir.
            </p>
          </div>
        )}

        {/* Footer buttons */}
        <div className="flex items-center justify-between border-t border-zinc-100 px-6 py-4">
          <button
            onClick={() => (step === 1 ? onClose() : setStep((s) => (s - 1) as 1 | 2 | 3))}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm text-zinc-600 hover:bg-zinc-100 disabled:opacity-50"
          >
            {step > 1 && <ChevronLeft className="size-4" />}
            {step === 1 ? 'Cancelar' : 'Voltar'}
          </button>

          {step < 3 ? (
            <button
              onClick={step === 1 ? goToStep2 : goToStep3}
              disabled={loading || (step === 1 && !selectedChannelId)}
              className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {loading ? <Loader2 className="size-4 animate-spin" /> : null}
              Continuar
              <ChevronRight className="size-4" />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={loading}
              className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {loading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
              Enviar agora
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

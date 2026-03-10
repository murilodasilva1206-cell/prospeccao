'use client'

// ---------------------------------------------------------------------------
// CampaignWizard — 3-step modal to configure and start a campaign.
//
// Step 1: Select WhatsApp channel
// Step 2: Set message (template for META_CLOUD, text for others)
// Step 3: Configure automation (delay, jitter, rate limits, working hours)
//         → "Iniciar campanha" triggers POST /start and opens CampaignProgressPanel
//
// Security:
//   - confirmation_token echoed back from campaign creation (never guessable)
//   - META_CLOUD enforces template-only messages (text blocked at API level)
//   - Auth via HttpOnly session cookie (sent automatically by browser)
// ---------------------------------------------------------------------------

import { useState, useEffect, useCallback } from 'react'
import { X, ChevronRight, ChevronLeft, Play, Check, AlertCircle, Loader2, Clock } from 'lucide-react'
import { FIRST_CONTACT_TEMPLATES, applyMessageTemplate } from '@/lib/agent-humanizer'
import type { PublicEmpresa } from '@/lib/mask-output'
import CampaignProgressPanel from './CampaignProgressPanel'

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

interface ApiTemplate {
  id: string
  template_name: string
  language: string
  status: string
  variables_count: number
}

interface TemplateVariable {
  index: number
  component: string
}

interface Props {
  campaignId: string
  confirmationToken: string
  recipients: PublicEmpresa[]
  searchNicho?: string
  onClose: () => void
  onComplete: () => void
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
  const [started, setStarted] = useState(false)

  // Step 1 state
  const [channels, setChannels] = useState<Channel[]>([])
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null)
  const [channelsLoading, setChannelsLoading] = useState(true)
  const [confirmed, setConfirmed] = useState(false)

  // Step 2 state — text (non-Meta) channels
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(FIRST_CONTACT_TEMPLATES[0].id)
  const [customBody, setCustomBody] = useState(FIRST_CONTACT_TEMPLATES[0].body)

  // Step 2 state — Meta Cloud API templates (from API catalog)
  const [apiTemplates, setApiTemplates] = useState<ApiTemplate[]>([])
  const [apiTemplatesLoading, setApiTemplatesLoading] = useState(false)
  const [selectedApiTemplateId, setSelectedApiTemplateId] = useState<string>('')
  const [templateVariables, setTemplateVariables] = useState<TemplateVariable[]>([])
  const [templateBodyParams, setTemplateBodyParams] = useState<string[]>([])

  // Step 3 — automation config
  const [delayMinutes, setDelayMinutes] = useState(2)
  const [jitterSeconds, setJitterSeconds] = useState(20)
  const [maxPerHour, setMaxPerHour] = useState(30)
  const [maxRetries, setMaxRetries] = useState(3)
  const [useWorkingHours, setUseWorkingHours] = useState(false)
  const [workingStart, setWorkingStart] = useState(8)
  const [workingEnd, setWorkingEnd] = useState(18)

  // Derived
  const selectedChannel = channels.find((c) => c.id === selectedChannelId) ?? null
  const isMetaCloud = selectedChannel?.provider === 'META_CLOUD'
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

  useEffect(() => {
    const tmpl = FIRST_CONTACT_TEMPLATES.find((t) => t.id === selectedTemplateId)
    if (tmpl) setCustomBody(tmpl.body)
  }, [selectedTemplateId])

  // Load APPROVED templates when a META_CLOUD channel is selected
  useEffect(() => {
    if (!selectedChannelId || !isMetaCloud) {
      setApiTemplates([])
      setSelectedApiTemplateId('')
      setTemplateVariables([])
      setTemplateBodyParams([])
      return
    }
    setApiTemplatesLoading(true)
    fetch(`/api/whatsapp/channels/${selectedChannelId}/templates?status=APPROVED&limit=100`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d: { data?: ApiTemplate[] }) => {
        const list = d.data ?? []
        setApiTemplates(list)
        if (list.length > 0) setSelectedApiTemplateId(list[0].id)
      })
      .catch(() => setApiTemplates([]))
      .finally(() => setApiTemplatesLoading(false))
  }, [selectedChannelId, isMetaCloud])

  // Load variable list when selected API template changes
  useEffect(() => {
    if (!selectedChannelId || !selectedApiTemplateId) {
      setTemplateVariables([])
      setTemplateBodyParams([])
      return
    }
    fetch(`/api/whatsapp/channels/${selectedChannelId}/templates/${selectedApiTemplateId}/variables`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d: { variables?: TemplateVariable[] }) => {
        const vars = (d.variables ?? []).filter((v) => v.component === 'BODY')
        setTemplateVariables(vars)
        setTemplateBodyParams(Array(vars.length).fill(''))
      })
      .catch(() => {
        setTemplateVariables([])
        setTemplateBodyParams([])
      })
  }, [selectedChannelId, selectedApiTemplateId])

  // ---------------------------------------------------------------------------
  // Step transitions
  // ---------------------------------------------------------------------------

  const goToStep2 = useCallback(async () => {
    if (!selectedChannelId) return
    setLoading(true)
    setError(null)
    try {
      if (!confirmed) {
        await apiPost(`/api/campaigns/${campaignId}/confirm`, {
          confirmation_token: confirmationToken,
        })
        setConfirmed(true)
      }
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
        const selected = apiTemplates.find((t) => t.id === selectedApiTemplateId)
        if (!selected) throw new Error('Selecione um template aprovado')
        await apiPost(`/api/campaigns/${campaignId}/set-message`, {
          message_type: 'template',
          message_content: {
            type: 'template',
            name: selected.template_name,
            language: selected.language,
            body_params: templateBodyParams.filter((p) => p.trim()).length > 0
              ? templateBodyParams
              : [],
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
  }, [selectedChannel, isMetaCloud, apiTemplates, selectedApiTemplateId, templateBodyParams, customBody, campaignId])

  // Close the wizard.
  // Pre-start (steps 1-3): cancel the campaign so it doesn't sit in a setup state.
  // Post-start (progress panel visible): just close — automation keeps running.
  // Explicit campaign cancellation is done via the "Cancelar" button in the progress panel.
  const handleClose = useCallback(async () => {
    if (!started) {
      fetch(`/api/campaigns/${campaignId}/cancel`, { method: 'POST' }).catch(() => {})
    }
    onClose()
  }, [started, campaignId, onClose])

  const handleStart = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      await apiPost(`/api/campaigns/${campaignId}/start`, {
        delay_seconds: Math.max(10, delayMinutes * 60),
        jitter_max:    Math.max(0, jitterSeconds),
        max_per_hour:  Math.max(1, maxPerHour),
        max_retries:   Math.max(0, maxRetries),
        ...(useWorkingHours
          ? { working_hours_start: workingStart, working_hours_end: workingEnd }
          : {}),
      })
      setStarted(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao iniciar campanha')
    } finally {
      setLoading(false)
    }
  }, [campaignId, delayMinutes, jitterSeconds, maxPerHour, maxRetries, useWorkingHours, workingStart, workingEnd])

  // ---------------------------------------------------------------------------
  // Preview text
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
  // After start: show progress panel inside the same overlay
  // ---------------------------------------------------------------------------
  if (started) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
        <div className="w-full max-w-xl">
          <CampaignProgressPanel
            campaignId={campaignId}
            recipientCount={recipients.length}
            onClose={onClose}
            onComplete={onComplete}
          />
        </div>
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // Wizard steps
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
            <div className="flex items-center gap-1.5">
              {([1, 2, 3] as const).map((s) => (
                <div
                  key={s}
                  className={`h-2 w-2 rounded-full transition-colors ${
                    step === s ? 'bg-emerald-500' : step > s ? 'bg-emerald-300' : 'bg-zinc-200'
                  }`}
                />
              ))}
            </div>
            <button
              onClick={handleClose}
              className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>

        {/* Error banner */}
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
                <a href="/whatsapp/canais" className="text-emerald-600 underline">Canais</a>.
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
                      {selectedChannelId === ch.id && <Check className="size-4 text-emerald-500" />}
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
                {apiTemplatesLoading ? (
                  <div className="flex items-center justify-center py-6">
                    <Loader2 className="size-5 animate-spin text-zinc-400" />
                  </div>
                ) : apiTemplates.length === 0 ? (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                    Nenhum template aprovado neste canal.{' '}
                    <a href="/whatsapp/canais" className="underline">
                      Sincronize os templates
                    </a>{' '}
                    e volte aqui.
                  </div>
                ) : (
                  <>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-zinc-700">Template</label>
                      <select
                        value={selectedApiTemplateId}
                        onChange={(e) => setSelectedApiTemplateId(e.target.value)}
                        className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-emerald-400"
                      >
                        {apiTemplates.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.template_name} ({t.language})
                          </option>
                        ))}
                      </select>
                    </div>
                    {templateVariables.length > 0 && (
                      <div className="space-y-2">
                        <p className="text-xs font-medium text-zinc-700">
                          Variaveis do template ({templateVariables.length})
                        </p>
                        {templateVariables.map((v, i) => (
                          <div key={v.index}>
                            <label className="mb-0.5 block text-xs text-zinc-500">
                              {`{{${v.index}}}`} - {v.component}
                            </label>
                            <input
                              value={templateBodyParams.at(i) ?? ''}
                              onChange={(e) => {
                                const val = e.target.value
                                setTemplateBodyParams((prev) => prev.map((p, j) => (j === i ? val : p)))
                              }}
                              placeholder={`Valor para {{${v.index}}}`}
                              className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400"
                            />
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            ) : (
              <div className="space-y-3">
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
                <textarea
                  value={customBody}
                  onChange={(e) => setCustomBody(e.target.value)}
                  rows={4}
                  maxLength={4096}
                  className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400"
                />
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

        {/* Step 3: Configure automation */}
        {step === 3 && (
          <div className="p-6">
            <h3 className="mb-1 text-sm font-medium text-zinc-900">Configurar automacao</h3>
            <p className="mb-4 text-xs text-zinc-500">
              O envio sera escalonado. Voce pode pausar ou cancelar a qualquer momento.
            </p>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-700">Intervalo (minutos)</label>
                  <input
                    type="number" min={1} max={1440} value={delayMinutes}
                    onChange={(e) => setDelayMinutes(Math.max(1, Number(e.target.value)))}
                    className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-700">Variacao (segundos)</label>
                  <input
                    type="number" min={0} max={300} value={jitterSeconds}
                    onChange={(e) => setJitterSeconds(Math.max(0, Number(e.target.value)))}
                    className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-700">Max por hora</label>
                  <input
                    type="number" min={1} max={500} value={maxPerHour}
                    onChange={(e) => setMaxPerHour(Math.max(1, Number(e.target.value)))}
                    className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-700">Tentativas em falha</label>
                  <input
                    type="number" min={0} max={10} value={maxRetries}
                    onChange={(e) => setMaxRetries(Math.max(0, Number(e.target.value)))}
                    className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400"
                  />
                </div>
              </div>
              <div>
                <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-zinc-700">
                  <input
                    type="checkbox" checked={useWorkingHours}
                    onChange={(e) => setUseWorkingHours(e.target.checked)}
                    className="rounded border-zinc-300"
                  />
                  Restringir horario de envio (UTC-3, Brasilia)
                </label>
                {useWorkingHours && (
                  <div className="mt-2 grid grid-cols-2 gap-3">
                    <div>
                      <label className="mb-1 block text-xs text-zinc-500">Inicio (hora 0-23)</label>
                      <input
                        type="number" min={0} max={23} value={workingStart}
                        onChange={(e) => setWorkingStart(Number(e.target.value))}
                        className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-emerald-400"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs text-zinc-500">Fim (hora 0-23)</label>
                      <input
                        type="number" min={0} max={23} value={workingEnd}
                        onChange={(e) => setWorkingEnd(Number(e.target.value))}
                        className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-emerald-400"
                      />
                    </div>
                  </div>
                )}
              </div>
              <div className="space-y-1 rounded-xl border border-zinc-100 bg-zinc-50 p-3 text-xs">
                <div className="flex justify-between text-zinc-600">
                  <span>Destinatarios</span>
                  <span className="font-medium text-zinc-900">{recipients.length}</span>
                </div>
                <div className="flex justify-between text-zinc-600">
                  <span>Canal</span>
                  <span className="font-medium text-zinc-900">
                    {selectedChannel?.name} ({selectedChannel && providerLabel(selectedChannel.provider)})
                  </span>
                </div>
              </div>
              <p className="flex items-start gap-1.5 text-xs text-amber-700">
                <Clock className="mt-0.5 size-3.5 shrink-0" />
                Envio continua automaticamente com o browser fechado. Mensagens reais serao enviadas via WhatsApp.
              </p>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-zinc-100 px-6 py-4">
          <button
            onClick={() => (step === 1 ? handleClose() : setStep((s) => (s - 1) as 1 | 2 | 3))}
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
              onClick={handleStart}
              disabled={loading}
              className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {loading ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
              Iniciar campanha
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

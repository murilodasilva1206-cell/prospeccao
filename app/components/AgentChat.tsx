'use client'

// ---------------------------------------------------------------------------
// AgentChat — floating chat panel for the prospecting AI agent.
//
// Flow:
//   1. User types a query (e.g. "10 salões em Manaus")
//   2. POST /api/agente → structured search results (requires session auth)
//   3. Results shown in chat + "Iniciar primeiro contato" CTA
//   4. Clicking CTA opens CampaignWizard
//
// Security:
//   - Only rendered when the user is authenticated (useAuth guard)
//   - Campaign confirmation_token stored in state until wizard completes
// ---------------------------------------------------------------------------

import { useState, useRef, useEffect, useCallback } from 'react'
import {
  Bot,
  X,
  Send,
  Loader2,
  MessageSquare,
  Users,
  CheckCircle2,
  XCircle,
  Building2,
} from 'lucide-react'
import CampaignWizard from './CampaignWizard'
import { humanizeSearchResult } from '@/lib/agent-humanizer'
import { useAuth } from '@/app/components/AuthProvider'
import type { PublicEmpresa } from '@/lib/mask-output'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MessageRole = 'user' | 'agent' | 'system'

interface ChatMessage {
  id: string
  role: MessageRole
  text: string
  subtitle?: string
  results?: PublicEmpresa[]
  resultsTotal?: number
  filters?: Record<string, unknown>
  hasCta?: boolean
  nicho?: string
  link?: string
}

interface AgentResponse {
  action: 'search' | 'export' | 'clarify' | 'reject'
  message?: string
  data?: PublicEmpresa[]
  meta?: { total: number; page: number; limit: number; pages: number }
  filters?: Record<string, unknown>
  // Server-generated narration (ai-narrator.ts); falls back to client-side when absent
  headline?: string
  subtitle?: string
  hasCta?: boolean
}

interface PendingCampaign {
  campaignId: string
  confirmationToken: string
  recipients: PublicEmpresa[]
  nicho?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function genId(): string {
  return Math.random().toString(36).slice(2)
}

const HTTP_STATUS_MESSAGES: Record<number, string> = {
  401: 'Sessão expirada. Faça login novamente.',
  403: 'Sem permissão para esta busca.',
  409: 'Nenhum provedor de IA configurado.',
  429: 'Muitas buscas em pouco tempo. Aguarde alguns segundos.',
  500: 'Erro interno do servidor. Tente novamente.',
  503: 'Serviço de IA temporariamente indisponível. Tente novamente.',
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AgentChat() {
  const { user, loading: authLoading } = useAuth()
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loading, setLoading] = useState(false)

  // Campaign wizard state
  const [pendingCampaign, setPendingCampaign] = useState<PendingCampaign | null>(null)
  const [campaignResult, setCampaignResult] = useState<{
    sent: number
    failed: number
  } | null>(null)

  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Auto-scroll on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, open])

  // Focus input when opened
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 100)
  }, [open])

  // ---------------------------------------------------------------------------
  // Send message
  // ---------------------------------------------------------------------------

  const sendMessage = useCallback(async () => {
    const text = input.trim()
    if (!text || loading) return
    setInput('')

    const userMsg: ChatMessage = { id: genId(), role: 'user', text }
    setMessages((prev) => [...prev, userMsg])
    setLoading(true)

    try {
      const res = await fetch('/api/agente', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      })

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({})) as { error?: string }
        const friendlyMsg =
          HTTP_STATUS_MESSAGES[res.status] ??
          errBody.error ??
          `Erro ${res.status}. Tente novamente.`
        setMessages((prev) => [
          ...prev,
          {
            id: genId(),
            role: 'system',
            text: friendlyMsg,
            ...(res.status === 409 && { link: '/whatsapp/llm' }),
          },
        ])
        return
      }

      const data: AgentResponse = await res.json()

      if (data.action === 'search' && data.data && data.meta) {
        const filters = (data.filters ?? {}) as Parameters<typeof humanizeSearchResult>[0]['filters']

        // Prefer server-generated narration (Narrator LLM); fall back to client-side
        let headline = data.headline
        let subtitle = data.subtitle
        let hasCta = data.hasCta
        if (!headline || !subtitle) {
          const fallback = humanizeSearchResult({
            total: data.meta.total,
            count: data.data.length,
            filters,
            data: data.data,
          })
          headline = headline ?? fallback.headline
          subtitle = subtitle ?? fallback.subtitle
          hasCta = hasCta ?? fallback.hasCta
        }

        const agentMsg: ChatMessage = {
          id: genId(),
          role: 'agent',
          text: headline,
          subtitle,
          results: data.data,
          resultsTotal: data.meta.total,
          filters: data.filters,
          hasCta: hasCta ?? false,
          nicho: typeof filters.nicho === 'string' ? filters.nicho : undefined,
        }
        setMessages((prev) => [...prev, agentMsg])
      } else {
        const agentMsg: ChatMessage = {
          id: genId(),
          role: 'agent',
          text:
            data.message ??
            (data.action === 'export'
              ? 'Pronto! Use o botao de exportacao para baixar os dados.'
              : 'Nao entendi. Tente descrever quem voce procura, por exemplo: "clinicas em Sao Paulo com telefone".'),
        }
        setMessages((prev) => [...prev, agentMsg])
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: genId(),
          role: 'system',
          text: 'Erro de conexao. Verifique sua internet e tente novamente.',
        },
      ])
    } finally {
      setLoading(false)
    }
  }, [input, loading])

  // ---------------------------------------------------------------------------
  // Start campaign
  // ---------------------------------------------------------------------------

  const startCampaign = useCallback(
    async (msg: ChatMessage) => {
      if (!msg.results || msg.results.length === 0) return

      setLoading(true)
      setCampaignResult(null)

      try {
        const res = await fetch('/api/campaigns', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: `Campanha: ${msg.text.slice(0, 100)}`,
            search_filters: msg.filters,
            recipients: msg.results.map((r) => ({
              cnpj: r.cnpj,
              razao_social: r.razaoSocial,
              nome_fantasia: r.nomeFantasia || undefined,
              telefone: r.telefone1 || r.telefone2 || undefined,
              email: r.email || undefined,
              municipio: r.municipio || undefined,
              uf: r.uf || undefined,
            })),
          }),
        })

        if (!res.ok) {
          const err = await res.json().catch(() => ({})) as { error?: string }
          const friendlyMsg =
            HTTP_STATUS_MESSAGES[res.status] ??
            err.error ??
            `Erro ${res.status}. Tente novamente.`
          throw new Error(friendlyMsg)
        }

        const data = await res.json() as {
          data: { id: string }
          confirmation_token: string
        }

        setPendingCampaign({
          campaignId: data.data.id,
          confirmationToken: data.confirmation_token,
          recipients: msg.results,
          nicho: msg.nicho,
        })
      } catch (err) {
        setMessages((prev) => [
          ...prev,
          {
            id: genId(),
            role: 'system',
            text: `Nao foi possivel criar a campanha: ${err instanceof Error ? err.message : 'Erro desconhecido'}`,
          },
        ])
      } finally {
        setLoading(false)
      }
    },
    [],
  )

  // ---------------------------------------------------------------------------
  // Campaign complete
  // ---------------------------------------------------------------------------

  const handleCampaignComplete = useCallback(
    () => {
      setPendingCampaign(null)
      setMessages((prev) => [
        ...prev,
        {
          id: genId(),
          role: 'agent',
          text: 'Campanha concluida! Veja os resultados no painel de progresso.',
        },
      ])
    },
    [],
  )

  // ---------------------------------------------------------------------------
  // Keyboard submit
  // ---------------------------------------------------------------------------

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  // Only render for authenticated users. Guard placed after all hooks so React
  // always calls the same set of hooks regardless of auth state.
  if (authLoading || !user) return null

  return (
    <>
      {/* Floating button */}
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="Abrir chat do agente"
        className="fixed bottom-6 right-6 z-40 flex size-14 items-center justify-center rounded-full bg-emerald-600 shadow-lg transition hover:bg-emerald-700 hover:shadow-xl"
      >
        {open ? (
          <X className="size-6 text-white" />
        ) : (
          <Bot className="size-6 text-white" />
        )}
      </button>

      {/* Chat panel */}
      {open && (
        <div className="fixed bottom-24 right-6 z-40 flex w-96 flex-col rounded-2xl border border-zinc-200 bg-white shadow-2xl">
          {/* Header */}
          <div className="flex items-center justify-between rounded-t-2xl bg-emerald-600 px-4 py-3">
            <div className="flex items-center gap-2">
              <Bot className="size-5 text-white" />
              <div>
                <p className="text-sm font-semibold text-white">Agente de Prospeccao</p>
                <p className="text-xs text-emerald-200">Busca empresas no CNPJ</p>
              </div>
            </div>
            <div />
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-3" style={{ maxHeight: '400px', minHeight: '200px' }}>
            {messages.length === 0 && (
              <div className="py-8 text-center text-sm text-zinc-400">
                <MessageSquare className="mx-auto mb-2 size-8 opacity-30" />
                <p>Experimente: <span className="italic">&quot;Clinicas em Sao Paulo com telefone&quot;</span></p>
              </div>
            )}

            {messages.map((msg) => (
              <div key={msg.id} className={`mb-3 ${msg.role === 'user' ? 'flex justify-end' : ''}`}>
                {msg.role === 'user' && (
                  <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-emerald-600 px-3 py-2 text-sm text-white">
                    {msg.text}
                  </div>
                )}

                {msg.role === 'agent' && (
                  <div className="max-w-full">
                    <div className="rounded-2xl rounded-bl-sm bg-zinc-100 px-3 py-2">
                      <p className="text-sm text-zinc-900">{msg.text}</p>
                      {msg.subtitle && (
                        <p className="mt-0.5 text-xs text-zinc-500">{msg.subtitle}</p>
                      )}
                    </div>

                    {/* Results preview (top 3) */}
                    {msg.results && msg.results.length > 0 && (
                      <div className="mt-2 rounded-xl border border-zinc-200 bg-white">
                        {msg.results.slice(0, 3).map((r) => (
                          <div
                            key={r.cnpj}
                            className="flex items-center gap-2 border-b border-zinc-100 px-3 py-2 last:border-0"
                          >
                            <Building2 className="size-3.5 shrink-0 text-zinc-400" />
                            <div className="min-w-0">
                              <p className="truncate text-xs font-medium text-zinc-800">
                                {r.nomeFantasia || r.razaoSocial}
                              </p>
                              <p className="truncate text-xs text-zinc-500">
                                {r.municipio}/{r.uf}
                                {r.telefone1 ? ` · ${r.telefone1}` : ''}
                              </p>
                            </div>
                          </div>
                        ))}
                        {(msg.resultsTotal ?? 0) > 3 && (
                          <p className="px-3 py-2 text-xs text-zinc-400">
                            + {(msg.resultsTotal ?? 0) - 3} outras empresas
                          </p>
                        )}
                      </div>
                    )}

                    {/* CTA */}
                    {msg.hasCta && (
                      <button
                        onClick={() => startCampaign(msg)}
                        disabled={loading}
                        className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                      >
                        <Users className="size-3.5" />
                        Iniciar primeiro contato
                      </button>
                    )}
                  </div>
                )}

                {msg.role === 'system' && (
                  <div className="rounded-xl bg-red-50 px-3 py-2 text-xs text-red-600">
                    {msg.text}
                    {msg.link && (
                      <a href={msg.link} className="ml-1 font-medium underline">
                        Configurar agora →
                      </a>
                    )}
                  </div>
                )}
              </div>
            ))}

            {loading && (
              <div className="flex items-center gap-2 text-sm text-zinc-400">
                <Loader2 className="size-4 animate-spin" />
                Processando...
              </div>
            )}

            {/* Campaign result banner */}
            {campaignResult && (
              <div className="mt-2 flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                {campaignResult.failed === 0 ? (
                  <CheckCircle2 className="size-4 shrink-0" />
                ) : (
                  <XCircle className="size-4 shrink-0 text-amber-500" />
                )}
                {campaignResult.sent} enviados
                {campaignResult.failed > 0 && `, ${campaignResult.failed} falhas`}
              </div>
            )}

            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div className="border-t border-zinc-100 p-3">
            <div className="flex items-end gap-2">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ex: 10 saloes em Manaus com telefone..."
                rows={2}
                maxLength={1000}
                className="flex-1 resize-none rounded-xl border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400"
              />
              <button
                onClick={sendMessage}
                disabled={!input.trim() || loading}
                className="flex size-9 items-center justify-center rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40"
              >
                <Send className="size-4" />
              </button>
            </div>
            <p className="mt-1 text-right text-xs text-zinc-400">{input.length}/1000</p>
          </div>
        </div>
      )}

      {/* Campaign wizard modal */}
      {pendingCampaign && (
        <CampaignWizard
          campaignId={pendingCampaign.campaignId}
          confirmationToken={pendingCampaign.confirmationToken}
          recipients={pendingCampaign.recipients}
          searchNicho={pendingCampaign.nicho}
          onClose={() => {
            // CampaignWizard handles cancel internally (pre-start only).
            // Post-start: automation keeps running after the panel is closed.
            setPendingCampaign(null)
          }}
          onComplete={handleCampaignComplete}
        />
      )}
    </>
  )
}

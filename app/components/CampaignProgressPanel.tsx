'use client'

// ---------------------------------------------------------------------------
// CampaignProgressPanel — real-time progress view for a running campaign.
//
// Polls GET /api/campaigns/:id/status every 5 s and displays:
//   - Progress bar (sent / total)
//   - Counters: enviados, falhas, pendentes
//   - Countdown to next send
//   - Control buttons: Pausar / Retomar / Cancelar
//   - Automation editor: PATCH delay/jitter/max_per_hour/max_retries/working_hours
//   - Final summary when completed
//
// Can be embedded in CampaignWizard (after /start) or standalone (campaign list).
// ---------------------------------------------------------------------------

import { useState, useEffect, useCallback, useRef } from 'react'
import { X, Pause, Play, StopCircle, CheckCircle2, AlertCircle, Loader2, Clock, Settings } from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CampaignStatus {
  id: string
  name: string | null
  status: string
  total_count: number
  sent_count: number
  failed_count: number
  pending_count: number
  progress: { pending: number; processing: number; sent: number; failed: number; skipped: number }
  next_send_at: string | null
  seconds_until_next: number | null
  paused_at: string | null
  is_terminal: boolean
  automation: {
    delay_seconds: number
    jitter_max: number
    max_per_hour: number
    max_retries: number
    working_hours_start: number | null
    working_hours_end: number | null
  }
}

interface AutomationDraft {
  delay_seconds: number
  jitter_max: number
  max_per_hour: number
  max_retries: number
  working_hours_start: number | null
  working_hours_end: number | null
}

interface Props {
  campaignId: string
  recipientCount: number
  onClose: () => void
  onComplete: () => void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function apiPost(url: string, body?: unknown) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`)
  }
  return res.json()
}

function statusLabel(status: string) {
  const map: Record<string, string> = {
    sending: 'Enviando',
    paused: 'Pausada',
    completed: 'Concluida',
    completed_with_errors: 'Concluida com erros',
    cancelled: 'Cancelada',
  }
  return map[status] ?? status
}

function statusColor(status: string) {
  if (status === 'sending') return 'bg-emerald-100 text-emerald-700'
  if (status === 'paused') return 'bg-amber-100 text-amber-700'
  if (status === 'completed') return 'bg-blue-100 text-blue-700'
  if (status === 'completed_with_errors') return 'bg-orange-100 text-orange-700'
  if (status === 'cancelled') return 'bg-zinc-100 text-zinc-600'
  return 'bg-zinc-100 text-zinc-600'
}

function formatCountdown(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return 'enviando...'
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function CampaignProgressPanel({ campaignId, recipientCount, onClose, onComplete }: Props) {
  const [status, setStatus] = useState<CampaignStatus | null>(null)
  const [countdown, setCountdown] = useState<number | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState<'pause' | 'resume' | 'cancel' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  // Automation editor
  const [showAutomationEdit, setShowAutomationEdit] = useState(false)
  const [automationDraft, setAutomationDraft] = useState<AutomationDraft>({
    delay_seconds: 120,
    jitter_max: 20,
    max_per_hour: 30,
    max_retries: 3,
    working_hours_start: null,
    working_hours_end: null,
  })
  const [automationSaving, setAutomationSaving] = useState(false)
  const [automationError, setAutomationError] = useState<string | null>(null)

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------
  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/status`)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`)
      }
      const data = (await res.json()) as { data: CampaignStatus }
      setStatus(data.data)
      setLoadError(null)

      // Sync countdown
      setCountdown(data.data.seconds_until_next)

      // Stop polling + notify parent when terminal
      if (data.data.is_terminal) {
        if (pollRef.current) clearInterval(pollRef.current)
        if (countdownRef.current) clearInterval(countdownRef.current)
        if (data.data.status === 'completed' || data.data.status === 'completed_with_errors') {
          onComplete()
        }
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Erro ao carregar status')
    }
  }, [campaignId, onComplete])

  useEffect(() => {
    fetchStatus()
    pollRef.current = setInterval(fetchStatus, 5_000)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [fetchStatus])

  // Countdown tick (every second)
  useEffect(() => {
    countdownRef.current = setInterval(() => {
      setCountdown((c) => (c !== null && c > 0 ? c - 1 : c))
    }, 1_000)
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current)
    }
  }, [])

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------
  const handleAction = useCallback(
    async (action: 'pause' | 'resume' | 'cancel') => {
      setActionLoading(action)
      setActionError(null)
      try {
        await apiPost(`/api/campaigns/${campaignId}/${action}`)
        await fetchStatus()
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Erro inesperado')
      } finally {
        setActionLoading(null)
      }
    },
    [campaignId, fetchStatus],
  )

  const openAutomationEdit = useCallback(() => {
    if (status?.automation) {
      setAutomationDraft({
        delay_seconds:       status.automation.delay_seconds,
        jitter_max:          status.automation.jitter_max,
        max_per_hour:        status.automation.max_per_hour,
        max_retries:         status.automation.max_retries,
        working_hours_start: status.automation.working_hours_start,
        working_hours_end:   status.automation.working_hours_end,
      })
    }
    setAutomationError(null)
    setShowAutomationEdit(true)
  }, [status])

  const handleSaveAutomation = useCallback(async () => {
    // Client-side validation before hitting the network
    if (automationDraft.delay_seconds < 10) {
      setAutomationError('Intervalo entre envios deve ser no minimo 10 segundos.')
      return
    }
    if (automationDraft.jitter_max < 0) {
      setAutomationError('Variacao (jitter) nao pode ser negativa.')
      return
    }
    if (automationDraft.max_per_hour < 1) {
      setAutomationError('Maximo por hora deve ser no minimo 1.')
      return
    }
    if (automationDraft.max_retries < 0) {
      setAutomationError('Numero de tentativas nao pode ser negativo.')
      return
    }
    const hasStart = automationDraft.working_hours_start !== null
    const hasEnd   = automationDraft.working_hours_end !== null
    if (hasStart !== hasEnd) {
      setAutomationError('Informe horario de inicio e fim juntos, ou deixe ambos em branco.')
      return
    }

    // Only send fields that actually changed (diff against current status.automation)
    const current = status?.automation
    const patch: Record<string, unknown> = {}
    if (!current || automationDraft.delay_seconds !== current.delay_seconds)
      patch.delay_seconds = automationDraft.delay_seconds
    if (!current || automationDraft.jitter_max !== current.jitter_max)
      patch.jitter_max = automationDraft.jitter_max
    if (!current || automationDraft.max_per_hour !== current.max_per_hour)
      patch.max_per_hour = automationDraft.max_per_hour
    if (!current || automationDraft.max_retries !== current.max_retries)
      patch.max_retries = automationDraft.max_retries
    if (!current || automationDraft.working_hours_start !== current.working_hours_start)
      patch.working_hours_start = automationDraft.working_hours_start
    if (!current || automationDraft.working_hours_end !== current.working_hours_end)
      patch.working_hours_end = automationDraft.working_hours_end

    if (Object.keys(patch).length === 0) {
      setShowAutomationEdit(false)
      return
    }

    setAutomationSaving(true)
    setAutomationError(null)
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/automation`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`)
      }
      setShowAutomationEdit(false)
      await fetchStatus()
    } catch (err) {
      setAutomationError(err instanceof Error ? err.message : 'Erro ao salvar')
    } finally {
      setAutomationSaving(false)
    }
  }, [campaignId, automationDraft, status, fetchStatus])

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  const total = status?.total_count ?? recipientCount
  const sent = status?.sent_count ?? 0
  const failed = status?.failed_count ?? 0
  const pending = status?.pending_count ?? total
  const pct = total > 0 ? Math.round(((sent + failed) / total) * 100) : 0
  const currentStatus = status?.status ?? 'sending'
  const isTerminal = status?.is_terminal ?? false
  const isPaused = currentStatus === 'paused'
  const isSending = currentStatus === 'sending'
  const hasWorkingHours = automationDraft.working_hours_start !== null && automationDraft.working_hours_end !== null

  return (
    <div className="rounded-2xl border border-zinc-200 bg-white shadow-2xl">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-100 px-6 py-4">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900">
            {status?.name ?? 'Campanha em andamento'}
          </h2>
          <span className={`mt-0.5 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${statusColor(currentStatus)}`}>
            {statusLabel(currentStatus)}
          </span>
        </div>
        <button
          onClick={onClose}
          className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="p-6 space-y-5">
        {/* Load error */}
        {loadError && (
          <div className="flex items-center gap-2 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
            <AlertCircle className="size-4 shrink-0" />
            {loadError}
          </div>
        )}

        {/* Action error */}
        {actionError && (
          <div className="flex items-center gap-2 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-700">
            <AlertCircle className="size-4 shrink-0" />
            {actionError}
          </div>
        )}

        {/* Progress bar */}
        <div>
          <div className="mb-1.5 flex justify-between text-xs">
            <span className="font-medium text-zinc-700">Progresso</span>
            <span className="text-zinc-500">{pct}%</span>
          </div>
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-zinc-100">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                failed > 0 ? 'bg-gradient-to-r from-emerald-500 to-orange-400' : 'bg-emerald-500'
              }`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>

        {/* Counters */}
        <div className="grid grid-cols-3 divide-x divide-zinc-100 rounded-xl border border-zinc-100">
          <div className="px-4 py-3 text-center">
            <p className="text-lg font-semibold text-emerald-600">{sent}</p>
            <p className="text-xs text-zinc-500">Enviados</p>
          </div>
          <div className="px-4 py-3 text-center">
            <p className={`text-lg font-semibold ${failed > 0 ? 'text-red-500' : 'text-zinc-400'}`}>{failed}</p>
            <p className="text-xs text-zinc-500">Falhas</p>
          </div>
          <div className="px-4 py-3 text-center">
            <p className="text-lg font-semibold text-zinc-700">{pending}</p>
            <p className="text-xs text-zinc-500">Pendentes</p>
          </div>
        </div>

        {/* Next send countdown */}
        {isSending && !isTerminal && (
          <div className="flex items-center justify-between rounded-lg bg-zinc-50 px-4 py-3">
            <div className="flex items-center gap-2 text-sm text-zinc-600">
              <Clock className="size-4 text-zinc-400" />
              Proximo envio em
            </div>
            <span className="font-medium text-zinc-800 tabular-nums">
              {formatCountdown(countdown)}
            </span>
          </div>
        )}

        {/* Paused info */}
        {isPaused && status?.paused_at && (
          <div className="rounded-lg bg-amber-50 px-4 py-3 text-xs text-amber-700">
            Pausada em {new Date(status.paused_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
          </div>
        )}

        {/* Terminal state */}
        {isTerminal && (
          <div className={`flex items-center gap-2 rounded-lg px-4 py-3 text-sm ${
            currentStatus === 'completed' ? 'bg-blue-50 text-blue-700' :
            currentStatus === 'completed_with_errors' ? 'bg-orange-50 text-orange-700' :
            'bg-zinc-50 text-zinc-600'
          }`}>
            {currentStatus === 'completed' ? (
              <CheckCircle2 className="size-4 shrink-0" />
            ) : currentStatus === 'cancelled' ? (
              <StopCircle className="size-4 shrink-0" />
            ) : (
              <AlertCircle className="size-4 shrink-0" />
            )}
            {statusLabel(currentStatus)} — {sent} enviados, {failed} falhas
          </div>
        )}

        {/* Skeleton while loading */}
        {!status && !loadError && (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="size-5 animate-spin text-zinc-400" />
          </div>
        )}

        {/* Controls */}
        {!isTerminal && (
          <div className="flex items-center gap-2 pt-1">
            {isSending && (
              <button
                onClick={() => handleAction('pause')}
                disabled={actionLoading !== null}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
              >
                {actionLoading === 'pause' ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Pause className="size-4" />
                )}
                Pausar
              </button>
            )}
            {isPaused && (
              <button
                onClick={() => handleAction('resume')}
                disabled={actionLoading !== null}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {actionLoading === 'resume' ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Play className="size-4" />
                )}
                Retomar
              </button>
            )}
            <button
              onClick={() => handleAction('cancel')}
              disabled={actionLoading !== null}
              className="flex items-center justify-center gap-1.5 rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
            >
              {actionLoading === 'cancel' ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <StopCircle className="size-4" />
              )}
              Cancelar
            </button>
            <button
              onClick={openAutomationEdit}
              disabled={actionLoading !== null}
              title="Editar automação"
              className="flex items-center justify-center rounded-lg border border-zinc-200 p-2 text-zinc-500 hover:bg-zinc-50 hover:text-zinc-700 disabled:opacity-50"
            >
              <Settings className="size-4" />
            </button>
          </div>
        )}

        {/* Automation editor */}
        {showAutomationEdit && (
          <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Editar automação
            </p>

            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1">
                <span className="text-xs text-zinc-500">Intervalo (s)</span>
                <input
                  type="number" min={10} max={86400}
                  value={automationDraft.delay_seconds}
                  onChange={(e) => setAutomationDraft((d) => ({ ...d, delay_seconds: Number(e.target.value) }))}
                  className="w-full rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm"
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs text-zinc-500">Jitter (s)</span>
                <input
                  type="number" min={0} max={300}
                  value={automationDraft.jitter_max}
                  onChange={(e) => setAutomationDraft((d) => ({ ...d, jitter_max: Number(e.target.value) }))}
                  className="w-full rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm"
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs text-zinc-500">Máx/hora</span>
                <input
                  type="number" min={1} max={500}
                  value={automationDraft.max_per_hour}
                  onChange={(e) => setAutomationDraft((d) => ({ ...d, max_per_hour: Number(e.target.value) }))}
                  className="w-full rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm"
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs text-zinc-500">Max tentativas</span>
                <input
                  type="number" min={0} max={10}
                  value={automationDraft.max_retries}
                  onChange={(e) => setAutomationDraft((d) => ({ ...d, max_retries: Number(e.target.value) }))}
                  className="w-full rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm"
                />
              </label>
            </div>

            <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-600">
              <input
                type="checkbox"
                checked={hasWorkingHours}
                onChange={(e) => {
                  if (e.target.checked) {
                    setAutomationDraft((d) => ({ ...d, working_hours_start: 8, working_hours_end: 18 }))
                  } else {
                    setAutomationDraft((d) => ({ ...d, working_hours_start: null, working_hours_end: null }))
                  }
                }}
                className="rounded"
              />
              Restringir horário de envio
            </label>

            {hasWorkingHours && (
              <div className="grid grid-cols-2 gap-3">
                <label className="space-y-1">
                  <span className="text-xs text-zinc-500">Início (h, 0–23)</span>
                  <input
                    type="number" min={0} max={23}
                    value={automationDraft.working_hours_start ?? 8}
                    onChange={(e) => setAutomationDraft((d) => ({ ...d, working_hours_start: Number(e.target.value) }))}
                    className="w-full rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-xs text-zinc-500">Fim (h, 0–23)</span>
                  <input
                    type="number" min={0} max={23}
                    value={automationDraft.working_hours_end ?? 18}
                    onChange={(e) => setAutomationDraft((d) => ({ ...d, working_hours_end: Number(e.target.value) }))}
                    className="w-full rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm"
                  />
                </label>
              </div>
            )}

            {automationError && (
              <p className="text-xs text-red-600">{automationError}</p>
            )}

            <div className="flex gap-2">
              <button
                onClick={handleSaveAutomation}
                disabled={automationSaving}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-zinc-800 px-3 py-2 text-xs font-medium text-white hover:bg-zinc-700 disabled:opacity-50"
              >
                {automationSaving && <Loader2 className="size-3 animate-spin" />}
                Salvar
              </button>
              <button
                onClick={() => { setShowAutomationEdit(false); setAutomationError(null) }}
                disabled={automationSaving}
                className="flex items-center justify-center rounded-lg border border-zinc-200 px-3 py-2 text-xs font-medium text-zinc-600 hover:bg-zinc-100 disabled:opacity-50"
              >
                Cancelar
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

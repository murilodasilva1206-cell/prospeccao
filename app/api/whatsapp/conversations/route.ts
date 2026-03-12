// GET /api/whatsapp/conversations — list conversations for authenticated workspace
//
// Query params: limit?, offset?, status?, provider?, channel_id?, date_from?, date_to?, preset?
// Auth: Bearer wk_... workspace API key or session cookie

import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { whatsappConversationLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { requireWorkspaceAuth, authErrorResponse } from '@/lib/whatsapp/auth-middleware'
import { findConversationsByWorkspace } from '@/lib/whatsapp/conversation-repo'
import { findChannelById } from '@/lib/whatsapp/channel-repo'

// ---------------------------------------------------------------------------
// Helpers de validação
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const VALID_PROVIDERS = ['META_CLOUD', 'EVOLUTION', 'UAZAPI'] as const
const VALID_PRESETS = ['last_7_days', 'last_month'] as const

/** Parseia YYYY-MM-DD como meia-noite local e valida que é uma data real. */
function parseDate(str: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str)
  if (!m) return null
  const y = parseInt(m[1], 10)
  const mo = parseInt(m[2], 10)
  const d = parseInt(m[3], 10)
  const date = new Date(y, mo - 1, d)
  if (
    date.getFullYear() !== y ||
    date.getMonth() !== mo - 1 ||
    date.getDate() !== d
  ) return null
  return date
}

/** Resolve preset para { date_from, date_to } — date_to sempre às 23:59:59.999 local. */
function resolvePreset(preset: string): { date_from: Date; date_to: Date } | null {
  const now = new Date()
  if (preset === 'last_7_days') {
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    from.setDate(from.getDate() - 7)
    const to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)
    return { date_from: from, date_to: to }
  }
  if (preset === 'last_month') {
    const prevMonth = now.getMonth() === 0 ? 11 : now.getMonth() - 1
    const prevYear = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear()
    const from = new Date(prevYear, prevMonth, 1)
    const to = new Date(prevYear, prevMonth + 1, 0, 23, 59, 59, 999) // dia 0 = último dia do mês
    return { date_from: from, date_to: to }
  }
  return null
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'GET /api/whatsapp/conversations', ip })

  const rateLimit = await whatsappConversationLimiter.check(ip)
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: 'Muitas requisições' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)) } },
    )
  }

  try {
    const client = await pool.connect()
    try {
      const auth = await requireWorkspaceAuth(request, client)

      const p = request.nextUrl.searchParams
      const limit = Math.min(parseInt(p.get('limit') ?? '50', 10) || 50, 100)
      const offset = parseInt(p.get('offset') ?? '0', 10) || 0
      const statusRaw = p.get('status')
      const VALID_STATUSES = ['open', 'resolved', 'ai_handled'] as const
      type ValidStatus = (typeof VALID_STATUSES)[number]
      if (statusRaw !== null && !(VALID_STATUSES as readonly string[]).includes(statusRaw)) {
        return NextResponse.json({ error: 'status inválido' }, { status: 400 })
      }
      const status: ValidStatus | undefined = statusRaw !== null ? (statusRaw as ValidStatus) : undefined

      // --- provider ---
      const providerRaw = p.get('provider')
      let provider: 'META_CLOUD' | 'EVOLUTION' | 'UAZAPI' | undefined
      if (providerRaw !== null) {
        if (!(VALID_PROVIDERS as readonly string[]).includes(providerRaw)) {
          return NextResponse.json({ error: 'provider inválido' }, { status: 400 })
        }
        provider = providerRaw as typeof provider
      }

      // --- channel_id ---
      const channelIdRaw = p.get('channel_id')
      let channel_id: string | undefined
      if (channelIdRaw !== null) {
        if (!UUID_RE.test(channelIdRaw)) {
          return NextResponse.json({ error: 'channel_id deve ser um UUID válido' }, { status: 400 })
        }
        const channel = await findChannelById(client, channelIdRaw)
        if (!channel || channel.workspace_id !== auth.workspace_id) {
          return NextResponse.json({ error: 'Acesso negado' }, { status: 403 })
        }
        channel_id = channelIdRaw
      }

      // --- datas / preset ---
      const presetRaw = p.get('preset')
      const dateFromRaw = p.get('date_from')
      const dateToRaw = p.get('date_to')
      let date_from: Date | undefined
      let date_to: Date | undefined

      if (presetRaw !== null) {
        if (!(VALID_PRESETS as readonly string[]).includes(presetRaw)) {
          return NextResponse.json({ error: 'preset inválido' }, { status: 400 })
        }
        const resolved = resolvePreset(presetRaw)!
        date_from = resolved.date_from
        date_to = resolved.date_to
      } else {
        if (dateFromRaw !== null) {
          const d = parseDate(dateFromRaw)
          if (!d) return NextResponse.json({ error: 'date_from inválido' }, { status: 400 })
          date_from = d
        }
        if (dateToRaw !== null) {
          const d = parseDate(dateToRaw)
          if (!d) return NextResponse.json({ error: 'date_to inválido' }, { status: 400 })
          d.setHours(23, 59, 59, 999)
          date_to = d
        }
        if (date_from && date_to && date_from > date_to) {
          return NextResponse.json({ error: 'date_from não pode ser posterior a date_to' }, { status: 400 })
        }
      }

      const conversations = await findConversationsByWorkspace(client, auth.workspace_id, {
        limit,
        offset,
        status,
        provider,
        channel_id,
        date_from,
        date_to,
      })

      log.info({ workspace_id: auth.workspace_id, count: conversations.length }, 'Conversas listadas')
      return NextResponse.json({ data: conversations })
    } finally {
      client.release()
    }
  } catch (err) {
    const res = authErrorResponse(err)
    if (res) return res
    log.error({ err }, 'Erro ao listar conversas')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

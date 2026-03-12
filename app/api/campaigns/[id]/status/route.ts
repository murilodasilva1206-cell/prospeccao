// GET /api/campaigns/:id/status — real-time progress for a running campaign
//
// Returns live recipient counts, automation config, next_send_at countdown,
// and current status. Designed for frontend polling every 5 seconds.

import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { campaignLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { requireWorkspaceAuth, authErrorResponse } from '@/lib/whatsapp/auth-middleware'
import { findCampaignById, getCampaignProgress } from '@/lib/campaign-repo'
import { z } from 'zod'

const CampaignIdSchema = z.string().uuid()

type Params = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, { params }: Params) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'GET /api/campaigns/:id/status', ip })

  const rateLimit = await campaignLimiter.check(ip)
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: 'Muitas requisições' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)) } },
    )
  }

  const idParsed = CampaignIdSchema.safeParse((await params).id)
  if (!idParsed.success) return NextResponse.json({ error: 'id inválido' }, { status: 400 })
  const campaignId = idParsed.data

  try {
    const client = await pool.connect()
    try {
      const auth = await requireWorkspaceAuth(request, client)
      const campaign = await findCampaignById(client, campaignId)

      if (!campaign) return NextResponse.json({ error: 'Campanha nao encontrada' }, { status: 404 })
      if (campaign.workspace_id !== auth.workspace_id) {
        return NextResponse.json({ error: 'Acesso negado' }, { status: 403 })
      }

      const progress = await getCampaignProgress(client, campaignId)

      const now = Date.now()
      const secondsUntilNext = campaign.next_send_at
        ? Math.max(0, Math.round((campaign.next_send_at.getTime() - now) / 1000))
        : null

      const isTerminal = ['completed', 'completed_with_errors', 'cancelled'].includes(campaign.status)

      log.debug({ campaignId, status: campaign.status }, 'Status consultado')
      return NextResponse.json({
        data: {
          id: campaign.id,
          name: campaign.name,
          status: campaign.status,
          total_count: campaign.total_count,
          sent_count: campaign.sent_count,
          failed_count: campaign.failed_count,
          pending_count: progress.pending + progress.processing,
          progress,
          next_send_at: campaign.next_send_at?.toISOString() ?? null,
          seconds_until_next: secondsUntilNext,
          paused_at: campaign.paused_at?.toISOString() ?? null,
          is_terminal: isTerminal,
          automation: {
            delay_seconds:       campaign.automation_delay_seconds,
            jitter_max:          campaign.automation_jitter_max,
            max_per_hour:        campaign.automation_max_per_hour,
            max_retries:         campaign.max_retries,
            working_hours_start: campaign.automation_working_hours_start,
            working_hours_end:   campaign.automation_working_hours_end,
          },
        },
      })
    } finally {
      client.release()
    }
  } catch (err) {
    const res = authErrorResponse(err)
    if (res) return res
    log.error({ err }, 'Erro ao consultar status da campanha')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

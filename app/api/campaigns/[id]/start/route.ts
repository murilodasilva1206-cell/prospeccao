// POST /api/campaigns/:id/start — begin automated sending
//
// Transitions: ready_to_send → sending
//
// Stores automation config (delay, jitter, rate limit, working hours, max_retries)
// and sets next_send_at = NOW() so the Vercel Cron picks this campaign up on its
// next tick (every minute at most).
//
// Security:
//   - Validates workspace ownership before transitioning state.
//   - Idempotency guard: returns 409 if campaign is not in 'ready_to_send'.

import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { campaignLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { requireWorkspaceAuth, authErrorResponse } from '@/lib/whatsapp/auth-middleware'
import { findCampaignById, startCampaignAutomation, insertCampaignAudit } from '@/lib/campaign-repo'
import { AutomationConfigSchema } from '@/lib/schemas'
import { z } from 'zod'

const CampaignIdSchema = z.string().uuid()

type Params = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, { params }: Params) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'POST /api/campaigns/:id/start', ip })

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

  const body = await request.json().catch(() => ({}))
  const configParsed = AutomationConfigSchema.safeParse(body)
  if (!configParsed.success) {
    return NextResponse.json(
      { error: 'Configuração inválida', details: configParsed.error.issues },
      { status: 400 },
    )
  }
  const config = configParsed.data

  try {
    const client = await pool.connect()
    try {
      const auth = await requireWorkspaceAuth(request, client)
      const campaign = await findCampaignById(client, campaignId)

      if (!campaign) return NextResponse.json({ error: 'Campanha nao encontrada' }, { status: 404 })
      if (campaign.workspace_id !== auth.workspace_id) {
        return NextResponse.json({ error: 'Acesso negado' }, { status: 403 })
      }
      if (campaign.status !== 'ready_to_send') {
        return NextResponse.json(
          { error: `Campanha nao pode ser iniciada (status: ${campaign.status})` },
          { status: 409 },
        )
      }

      const updated = await startCampaignAutomation(client, campaignId, config)
      if (!updated) {
        return NextResponse.json(
          { error: 'Campanha foi modificada concorrentemente — tente novamente' },
          { status: 409 },
        )
      }

      await insertCampaignAudit(client, campaignId, 'automation_started', auth.key_id, {
        delay_seconds: config.delay_seconds,
        jitter_max: config.jitter_max,
        max_per_hour: config.max_per_hour,
        max_retries: config.max_retries,
        working_hours_start: config.working_hours_start ?? null,
        working_hours_end: config.working_hours_end ?? null,
      })

      log.info({ campaignId, config }, 'Automacao de campanha iniciada')
      return NextResponse.json({ data: updated })
    } finally {
      client.release()
    }
  } catch (err) {
    const res = authErrorResponse(err)
    if (res) return res
    log.error({ err }, 'Erro ao iniciar automacao da campanha')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

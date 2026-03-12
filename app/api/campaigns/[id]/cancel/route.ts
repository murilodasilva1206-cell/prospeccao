// POST /api/campaigns/:id/cancel — cancel a campaign
//
// Allowed from: draft | awaiting_confirmation | awaiting_channel | awaiting_message
//               | ready_to_send | sending | paused
// Not allowed when: completed | completed_with_errors | cancelled

import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { campaignLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { requireWorkspaceAuth, authErrorResponse } from '@/lib/whatsapp/auth-middleware'
import { findCampaignById, cancelCampaignIfAllowed, insertCampaignAudit } from '@/lib/campaign-repo'
import { z } from 'zod'

const CampaignIdSchema = z.string().uuid()

type Params = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, { params }: Params) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'POST /api/campaigns/:id/cancel', ip })

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

      // Atomic: UPDATE ... WHERE status IN (cancellable) — prevents race with cron finalizer
      const updated = await cancelCampaignIfAllowed(client, campaignId)
      if (!updated) {
        return NextResponse.json(
          { error: `Campanha nao pode ser cancelada (status: ${campaign.status})` },
          { status: 409 },
        )
      }

      await insertCampaignAudit(client, campaignId, 'cancelled', auth.key_id)

      log.info({ campaignId, previousStatus: campaign.status }, 'Campanha cancelada')
      return NextResponse.json({ data: updated })
    } finally {
      client.release()
    }
  } catch (err) {
    const res = authErrorResponse(err)
    if (res) return res
    log.error({ err }, 'Erro ao cancelar campanha')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

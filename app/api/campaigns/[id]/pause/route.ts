// POST /api/campaigns/:id/pause — pause an active campaign
//
// Transitions: sending → paused
//
// The Vercel Cron will skip campaigns in 'paused' state. Already-claimed
// recipients (status='processing') will be finalized when the cron runs next
// after resume; the lease recovery mechanism handles them automatically.

import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { campaignLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { requireWorkspaceAuth, authErrorResponse } from '@/lib/whatsapp/auth-middleware'
import { findCampaignById, pauseCampaign, insertCampaignAudit } from '@/lib/campaign-repo'
import { z } from 'zod'

const CampaignIdSchema = z.string().uuid()

type Params = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, { params }: Params) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'POST /api/campaigns/:id/pause', ip })

  const rateLimit = await campaignLimiter.check(ip)
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: 'Muitas requisicoes' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)) } },
    )
  }

  const idParsed = CampaignIdSchema.safeParse((await params).id)
  if (!idParsed.success) return NextResponse.json({ error: 'id invalido' }, { status: 400 })
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
      if (campaign.status !== 'sending') {
        return NextResponse.json(
          { error: `Campanha nao pode ser pausada (status: ${campaign.status})` },
          { status: 409 },
        )
      }

      const updated = await pauseCampaign(client, campaignId)
      if (!updated) {
        return NextResponse.json(
          { error: 'Campanha foi modificada concorrentemente — tente novamente' },
          { status: 409 },
        )
      }

      await insertCampaignAudit(client, campaignId, 'automation_paused', auth.key_id)

      log.info({ campaignId }, 'Campanha pausada')
      return NextResponse.json({ data: updated })
    } finally {
      client.release()
    }
  } catch (err) {
    const res = authErrorResponse(err)
    if (res) return res
    log.error({ err }, 'Erro ao pausar campanha')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

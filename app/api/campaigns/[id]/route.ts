// GET /api/campaigns/:id — get campaign details
//
// Auth: Bearer wk_... workspace API key required.

import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { campaignLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { requireWorkspaceAuth, authErrorResponse } from '@/lib/whatsapp/auth-middleware'
import { findCampaignById, countRecipients } from '@/lib/campaign-repo'
import { z } from 'zod'

const CampaignIdSchema = z.string().uuid('id deve ser um UUID valido')

type Params = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, { params }: Params) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'GET /api/campaigns/:id', ip })

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

      // Count recipients by status
      const [pending, sent, failed, skipped] = await Promise.all([
        countRecipients(client, campaignId, 'pending'),
        countRecipients(client, campaignId, 'sent'),
        countRecipients(client, campaignId, 'failed'),
        countRecipients(client, campaignId, 'skipped'),
      ])

      // Never expose confirmation_token in GET responses
      const { confirmation_token: _token, ...safeCampaign } = campaign

      log.info({ campaignId, status: campaign.status }, 'Campanha consultada')
      return NextResponse.json({
        data: {
          ...safeCampaign,
          recipients_summary: { pending, sent, failed, skipped },
        },
      })
    } finally {
      client.release()
    }
  } catch (err) {
    const res = authErrorResponse(err)
    if (res) return res
    log.error({ err }, 'Erro ao buscar campanha')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

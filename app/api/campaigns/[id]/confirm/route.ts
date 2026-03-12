// POST /api/campaigns/:id/confirm — confirm a draft campaign
//
// Transitions: draft → awaiting_channel
// Requires echoing back the confirmation_token from the creation response.
// This explicit confirmation prevents CSRF-style auto-activation via crafted links.

import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { timingSafeEqual } from 'crypto'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { campaignLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { ConfirmCampaignSchema } from '@/lib/schemas'
import { requireWorkspaceAuth, authErrorResponse } from '@/lib/whatsapp/auth-middleware'
import { findCampaignById, updateCampaignStatus, insertCampaignAudit } from '@/lib/campaign-repo'
import { z } from 'zod'

const CampaignIdSchema = z.string().uuid('id deve ser um UUID valido')

type Params = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, { params }: Params) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'POST /api/campaigns/:id/confirm', ip })

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

  let body
  try {
    const raw = await request.json()
    body = ConfirmCampaignSchema.parse(raw)
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json({ error: 'Parâmetros inválidos', details: err.issues }, { status: 400 })
    }
    return NextResponse.json({ error: 'JSON inválido no corpo da requisição' }, { status: 400 })
  }

  try {
    const client = await pool.connect()
    try {
      const auth = await requireWorkspaceAuth(request, client)
      const campaign = await findCampaignById(client, campaignId)

      if (!campaign) return NextResponse.json({ error: 'Campanha nao encontrada' }, { status: 404 })
      if (campaign.workspace_id !== auth.workspace_id) {
        return NextResponse.json({ error: 'Acesso negado' }, { status: 403 })
      }
      if (campaign.status !== 'draft') {
        return NextResponse.json(
          { error: `Campanha nao pode ser confirmada (status atual: ${campaign.status})` },
          { status: 409 },
        )
      }
      if (!campaign.confirmation_token) {
        return NextResponse.json({ error: 'Token de confirmação ausente' }, { status: 400 })
      }

      // Constant-time comparison to prevent timing attacks
      const storedBuf = Buffer.from(campaign.confirmation_token, 'utf8')
      const givenBuf = Buffer.from(body.confirmation_token, 'utf8')
      const tokenMatch =
        storedBuf.length === givenBuf.length &&
        timingSafeEqual(storedBuf, givenBuf)

      if (!tokenMatch) {
        log.warn({ campaignId }, 'Token de confirmação inválido')
        return NextResponse.json({ error: 'Token de confirmação inválido' }, { status: 403 })
      }

      // Transition to awaiting_channel; clear token (single-use)
      const updated = await updateCampaignStatus(client, campaignId, 'awaiting_channel', {
        confirmation_token: null,
      })

      await insertCampaignAudit(client, campaignId, 'confirmed', auth.key_id)

      log.info({ campaignId }, 'Campanha confirmada → awaiting_channel')
      return NextResponse.json({
        data: updated,
        next_step: 'Selecione o canal via POST /api/campaigns/:id/select-channel',
      })
    } finally {
      client.release()
    }
  } catch (err) {
    const res = authErrorResponse(err)
    if (res) return res
    log.error({ err }, 'Erro ao confirmar campanha')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

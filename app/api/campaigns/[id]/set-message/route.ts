// POST /api/campaigns/:id/set-message — define the message to send
//
// Transitions: awaiting_message → ready_to_send
// Enforces: META_CLOUD requires message_type="template"; others require "text".

import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { campaignLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { SetCampaignMessageSchema } from '@/lib/schemas'
import { requireWorkspaceAuth, authErrorResponse } from '@/lib/whatsapp/auth-middleware'
import { findCampaignById, updateCampaignStatus, insertCampaignAudit } from '@/lib/campaign-repo'
import { findChannelById } from '@/lib/whatsapp/channel-repo'
import { z } from 'zod'

const CampaignIdSchema = z.string().uuid()

type Params = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, { params }: Params) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'POST /api/campaigns/:id/set-message', ip })

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
    body = SetCampaignMessageSchema.parse(raw)
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
      if (campaign.status !== 'awaiting_message') {
        return NextResponse.json(
          { error: `Campanha não está aguardando mensagem (status: ${campaign.status})` },
          { status: 409 },
        )
      }
      if (!campaign.channel_id) {
        return NextResponse.json({ error: 'Canal nao foi selecionado' }, { status: 409 })
      }

      const channel = await findChannelById(client, campaign.channel_id)
      if (!channel) return NextResponse.json({ error: 'Canal associado nao encontrado' }, { status: 404 })

      // Enforce provider rules:
      // - META_CLOUD: only templates (free-text in first-contact window is blocked by Meta)
      // - EVOLUTION / UAZAPI: only plain text
      if (channel.provider === 'META_CLOUD' && body.message_type !== 'template') {
        return NextResponse.json(
          { error: 'Canal META_CLOUD requer message_type="template" para primeiro contato' },
          { status: 422 },
        )
      }
      if (channel.provider !== 'META_CLOUD' && body.message_type !== 'text') {
        return NextResponse.json(
          { error: `Canal ${channel.provider} requer message_type="text"` },
          { status: 422 },
        )
      }

      const updated = await updateCampaignStatus(client, campaignId, 'ready_to_send', {
        message_type: body.message_type,
        message_content: body.message_content as Record<string, unknown>,
      })

      await insertCampaignAudit(client, campaignId, 'message_set', auth.key_id, {
        message_type: body.message_type,
        provider: channel.provider,
      })

      log.info({ campaignId, message_type: body.message_type }, 'Mensagem definida → ready_to_send')
      return NextResponse.json({
        data: updated,
        next_step: 'Configure e inicie a automacao via POST /api/campaigns/:id/start',
      })
    } finally {
      client.release()
    }
  } catch (err) {
    const res = authErrorResponse(err)
    if (res) return res
    log.error({ err }, 'Erro ao definir mensagem da campanha')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

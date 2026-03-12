// POST /api/campaigns/:id/select-channel — assign a WhatsApp channel to the campaign
//
// Transitions: awaiting_channel → awaiting_message
// Validates that the channel belongs to the same workspace and is CONNECTED.

import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { campaignLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { SelectChannelSchema } from '@/lib/schemas'
import { requireWorkspaceAuth, authErrorResponse } from '@/lib/whatsapp/auth-middleware'
import { findCampaignById, updateCampaignStatus, insertCampaignAudit } from '@/lib/campaign-repo'
import { findChannelById } from '@/lib/whatsapp/channel-repo'
import { z } from 'zod'

const CampaignIdSchema = z.string().uuid()

type Params = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, { params }: Params) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'POST /api/campaigns/:id/select-channel', ip })

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
    body = SelectChannelSchema.parse(raw)
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

      const [campaign, channel] = await Promise.all([
        findCampaignById(client, campaignId),
        findChannelById(client, body.channel_id),
      ])

      if (!campaign) return NextResponse.json({ error: 'Campanha nao encontrada' }, { status: 404 })
      if (campaign.workspace_id !== auth.workspace_id) {
        return NextResponse.json({ error: 'Acesso negado' }, { status: 403 })
      }
      // Also accept 'awaiting_message': the user may go back in the wizard to change
      // channel before setting the message. In that case we reset message fields.
      if (campaign.status !== 'awaiting_channel' && campaign.status !== 'awaiting_message') {
        return NextResponse.json(
          { error: `Campanha não está aguardando seleção de canal (status: ${campaign.status})` },
          { status: 409 },
        )
      }
      if (!channel) return NextResponse.json({ error: 'Canal nao encontrado' }, { status: 404 })
      if (channel.workspace_id !== auth.workspace_id) {
        return NextResponse.json({ error: 'Canal nao pertence a este workspace' }, { status: 403 })
      }
      if (channel.status !== 'CONNECTED') {
        return NextResponse.json(
          { error: `Canal não está conectado (status: ${channel.status})` },
          { status: 409 },
        )
      }

      // Always transition to awaiting_message; if re-selecting channel, explicitly
      // clear message fields so they cannot carry over an incompatible provider type.
      const updated = await updateCampaignStatus(client, campaignId, 'awaiting_message', {
        channel_id: body.channel_id,
        resetMessageFields: true,
      })

      await insertCampaignAudit(client, campaignId, 'channel_selected', auth.key_id, {
        channel_id: body.channel_id,
        channel_name: channel.name,
        provider: channel.provider,
      })

      log.info({ campaignId, channelId: body.channel_id, provider: channel.provider }, 'Canal selecionado')
      return NextResponse.json({
        data: updated,
        channel_provider: channel.provider,
        next_step:
          channel.provider === 'META_CLOUD'
            ? 'Defina o template via POST /api/campaigns/:id/set-message (message_type: "template")'
            : 'Defina a mensagem via POST /api/campaigns/:id/set-message (message_type: "text")',
      })
    } finally {
      client.release()
    }
  } catch (err) {
    const res = authErrorResponse(err)
    if (res) return res
    log.error({ err }, 'Erro ao selecionar canal')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

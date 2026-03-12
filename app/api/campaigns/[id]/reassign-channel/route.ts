// POST /api/campaigns/:id/reassign-channel — change the WhatsApp channel on a paused campaign.
//
// Allowed only from 'paused' status. Campaign status and message fields are unchanged.
// The new channel must be CONNECTED and belong to the same workspace.
//
// Use case: the original channel went offline during a send — operator pauses the campaign,
// assigns a different connected channel, then resumes.
//
// All mutations (channel update + audit) run inside an explicit transaction so a
// failed audit insert rolls back the channel change entirely.

import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { campaignLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { SelectChannelSchema } from '@/lib/schemas'
import { requireWorkspaceAuth, authErrorResponse } from '@/lib/whatsapp/auth-middleware'
import { findCampaignById, reassignCampaignChannel, insertCampaignAudit } from '@/lib/campaign-repo'
import { findChannelById } from '@/lib/whatsapp/channel-repo'
import { z } from 'zod'

const CampaignIdSchema = z.string().uuid()

type Params = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, { params }: Params) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'POST /api/campaigns/:id/reassign-channel', ip })

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

  let body: { channel_id: string }
  try {
    body = SelectChannelSchema.parse(await request.json())
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json({ error: 'Parâmetros inválidos', details: err.issues }, { status: 400 })
    }
    return NextResponse.json({ error: 'JSON inválido no corpo da requisição' }, { status: 400 })
  }

  try {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      const auth = await requireWorkspaceAuth(request, client)

      const [campaign, channel] = await Promise.all([
        findCampaignById(client, campaignId),
        findChannelById(client, body.channel_id),
      ])

      if (!campaign) {
        await client.query('ROLLBACK')
        return NextResponse.json({ error: 'Campanha nao encontrada' }, { status: 404 })
      }
      if (campaign.workspace_id !== auth.workspace_id) {
        await client.query('ROLLBACK')
        return NextResponse.json({ error: 'Acesso negado' }, { status: 403 })
      }
      if (campaign.status !== 'paused') {
        await client.query('ROLLBACK')
        return NextResponse.json(
          { error: `Reatribuicao de canal so e permitida em campanhas pausadas (status: ${campaign.status})` },
          { status: 409 },
        )
      }
      if (!channel) {
        await client.query('ROLLBACK')
        return NextResponse.json({ error: 'Canal nao encontrado' }, { status: 404 })
      }
      if (channel.workspace_id !== auth.workspace_id) {
        await client.query('ROLLBACK')
        return NextResponse.json({ error: 'Canal nao pertence a este workspace' }, { status: 403 })
      }
      if (channel.status !== 'CONNECTED') {
        await client.query('ROLLBACK')
        return NextResponse.json(
          { error: `Canal não está conectado (status: ${channel.status})` },
          { status: 409 },
        )
      }

      const updated = await reassignCampaignChannel(client, campaignId, body.channel_id)
      if (!updated) {
        await client.query('ROLLBACK')
        return NextResponse.json(
          { error: 'Campanha foi modificada concorrentemente — verifique o status e tente novamente' },
          { status: 409 },
        )
      }

      await insertCampaignAudit(client, campaignId, 'channel_reassigned', auth.key_id, {
        channel_id: body.channel_id,
        channel_name: channel.name,
        provider: channel.provider,
      })

      await client.query('COMMIT')

      log.info({ campaignId, channelId: body.channel_id, provider: channel.provider }, 'Canal reatribuido')
      return NextResponse.json({ data: updated, channel_provider: channel.provider })
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  } catch (err) {
    const res = authErrorResponse(err)
    if (res) return res
    log.error({ err }, 'Erro ao reatribuir canal')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

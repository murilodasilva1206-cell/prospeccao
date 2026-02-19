// POST /api/whatsapp/channels/:id/send-reaction — send reaction to a message
//
// Body: { to, emoji, target_provider_message_id }
// Auth: Bearer wk_... workspace API key

import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { whatsappChannelLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { SendReactionSchema } from '@/lib/schemas'
import { requireWorkspaceAuth, authErrorResponse } from '@/lib/whatsapp/auth-middleware'
import { findChannelById } from '@/lib/whatsapp/channel-repo'
import { decryptCredentials } from '@/lib/whatsapp/crypto'
import { getAdapter } from '@/lib/whatsapp/adapters/factory'
import { insertMessage } from '@/lib/whatsapp/message-repo'
import { upsertConversation } from '@/lib/whatsapp/conversation-repo'
import { ChannelIdSchema } from '@/lib/whatsapp/route-params'

type Params = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, { params }: Params) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'POST /api/whatsapp/channels/:id/send-reaction', ip })

  const rateLimit = await whatsappChannelLimiter.check(ip)
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: 'Muitas requisicoes' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)) } },
    )
  }

  const idParsed = ChannelIdSchema.safeParse((await params).id)
  if (!idParsed.success) return NextResponse.json({ error: 'id invalido' }, { status: 400 })
  const channelId = idParsed.data

  let body
  try {
    const raw = await request.json()
    body = SendReactionSchema.parse(raw)
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json({ error: 'Parametros invalidos', details: err.issues }, { status: 400 })
    }
    return NextResponse.json({ error: 'JSON invalido no corpo da requisicao' }, { status: 400 })
  }

  try {
    const client = await pool.connect()
    try {
      const auth = await requireWorkspaceAuth(request, client)

      const channel = await findChannelById(client, channelId)
      if (!channel) {
        return NextResponse.json({ error: 'Canal nao encontrado' }, { status: 404 })
      }
      if (channel.workspace_id !== auth.workspace_id) {
        return NextResponse.json({ error: 'Acesso negado' }, { status: 403 })
      }

      const creds = decryptCredentials(channel.credentials_encrypted)
      const adapter = getAdapter(channel.provider)
      const sendResult = await adapter.sendReaction(channel, creds, body.to, body.emoji, body.target_provider_message_id)

      const conversation = await upsertConversation(client, {
        channel_id: channelId,
        workspace_id: auth.workspace_id,
        contact_phone: body.to,
        contact_name: null,
      })

      const message = await insertMessage(client, {
        conversation_id: conversation.id,
        channel_id: channelId,
        provider_message_id: sendResult.message_id,
        direction: 'outbound',
        message_type: 'reaction',
        status: 'sent',
        body: body.emoji,
        sent_by: `human:${auth.key_id}`,
      })

      log.info({ channelId, messageId: message.id }, 'Reaction enviada')
      return NextResponse.json({ data: { id: message.id, provider_message_id: sendResult.message_id } }, { status: 201 })
    } finally {
      client.release()
    }
  } catch (err) {
    const res = authErrorResponse(err)
    if (res) return res
    log.error({ err }, 'Erro ao enviar reaction')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

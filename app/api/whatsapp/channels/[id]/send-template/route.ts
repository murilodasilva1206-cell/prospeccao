// POST /api/whatsapp/channels/:id/send-template — send Meta template message
//
// Body: { to, name, language, body_params? }
// Auth: Bearer wk_... workspace API key

import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { whatsappSendLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { SendTemplateSchema } from '@/lib/schemas'
import { requireWorkspaceAuth, authErrorResponse } from '@/lib/whatsapp/auth-middleware'
import { findChannelById } from '@/lib/whatsapp/channel-repo'
import { decryptCredentials } from '@/lib/whatsapp/crypto'
import { getAdapter } from '@/lib/whatsapp/adapters/factory'
import { upsertConversation } from '@/lib/whatsapp/conversation-repo'
import { insertMessage } from '@/lib/whatsapp/message-repo'
import { ChannelIdSchema } from '@/lib/whatsapp/route-params'

type Params = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, { params }: Params) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'POST /api/whatsapp/channels/:id/send-template', ip })

  const rateLimit = await whatsappSendLimiter.check(ip)
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: 'Muitas requisições' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)) } },
    )
  }

  const idParsed = ChannelIdSchema.safeParse((await params).id)
  if (!idParsed.success) return NextResponse.json({ error: 'id inválido' }, { status: 400 })
  const channelId = idParsed.data

  let body
  try {
    const raw = await request.json()
    body = SendTemplateSchema.parse(raw)
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

      const channel = await findChannelById(client, channelId)
      if (!channel) return NextResponse.json({ error: 'Canal nao encontrado' }, { status: 404 })
      if (channel.workspace_id !== auth.workspace_id) return NextResponse.json({ error: 'Acesso negado' }, { status: 403 })
      if (channel.provider !== 'META_CLOUD') {
        return NextResponse.json({ error: 'Templates oficiais disponiveis apenas para META_CLOUD' }, { status: 409 })
      }
      if (channel.status !== 'CONNECTED') {
        return NextResponse.json({ error: `Canal não está conectado (status: ${channel.status})` }, { status: 409 })
      }

      const creds = decryptCredentials(channel.credentials_encrypted)
      const adapter = getAdapter(channel.provider)
      const sendResult = await adapter.sendTemplate(
        channel,
        creds,
        body.to,
        body.name,
        body.language,
        body.body_params,
      )

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
        message_type: 'text',
        status: 'sent',
        body: `[template:${body.name}]`,
        sent_by: `human:${auth.key_id}`,
      })

      log.info({ channelId, messageId: message.id, template: body.name }, 'Template enviado')
      return NextResponse.json({ data: { id: message.id, provider_message_id: sendResult.message_id } }, { status: 201 })
    } finally {
      client.release()
    }
  } catch (err) {
    const res = authErrorResponse(err)
    if (res) return res
    log.error({ err }, 'Erro ao enviar template')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

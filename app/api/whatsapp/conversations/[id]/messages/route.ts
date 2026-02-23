// GET  /api/whatsapp/conversations/:id/messages — list messages (cursor pagination)
// POST /api/whatsapp/conversations/:id/messages — send text message to conversation
//
// Auth: Bearer wk_... workspace API key

import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { whatsappInboxLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { MessagePaginationSchema } from '@/lib/schemas'
import { requireWorkspaceAuth, authErrorResponse } from '@/lib/whatsapp/auth-middleware'
import { findConversationById } from '@/lib/whatsapp/conversation-repo'
import { findMessagesByConversation, insertMessage } from '@/lib/whatsapp/message-repo'
import { findChannelById } from '@/lib/whatsapp/channel-repo'
import { decryptCredentials } from '@/lib/whatsapp/crypto'
import { getAdapter } from '@/lib/whatsapp/adapters/factory'
import { getSignedUrl } from '@/lib/whatsapp/media'
import type { Message } from '@/lib/whatsapp/types'

type Params = { params: Promise<{ id: string }> }

// Attach signed S3 URLs to messages that have media
async function attachSignedUrls(messages: Message[]): Promise<(Message & { media_url?: string })[]> {
  return Promise.all(
    messages.map(async (msg) => {
      if (!msg.media_s3_key) return msg
      try {
        const media_url = await getSignedUrl(msg.media_s3_key, 300)
        return { ...msg, media_url }
      } catch {
        return msg
      }
    }),
  )
}

export async function GET(request: NextRequest, { params }: Params) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'GET /api/whatsapp/conversations/:id/messages', ip })

  const rateLimit = await whatsappInboxLimiter.check(ip)
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: 'Muitas requisicoes' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)) } },
    )
  }

  const { id: conversationId } = await params

  try {
    const client = await pool.connect()
    try {
      const auth = await requireWorkspaceAuth(request, client)

      const conversation = await findConversationById(client, conversationId)
      if (!conversation) {
        return NextResponse.json({ error: 'Conversa nao encontrada' }, { status: 404 })
      }
      if (conversation.workspace_id !== auth.workspace_id) {
        return NextResponse.json({ error: 'Acesso negado' }, { status: 403 })
      }

      let pagination
      try {
        pagination = MessagePaginationSchema.parse({
          limit: request.nextUrl.searchParams.get('limit') ?? undefined,
          before: request.nextUrl.searchParams.get('before') ?? undefined,
        })
      } catch (err) {
        if (err instanceof ZodError) {
          return NextResponse.json({ error: 'Parametros invalidos', details: err.issues }, { status: 400 })
        }
        throw err
      }

      const messages = await findMessagesByConversation(client, conversationId, {
        limit: pagination.limit,
        before: pagination.before,
      })

      const messagesWithUrls = await attachSignedUrls(messages)

      log.info({ conversationId, count: messages.length }, 'Mensagens listadas')
      return NextResponse.json({ data: messagesWithUrls })
    } finally {
      client.release()
    }
  } catch (err) {
    const res = authErrorResponse(err)
    if (res) return res
    log.error({ err }, 'Erro ao listar mensagens')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

export async function POST(request: NextRequest, { params }: Params) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'POST /api/whatsapp/conversations/:id/messages', ip })

  const rateLimit = await whatsappInboxLimiter.check(ip)
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: 'Muitas requisicoes' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)) } },
    )
  }

  const { id: conversationId } = await params

  let body: { text: string }
  try {
    const raw = await request.json()
    if (!raw.text || typeof raw.text !== 'string' || raw.text.trim().length === 0) {
      return NextResponse.json({ error: 'text e obrigatorio e nao pode ser vazio' }, { status: 400 })
    }
    if (raw.text.length > 4096) {
      return NextResponse.json({ error: 'text nao pode exceder 4096 caracteres' }, { status: 400 })
    }
    body = { text: raw.text as string }
  } catch {
    return NextResponse.json({ error: 'JSON invalido' }, { status: 400 })
  }

  try {
    const client = await pool.connect()
    try {
      const auth = await requireWorkspaceAuth(request, client)

      const conversation = await findConversationById(client, conversationId)
      if (!conversation) {
        return NextResponse.json({ error: 'Conversa nao encontrada' }, { status: 404 })
      }
      if (conversation.workspace_id !== auth.workspace_id) {
        return NextResponse.json({ error: 'Acesso negado' }, { status: 403 })
      }

      const channel = await findChannelById(client, conversation.channel_id)
      if (!channel) {
        return NextResponse.json({ error: 'Canal nao encontrado' }, { status: 404 })
      }

      const creds = decryptCredentials(channel.credentials_encrypted)
      const adapter = getAdapter(channel.provider)
      const sendResult = await adapter.sendMessage(channel, creds, conversation.contact_phone, body.text)

      const message = await insertMessage(client, {
        conversation_id: conversationId,
        channel_id: channel.id,
        provider_message_id: sendResult.message_id,
        direction: 'outbound',
        message_type: 'text',
        status: 'sent',
        body: body.text,
        sent_by: `human:${auth.key_id}`,
      })

      log.info({ conversationId, messageId: message.id }, 'Mensagem enviada via inbox')
      return NextResponse.json({ data: message }, { status: 201 })
    } finally {
      client.release()
    }
  } catch (err) {
    const res = authErrorResponse(err)
    if (res) return res
    log.error({ err }, 'Erro ao enviar mensagem na conversa')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

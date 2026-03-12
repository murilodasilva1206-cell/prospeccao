// POST /api/whatsapp/ai-dispatch — AI message dispatcher (Vercel Cron)
//
// Picks up messages where sent_by='ai' AND status='queued', sends them via
// the appropriate WhatsApp adapter, and updates status to 'sent' or 'failed'.
//
// Uses FOR UPDATE SKIP LOCKED (via claimAiQueuedMessages) so concurrent cron
// runs cannot double-send the same message.
//
// Auth: Authorization: Bearer <CRON_SECRET>
// Returns 503 if CRON_SECRET is not configured.

import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import pool from '@/lib/database'
import { env } from '@/lib/env'
import { logger } from '@/lib/logger'
import { claimAiQueuedMessages, markAiMessageDispatched } from '@/lib/whatsapp/message-repo'
import { findConversationById } from '@/lib/whatsapp/conversation-repo'
import { findChannelById } from '@/lib/whatsapp/channel-repo'
import { decryptCredentials } from '@/lib/whatsapp/crypto'
import { getAdapter } from '@/lib/whatsapp/adapters/factory'
import { RetryableError } from '@/lib/whatsapp/errors'

const log = logger.child({ route: 'POST /api/whatsapp/ai-dispatch' })

function authOk(request: NextRequest): boolean {
  if (!env.CRON_SECRET) return false
  const header = request.headers.get('Authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!token || token.length !== env.CRON_SECRET.length) return false
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(env.CRON_SECRET))
  } catch {
    return false
  }
}

export async function POST(request: NextRequest) {
  if (!env.CRON_SECRET) {
    return NextResponse.json({ error: 'CRON_SECRET nao configurado' }, { status: 503 })
  }
  if (!authOk(request)) {
    return NextResponse.json({ error: 'Nao autorizado' }, { status: 401 })
  }

  const client = await pool.connect()
  let sent = 0
  let failed = 0

  try {
    const messages = await claimAiQueuedMessages(client, 10)

    for (const msg of messages) {
      let outcome: 'sent' | 'failed' = 'failed'
      let providerMessageId: string | null = null

      try {
        const conversation = await findConversationById(client, msg.conversation_id)
        if (!conversation) {
          log.warn({ messageId: msg.id }, '[ai-dispatch] Conversa nao encontrada — marcando failed')
          await markAiMessageDispatched(client, msg.id, { status: 'failed' })
          failed++
          continue
        }

        const channel = await findChannelById(client, msg.channel_id)
        if (!channel || channel.status !== 'CONNECTED') {
          log.warn({ messageId: msg.id, channelId: msg.channel_id }, '[ai-dispatch] Canal nao disponivel — marcando failed')
          await markAiMessageDispatched(client, msg.id, { status: 'failed' })
          failed++
          continue
        }

        const creds = decryptCredentials(channel.credentials_encrypted)
        const adapter = getAdapter(channel.provider)

        const result = await adapter.sendMessage(
          channel,
          creds,
          conversation.contact_phone.replace(/[^\d]/g, ''),
          msg.body ?? '',
        )

        providerMessageId = result.message_id ?? null
        outcome = 'sent'
        sent++
      } catch (err) {
        if (err instanceof RetryableError) {
          // Put back to queued so the next cron tick can retry
          await client.query(
            `UPDATE messages SET status = 'queued', updated_at = NOW() WHERE id = $1`,
            [msg.id],
          )
          log.warn({ messageId: msg.id, err }, '[ai-dispatch] Erro transitorio — re-enfileirando')
          continue
        }
        log.error({ messageId: msg.id, err }, '[ai-dispatch] Erro permanente — marcando failed')
        failed++
      }

      if (outcome === 'sent' || outcome === 'failed') {
        await markAiMessageDispatched(client, msg.id, { status: outcome, provider_message_id: providerMessageId })
      }
    }

    log.info({ sent, failed, total: messages.length }, '[ai-dispatch] Ciclo concluido')
    return NextResponse.json({ sent, failed, total: messages.length }, { status: 200 })
  } finally {
    client.release()
  }
}

// Allow Vercel Cron to invoke via GET as well
export { POST as GET }

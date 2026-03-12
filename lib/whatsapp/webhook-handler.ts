// ---------------------------------------------------------------------------
// Webhook processing pipeline — provider-agnostic.
//
// Pipeline:
//   1. Look up channel by ID (confirms it belongs to the declared provider)
//   2. Decrypt credentials (needed for Meta HMAC verification)
//   3. Verify HMAC / API key signature → 401 on failure
//   4. Parse payload
//   5. Normalize to WhatsAppEvent
//   6. Idempotency check (provider, event_id) → return 200 if already seen
//   7. Mark event as seen
//   8. Process side-effects (e.g. update channel status on connection.update)
//   9. Return normalized event for caller (route can emit to queues/websockets)
// ---------------------------------------------------------------------------

import { decryptCredentials } from './crypto'
import { findChannelById, updateChannelStatus } from './channel-repo'
import { markEventSeen } from './webhook-repo'
import { getAdapter } from './adapters/factory'
import type { Provider, WhatsAppEvent, ChannelStatus } from './types'

export interface WebhookResult {
  /** true = processed for the first time; false = duplicate (idempotent skip) */
  processed: boolean
  event: WhatsAppEvent | null
}

export async function processWebhook(
  client: PoolClient,
  provider: Provider,
  channelId: string,
  headers: Headers,
  rawBody: string,
): Promise<WebhookResult> {
  // 1. Fetch channel (validates channelId exists + belongs to declared provider)
  const channel = await findChannelById(client, channelId)
  if (!channel) {
    throw new ChannelNotFoundError(channelId)
  }
  if (channel.provider !== provider) {
    throw new ProviderMismatchError(channelId, provider, channel.provider)
  }

  // 2. Decrypt credentials (needed for Meta HMAC; no-op cost for Evolution/UAZAPI)
  const creds = decryptCredentials(channel.credentials_encrypted)

  // 3. Verify signature
  const adapter = getAdapter(provider)
  const valid = adapter.verifyWebhookSignature(channel, creds, headers, rawBody)
  if (!valid) {
    throw new SignatureInvalidError()
  }

  // 4. Parse payload (rawBody already verified by HMAC)
  let payload: unknown
  try {
    payload = JSON.parse(rawBody)
  } catch {
    throw new Error('Webhook body não é JSON valido')
  }

  // 5. Normalize to internal event
  const partial = adapter.normalizeEvent(payload)
  const event: WhatsAppEvent = {
    ...partial,
    channel_id: channelId,
    provider,
  }

  // 6. Idempotency gate — INSERT ... ON CONFLICT DO NOTHING eliminates TOCTOU race
  const inserted = await markEventSeen(client, provider, event.event_id, channelId)
  if (!inserted) {
    return { processed: false, event: null }
  }

  // 8. Side-effects based on event type
  if (event.type === 'connection.update') {
    const stateMap: Record<string, ChannelStatus> = {
      open: 'CONNECTED',
      connecting: 'CONNECTING',
      close: 'DISCONNECTED',
      connected: 'CONNECTED',
      disconnected: 'DISCONNECTED',
      qr: 'PENDING_QR',
    }
    const rawState = String(event.payload.state ?? event.payload.status ?? '')
    const newStatus = stateMap[rawState.toLowerCase()] ?? channel.status
    if (newStatus !== channel.status) {
      await updateChannelStatus(client, channelId, newStatus, {
        last_seen_at: event.timestamp,
      })
    }
  }

  if (event.type === 'qr.updated') {
    await updateChannelStatus(client, channelId, 'PENDING_QR', {
      last_seen_at: event.timestamp,
    })
  }

  return { processed: true, event }
}

// ---------------------------------------------------------------------------
// Domain errors — let routes translate to appropriate HTTP status codes
// ---------------------------------------------------------------------------

export class ChannelNotFoundError extends Error {
  constructor(channelId: string) {
    super(`Canal nao encontrado: ${channelId}`)
    this.name = 'ChannelNotFoundError'
  }
}

export class ProviderMismatchError extends Error {
  constructor(channelId: string, expected: string, actual: string) {
    super(
      `Canal ${channelId} pertence ao provider ${actual}, nao ${expected}`,
    )
    this.name = 'ProviderMismatchError'
  }
}

export class SignatureInvalidError extends Error {
  constructor() {
    super('Assinatura do webhook inválida ou ausente')
    this.name = 'SignatureInvalidError'
  }
}

// ---------------------------------------------------------------------------
// Inbound message handler — persists message + triggers AI when enabled
// ---------------------------------------------------------------------------

import { upsertConversation, incrementUnread } from './conversation-repo'
import { insertMessage } from './message-repo'
import { routeInboundToAi } from './ai-inbox-agent'
import type { PoolClient } from 'pg'

/**
 * Handles a normalized 'message.received' event:
 *   1. Upserts the conversation (one per channel+contact_phone pair)
 *   2. Increments unread counter
 *   3. Persists the inbound message row
 *   4. If ai_enabled on the conversation, routes body to the AI agent
 *   5. If AI replies, persists the outbound AI message row
 *
 * This function does NOT send the WhatsApp reply — the caller is responsible
 * for calling the adapter's sendMessage() after checking result.shouldReply.
 */
export async function handleInboundMessage(
  client: PoolClient,
  event: WhatsAppEvent,
  channel: { id: string; workspace_id: string; ai_enabled?: boolean },
): Promise<{
  conversation_id: string
  message_id: string
  aiResult: import('./ai-inbox-agent').InboxAiResult | null
}> {
  const payload = event.payload as {
    from?: string
    contact_name?: string
    message_id?: string
    message_type?: string
    body?: string
    media_url?: string
    media_id?: string
    mime_type?: string
    filename?: string
    media_size_bytes?: number
    reaction_to?: string
    emoji?: string
  }

  const contactPhone = String(payload.from ?? '')
  const contactName = payload.contact_name ? String(payload.contact_name) : null
  const providerMessageId = payload.message_id ? String(payload.message_id) : null
  const messageType = (payload.message_type ?? 'text') as import('./types').MessageType
  const body = payload.body ? String(payload.body) : null

  // 1. Upsert conversation
  const conversation = await upsertConversation(client, {
    channel_id: channel.id,
    workspace_id: channel.workspace_id,
    contact_phone: contactPhone,
    contact_name: contactName,
  })

  // 2. Increment unread counter
  await incrementUnread(client, conversation.id)

  // 3a. If inbound has a media_id, download from provider and upload to S3.
  //     Non-fatal: if download/upload fails, message is still saved without S3 key.
  let mediaS3Key: string | null = null
  let mediaMime: string | null = payload.mime_type ?? null
  let mediaFilename: string | null = payload.filename ?? null
  const mediaSizeBytes: number | null = payload.media_size_bytes ?? null

  if (payload.media_id) {
    try {
      const { findChannelById: findCh } = await import('./channel-repo')
      const { decryptCredentials: decrypt } = await import('./crypto')
      const { getAdapter: getAdapterFn } = await import('./adapters/factory')
      const { uploadMedia: uploadFn } = await import('./media')

      const fullChannel = await findCh(client, channel.id)
      if (fullChannel) {
        const creds = decrypt(fullChannel.credentials_encrypted)
        const adapter = getAdapterFn(fullChannel.provider)
        const downloaded = await adapter.downloadMedia(fullChannel, creds, String(payload.media_id))
        const { s3Key } = await uploadFn(downloaded.buffer, downloaded.mime, downloaded.filename, channel.id)
        mediaS3Key = s3Key
        mediaMime = downloaded.mime
        mediaFilename = downloaded.filename
      }
    } catch {
      // Non-fatal: media download/upload failed; message saved without S3 key
    }
  }

  // 3. Persist inbound message
  const message = await insertMessage(client, {
    conversation_id: conversation.id,
    channel_id: channel.id,
    provider_message_id: providerMessageId,
    direction: 'inbound',
    message_type: messageType,
    status: 'delivered',
    body,
    media_s3_key: mediaS3Key,
    media_mime_type: mediaMime,
    media_filename: mediaFilename,
    media_size_bytes: mediaSizeBytes,
    reaction_to_msg_id: payload.reaction_to ?? null,
    sent_by: 'webhook',
    raw_event: event.payload as Record<string, unknown>,
  })

  // 4. AI routing — only if conversation has ai_enabled and there is a text body
  let aiResult: import('./ai-inbox-agent').InboxAiResult | null = null
  if (conversation.ai_enabled && body && body.trim().length > 0) {
    const { findChannelById } = await import('./channel-repo')
    const fullChannel = await findChannelById(client, channel.id)
    if (fullChannel) {
      try {
        aiResult = await routeInboundToAi(
          {
            body,
            from: contactPhone,
            conversation_id: conversation.id,
          },
          fullChannel,
        )

        // 5. If AI decided to reply, persist outbound AI message
        if (aiResult.shouldReply && aiResult.replyText) {
          await insertMessage(client, {
            conversation_id: conversation.id,
            channel_id: channel.id,
            direction: 'outbound',
            message_type: 'text',
            status: 'queued',
            body: aiResult.replyText,
            sent_by: 'ai',
            ai_decision_log: aiResult.decisionLog,
          })
        }
      } catch {
        // AI routing is non-fatal — inbound message was already saved above.
        // The conversation is preserved even if the AI fails.
        aiResult = null
      }
    }
  }

  return {
    conversation_id: conversation.id,
    message_id: message.id,
    aiResult,
  }
}

// ---------------------------------------------------------------------------
// Status update handler — maps provider delivery/read receipts to DB
// ---------------------------------------------------------------------------

import { updateMessageStatus } from './message-repo'
import {
  updateRecipientStatusByProviderMessageId,
  markRecipientDeliveredByProviderMessageId,
} from '@/lib/campaign-repo'
import type { MessageStatus } from './types'

/**
 * Handles 'message.delivered', 'message.read', 'message.sent', and
 * 'message.failed' events.
 *
 * Side-effects (all idempotent):
 *   1. Updates the status column of the matching outbound message row.
 *   2. 'message.failed' → transitions campaign recipient from 'sent' → 'failed'
 *      and adjusts campaign counters (sent_count -1, failed_count +1).
 *   3. 'message.delivered' / 'message.read' → stamps delivered_at on the campaign
 *      recipient so the delivery watchdog will NOT time it out later.
 *      The recipient status stays 'sent' (campaign tracks "accepted by provider").
 *
 * Returns true if a message row was updated, false if not found.
 */
export async function handleStatusUpdate(
  client: PoolClient,
  event: WhatsAppEvent,
  channel: { id: string },
): Promise<boolean> {
  const payload = event.payload as {
    message_id?: string
    status?: string
    error_reason?: string | null
  }

  const providerMessageId = payload.message_id ? String(payload.message_id) : null
  if (!providerMessageId) return false

  const statusMap: Record<string, MessageStatus> = {
    'message.sent':      'sent',
    'message.delivered': 'delivered',
    'message.read':      'read',
    'message.failed':    'failed',
  }

  const newStatus = statusMap[event.type]
  if (!newStatus) return false

  const updated = await updateMessageStatus(client, {
    channel_id: channel.id,
    provider_message_id: providerMessageId,
    status: newStatus,
  })

  if (newStatus === 'failed') {
    // Reconcile: recipient moves to failed, counters adjusted atomically.
    const errorReason = payload.error_reason ? String(payload.error_reason) : 'Falha reportada pelo provider'
    await updateRecipientStatusByProviderMessageId(
      client,
      channel.id,
      providerMessageId,
      'failed',
      errorReason,
    )
  } else if (newStatus === 'delivered' || newStatus === 'read') {
    // Stamp delivered_at so the delivery watchdog skips this recipient.
    // Recipient status remains 'sent' — no DB CHECK constraint change needed.
    await markRecipientDeliveredByProviderMessageId(client, channel.id, providerMessageId)
  }

  return updated
}

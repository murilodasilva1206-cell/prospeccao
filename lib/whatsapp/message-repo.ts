// ---------------------------------------------------------------------------
// Message repository — DB operations for the messages table
// ---------------------------------------------------------------------------

import type { PoolClient } from 'pg'
import type { Message, MessageType, MessageDirection, MessageStatus } from './types'

export interface CreateMessageInput {
  conversation_id: string
  channel_id: string
  provider_message_id?: string | null
  direction: MessageDirection
  message_type: MessageType
  status?: MessageStatus
  body?: string | null
  media_s3_key?: string | null
  media_mime_type?: string | null
  media_filename?: string | null
  media_size_bytes?: number | null
  reaction_to_msg_id?: string | null
  sent_by: string
  ai_decision_log?: Record<string, unknown> | null
  raw_event?: Record<string, unknown> | null
}

export interface UpdateMessageStatusInput {
  channel_id: string
  provider_message_id: string
  status: MessageStatus
}

export interface FindMessagesOptions {
  limit?: number
  before?: string  // cursor: message ID — fetch messages older than this
}

/**
 * Inserts a new message row.
 */
export async function insertMessage(
  client: PoolClient,
  input: CreateMessageInput,
): Promise<Message> {
  const result = await client.query<Message>(
    `INSERT INTO messages (
       conversation_id, channel_id, provider_message_id,
       direction, message_type, status, body,
       media_s3_key, media_mime_type, media_filename, media_size_bytes,
       reaction_to_msg_id, sent_by, ai_decision_log, raw_event
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING id, conversation_id, channel_id, provider_message_id,
               direction, message_type, status, body,
               media_s3_key, media_mime_type, media_filename, media_size_bytes,
               reaction_to_msg_id, sent_by, ai_decision_log, raw_event,
               created_at, updated_at`,
    [
      input.conversation_id,
      input.channel_id,
      input.provider_message_id ?? null,
      input.direction,
      input.message_type,
      input.status ?? 'queued',
      input.body ?? null,
      input.media_s3_key ?? null,
      input.media_mime_type ?? null,
      input.media_filename ?? null,
      input.media_size_bytes ?? null,
      input.reaction_to_msg_id ?? null,
      input.sent_by,
      input.ai_decision_log ? JSON.stringify(input.ai_decision_log) : null,
      input.raw_event ? JSON.stringify(input.raw_event) : null,
    ],
  )
  return result.rows[0]
}

/**
 * Updates the status of an outbound message when the provider reports delivery/read.
 * Matches by channel_id + provider_message_id.
 */
export async function updateMessageStatus(
  client: PoolClient,
  input: UpdateMessageStatusInput,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE messages SET status = $1, updated_at = NOW()
     WHERE channel_id = $2 AND provider_message_id = $3`,
    [input.status, input.channel_id, input.provider_message_id],
  )
  return (result.rowCount ?? 0) > 0
}

/**
 * Lists messages in a conversation, oldest-first (thread view).
 * Supports cursor-based pagination via 'before' (message ID).
 */
export async function findMessagesByConversation(
  client: PoolClient,
  conversation_id: string,
  options: FindMessagesOptions = {},
): Promise<Message[]> {
  const limit = options.limit ?? 50
  const params: unknown[] = [conversation_id, limit]
  let cursorClause = ''

  if (options.before) {
    // Fetch messages older than the 'before' message (created_at < cursor's created_at)
    params.push(options.before)
    cursorClause = `AND m.created_at < (
      SELECT created_at FROM messages WHERE id = $${params.length}
    )`
  }

  const result = await client.query<Message>(
    `SELECT m.id, m.conversation_id, m.channel_id, m.provider_message_id,
            m.direction, m.message_type, m.status, m.body,
            m.media_s3_key, m.media_mime_type, m.media_filename, m.media_size_bytes,
            m.reaction_to_msg_id, m.sent_by, m.ai_decision_log, m.raw_event,
            m.created_at, m.updated_at
     FROM messages m
     WHERE m.conversation_id = $1 ${cursorClause}
     ORDER BY m.created_at ASC
     LIMIT $2`,
    params,
  )
  return result.rows
}

export interface AiQueuedMessage {
  id: string
  conversation_id: string
  channel_id: string
  body: string | null
  ai_decision_log: Record<string, unknown> | null
}

/**
 * Atomically claims up to `limit` AI-authored queued messages for dispatch.
 * Uses FOR UPDATE SKIP LOCKED to prevent duplicate sends across concurrent cron runs.
 * Transitions status queued → sending while claiming.
 */
export async function claimAiQueuedMessages(
  client: PoolClient,
  limit = 10,
): Promise<AiQueuedMessage[]> {
  const result = await client.query<AiQueuedMessage>(
    `WITH claimed AS (
       SELECT id FROM messages
       WHERE sent_by = 'ai' AND status = 'queued'
       ORDER BY created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE messages SET status = 'sending', updated_at = NOW()
     FROM claimed
     WHERE messages.id = claimed.id
     RETURNING messages.id, messages.conversation_id, messages.channel_id,
               messages.body, messages.ai_decision_log`,
    [limit],
  )
  return result.rows
}

/**
 * Marks a dispatched AI message as sent (provider accepted) or failed.
 */
export async function markAiMessageDispatched(
  client: PoolClient,
  messageId: string,
  outcome: { status: 'sent' | 'failed'; provider_message_id?: string | null },
): Promise<void> {
  await client.query(
    `UPDATE messages SET status = $1, provider_message_id = $2, updated_at = NOW()
     WHERE id = $3`,
    [outcome.status, outcome.provider_message_id ?? null, messageId],
  )
}

/** Fetches a single message by ID. */
export async function findMessageById(client: PoolClient, id: string): Promise<Message | null> {
  const result = await client.query<Message>(
    `SELECT id, conversation_id, channel_id, provider_message_id,
            direction, message_type, status, body,
            media_s3_key, media_mime_type, media_filename, media_size_bytes,
            reaction_to_msg_id, sent_by, ai_decision_log, raw_event,
            created_at, updated_at
     FROM messages WHERE id = $1`,
    [id],
  )
  return result.rows[0] ?? null
}

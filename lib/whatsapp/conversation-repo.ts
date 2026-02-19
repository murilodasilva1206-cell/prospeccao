// ---------------------------------------------------------------------------
// Conversation repository — DB operations for the conversations table
// ---------------------------------------------------------------------------

import type { PoolClient } from 'pg'
import type { Conversation } from './types'

export interface UpsertConversationInput {
  channel_id: string
  workspace_id: string
  contact_phone: string
  contact_name?: string | null
}

export interface FindConversationsOptions {
  limit?: number
  offset?: number
  status?: 'open' | 'resolved' | 'ai_handled'
}

/**
 * Inserts a new conversation or updates contact_name and last_message_at if it already exists.
 * Ensures exactly one conversation per (channel_id, contact_phone) pair.
 */
export async function upsertConversation(
  client: PoolClient,
  input: UpsertConversationInput,
): Promise<Conversation> {
  const result = await client.query<Conversation>(
    `INSERT INTO conversations (channel_id, workspace_id, contact_phone, contact_name, last_message_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (channel_id, contact_phone) DO UPDATE SET
       contact_name    = COALESCE(EXCLUDED.contact_name, conversations.contact_name),
       last_message_at = NOW(),
       updated_at      = NOW()
     RETURNING id, channel_id, workspace_id, contact_phone, contact_name,
               status, last_message_at, unread_count, ai_enabled,
               created_at, updated_at`,
    [
      input.channel_id,
      input.workspace_id,
      input.contact_phone,
      input.contact_name ?? null,
    ],
  )
  return result.rows[0]
}

/**
 * Lists all conversations for a workspace, sorted by last_message_at DESC.
 */
export async function findConversationsByWorkspace(
  client: PoolClient,
  workspace_id: string,
  options: FindConversationsOptions = {},
): Promise<Conversation[]> {
  const limit = options.limit ?? 20
  const offset = options.offset ?? 0

  const params: unknown[] = [workspace_id, limit, offset]
  let statusClause = ''

  if (options.status) {
    params.push(options.status)
    statusClause = `AND status = $${params.length}`
  }

  const result = await client.query<Conversation>(
    `SELECT id, channel_id, workspace_id, contact_phone, contact_name,
            status, last_message_at, unread_count, ai_enabled,
            created_at, updated_at
     FROM conversations
     WHERE workspace_id = $1 ${statusClause}
     ORDER BY last_message_at DESC NULLS LAST
     LIMIT $2 OFFSET $3`,
    params,
  )
  return result.rows
}

/** Fetches a single conversation by ID. Returns null if not found. */
export async function findConversationById(
  client: PoolClient,
  id: string,
): Promise<Conversation | null> {
  const result = await client.query<Conversation>(
    `SELECT id, channel_id, workspace_id, contact_phone, contact_name,
            status, last_message_at, unread_count, ai_enabled,
            created_at, updated_at
     FROM conversations
     WHERE id = $1`,
    [id],
  )
  return result.rows[0] ?? null
}

/** Updates the status of a conversation. */
export async function updateConversationStatus(
  client: PoolClient,
  id: string,
  status: 'open' | 'resolved' | 'ai_handled',
): Promise<Conversation | null> {
  const result = await client.query<Conversation>(
    `UPDATE conversations SET status = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING id, channel_id, workspace_id, contact_phone, contact_name,
               status, last_message_at, unread_count, ai_enabled,
               created_at, updated_at`,
    [status, id],
  )
  return result.rows[0] ?? null
}

/** Updates the ai_enabled flag for a conversation. */
export async function updateConversationAiEnabled(
  client: PoolClient,
  id: string,
  ai_enabled: boolean,
): Promise<Conversation | null> {
  const result = await client.query<Conversation>(
    `UPDATE conversations SET ai_enabled = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING id, channel_id, workspace_id, contact_phone, contact_name,
               status, last_message_at, unread_count, ai_enabled,
               created_at, updated_at`,
    [ai_enabled, id],
  )
  return result.rows[0] ?? null
}

/** Increments the unread message counter for inbound messages. */
export async function incrementUnread(client: PoolClient, conversation_id: string): Promise<void> {
  await client.query(
    `UPDATE conversations SET unread_count = unread_count + 1, updated_at = NOW()
     WHERE id = $1`,
    [conversation_id],
  )
}

/** Resets the unread counter to 0 (when the inbox is opened). */
export async function markAllRead(client: PoolClient, conversation_id: string): Promise<void> {
  await client.query(
    `UPDATE conversations SET unread_count = 0, updated_at = NOW()
     WHERE id = $1`,
    [conversation_id],
  )
}

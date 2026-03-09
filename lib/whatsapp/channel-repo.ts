// ---------------------------------------------------------------------------
// Channel repository — all DB access for whatsapp_channels table.
// Only parameterized SQL ($N). Never interpolates user input into query text.
// ---------------------------------------------------------------------------

import type { PoolClient } from 'pg'
import type { Channel, ChannelStatus, Provider } from './types'

interface CreateChannelInput {
  workspace_id: string
  name: string
  provider: Provider
  credentials_encrypted: string
  webhook_secret: string
  phone_number?: string | null
}

function rowToChannel(row: Record<string, unknown>): Channel {
  return {
    id: row.id as string,
    workspace_id: row.workspace_id as string,
    name: row.name as string,
    provider: row.provider as Provider,
    status: row.status as ChannelStatus,
    phone_number: (row.phone_number as string | null) ?? null,
    external_instance_id: (row.external_instance_id as string | null) ?? null,
    credentials_encrypted: row.credentials_encrypted as string,
    webhook_secret: row.webhook_secret as string,
    last_seen_at: row.last_seen_at ? new Date(row.last_seen_at as string) : null,
    created_at: new Date(row.created_at as string),
    updated_at: new Date(row.updated_at as string),
  }
}

export async function createChannel(
  client: PoolClient,
  input: CreateChannelInput,
): Promise<Channel> {
  const { rows } = await client.query(
    `INSERT INTO whatsapp_channels
       (workspace_id, name, provider, credentials_encrypted, webhook_secret, phone_number)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      input.workspace_id,
      input.name,
      input.provider,
      input.credentials_encrypted,
      input.webhook_secret,
      input.phone_number ?? null,
    ],
  )
  return rowToChannel(rows[0])
}

export async function findChannelById(
  client: PoolClient,
  id: string,
): Promise<Channel | null> {
  const { rows } = await client.query(
    'SELECT * FROM whatsapp_channels WHERE id = $1',
    [id],
  )
  return rows.length > 0 ? rowToChannel(rows[0]) : null
}

export async function findChannelsByWorkspace(
  client: PoolClient,
  workspace_id: string,
): Promise<Channel[]> {
  const { rows } = await client.query(
    'SELECT * FROM whatsapp_channels WHERE workspace_id = $1 ORDER BY created_at DESC',
    [workspace_id],
  )
  return rows.map(rowToChannel)
}

export async function updateChannelStatus(
  client: PoolClient,
  id: string,
  status: ChannelStatus,
  extra: {
    phone_number?: string | null
    external_instance_id?: string | null
    last_seen_at?: Date | null
  } = {},
): Promise<Channel | null> {
  const { rows } = await client.query(
    `UPDATE whatsapp_channels
     SET status               = $2,
         phone_number         = COALESCE($3, phone_number),
         external_instance_id = COALESCE($4, external_instance_id),
         last_seen_at         = COALESCE($5, last_seen_at)
     WHERE id = $1
     RETURNING *`,
    [
      id,
      status,
      extra.phone_number ?? null,
      extra.external_instance_id ?? null,
      extra.last_seen_at ?? null,
    ],
  )
  return rows.length > 0 ? rowToChannel(rows[0]) : null
}

interface UpdateChannelConfigInput {
  name?: string
  phone_number?: string | null
  credentials_encrypted?: string
  external_instance_id?: string | null
}

export async function updateChannelConfig(
  client: PoolClient,
  id: string,
  updates: UpdateChannelConfigInput,
): Promise<Channel | null> {
  const sets: string[] = []
  const values: unknown[] = [id] // $1 = id (always in WHERE clause)

  if (updates.name !== undefined) {
    values.push(updates.name)
    sets.push(`name = $${values.length}`)
  }
  if ('phone_number' in updates) {
    values.push(updates.phone_number ?? null)
    sets.push(`phone_number = $${values.length}`)
  }
  if (updates.credentials_encrypted !== undefined) {
    values.push(updates.credentials_encrypted)
    sets.push(`credentials_encrypted = $${values.length}`)
  }
  if ('external_instance_id' in updates) {
    values.push(updates.external_instance_id ?? null)
    sets.push(`external_instance_id = $${values.length}`)
  }

  if (sets.length === 0) {
    // Nothing to update — return the current row unchanged
    return findChannelById(client, id)
  }

  const { rows } = await client.query(
    `UPDATE whatsapp_channels SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
    values,
  )
  return rows.length > 0 ? rowToChannel(rows[0]) : null
}

export async function deleteChannel(
  client: PoolClient,
  id: string,
): Promise<boolean> {
  const { rowCount } = await client.query(
    'DELETE FROM whatsapp_channels WHERE id = $1',
    [id],
  )
  return (rowCount ?? 0) > 0
}

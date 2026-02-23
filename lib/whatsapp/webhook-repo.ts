// ---------------------------------------------------------------------------
// Webhook events repository — idempotency for incoming provider webhooks.
//
// Strategy: INSERT ... ON CONFLICT DO NOTHING
// If the event_id was already seen (provider retry), the INSERT is a no-op
// and isEventSeen() returns true, telling the handler to skip reprocessing.
// ---------------------------------------------------------------------------

import type { PoolClient } from 'pg'
import type { Provider } from './types'

/**
 * Returns true if this (provider, event_id) pair was already processed.
 * Uses a SELECT for a clean boolean check before attempting INSERT.
 */
export async function isEventSeen(
  client: PoolClient,
  provider: Provider,
  eventId: string,
): Promise<boolean> {
  const { rows } = await client.query(
    'SELECT 1 FROM webhook_events WHERE provider = $1 AND event_id = $2 LIMIT 1',
    [provider, eventId],
  )
  return rows.length > 0
}

/**
 * Records the event as processed.
 * Uses INSERT ... ON CONFLICT DO NOTHING to be safe against races.
 * Returns true if the record was inserted (first time), false if it already existed.
 */
export async function markEventSeen(
  client: PoolClient,
  provider: Provider,
  eventId: string,
  channelId: string,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `INSERT INTO webhook_events (provider, event_id, channel_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (provider, event_id) DO NOTHING`,
    [provider, eventId, channelId],
  )
  return (rowCount ?? 0) > 0
}

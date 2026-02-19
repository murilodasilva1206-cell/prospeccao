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

import type { PoolClient } from 'pg'
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
    throw new Error('Webhook body nao e JSON valido')
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
    super('Assinatura do webhook invalida ou ausente')
    this.name = 'SignatureInvalidError'
  }
}

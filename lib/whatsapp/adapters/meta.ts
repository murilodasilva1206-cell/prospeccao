// ---------------------------------------------------------------------------
// Meta Cloud API adapter
//
// Connection flow: token-based (no QR).
//   createChannel() → validates token via Graph API
//   startConnection() → channel goes CONNECTED immediately if token valid
//
// Webhook verification: HMAC-SHA256(rawBody, app_secret) vs X-Hub-Signature-256
//
// Graph API docs: https://developers.facebook.com/docs/whatsapp/cloud-api
// ---------------------------------------------------------------------------

import { createHash, createHmac } from 'crypto'
import { safeCompare } from '../crypto'

function stableId(...parts: string[]): string {
  return createHash('sha256').update(parts.join('::')).digest('hex').slice(0, 32)
}
import type { IWhatsAppAdapter, ConnectResult, SendResult } from './interface'
import type { Channel, ChannelCredentials, ChannelStatus, WhatsAppEvent } from '../types'

const GRAPH_API_VERSION = 'v18.0'
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`

type MetaMessageEntry = {
  id?: string
  from?: string
  type?: string
  timestamp?: string
  text?: { body?: string }
  status?: string
  statuses?: Array<{ id?: string; status?: string; timestamp?: string }>
  messages?: Array<{
    id?: string
    from?: string
    type?: string
    timestamp?: string
    text?: { body?: string }
  }>
}

export class MetaAdapter implements IWhatsAppAdapter {
  async createChannel(
    _channel: Channel,
    creds: ChannelCredentials,
  ): Promise<{ external_instance_id: string }> {
    if (!creds.access_token || !creds.phone_number_id) {
      throw new Error('Meta adapter requer access_token e phone_number_id')
    }

    // Validate token by fetching phone number metadata from Graph API
    const res = await fetch(
      `${GRAPH_BASE}/${creds.phone_number_id}?fields=id,display_phone_number`,
      {
        headers: { Authorization: `Bearer ${creds.access_token}` },
      },
    )

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(
        `Meta Graph API retornou ${res.status} ao validar phone_number_id: ${body}`,
      )
    }

    const data = (await res.json()) as { id?: string; display_phone_number?: string }
    if (!data.id) {
      throw new Error('Meta Graph API nao retornou ID para o phone_number_id informado')
    }

    return { external_instance_id: data.id }
  }

  async startConnection(
    _channel: Channel,
    creds: ChannelCredentials,
  ): Promise<ConnectResult> {
    if (!creds.access_token || !creds.phone_number_id) {
      throw new Error('Meta adapter requer access_token e phone_number_id')
    }

    // Validate token is still active
    const res = await fetch(
      `${GRAPH_BASE}/${creds.phone_number_id}?fields=id,display_phone_number`,
      {
        headers: { Authorization: `Bearer ${creds.access_token}` },
      },
    )

    if (!res.ok) {
      return { status: 'ERROR' }
    }

    const data = (await res.json()) as { id?: string; display_phone_number?: string }
    return {
      status: 'CONNECTED',
      phone_number: data.display_phone_number,
      external_instance_id: data.id,
    }
  }

  async getConnectionStatus(
    _channel: Channel,
    creds: ChannelCredentials,
  ): Promise<ChannelStatus> {
    if (!creds.access_token || !creds.phone_number_id) return 'ERROR'

    const res = await fetch(
      `${GRAPH_BASE}/${creds.phone_number_id}?fields=id`,
      {
        headers: { Authorization: `Bearer ${creds.access_token}` },
      },
    )
    return res.ok ? 'CONNECTED' : 'ERROR'
  }

  async disconnect(
    _channel: Channel,
    _creds: ChannelCredentials,
  ): Promise<void> {
    // Meta does not have a server-side "logout" — simply clearing credentials
    // on our side is sufficient. No API call needed.
  }

  async sendMessage(
    _channel: Channel,
    creds: ChannelCredentials,
    to: string,
    text: string,
  ): Promise<SendResult> {
    if (!creds.access_token || !creds.phone_number_id) {
      throw new Error('Meta adapter requer access_token e phone_number_id')
    }

    const res = await fetch(
      `${GRAPH_BASE}/${creds.phone_number_id}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${creds.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { body: text },
        }),
      },
    )

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Meta sendMessage falhou (${res.status}): ${body}`)
    }

    const data = (await res.json()) as { messages?: Array<{ id?: string }> }
    const messageId = data.messages?.[0]?.id
    if (!messageId) throw new Error('Meta nao retornou message_id na resposta de envio')

    return { message_id: messageId }
  }

  verifyWebhookSignature(
    _channel: Channel,
    creds: ChannelCredentials,
    headers: Headers,
    rawBody: string,
  ): boolean {
    // Meta sends: X-Hub-Signature-256: sha256=<hmac>
    const signature = headers.get('x-hub-signature-256')
    if (!signature || !creds.app_secret) return false

    const expected =
      'sha256=' + createHmac('sha256', creds.app_secret).update(rawBody).digest('hex')

    return safeCompare(signature, expected)
  }

  normalizeEvent(
    rawPayload: unknown,
  ): Omit<WhatsAppEvent, 'channel_id' | 'provider'> {
    const payload = rawPayload as {
      entry?: Array<{
        changes?: Array<{
          value?: {
            messages?: MetaMessageEntry[]
            statuses?: MetaMessageEntry[]
            metadata?: { phone_number_id?: string }
          }
        }>
      }>
    }

    const change = payload.entry?.[0]?.changes?.[0]?.value
    const message = change?.messages?.[0]
    const statusEntry = change?.statuses?.[0] as
      | { id?: string; status?: string; timestamp?: string }
      | undefined

    if (message) {
      const eventType =
        message.type === 'text' ? 'message.received' : 'message.received'
      return {
        type: eventType,
        event_id: message.id ?? stableId('meta', 'message', message.from ?? '', message.timestamp ?? '', JSON.stringify(rawPayload)),
        timestamp: message.timestamp
          ? new Date(Number(message.timestamp) * 1000)
          : new Date(),
        payload: {
          from: message.from,
          message_id: message.id,
          type: message.type,
          text: message.text?.body,
        },
      }
    }

    if (statusEntry) {
      const typeMap: Record<string, WhatsAppEvent['type']> = {
        sent: 'message.sent',
        delivered: 'message.delivered',
        read: 'message.read',
      }
      return {
        type: typeMap[statusEntry.status ?? ''] ?? 'message.sent',
        event_id: `${statusEntry.id ?? ''}-${statusEntry.status ?? ''}`,
        timestamp: statusEntry.timestamp
          ? new Date(Number(statusEntry.timestamp) * 1000)
          : new Date(),
        payload: {
          message_id: statusEntry.id,
          status: statusEntry.status,
        },
      }
    }

    // Fallback: unknown event structure
    return {
      type: 'connection.update',
      event_id: stableId('meta', 'unknown', JSON.stringify(rawPayload)),
      timestamp: new Date(),
      payload: { raw: rawPayload },
    }
  }
}

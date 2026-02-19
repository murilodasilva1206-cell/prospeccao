// ---------------------------------------------------------------------------
// UAZAPI adapter
//
// Connection flow: QR-based (similar to Evolution).
//   createChannel() → POST /instance/init
//   startConnection() → GET /instance/qrcode
//   getConnectionStatus() → GET /instance/status
//   disconnect() → POST /instance/logout
//
// Webhook verification: compare Authorization header with channel.webhook_secret
//
// UAZAPI docs: https://uazapi.com/docs
// ---------------------------------------------------------------------------

import { createHash } from 'crypto'
import { safeCompare } from '../crypto'

function stableId(...parts: string[]): string {
  return createHash('sha256').update(parts.join('::')).digest('hex').slice(0, 32)
}
import type { IWhatsAppAdapter, ConnectResult, SendResult } from './interface'
import type { Channel, ChannelCredentials, ChannelStatus, WhatsAppEvent } from '../types'

export class UazapiAdapter implements IWhatsAppAdapter {
  private base(creds: ChannelCredentials): string {
    if (!creds.instance_url) throw new Error('UAZAPI adapter requer instance_url')
    return creds.instance_url.replace(/\/$/, '')
  }

  private headers(creds: ChannelCredentials): Record<string, string> {
    return {
      Authorization: `Bearer ${creds.api_key ?? ''}`,
      'Content-Type': 'application/json',
    }
  }

  async createChannel(
    channel: Channel,
    creds: ChannelCredentials,
  ): Promise<{ external_instance_id: string }> {
    if (!creds.api_key || !creds.instance_url) {
      throw new Error('UAZAPI adapter requer api_key e instance_url')
    }

    const instanceName = `prospeccao-${channel.id.slice(0, 8)}`

    const res = await fetch(`${this.base(creds)}/instance/init`, {
      method: 'POST',
      headers: this.headers(creds),
      body: JSON.stringify({ name: instanceName }),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`UAZAPI createChannel falhou (${res.status}): ${body}`)
    }

    const data = (await res.json()) as { name?: string; id?: string }
    const id = data.id ?? data.name ?? instanceName
    return { external_instance_id: id }
  }

  async startConnection(
    channel: Channel,
    creds: ChannelCredentials,
  ): Promise<ConnectResult> {
    const instanceId = channel.external_instance_id
    if (!instanceId) throw new Error('external_instance_id nao definido — chame createChannel primeiro')

    const res = await fetch(
      `${this.base(creds)}/instance/qrcode?id=${encodeURIComponent(instanceId)}`,
      { headers: this.headers(creds) },
    )

    if (!res.ok) return { status: 'ERROR' }

    const data = (await res.json()) as { qrcode?: string; base64?: string }
    const qr = data.qrcode ?? data.base64

    return {
      status: qr ? 'PENDING_QR' : 'CONNECTING',
      qr_code: qr,
      external_instance_id: instanceId,
    }
  }

  async getConnectionStatus(
    channel: Channel,
    creds: ChannelCredentials,
  ): Promise<ChannelStatus> {
    const instanceId = channel.external_instance_id
    if (!instanceId) return 'DISCONNECTED'

    const res = await fetch(
      `${this.base(creds)}/instance/status?id=${encodeURIComponent(instanceId)}`,
      { headers: this.headers(creds) },
    )

    if (!res.ok) return 'ERROR'

    const data = (await res.json()) as { status?: string; connected?: boolean }

    if (data.connected === true) return 'CONNECTED'

    const statusMap: Record<string, ChannelStatus> = {
      connected: 'CONNECTED',
      connecting: 'CONNECTING',
      disconnected: 'DISCONNECTED',
      qr: 'PENDING_QR',
    }
    return statusMap[data.status ?? ''] ?? 'ERROR'
  }

  async disconnect(channel: Channel, creds: ChannelCredentials): Promise<void> {
    const instanceId = channel.external_instance_id
    if (!instanceId) return

    await fetch(`${this.base(creds)}/instance/logout`, {
      method: 'POST',
      headers: this.headers(creds),
      body: JSON.stringify({ id: instanceId }),
    }).catch(() => {
      // Best-effort — channel might already be disconnected
    })
  }

  async sendMessage(
    channel: Channel,
    creds: ChannelCredentials,
    to: string,
    text: string,
  ): Promise<SendResult> {
    const instanceId = channel.external_instance_id
    if (!instanceId) throw new Error('Canal nao possui external_instance_id')

    const res = await fetch(`${this.base(creds)}/message/send`, {
      method: 'POST',
      headers: this.headers(creds),
      body: JSON.stringify({ id: instanceId, phone: to, message: text }),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`UAZAPI sendMessage falhou (${res.status}): ${body}`)
    }

    const data = (await res.json()) as { id?: string; messageId?: string }
    const messageId = data.id ?? data.messageId
    if (!messageId) throw new Error('UAZAPI nao retornou id na resposta de envio')

    return { message_id: messageId }
  }

  verifyWebhookSignature(
    channel: Channel,
    _creds: ChannelCredentials,
    headers: Headers,
    _rawBody: string,
  ): boolean {
    // UAZAPI sends the secret in the Authorization header as Bearer token
    const auth = headers.get('authorization') ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth
    return safeCompare(token, channel.webhook_secret)
  }

  normalizeEvent(
    rawPayload: unknown,
  ): Omit<WhatsAppEvent, 'channel_id' | 'provider'> {
    const payload = rawPayload as {
      type?: string
      messageId?: string
      from?: string
      fromMe?: boolean
      body?: string
      status?: string
      qrcode?: string
    }

    const type = payload.type ?? ''

    if (type === 'message' || type === 'message.received') {
      return {
        type: payload.fromMe ? 'message.sent' : 'message.received',
        event_id: payload.messageId ?? stableId('uazapi', 'message', payload.from ?? '', JSON.stringify(rawPayload)),
        timestamp: new Date(),
        payload: {
          from: payload.from,
          message_id: payload.messageId,
          from_me: payload.fromMe,
          text: payload.body,
        },
      }
    }

    if (type === 'qr') {
      return {
        type: 'qr.updated',
        event_id: stableId('uazapi', 'qr', JSON.stringify(rawPayload)),
        timestamp: new Date(),
        payload: { qr_code: payload.qrcode },
      }
    }

    if (type === 'connection') {
      return {
        type: 'connection.update',
        event_id: stableId('uazapi', 'connection', payload.status ?? '', JSON.stringify(rawPayload)),
        timestamp: new Date(),
        payload: { status: payload.status },
      }
    }

    return {
      type: 'connection.update',
      event_id: stableId('uazapi', type, JSON.stringify(rawPayload)),
      timestamp: new Date(),
      payload: { raw_type: type, raw: rawPayload },
    }
  }
}

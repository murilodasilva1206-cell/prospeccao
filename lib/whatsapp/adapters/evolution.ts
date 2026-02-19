// ---------------------------------------------------------------------------
// Evolution API adapter
//
// Connection flow: QR-based.
//   createChannel() → POST /instance/create
//   startConnection() → GET /instance/connect/:name → returns QR → PENDING_QR
//   getConnectionStatus() → GET /instance/connectionState/:name
//   disconnect() → DELETE /instance/logout/:name
//
// Webhook verification: compare `apikey` request header with channel.webhook_secret
//
// Evolution API docs: https://doc.evolution-api.com
// ---------------------------------------------------------------------------

import { createHash } from 'crypto'
import { safeCompare } from '../crypto'

function stableId(...parts: string[]): string {
  return createHash('sha256').update(parts.join('::')).digest('hex').slice(0, 32)
}
import type { IWhatsAppAdapter, ConnectResult, SendResult } from './interface'
import type { Channel, ChannelCredentials, ChannelStatus, WhatsAppEvent } from '../types'

export class EvolutionAdapter implements IWhatsAppAdapter {
  private base(creds: ChannelCredentials): string {
    if (!creds.instance_url) throw new Error('Evolution adapter requer instance_url')
    return creds.instance_url.replace(/\/$/, '')
  }

  private headers(creds: ChannelCredentials): Record<string, string> {
    return {
      apikey: creds.api_key ?? '',
      'Content-Type': 'application/json',
    }
  }

  async createChannel(
    channel: Channel,
    creds: ChannelCredentials,
  ): Promise<{ external_instance_id: string }> {
    if (!creds.api_key || !creds.instance_url) {
      throw new Error('Evolution adapter requer api_key e instance_url')
    }

    const instanceName = `prospeccao-${channel.id.slice(0, 8)}`

    const res = await fetch(`${this.base(creds)}/instance/create`, {
      method: 'POST',
      headers: this.headers(creds),
      body: JSON.stringify({
        instanceName,
        qrcode: true,
        integration: 'WHATSAPP-BAILEYS',
        webhook: {
          enabled: false, // webhook URL is managed externally via our endpoint
        },
      }),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Evolution createChannel falhou (${res.status}): ${body}`)
    }

    const data = (await res.json()) as { instance?: { instanceName?: string } }
    const name = data.instance?.instanceName ?? instanceName
    return { external_instance_id: name }
  }

  async startConnection(
    channel: Channel,
    creds: ChannelCredentials,
  ): Promise<ConnectResult> {
    const instanceName = channel.external_instance_id
    if (!instanceName) throw new Error('external_instance_id nao definido — chame createChannel primeiro')

    const res = await fetch(
      `${this.base(creds)}/instance/connect/${instanceName}`,
      { headers: this.headers(creds) },
    )

    if (!res.ok) {
      return { status: 'ERROR' }
    }

    const data = (await res.json()) as {
      base64?: string
      qrcode?: { base64?: string }
      code?: string
    }
    const qr = data.base64 ?? data.qrcode?.base64

    return {
      status: qr ? 'PENDING_QR' : 'CONNECTING',
      qr_code: qr,
      external_instance_id: instanceName,
    }
  }

  async getConnectionStatus(
    channel: Channel,
    creds: ChannelCredentials,
  ): Promise<ChannelStatus> {
    const instanceName = channel.external_instance_id
    if (!instanceName) return 'DISCONNECTED'

    const res = await fetch(
      `${this.base(creds)}/instance/connectionState/${instanceName}`,
      { headers: this.headers(creds) },
    )

    if (!res.ok) return 'ERROR'

    const data = (await res.json()) as { instance?: { state?: string } }
    const state = data.instance?.state ?? ''

    const statusMap: Record<string, ChannelStatus> = {
      open: 'CONNECTED',
      connecting: 'CONNECTING',
      close: 'DISCONNECTED',
    }
    // eslint-disable-next-line security/detect-object-injection
    return statusMap[state] ?? 'ERROR'
  }

  async disconnect(channel: Channel, creds: ChannelCredentials): Promise<void> {
    const instanceName = channel.external_instance_id
    if (!instanceName) return

    await fetch(
      `${this.base(creds)}/instance/logout/${instanceName}`,
      { method: 'DELETE', headers: this.headers(creds) },
    ).catch(() => {
      // Best-effort — channel might already be disconnected
    })
  }

  async sendMessage(
    channel: Channel,
    creds: ChannelCredentials,
    to: string,
    text: string,
  ): Promise<SendResult> {
    const instanceName = channel.external_instance_id
    if (!instanceName) throw new Error('Canal nao possui external_instance_id')

    const res = await fetch(
      `${this.base(creds)}/message/sendText/${instanceName}`,
      {
        method: 'POST',
        headers: this.headers(creds),
        body: JSON.stringify({
          number: to,
          text,
        }),
      },
    )

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Evolution sendMessage falhou (${res.status}): ${body}`)
    }

    const data = (await res.json()) as { key?: { id?: string } }
    const messageId = data.key?.id
    if (!messageId) throw new Error('Evolution nao retornou key.id na resposta de envio')

    return { message_id: messageId }
  }

  verifyWebhookSignature(
    channel: Channel,
    _creds: ChannelCredentials,
    headers: Headers,
    _rawBody: string,
  ): boolean {
    // Evolution sends the API key in the `apikey` header
    const headerKey = headers.get('apikey') ?? ''
    return safeCompare(headerKey, channel.webhook_secret)
  }

  normalizeEvent(
    rawPayload: unknown,
  ): Omit<WhatsAppEvent, 'channel_id' | 'provider'> {
    const payload = rawPayload as {
      event?: string
      data?: {
        key?: { id?: string; remoteJid?: string; fromMe?: boolean }
        message?: { conversation?: string }
        qrcode?: { base64?: string }
        instance?: string
        state?: string
      }
    }

    const event = payload.event ?? ''
    const data = payload.data ?? {}

    if (event === 'messages.upsert') {
      const isOutbound = data.key?.fromMe === true
      return {
        type: isOutbound ? 'message.sent' : 'message.received',
        event_id: data.key?.id ?? stableId('evolution', 'messages.upsert', data.key?.remoteJid ?? '', JSON.stringify(rawPayload)),
        timestamp: new Date(),
        payload: {
          from: data.key?.remoteJid,
          message_id: data.key?.id,
          from_me: data.key?.fromMe,
          text: data.message?.conversation,
        },
      }
    }

    if (event === 'qrcode.updated') {
      return {
        type: 'qr.updated',
        event_id: stableId('evolution', 'qrcode.updated', data.instance ?? '', JSON.stringify(rawPayload)),
        timestamp: new Date(),
        payload: { qr_code: data.qrcode?.base64 },
      }
    }

    if (event === 'connection.update') {
      return {
        type: 'connection.update',
        event_id: stableId('evolution', 'connection.update', data.instance ?? '', data.state ?? '', JSON.stringify(rawPayload)),
        timestamp: new Date(),
        payload: { state: data.state, instance: data.instance },
      }
    }

    return {
      type: 'connection.update',
      event_id: stableId('evolution', event, JSON.stringify(rawPayload)),
      timestamp: new Date(),
      payload: { raw_event: event, raw: rawPayload },
    }
  }
}

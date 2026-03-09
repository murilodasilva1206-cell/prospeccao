// ---------------------------------------------------------------------------
// UAZAPI adapter
//
// Connection flow: QR-based (similar to Evolution).
//   createChannel()      → POST /instance/init        (header: admintoken)
//   startConnection()    → POST /instance/connect      (header: token)
//   getConnectionStatus()→ GET  /instance/status       (header: token)
//   disconnect()         → POST /instance/disconnect   (header: token)
//
// Webhook verification: compare Authorization header with channel.webhook_secret
//
// UAZAPI docs: https://uazapi.com/docs
// ---------------------------------------------------------------------------

import { createHash } from 'crypto'
import { safeCompare } from '../crypto'
import { RetryableError, CredentialValidationError } from '../errors'
import type { IWhatsAppAdapter, ConnectResult, SendResult, DownloadResult } from './interface'
import type { Channel, ChannelCredentials, ChannelStatus, WhatsAppEvent } from '../types'

function stableId(...parts: string[]): string {
  return createHash('sha256').update(parts.join('::')).digest('hex').slice(0, 32)
}

function mapUazapiAck(ack: number): WhatsAppEvent['type'] {
  switch (ack) {
    case 3: return 'message.read'
    case 2: return 'message.delivered'
    case 1: return 'message.sent'
    case -1:
    case 0:
      return 'message.failed'
    default: return 'message.sent'
  }
}

export class UazapiAdapter implements IWhatsAppAdapter {
  private base(creds: ChannelCredentials): string {
    if (!creds.instance_url) throw new Error('UAZAPI adapter requer instance_url')
    return creds.instance_url.replace(/\/$/, '')
  }

  /** Header for admin operations (createChannel). Uses admintoken header. */
  private adminHeaders(creds: ChannelCredentials): Record<string, string> {
    return {
      admintoken: creds.admin_token ?? '',
      'Content-Type': 'application/json',
    }
  }

  /** Header for instance operations (connect/status/disconnect/send). Uses token header. */
  private instanceHeaders(creds: ChannelCredentials): Record<string, string> {
    return {
      token: creds.instance_token ?? '',
      'Content-Type': 'application/json',
    }
  }

  async createChannel(
    channel: Channel,
    creds: ChannelCredentials,
  ): Promise<{ external_instance_id: string }> {
    if (!creds.admin_token || !creds.instance_token || !creds.instance_url) {
      throw new Error('UAZAPI adapter requer admin_token, instance_token e instance_url')
    }

    const instanceName = `prospeccao-${channel.id.slice(0, 8)}`

    const res = await fetch(`${this.base(creds)}/instance/init`, {
      method: 'POST',
      headers: this.adminHeaders(creds),
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

  async validateCredentials(_channel: Channel, creds: ChannelCredentials): Promise<void> {
    if (!creds.instance_url || !creds.instance_token)
      throw new Error('UAZAPI adapter requer instance_url e instance_token')

    // GET /instance/status validates the instance_token (same endpoint as getConnectionStatus).
    // admin_token is only required for createChannel (POST /instance/init) — not validated here.
    const res = await fetch(`${this.base(creds)}/instance/status`, {
      headers: this.instanceHeaders(creds),
    })

    if (res.status === 401 || res.status === 403) {
      const body = await res.text().catch(() => '')
      throw new CredentialValidationError('Token de instância inválido', res.status, body)
    }

    if (res.status === 404) {
      const body = await res.text().catch(() => '')
      throw new CredentialValidationError(
        'Instance URL/rota inválida para este ambiente',
        res.status,
        body,
      )
    }

    if (res.status >= 500) {
      const body = await res.text().catch(() => '')
      throw new CredentialValidationError(
        'Provider UAZAPI indisponível no momento',
        res.status,
        body,
      )
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new CredentialValidationError(
        'Credenciais inválidas ou provider inacessível',
        res.status,
        body,
      )
    }
  }

  async startConnection(
    channel: Channel,
    creds: ChannelCredentials,
  ): Promise<ConnectResult> {
    const instanceId = channel.external_instance_id
    if (!instanceId) throw new Error('external_instance_id nao definido — chame createChannel primeiro')

    const res = await fetch(`${this.base(creds)}/instance/connect`, {
      method: 'POST',
      headers: this.instanceHeaders(creds),
      body: JSON.stringify({ id: instanceId }),
    })

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

    const res = await fetch(`${this.base(creds)}/instance/status`, {
      headers: this.instanceHeaders(creds),
    })

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

    await fetch(`${this.base(creds)}/instance/disconnect`, {
      method: 'POST',
      headers: this.instanceHeaders(creds),
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
      headers: this.instanceHeaders(creds),
      body: JSON.stringify({ id: instanceId, phone: to, message: text }),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      if (res.status === 429 || res.status >= 500) {
        throw new RetryableError(`UAZAPI sendMessage falhou (${res.status}): ${body}`)
      }
      throw new Error(`UAZAPI sendMessage falhou (${res.status}): ${body}`)
    }

    const data = (await res.json()) as { id?: string; messageId?: string }
    const messageId = data.id ?? data.messageId
    if (!messageId) throw new Error('UAZAPI nao retornou id na resposta de envio')

    return { message_id: messageId }
  }

  async sendMedia(
    channel: Channel,
    creds: ChannelCredentials,
    to: string,
    mediaBuffer: Buffer,
    mime: string,
    filename: string,
    caption?: string,
  ): Promise<SendResult> {
    const instanceId = channel.external_instance_id
    if (!instanceId) throw new Error('Canal nao possui external_instance_id')

    const base64 = mediaBuffer.toString('base64')
    const res = await fetch(`${this.base(creds)}/message/sendFile`, {
      method: 'POST',
      headers: this.instanceHeaders(creds),
      body: JSON.stringify({
        id: instanceId,
        phone: to,
        base64,
        mimetype: mime,
        filename,
        caption: caption ?? '',
      }),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`UAZAPI sendMedia falhou (${res.status}): ${body}`)
    }

    const data = (await res.json()) as { id?: string; messageId?: string }
    const messageId = data.id ?? data.messageId
    if (!messageId) throw new Error('UAZAPI nao retornou id no sendMedia')

    return { message_id: messageId }
  }

  async sendAudio(
    channel: Channel,
    creds: ChannelCredentials,
    to: string,
    audioBuffer: Buffer,
  ): Promise<SendResult> {
    return this.sendMedia(channel, creds, to, audioBuffer, 'audio/ogg', 'audio.ogg')
  }

  async sendSticker(
    channel: Channel,
    creds: ChannelCredentials,
    to: string,
    stickerBuffer: Buffer,
  ): Promise<SendResult> {
    const instanceId = channel.external_instance_id
    if (!instanceId) throw new Error('Canal nao possui external_instance_id')

    const base64 = stickerBuffer.toString('base64')
    const res = await fetch(`${this.base(creds)}/message/sendSticker`, {
      method: 'POST',
      headers: this.instanceHeaders(creds),
      body: JSON.stringify({ id: instanceId, phone: to, base64, mimetype: 'image/webp' }),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`UAZAPI sendSticker falhou (${res.status}): ${body}`)
    }

    const data = (await res.json()) as { id?: string; messageId?: string }
    return { message_id: data.id ?? data.messageId ?? stableId('uazapi', 'sticker', to) }
  }

  async sendReaction(
    channel: Channel,
    creds: ChannelCredentials,
    to: string,
    emoji: string,
    targetMessageId: string,
  ): Promise<SendResult> {
    const instanceId = channel.external_instance_id
    if (!instanceId) throw new Error('Canal nao possui external_instance_id')

    const res = await fetch(`${this.base(creds)}/message/sendReaction`, {
      method: 'POST',
      headers: this.instanceHeaders(creds),
      body: JSON.stringify({ id: instanceId, phone: to, messageId: targetMessageId, reaction: emoji }),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`UAZAPI sendReaction falhou (${res.status}): ${body}`)
    }

    const data = (await res.json()) as { id?: string; messageId?: string }
    return { message_id: data.id ?? data.messageId ?? targetMessageId + '-reaction' }
  }

  async sendTemplate(
    _channel: Channel,
    _creds: ChannelCredentials,
    _to: string,
    _templateName: string,
    _language: string,
    _bodyParams: string[] = [],
  ): Promise<SendResult> {
    throw new Error('Templates oficiais sao suportados apenas no canal META_CLOUD')
  }

  async downloadMedia(
    channel: Channel,
    creds: ChannelCredentials,
    mediaId: string,
  ): Promise<DownloadResult> {
    const instanceId = channel.external_instance_id
    if (!instanceId) throw new Error('Canal nao possui external_instance_id')

    const res = await fetch(
      `${this.base(creds)}/message/downloadMedia?id=${encodeURIComponent(instanceId)}&messageId=${encodeURIComponent(mediaId)}`,
      { headers: this.instanceHeaders(creds) },
    )

    if (!res.ok) throw new Error(`UAZAPI downloadMedia falhou (${res.status})`)

    const data = (await res.json()) as { base64?: string; mimetype?: string; filename?: string }
    if (!data.base64) throw new Error('UAZAPI nao retornou base64 para o media')

    const buffer = Buffer.from(data.base64, 'base64')
    const mime = data.mimetype ?? 'application/octet-stream'
    const ext = mime.split('/')[1]?.split(';')[0] ?? 'bin'
    return { buffer, mime, filename: data.filename ?? `uazapi-${mediaId}.${ext}` }
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

  normalizeInboundEvent(
    rawPayload: unknown,
  ): Omit<WhatsAppEvent, 'channel_id' | 'provider'> | null {
    const payload = rawPayload as {
      type?: string
      messageId?: string
      from?: string
      fromMe?: boolean
      body?: string
      mimetype?: string
      filename?: string
      caption?: string
      mediaType?: string
      contactName?: string
      timestamp?: number
      reactionTo?: string
      emoji?: string
    }

    const type = payload.type ?? ''
    if (type !== 'message' && type !== 'message.received') return null
    if (payload.fromMe === true) return null

    const messageId = payload.messageId ?? ''
    const from = payload.from ?? ''
    const timestamp = payload.timestamp ? new Date(payload.timestamp * 1000) : new Date()
    const msgType = payload.mediaType ?? (payload.emoji ? 'reaction' : 'text')

    const eventPayload: Record<string, unknown> = {
      from,
      message_id: messageId,
      message_type: msgType,
      contact_name: payload.contactName ?? null,
    }

    if (msgType === 'reaction') {
      eventPayload.reaction_to = payload.reactionTo ?? null
      eventPayload.emoji = payload.emoji ?? null
      eventPayload.body = payload.emoji ?? null
    } else if (msgType === 'text') {
      eventPayload.body = payload.body ?? null
    } else {
      eventPayload.media_id = messageId
      eventPayload.mime_type = payload.mimetype ?? null
      eventPayload.caption = payload.caption ?? null
      eventPayload.filename = payload.filename ?? null
    }

    return {
      type: 'message.received',
      event_id: messageId || stableId('uazapi', 'inbound', from, String(timestamp.getTime())),
      timestamp,
      payload: eventPayload,
    }
  }

  normalizeStatusEvent(
    rawPayload: unknown,
  ): Omit<WhatsAppEvent, 'channel_id' | 'provider'> | null {
    const payload = rawPayload as {
      type?: string
      messageId?: string
      status?: string
      ack?: number
    }

    const type = payload.type ?? ''
    if (type !== 'message.ack' && type !== 'ack') return null

    const messageId = payload.messageId ?? ''
    // UAZAPI ack: -1=failed, 0=error, 1=sent, 2=delivered, 3=read
    const ack = payload.ack ?? 0
    const eventType = mapUazapiAck(ack)
    const statusLabel = ack === 3 ? 'read' : ack === 2 ? 'delivered' : ack <= 0 ? 'failed' : 'sent'
    const errorReason = (payload as Record<string, unknown>).error as string | undefined ?? null

    return {
      type: eventType,
      event_id: `${messageId}-ack${ack}`,
      timestamp: new Date(),
      payload: { message_id: messageId, status: statusLabel, error_reason: errorReason },
    }
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

    const inbound = this.normalizeInboundEvent(rawPayload)
    if (inbound) return inbound

    const status = this.normalizeStatusEvent(rawPayload)
    if (status) return status

    // Outbound message.sent (fromMe)
    if ((type === 'message' || type === 'message.received') && payload.fromMe === true) {
      return {
        type: 'message.sent',
        event_id: payload.messageId ?? stableId('uazapi', 'sent', payload.from ?? '', JSON.stringify(rawPayload)),
        timestamp: new Date(),
        payload: {
          from: payload.from,
          message_id: payload.messageId,
          from_me: true,
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

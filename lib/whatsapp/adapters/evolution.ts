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
import { RetryableError } from '../errors'
import type { IWhatsAppAdapter, ConnectResult, SendResult, DownloadResult } from './interface'
import type { Channel, ChannelCredentials, ChannelStatus, WhatsAppEvent } from '../types'

function stableId(...parts: string[]): string {
  return createHash('sha256').update(parts.join('::')).digest('hex').slice(0, 32)
}

function mapEvolutionStatus(statusRaw: string): WhatsAppEvent['type'] | undefined {
  switch (statusRaw) {
    case 'SERVER_ACK': return 'message.sent'
    case 'DELIVERY_ACK': return 'message.delivered'
    case 'READ': return 'message.read'
    case 'PLAYED': return 'message.read'
    case 'ERROR': return 'message.failed'
    case 'NACK': return 'message.failed'
    default: return undefined
  }
}

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
        body: JSON.stringify({ number: to, text }),
      },
    )

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      if (res.status === 429 || res.status >= 500) {
        throw new RetryableError(`Evolution sendMessage falhou (${res.status}): ${body}`)
      }
      throw new Error(`Evolution sendMessage falhou (${res.status}): ${body}`)
    }

    const data = (await res.json()) as { key?: { id?: string } }
    const messageId = data.key?.id
    if (!messageId) throw new Error('Evolution nao retornou key.id na resposta de envio')

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
    const instanceName = channel.external_instance_id
    if (!instanceName) throw new Error('Canal nao possui external_instance_id')

    const base64 = mediaBuffer.toString('base64')
    const mediatype = mime.startsWith('image/') ? 'image'
      : mime.startsWith('audio/') ? 'audio'
      : mime.startsWith('video/') ? 'video'
      : 'document'

    const res = await fetch(
      `${this.base(creds)}/message/sendMedia/${instanceName}`,
      {
        method: 'POST',
        headers: this.headers(creds),
        body: JSON.stringify({
          number: to,
          mediatype,
          mimetype: mime,
          caption: caption ?? '',
          media: base64,
          fileName: filename,
        }),
      },
    )

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Evolution sendMedia falhou (${res.status}): ${body}`)
    }

    const data = (await res.json()) as { key?: { id?: string } }
    const messageId = data.key?.id
    if (!messageId) throw new Error('Evolution nao retornou key.id no sendMedia')

    return { message_id: messageId }
  }

  async sendAudio(
    channel: Channel,
    creds: ChannelCredentials,
    to: string,
    audioBuffer: Buffer,
  ): Promise<SendResult> {
    const instanceName = channel.external_instance_id
    if (!instanceName) throw new Error('Canal nao possui external_instance_id')

    const base64 = audioBuffer.toString('base64')

    const res = await fetch(
      `${this.base(creds)}/message/sendWhatsAppAudio/${instanceName}`,
      {
        method: 'POST',
        headers: this.headers(creds),
        body: JSON.stringify({ number: to, audio: base64, encoding: true }),
      },
    )

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Evolution sendAudio falhou (${res.status}): ${body}`)
    }

    const data = (await res.json()) as { key?: { id?: string } }
    const messageId = data.key?.id
    if (!messageId) throw new Error('Evolution nao retornou key.id no sendAudio')

    return { message_id: messageId }
  }

  async sendSticker(
    channel: Channel,
    creds: ChannelCredentials,
    to: string,
    stickerBuffer: Buffer,
  ): Promise<SendResult> {
    // Evolution uses sendMedia with sticker mediatype
    return this.sendMedia(channel, creds, to, stickerBuffer, 'image/webp', 'sticker.webp')
  }

  async sendReaction(
    channel: Channel,
    creds: ChannelCredentials,
    to: string,
    emoji: string,
    targetMessageId: string,
  ): Promise<SendResult> {
    const instanceName = channel.external_instance_id
    if (!instanceName) throw new Error('Canal nao possui external_instance_id')

    const res = await fetch(
      `${this.base(creds)}/message/sendReaction/${instanceName}`,
      {
        method: 'POST',
        headers: this.headers(creds),
        body: JSON.stringify({
          key: { remoteJid: to, id: targetMessageId, fromMe: false },
          reaction: emoji,
        }),
      },
    )

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Evolution sendReaction falhou (${res.status}): ${body}`)
    }

    const data = (await res.json()) as { key?: { id?: string } }
    return { message_id: data.key?.id ?? targetMessageId + '-reaction' }
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
    const instanceName = channel.external_instance_id
    if (!instanceName) throw new Error('Canal nao possui external_instance_id')

    // Evolution: GET /chat/getBase64FromMediaMessage/:instance with message key
    const res = await fetch(
      `${this.base(creds)}/chat/getBase64FromMediaMessage/${instanceName}`,
      {
        method: 'POST',
        headers: this.headers(creds),
        body: JSON.stringify({ message: { key: { id: mediaId } }, convertToMp4: false }),
      },
    )

    if (!res.ok) throw new Error(`Evolution downloadMedia falhou (${res.status})`)

    const data = (await res.json()) as { base64?: string; mediaType?: string; fileName?: string }
    if (!data.base64) throw new Error('Evolution nao retornou base64 para o media')

    const buffer = Buffer.from(data.base64, 'base64')
    const mime = data.mediaType ?? 'application/octet-stream'
    const ext = mime.split('/')[1]?.split(';')[0] ?? 'bin'
    return { buffer, mime, filename: data.fileName ?? `evolution-${mediaId}.${ext}` }
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

  normalizeInboundEvent(
    rawPayload: unknown,
  ): Omit<WhatsAppEvent, 'channel_id' | 'provider'> | null {
    const payload = rawPayload as {
      event?: string
      data?: {
        key?: { id?: string; remoteJid?: string; fromMe?: boolean }
        message?: Record<string, unknown>
        messageType?: string
        pushName?: string
        messageTimestamp?: number
      }
    }

    if (payload.event !== 'messages.upsert') return null

    const data = payload.data ?? {}
    if (data.key?.fromMe === true) return null // outbound, not inbound

    const messageId = data.key?.id ?? ''
    const from = data.key?.remoteJid ?? ''
    const timestamp = data.messageTimestamp
      ? new Date(data.messageTimestamp * 1000)
      : new Date()
    const contactName = data.pushName ?? null
    const msgType = this.detectMsgType(data.message ?? {})
    const eventPayload: Record<string, unknown> = {
      from,
      message_id: messageId,
      message_type: msgType,
      contact_name: contactName,
    }

    const msg = data.message ?? {}
    if (msgType === 'text') {
      eventPayload.body = (msg.conversation as string | undefined)
        ?? ((msg.extendedTextMessage as Record<string, unknown> | undefined)?.text as string | undefined)
        ?? null
    } else if (msgType === 'reaction') {
      const rxn = msg.reactionMessage as Record<string, unknown> | undefined
      eventPayload.reaction_to = (rxn?.key as Record<string, unknown> | undefined)?.id ?? null
      eventPayload.emoji = rxn?.text ?? null
      eventPayload.body = rxn?.text ?? null
    } else {
      const mediaMsg = (msg[`${msgType}Message`] as Record<string, unknown> | undefined) ?? {}
      eventPayload.media_id = messageId // Evolution uses message ID to download
      eventPayload.mime_type = mediaMsg.mimetype ?? null
      eventPayload.caption = mediaMsg.caption ?? null
      eventPayload.filename = mediaMsg.fileName ?? null
    }

    return {
      type: 'message.received',
      event_id: messageId || stableId('evolution', 'inbound', from, String(timestamp.getTime())),
      timestamp,
      payload: eventPayload,
    }
  }

  normalizeStatusEvent(
    rawPayload: unknown,
  ): Omit<WhatsAppEvent, 'channel_id' | 'provider'> | null {
    const payload = rawPayload as {
      event?: string
      data?: {
        key?: { id?: string; remoteJid?: string }
        update?: { status?: string }
        status?: string
      }
    }

    if (payload.event !== 'messages.update') return null

    const data = payload.data ?? {}
    const messageId = data.key?.id ?? ''
    const statusRaw = (data.update?.status ?? data.status ?? '').toUpperCase()

    // Unknown statuses are not silently mapped to message.sent to avoid false positives
    const eventType = mapEvolutionStatus(statusRaw)
    if (!eventType) return null

    const errorReason = (data.update as Record<string, unknown> | undefined)?.reason as string | undefined ?? null
    return {
      type: eventType,
      event_id: `${messageId}-${statusRaw.toLowerCase()}`,
      timestamp: new Date(),
      payload: { message_id: messageId, status: statusRaw.toLowerCase(), error_reason: errorReason },
    }
  }

  normalizeEvent(
    rawPayload: unknown,
  ): Omit<WhatsAppEvent, 'channel_id' | 'provider'> {
    const payload = rawPayload as { event?: string; data?: Record<string, unknown> }
    const event = payload.event ?? ''
    const data = payload.data ?? {}

    const inbound = this.normalizeInboundEvent(rawPayload)
    if (inbound) return inbound

    const status = this.normalizeStatusEvent(rawPayload)
    if (status) return status

    if (event === 'qrcode.updated') {
      return {
        type: 'qr.updated',
        event_id: stableId('evolution', 'qrcode.updated', String(data.instance ?? ''), JSON.stringify(rawPayload)),
        timestamp: new Date(),
        payload: { qr_code: (data.qrcode as Record<string, unknown> | undefined)?.base64 },
      }
    }

    if (event === 'connection.update') {
      return {
        type: 'connection.update',
        event_id: stableId('evolution', 'connection.update', String(data.instance ?? ''), String(data.state ?? ''), JSON.stringify(rawPayload)),
        timestamp: new Date(),
        payload: { state: data.state, instance: data.instance },
      }
    }

    // outbound message.sent (fromMe) from messages.upsert
    if (event === 'messages.upsert') {
      const key = data.key as Record<string, unknown> | undefined
      return {
        type: 'message.sent',
        event_id: String(key?.id ?? '') || stableId('evolution', 'messages.upsert', String(key?.remoteJid ?? ''), JSON.stringify(rawPayload)),
        timestamp: new Date(),
        payload: {
          from: key?.remoteJid,
          message_id: key?.id,
          from_me: key?.fromMe,
        },
      }
    }

    return {
      type: 'connection.update',
      event_id: stableId('evolution', event, JSON.stringify(rawPayload)),
      timestamp: new Date(),
      payload: { raw_event: event, raw: rawPayload },
    }
  }

  private detectMsgType(message: Record<string, unknown>): string {
    if (message.conversation || message.extendedTextMessage) return 'text'
    if (message.imageMessage) return 'image'
    if (message.audioMessage) return 'audio'
    if (message.videoMessage) return 'video'
    if (message.documentMessage) return 'document'
    if (message.stickerMessage) return 'sticker'
    if (message.reactionMessage) return 'reaction'
    return 'text'
  }
}

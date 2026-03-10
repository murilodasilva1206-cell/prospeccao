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
import { RetryableError, CredentialValidationError } from '../errors'
import type { IWhatsAppAdapter, ConnectResult, SendResult, DownloadResult } from './interface'
import type { Channel, ChannelCredentials, ChannelStatus, WhatsAppEvent } from '../types'
import type { MetaTemplateItem } from '../../schemas'
import { MetaTemplateItemSchema } from '../../schemas'

const GRAPH_API_VERSION = 'v18.0'
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`

function stableId(...parts: string[]): string {
  return createHash('sha256').update(parts.join('::')).digest('hex').slice(0, 32)
}

function mapMetaStatus(rawStatus: string): WhatsAppEvent['type'] | undefined {
  switch (rawStatus) {
    case 'sent': return 'message.sent'
    case 'delivered': return 'message.delivered'
    case 'read': return 'message.read'
    case 'failed': return 'message.failed'
    default: return undefined
  }
}

export class MetaAdapter implements IWhatsAppAdapter {
  async createChannel(
    _channel: Channel,
    creds: ChannelCredentials,
  ): Promise<{ external_instance_id: string }> {
    if (!creds.access_token || !creds.phone_number_id)
      throw new Error('Meta adapter requer access_token e phone_number_id')
    const res = await fetch(
      `${GRAPH_BASE}/${creds.phone_number_id}?fields=id,display_phone_number`,
      { headers: { Authorization: `Bearer ${creds.access_token}` } },
    )
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Meta Graph API retornou ${res.status} ao validar phone_number_id: ${body}`)
    }
    const data = (await res.json()) as { id?: string; display_phone_number?: string }
    if (!data.id) throw new Error('Meta Graph API nao retornou ID para o phone_number_id informado')
    return { external_instance_id: data.id }
  }

  async validateCredentials(_channel: Channel, creds: ChannelCredentials): Promise<void> {
    if (!creds.access_token || !creds.phone_number_id)
      throw new Error('Meta adapter requer access_token e phone_number_id')
    const res = await fetch(
      `${GRAPH_BASE}/${creds.phone_number_id}?fields=id`,
      { headers: { Authorization: `Bearer ${creds.access_token}` } },
    )
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      const userMessage = res.status >= 500 ? 'Meta API inacessível' : 'Credenciais Meta inválidas'
      throw new CredentialValidationError(userMessage, res.status, body)
    }
  }

  async startConnection(
    _channel: Channel,
    creds: ChannelCredentials,
  ): Promise<ConnectResult> {
    if (!creds.access_token || !creds.phone_number_id)
      throw new Error('Meta adapter requer access_token e phone_number_id')
    const res = await fetch(
      `${GRAPH_BASE}/${creds.phone_number_id}?fields=id,display_phone_number`,
      { headers: { Authorization: `Bearer ${creds.access_token}` } },
    )
    if (!res.ok) return { status: 'ERROR' }
    const data = (await res.json()) as { id?: string; display_phone_number?: string }
    return { status: 'CONNECTED', phone_number: data.display_phone_number, external_instance_id: data.id }
  }

  async getConnectionStatus(
    _channel: Channel,
    creds: ChannelCredentials,
  ): Promise<ChannelStatus> {
    if (!creds.access_token || !creds.phone_number_id) return 'ERROR'
    const res = await fetch(
      `${GRAPH_BASE}/${creds.phone_number_id}?fields=id`,
      { headers: { Authorization: `Bearer ${creds.access_token}` } },
    )
    return res.ok ? 'CONNECTED' : 'ERROR'
  }

  async disconnect(_channel: Channel, _creds: ChannelCredentials): Promise<void> {
    // Meta: no server-side logout
  }

  async sendMessage(
    _channel: Channel,
    creds: ChannelCredentials,
    to: string,
    text: string,
  ): Promise<SendResult> {
    if (!creds.access_token || !creds.phone_number_id)
      throw new Error('Meta adapter requer access_token e phone_number_id')
    const res = await fetch(`${GRAPH_BASE}/${creds.phone_number_id}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${creds.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      if (res.status === 429 || res.status >= 500) {
        throw new RetryableError(`Meta sendMessage falhou (${res.status}): ${body}`)
      }
      throw new Error(`Meta sendMessage falhou (${res.status}): ${body}`)
    }
    const data = (await res.json()) as { messages?: Array<{ id?: string }> }
    const messageId = data.messages?.[0]?.id
    if (!messageId) throw new Error('Meta nao retornou message_id na resposta de envio')
    return { message_id: messageId }
  }

  async sendMedia(
    _channel: Channel,
    creds: ChannelCredentials,
    to: string,
    mediaBuffer: Buffer,
    mime: string,
    filename: string,
    caption?: string,
  ): Promise<SendResult> {
    if (!creds.access_token || !creds.phone_number_id)
      throw new Error('Meta adapter requer access_token e phone_number_id')
    // Step 1: upload to Meta Media API
    const form = new FormData()
    form.append('messaging_product', 'whatsapp')
    form.append('type', mime)
    form.append('file', new Blob([new Uint8Array(mediaBuffer)], { type: mime }), filename)
    const uploadRes = await fetch(`${GRAPH_BASE}/${creds.phone_number_id}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${creds.access_token}` },
      body: form,
    })
    if (!uploadRes.ok) throw new Error(`Meta media upload falhou (${uploadRes.status})`)
    const { id: mediaId } = (await uploadRes.json()) as { id?: string }
    if (!mediaId) throw new Error('Meta nao retornou media id')
    // Step 2: send message referencing media_id
    const msgType = mime.startsWith('image/') ? 'image'
      : mime.startsWith('audio/') ? 'audio'
      : mime.startsWith('video/') ? 'video'
      : 'document'
    const mediaObj: Record<string, unknown> = { id: mediaId }
    if (caption && (msgType === 'image' || msgType === 'video')) mediaObj.caption = caption
    if (msgType === 'document') mediaObj.filename = filename
    const res = await fetch(`${GRAPH_BASE}/${creds.phone_number_id}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${creds.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: msgType, [msgType]: mediaObj }),
    })
    if (!res.ok) throw new Error(`Meta sendMedia falhou (${res.status})`)
    const data = (await res.json()) as { messages?: Array<{ id?: string }> }
    const messageId = data.messages?.[0]?.id
    if (!messageId) throw new Error('Meta nao retornou message_id no sendMedia')
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
    _channel: Channel,
    creds: ChannelCredentials,
    to: string,
    stickerBuffer: Buffer,
  ): Promise<SendResult> {
    if (!creds.access_token || !creds.phone_number_id)
      throw new Error('Meta adapter requer access_token e phone_number_id')
    const form = new FormData()
    form.append('messaging_product', 'whatsapp')
    form.append('type', 'image/webp')
    form.append('file', new Blob([new Uint8Array(stickerBuffer)], { type: 'image/webp' }), 'sticker.webp')
    const uploadRes = await fetch(`${GRAPH_BASE}/${creds.phone_number_id}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${creds.access_token}` },
      body: form,
    })
    if (!uploadRes.ok) throw new Error(`Meta sticker upload falhou (${uploadRes.status})`)
    const { id: mediaId } = (await uploadRes.json()) as { id?: string }
    if (!mediaId) throw new Error('Meta nao retornou media id no sticker')
    const res = await fetch(`${GRAPH_BASE}/${creds.phone_number_id}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${creds.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'sticker', sticker: { id: mediaId } }),
    })
    if (!res.ok) throw new Error(`Meta sendSticker falhou (${res.status})`)
    const data = (await res.json()) as { messages?: Array<{ id?: string }> }
    return { message_id: data.messages?.[0]?.id ?? mediaId }
  }

  async sendReaction(
    _channel: Channel,
    creds: ChannelCredentials,
    to: string,
    emoji: string,
    targetMessageId: string,
  ): Promise<SendResult> {
    if (!creds.access_token || !creds.phone_number_id)
      throw new Error('Meta adapter requer access_token e phone_number_id')
    const res = await fetch(`${GRAPH_BASE}/${creds.phone_number_id}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${creds.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'reaction',
        reaction: { message_id: targetMessageId, emoji },
      }),
    })
    if (!res.ok) throw new Error(`Meta sendReaction falhou (${res.status})`)
    const data = (await res.json()) as { messages?: Array<{ id?: string }> }
    return { message_id: data.messages?.[0]?.id ?? targetMessageId + '-reaction' }
  }

  async sendTemplate(
    _channel: Channel,
    creds: ChannelCredentials,
    to: string,
    templateName: string,
    language: string,
    bodyParams: string[] = [],
  ): Promise<SendResult> {
    if (!creds.access_token || !creds.phone_number_id)
      throw new Error('Meta adapter requer access_token e phone_number_id')

    const components =
      bodyParams.length > 0
        ? [
            {
              type: 'body',
              parameters: bodyParams.map((text) => ({ type: 'text', text })),
            },
          ]
        : undefined

    const res = await fetch(`${GRAPH_BASE}/${creds.phone_number_id}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${creds.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: templateName,
          language: { code: language },
          ...(components ? { components } : {}),
        },
      }),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      if (res.status === 429 || res.status >= 500) {
        throw new RetryableError(`Meta sendTemplate falhou (${res.status}): ${body}`)
      }
      throw new Error(`Meta sendTemplate falhou (${res.status}): ${body}`)
    }

    const data = (await res.json()) as { messages?: Array<{ id?: string }> }
    return { message_id: data.messages?.[0]?.id ?? stableId('meta', 'template', to, templateName) }
  }

  async downloadMedia(
    _channel: Channel,
    creds: ChannelCredentials,
    mediaId: string,
  ): Promise<DownloadResult> {
    if (!creds.access_token) throw new Error('Meta adapter requer access_token')
    const infoRes = await fetch(`${GRAPH_BASE}/${mediaId}`, {
      headers: { Authorization: `Bearer ${creds.access_token}` },
    })
    if (!infoRes.ok) throw new Error(`Meta downloadMedia info falhou (${infoRes.status})`)
    const info = (await infoRes.json()) as { url?: string; mime_type?: string }
    if (!info.url) throw new Error('Meta nao retornou URL para o media')
    const fileRes = await fetch(info.url, {
      headers: { Authorization: `Bearer ${creds.access_token}` },
    })
    if (!fileRes.ok) throw new Error(`Meta downloadMedia download falhou (${fileRes.status})`)
    const ab = await fileRes.arrayBuffer()
    const buffer = Buffer.from(ab)
    const mime = info.mime_type ?? 'application/octet-stream'
    const ext = mime.split('/')[1]?.split(';')[0] ?? 'bin'
    return { buffer, mime, filename: `meta-${mediaId}.${ext}` }
  }

  verifyWebhookSignature(
    _channel: Channel,
    creds: ChannelCredentials,
    headers: Headers,
    rawBody: string,
  ): boolean {
    const signature = headers.get('x-hub-signature-256')
    if (!signature || !creds.app_secret) return false
    const expected = 'sha256=' + createHmac('sha256', creds.app_secret).update(rawBody).digest('hex')
    return safeCompare(signature, expected)
  }

  normalizeInboundEvent(
    rawPayload: unknown,
  ): Omit<WhatsAppEvent, 'channel_id' | 'provider'> | null {
    const p = rawPayload as Record<string, unknown>
    const entry = (p?.entry as unknown[])?.[0] as Record<string, unknown> | undefined
    const value = ((entry?.changes as unknown[])?.[0] as Record<string, unknown>)?.value as Record<string, unknown> | undefined
    const messages = value?.messages as Array<Record<string, unknown>> | undefined
    const message = messages?.[0]
    if (!message) return null

    const msgType = String(message.type ?? 'text')
    const from = String(message.from ?? '')
    const messageId = String(message.id ?? '')
    const timestamp = message.timestamp ? new Date(Number(message.timestamp) * 1000) : new Date()
    const payload: Record<string, unknown> = { from, message_id: messageId, message_type: msgType }

    if (msgType === 'text') {
      payload.body = (message.text as Record<string, unknown>)?.body ?? null
    } else if (msgType === 'reaction') {
      const rxn = message.reaction as Record<string, unknown> | undefined
      payload.reaction_to = rxn?.message_id ?? null
      payload.emoji = rxn?.emoji ?? null
      payload.body = rxn?.emoji ?? null
    } else {
      // eslint-disable-next-line security/detect-object-injection
      const m = (message[msgType] as Record<string, unknown>) ?? {}
      payload.media_id = String(m.id ?? '')
      payload.mime_type = String(m.mime_type ?? '')
      payload.caption = m.caption ? String(m.caption) : null
      payload.filename = m.filename ? String(m.filename) : null
    }

    return {
      type: 'message.received',
      event_id: messageId || stableId('meta', 'inbound', from, String(timestamp.getTime())),
      timestamp,
      payload,
    }
  }

  normalizeStatusEvent(
    rawPayload: unknown,
  ): Omit<WhatsAppEvent, 'channel_id' | 'provider'> | null {
    const p = rawPayload as Record<string, unknown>
    const entry = (p?.entry as unknown[])?.[0] as Record<string, unknown> | undefined
    const value = ((entry?.changes as unknown[])?.[0] as Record<string, unknown>)?.value as Record<string, unknown> | undefined
    const statuses = value?.statuses as Array<Record<string, unknown>> | undefined
    const statusEntry = statuses?.[0]
    if (!statusEntry) return null

    const rawStatus = String(statusEntry.status ?? '')
    // Unknown status values must NOT be silently promoted to message.sent — that would
    // mark recipients as delivered when the provider sent an unrecognized status code.
    // Return null so normalizeEvent falls through to the connection.update fallback.
    const eventType = mapMetaStatus(rawStatus)
    if (!eventType) return null
    const errors = statusEntry.errors as Array<Record<string, unknown>> | undefined
    const errorCode = errors?.[0]?.code ?? null
    const errorTitle = errors?.[0]?.title ?? null
    return {
      type: eventType,
      event_id: `${statusEntry.id ?? ''}-${rawStatus}`,
      timestamp: statusEntry.timestamp ? new Date(Number(statusEntry.timestamp) * 1000) : new Date(),
      payload: {
        message_id: statusEntry.id,
        status: rawStatus,
        error_code: errorCode,
        error_reason: errorTitle,
      },
    }
  }

  normalizeEvent(
    rawPayload: unknown,
  ): Omit<WhatsAppEvent, 'channel_id' | 'provider'> {
    return (
      this.normalizeInboundEvent(rawPayload) ??
      this.normalizeStatusEvent(rawPayload) ?? {
        type: 'connection.update',
        event_id: stableId('meta', 'unknown', JSON.stringify(rawPayload)),
        timestamp: new Date(),
        payload: { raw: rawPayload },
      }
    )
  }

  /**
   * Fetches all message templates from the Meta Graph API for a WABA account.
   * Follows paging cursors to collect all pages.
   * Throws RetryableError on 429/5xx; plain Error on 4xx.
   */
  async syncTemplates(
    _channel: Channel,
    creds: ChannelCredentials,
  ): Promise<MetaTemplateItem[]> {
    if (!creds.access_token) throw new Error('Meta adapter requer access_token para syncTemplates')
    if (!creds.waba_id) throw new Error('Meta adapter requer waba_id para syncTemplates (configure o WABA ID nas credenciais do canal)')

    const allTemplates: MetaTemplateItem[] = []
    const fields = 'name,language,status,category,components'
    let nextUrl: string | null =
      `${GRAPH_BASE}/${creds.waba_id}/message_templates?fields=${fields}&limit=100`

    while (nextUrl) {
      const res = await fetch(nextUrl, {
        headers: { Authorization: `Bearer ${creds.access_token}` },
      })

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        if (res.status === 429 || res.status >= 500) {
          throw new RetryableError(`Meta syncTemplates falhou (${res.status}): ${body}`)
        }
        throw new Error(`Meta syncTemplates falhou (${res.status}): ${body}`)
      }

      const data = (await res.json()) as {
        data?: unknown[]
        paging?: { next?: string }
      }

      const page = data.data ?? []
      for (const item of page) {
        const parsed = MetaTemplateItemSchema.safeParse(item)
        if (parsed.success) {
          allTemplates.push(parsed.data)
        }
        // Invalid items are silently skipped — prefer resilience over strict failure
      }

      nextUrl = data.paging?.next ?? null
    }

    return allTemplates
  }
}

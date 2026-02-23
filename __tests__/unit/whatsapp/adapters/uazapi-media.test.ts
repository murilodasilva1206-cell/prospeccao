import { describe, it, expect } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../../mocks/server'
import { UazapiAdapter } from '@/lib/whatsapp/adapters/uazapi'
import type { Channel, ChannelCredentials } from '@/lib/whatsapp/types'

function makeChannel(): Channel {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    workspace_id: 'ws-3',
    name: 'Test UAZAPI',
    provider: 'UAZAPI',
    status: 'CONNECTED',
    phone_number: '+5531977770000',
    external_instance_id: 'instance-uazapi-xyz',
    credentials_encrypted: 'fake-blob',
    webhook_secret: 'uazapi-secret',
    last_seen_at: null,
    created_at: new Date(),
    updated_at: new Date(),
  }
}

const creds: ChannelCredentials = {
  instance_url: 'https://uazapi.example.com',
  api_key: 'uazapi-api-key-456',
}

const adapter = new UazapiAdapter()
const channel = makeChannel()
const BASE = 'https://uazapi.example.com'

// ---------------------------------------------------------------------------
// sendMedia
// ---------------------------------------------------------------------------

describe('UazapiAdapter.sendMedia', () => {
  it('sends file as base64 and returns id', async () => {
    server.use(
      http.post(`${BASE}/message/sendFile`, () =>
        HttpResponse.json({ id: 'uazapi-media-id-789' }),
      ),
    )
    const buf = Buffer.from('fake video bytes')
    const result = await adapter.sendMedia(channel, creds, '5531977770000', buf, 'video/mp4', 'video.mp4', 'Video legal')
    expect(result.message_id).toBe('uazapi-media-id-789')
  })
})

// ---------------------------------------------------------------------------
// sendSticker
// ---------------------------------------------------------------------------

describe('UazapiAdapter.sendSticker', () => {
  it('sends sticker via sendSticker endpoint', async () => {
    server.use(
      http.post(`${BASE}/message/sendSticker`, () =>
        HttpResponse.json({ id: 'uazapi-sticker-id' }),
      ),
    )
    const result = await adapter.sendSticker(channel, creds, '5531977770000', Buffer.from('webp bytes'))
    expect(result.message_id).toBe('uazapi-sticker-id')
  })
})

// ---------------------------------------------------------------------------
// downloadMedia
// ---------------------------------------------------------------------------

describe('UazapiAdapter.downloadMedia', () => {
  it('downloads base64 content from downloadMedia endpoint', async () => {
    const fakeContent = Buffer.from('audio content here')
    const base64 = fakeContent.toString('base64')

    server.use(
      http.get(`${BASE}/message/downloadMedia`, () =>
        HttpResponse.json({ base64, mimetype: 'audio/ogg', filename: 'audio.ogg' }),
      ),
    )

    const result = await adapter.downloadMedia(channel, creds, 'uazapi-media-id-xyz')
    expect(result.mime).toBe('audio/ogg')
    expect(result.filename).toBe('audio.ogg')
    expect(result.buffer.toString()).toBe('audio content here')
  })
})

// ---------------------------------------------------------------------------
// normalizeInboundEvent
// ---------------------------------------------------------------------------

describe('UazapiAdapter.normalizeInboundEvent', () => {
  it('normalizes text message', () => {
    const payload = {
      type: 'message',
      messageId: 'uaz-msg-1',
      from: '5531977770000',
      fromMe: false,
      body: 'Oi, tudo bem?',
      timestamp: 1700000000,
    }
    const event = adapter.normalizeInboundEvent(payload)
    expect(event).not.toBeNull()
    expect(event!.type).toBe('message.received')
    expect(event!.payload.body).toBe('Oi, tudo bem?')
    expect(event!.payload.message_type).toBe('text')
  })

  it('normalizes image message', () => {
    const payload = {
      type: 'message',
      messageId: 'uaz-img-1',
      from: '5531977770000',
      fromMe: false,
      mediaType: 'image',
      mimetype: 'image/jpeg',
      caption: 'foto aqui',
      filename: 'foto.jpg',
      timestamp: 1700000001,
    }
    const event = adapter.normalizeInboundEvent(payload)
    expect(event).not.toBeNull()
    expect(event!.payload.message_type).toBe('image')
    expect(event!.payload.mime_type).toBe('image/jpeg')
    expect(event!.payload.caption).toBe('foto aqui')
  })

  it('normalizes reaction message', () => {
    const payload = {
      type: 'message',
      messageId: 'uaz-react-1',
      from: '5531977770000',
      fromMe: false,
      emoji: '🎉',
      reactionTo: 'uaz-original-msg',
      timestamp: 1700000002,
    }
    const event = adapter.normalizeInboundEvent(payload)
    expect(event).not.toBeNull()
    expect(event!.payload.message_type).toBe('reaction')
    expect(event!.payload.emoji).toBe('🎉')
    expect(event!.payload.reaction_to).toBe('uaz-original-msg')
  })

  it('returns null for outbound messages (fromMe: true)', () => {
    const payload = { type: 'message', messageId: 'uaz-out-1', from: '5531977770000', fromMe: true, body: 'sent' }
    const result = adapter.normalizeInboundEvent(payload)
    expect(result).toBeNull()
  })

  it('returns null for non-message events', () => {
    const result = adapter.normalizeInboundEvent({ type: 'connection', status: 'connected' })
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// normalizeStatusEvent
// ---------------------------------------------------------------------------

describe('UazapiAdapter.normalizeStatusEvent', () => {
  it('maps ack=1 to message.sent', () => {
    const payload = { type: 'message.ack', messageId: 'uaz-msg-50', ack: 1 }
    const event = adapter.normalizeStatusEvent(payload)
    expect(event).not.toBeNull()
    expect(event!.type).toBe('message.sent')
  })

  it('maps ack=2 to message.delivered', () => {
    const payload = { type: 'ack', messageId: 'uaz-msg-51', ack: 2 }
    const event = adapter.normalizeStatusEvent(payload)
    expect(event!.type).toBe('message.delivered')
  })

  it('maps ack=3 to message.read', () => {
    const payload = { type: 'message.ack', messageId: 'uaz-msg-52', ack: 3 }
    const event = adapter.normalizeStatusEvent(payload)
    expect(event!.type).toBe('message.read')
  })

  it('returns null for non-ack events', () => {
    const result = adapter.normalizeStatusEvent({ type: 'connection', status: 'ok' })
    expect(result).toBeNull()
  })
})

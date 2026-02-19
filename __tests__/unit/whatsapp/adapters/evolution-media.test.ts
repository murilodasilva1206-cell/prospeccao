import { describe, it, expect } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../../mocks/server'
import { EvolutionAdapter } from '@/lib/whatsapp/adapters/evolution'
import type { Channel, ChannelCredentials } from '@/lib/whatsapp/types'

function makeChannel(): Channel {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    workspace_id: 'ws-2',
    name: 'Test Evolution',
    provider: 'EVOLUTION',
    status: 'CONNECTED',
    phone_number: '+5521988880000',
    external_instance_id: 'prospeccao-22222222',
    credentials_encrypted: 'fake-blob',
    webhook_secret: 'evo-secret-key',
    last_seen_at: null,
    created_at: new Date(),
    updated_at: new Date(),
  }
}

const creds: ChannelCredentials = {
  instance_url: 'https://evo.example.com',
  api_key: 'evo-api-key-123',
}

const adapter = new EvolutionAdapter()
const channel = makeChannel()
const BASE = 'https://evo.example.com'

// ---------------------------------------------------------------------------
// sendMedia
// ---------------------------------------------------------------------------

describe('EvolutionAdapter.sendMedia', () => {
  it('sends media as base64 and returns key.id', async () => {
    server.use(
      http.post(`${BASE}/message/sendMedia/${channel.external_instance_id}`, () =>
        HttpResponse.json({ key: { id: 'evo-media-msg-id' } }),
      ),
    )
    const buf = Buffer.from('fake image content')
    const result = await adapter.sendMedia(channel, creds, '5521988880000', buf, 'image/jpeg', 'img.jpg', 'caption')
    expect(result.message_id).toBe('evo-media-msg-id')
  })

  it('throws on HTTP error', async () => {
    server.use(
      http.post(`${BASE}/message/sendMedia/${channel.external_instance_id}`, () =>
        HttpResponse.json({ error: 'fail' }, { status: 500 }),
      ),
    )
    await expect(
      adapter.sendMedia(channel, creds, '5521988880000', Buffer.from('x'), 'image/jpeg', 'img.jpg'),
    ).rejects.toThrow('500')
  })
})

// ---------------------------------------------------------------------------
// sendAudio — uses /sendWhatsAppAudio
// ---------------------------------------------------------------------------

describe('EvolutionAdapter.sendAudio', () => {
  it('sends audio with encoding:true', async () => {
    server.use(
      http.post(`${BASE}/message/sendWhatsAppAudio/${channel.external_instance_id}`, () =>
        HttpResponse.json({ key: { id: 'evo-audio-id' } }),
      ),
    )
    const result = await adapter.sendAudio(channel, creds, '5521988880000', Buffer.from('audio'))
    expect(result.message_id).toBe('evo-audio-id')
  })
})

// ---------------------------------------------------------------------------
// downloadMedia
// ---------------------------------------------------------------------------

describe('EvolutionAdapter.downloadMedia', () => {
  it('fetches base64 content from getBase64FromMediaMessage', async () => {
    const fakeBase64 = Buffer.from('fake image bytes').toString('base64')
    server.use(
      http.post(`${BASE}/chat/getBase64FromMediaMessage/${channel.external_instance_id}`, () =>
        HttpResponse.json({ base64: fakeBase64, mediaType: 'image/jpeg', fileName: 'photo.jpg' }),
      ),
    )
    const result = await adapter.downloadMedia(channel, creds, 'evo-msg-id-abc')
    expect(result.mime).toBe('image/jpeg')
    expect(result.filename).toBe('photo.jpg')
    expect(result.buffer.toString()).toBe('fake image bytes')
  })
})

// ---------------------------------------------------------------------------
// normalizeInboundEvent
// ---------------------------------------------------------------------------

describe('EvolutionAdapter.normalizeInboundEvent', () => {
  it('normalizes text message', () => {
    const payload = {
      event: 'messages.upsert',
      data: {
        key: { id: 'evo-msg-1', remoteJid: '5521988880000@s.whatsapp.net', fromMe: false },
        message: { conversation: 'Ola!' },
        messageType: 'conversation',
        pushName: 'Joao',
        messageTimestamp: 1700000000,
      },
    }
    const event = adapter.normalizeInboundEvent(payload)
    expect(event).not.toBeNull()
    expect(event!.type).toBe('message.received')
    expect(event!.payload.body).toBe('Ola!')
    expect(event!.payload.message_type).toBe('text')
    expect(event!.payload.contact_name).toBe('Joao')
  })

  it('normalizes imageMessage', () => {
    const payload = {
      event: 'messages.upsert',
      data: {
        key: { id: 'evo-img-1', remoteJid: '5521988880000@s.whatsapp.net', fromMe: false },
        message: { imageMessage: { mimetype: 'image/jpeg', caption: 'Look at this' } },
        messageTimestamp: 1700000001,
      },
    }
    const event = adapter.normalizeInboundEvent(payload)
    expect(event).not.toBeNull()
    expect(event!.payload.message_type).toBe('image')
    expect(event!.payload.mime_type).toBe('image/jpeg')
    expect(event!.payload.caption).toBe('Look at this')
  })

  it('normalizes reactionMessage', () => {
    const payload = {
      event: 'messages.upsert',
      data: {
        key: { id: 'evo-react-1', remoteJid: '5521988880000@s.whatsapp.net', fromMe: false },
        message: {
          reactionMessage: {
            key: { id: 'evo-original-msg', fromMe: true },
            text: '❤️',
          },
        },
        messageTimestamp: 1700000002,
      },
    }
    const event = adapter.normalizeInboundEvent(payload)
    expect(event).not.toBeNull()
    expect(event!.payload.message_type).toBe('reaction')
    expect(event!.payload.emoji).toBe('❤️')
    expect(event!.payload.reaction_to).toBe('evo-original-msg')
  })

  it('returns null for outbound messages (fromMe: true)', () => {
    const payload = {
      event: 'messages.upsert',
      data: {
        key: { id: 'evo-out-1', remoteJid: '5521988880000@s.whatsapp.net', fromMe: true },
        message: { conversation: 'sent by me' },
        messageTimestamp: 1700000003,
      },
    }
    const result = adapter.normalizeInboundEvent(payload)
    expect(result).toBeNull()
  })

  it('returns null for non-messages.upsert events', () => {
    const result = adapter.normalizeInboundEvent({ event: 'connection.update', data: {} })
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// normalizeStatusEvent
// ---------------------------------------------------------------------------

describe('EvolutionAdapter.normalizeStatusEvent', () => {
  it('maps SERVER_ACK to message.sent', () => {
    const payload = {
      event: 'messages.update',
      data: {
        key: { id: 'evo-msg-99', remoteJid: '5521988880000@s.whatsapp.net' },
        update: { status: 'SERVER_ACK' },
      },
    }
    const event = adapter.normalizeStatusEvent(payload)
    expect(event).not.toBeNull()
    expect(event!.type).toBe('message.sent')
    expect(event!.payload.message_id).toBe('evo-msg-99')
  })

  it('maps READ to message.read', () => {
    const payload = {
      event: 'messages.update',
      data: {
        key: { id: 'evo-msg-100', remoteJid: '5521988880000@s.whatsapp.net' },
        update: { status: 'READ' },
      },
    }
    const event = adapter.normalizeStatusEvent(payload)
    expect(event!.type).toBe('message.read')
  })

  it('returns null for non-messages.update events', () => {
    const result = adapter.normalizeStatusEvent({ event: 'messages.upsert', data: {} })
    expect(result).toBeNull()
  })
})

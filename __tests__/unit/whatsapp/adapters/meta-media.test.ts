import { describe, it, expect } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../../mocks/server'
import { MetaAdapter } from '@/lib/whatsapp/adapters/meta'
import type { Channel, ChannelCredentials } from '@/lib/whatsapp/types'

const GRAPH_BASE = 'https://graph.facebook.com/v18.0'

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    workspace_id: 'ws-1',
    name: 'Test Meta',
    provider: 'META_CLOUD',
    status: 'CONNECTED',
    phone_number: '+5511999990000',
    external_instance_id: '109876543210',
    credentials_encrypted: 'fake-blob',
    webhook_secret: 'whsec_test',
    last_seen_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  }
}

const creds: ChannelCredentials = {
  access_token: 'EAABtest123',
  phone_number_id: '109876543210',
  app_secret: 'app_secret_value',
}

const adapter = new MetaAdapter()
const channel = makeChannel()

// ---------------------------------------------------------------------------
// sendMedia
// ---------------------------------------------------------------------------

describe('MetaAdapter.sendMedia', () => {
  it('uploads media then sends message, returns message_id', async () => {
    server.use(
      http.post(`${GRAPH_BASE}/${creds.phone_number_id}/media`, () =>
        HttpResponse.json({ id: 'media-id-123' }),
      ),
      http.post(`${GRAPH_BASE}/${creds.phone_number_id}/messages`, () =>
        HttpResponse.json({ messages: [{ id: 'wamid.IMAGEMESSAGEID' }] }),
      ),
    )
    const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(96).fill(0)])
    const result = await adapter.sendMedia(channel, creds, '5511999990000', JPEG_MAGIC, 'image/jpeg', 'photo.jpg', 'Olha isso')
    expect(result.message_id).toBe('wamid.IMAGEMESSAGEID')
  })

  it('throws when media upload fails', async () => {
    server.use(
      http.post(`${GRAPH_BASE}/${creds.phone_number_id}/media`, () =>
        HttpResponse.json({ error: 'upload failed' }, { status: 400 }),
      ),
    )
    const buf = Buffer.from([0xff, 0xd8, 0xff])
    await expect(adapter.sendMedia(channel, creds, '5511999990000', buf, 'image/jpeg', 'p.jpg')).rejects.toThrow('400')
  })
})

// ---------------------------------------------------------------------------
// downloadMedia
// ---------------------------------------------------------------------------

describe('MetaAdapter.downloadMedia', () => {
  it('fetches media info then downloads content', async () => {
    const fakeContent = Buffer.from([0xff, 0xd8, 0xff, 0xe0])

    server.use(
      http.get(`${GRAPH_BASE}/media-abc-123`, () =>
        HttpResponse.json({ url: 'https://example.com/media-abc-123.jpg', mime_type: 'image/jpeg' }),
      ),
      http.get('https://example.com/media-abc-123.jpg', () =>
        new HttpResponse(fakeContent, { headers: { 'Content-Type': 'image/jpeg' } }),
      ),
    )

    const result = await adapter.downloadMedia(channel, creds, 'media-abc-123')
    expect(result.mime).toBe('image/jpeg')
    expect(result.filename).toContain('meta-media-abc-123')
    expect(result.buffer.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// normalizeInboundEvent
// ---------------------------------------------------------------------------

describe('MetaAdapter.normalizeInboundEvent', () => {
  function makeWebhookPayload(message: Record<string, unknown>) {
    return {
      entry: [{
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '15551234567', phone_number_id: '109876543210' },
            messages: [message],
          },
        }],
      }],
    }
  }

  it('normalizes text message', () => {
    const payload = makeWebhookPayload({
      id: 'wamid.TEXT001',
      from: '5511999990000',
      timestamp: '1700000000',
      type: 'text',
      text: { body: 'Hello world' },
    })
    const event = adapter.normalizeInboundEvent(payload)
    expect(event).not.toBeNull()
    expect(event!.type).toBe('message.received')
    expect(event!.payload.body).toBe('Hello world')
    expect(event!.payload.message_type).toBe('text')
    expect(event!.event_id).toBe('wamid.TEXT001')
  })

  it('normalizes image message with caption', () => {
    const payload = makeWebhookPayload({
      id: 'wamid.IMAGE001',
      from: '5511999990000',
      timestamp: '1700000001',
      type: 'image',
      image: { id: 'img-media-id', mime_type: 'image/jpeg', caption: 'My photo' },
    })
    const event = adapter.normalizeInboundEvent(payload)
    expect(event).not.toBeNull()
    expect(event!.payload.message_type).toBe('image')
    expect(event!.payload.media_id).toBe('img-media-id')
    expect(event!.payload.caption).toBe('My photo')
    expect(event!.payload.mime_type).toBe('image/jpeg')
  })

  it('normalizes reaction message', () => {
    const payload = makeWebhookPayload({
      id: 'wamid.REACT001',
      from: '5511999990000',
      timestamp: '1700000002',
      type: 'reaction',
      reaction: { message_id: 'wamid.ORIGINAL', emoji: '👍' },
    })
    const event = adapter.normalizeInboundEvent(payload)
    expect(event).not.toBeNull()
    expect(event!.payload.message_type).toBe('reaction')
    expect(event!.payload.emoji).toBe('👍')
    expect(event!.payload.reaction_to).toBe('wamid.ORIGINAL')
  })

  it('returns null when no messages in payload', () => {
    const payload = { entry: [{ changes: [{ value: { messages: [] } }] }] }
    const result = adapter.normalizeInboundEvent(payload)
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// normalizeStatusEvent
// ---------------------------------------------------------------------------

describe('MetaAdapter.normalizeStatusEvent', () => {
  function makeStatusPayload(status: Record<string, unknown>) {
    return {
      entry: [{
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            statuses: [status],
          },
        }],
      }],
    }
  }

  it('maps "delivered" status to message.delivered event', () => {
    const payload = makeStatusPayload({ id: 'wamid.MSG001', status: 'delivered', timestamp: '1700000010' })
    const event = adapter.normalizeStatusEvent(payload)
    expect(event).not.toBeNull()
    expect(event!.type).toBe('message.delivered')
    expect(event!.payload.message_id).toBe('wamid.MSG001')
  })

  it('maps "read" status to message.read event', () => {
    const payload = makeStatusPayload({ id: 'wamid.MSG002', status: 'read', timestamp: '1700000011' })
    const event = adapter.normalizeStatusEvent(payload)
    expect(event!.type).toBe('message.read')
  })

  it('returns null when no statuses in payload', () => {
    const result = adapter.normalizeStatusEvent({ entry: [{ changes: [{ value: {} }] }] })
    expect(result).toBeNull()
  })
})

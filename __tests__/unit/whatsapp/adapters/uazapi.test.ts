import { describe, it, expect } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../../mocks/server'
import { UazapiAdapter } from '@/lib/whatsapp/adapters/uazapi'
import type { Channel, ChannelCredentials } from '@/lib/whatsapp/types'

// Uses the global MSW server (managed by vitest.setup.ts).

const BASE = 'https://uaz.example.com'
const INSTANCE_ID = 'uaz-inst-001'

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    workspace_id: 'ws-1',
    name: 'Test UAZAPI',
    provider: 'UAZAPI',
    status: 'DISCONNECTED',
    phone_number: null,
    external_instance_id: INSTANCE_ID,
    credentials_encrypted: 'fake-blob',
    webhook_secret: 'uaz_secret_token',
    last_seen_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  }
}

const creds: ChannelCredentials = {
  instance_url: BASE,
  admin_token: 'uaz-admin-token',
  instance_token: 'uaz-instance-token',
}

const adapter = new UazapiAdapter()

// ---------------------------------------------------------------------------
// createChannel
// ---------------------------------------------------------------------------
describe('UazapiAdapter.createChannel', () => {
  it('returns external_instance_id from API response (id field)', async () => {
    server.use(
      http.post(`${BASE}/instance/init`, () =>
        HttpResponse.json({ id: 'uaz-inst-001', name: 'prospeccao-33333333' }),
      ),
    )
    const result = await adapter.createChannel(makeChannel(), creds)
    expect(result.external_instance_id).toBe('uaz-inst-001')
  })

  it('falls back to name field when id is absent', async () => {
    server.use(
      http.post(`${BASE}/instance/init`, () =>
        HttpResponse.json({ name: 'prospeccao-fallback' }),
      ),
    )
    const result = await adapter.createChannel(makeChannel(), creds)
    expect(result.external_instance_id).toBe('prospeccao-fallback')
  })

  it('throws when API fails', async () => {
    server.use(
      http.post(`${BASE}/instance/init`, () =>
        HttpResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      ),
    )
    await expect(adapter.createChannel(makeChannel(), creds)).rejects.toThrow('401')
  })

  it('throws when creds are missing', async () => {
    await expect(adapter.createChannel(makeChannel(), {})).rejects.toThrow('admin_token')
  })
})

// ---------------------------------------------------------------------------
// startConnection
// ---------------------------------------------------------------------------
describe('UazapiAdapter.startConnection', () => {
  it('returns PENDING_QR with qrcode field', async () => {
    server.use(
      http.post(`${BASE}/instance/connect`, () =>
        HttpResponse.json({ qrcode: 'data:image/png;base64,QRQR' }),
      ),
    )
    const result = await adapter.startConnection(makeChannel(), creds)
    expect(result.status).toBe('PENDING_QR')
    expect(result.qr_code).toBe('data:image/png;base64,QRQR')
  })

  it('returns PENDING_QR with base64 field as fallback', async () => {
    server.use(
      http.post(`${BASE}/instance/connect`, () =>
        HttpResponse.json({ base64: 'data:image/png;base64,B64B64' }),
      ),
    )
    const result = await adapter.startConnection(makeChannel(), creds)
    expect(result.status).toBe('PENDING_QR')
    expect(result.qr_code).toBe('data:image/png;base64,B64B64')
  })

  it('returns CONNECTING when no QR in response', async () => {
    server.use(
      http.post(`${BASE}/instance/connect`, () =>
        HttpResponse.json({}),
      ),
    )
    const result = await adapter.startConnection(makeChannel(), creds)
    expect(result.status).toBe('CONNECTING')
  })

  it('returns ERROR when API fails', async () => {
    server.use(
      http.post(`${BASE}/instance/connect`, () =>
        HttpResponse.json({}, { status: 500 }),
      ),
    )
    const result = await adapter.startConnection(makeChannel(), creds)
    expect(result.status).toBe('ERROR')
  })

  it('throws when external_instance_id is null', async () => {
    await expect(
      adapter.startConnection(makeChannel({ external_instance_id: null }), creds),
    ).rejects.toThrow('external_instance_id')
  })
})

// ---------------------------------------------------------------------------
// getConnectionStatus
// ---------------------------------------------------------------------------
describe('UazapiAdapter.getConnectionStatus', () => {
  it('returns CONNECTED when connected=true', async () => {
    server.use(
      http.get(`${BASE}/instance/status`, () =>
        HttpResponse.json({ connected: true }),
      ),
    )
    const status = await adapter.getConnectionStatus(makeChannel(), creds)
    expect(status).toBe('CONNECTED')
  })

  it('returns CONNECTED from status string', async () => {
    server.use(
      http.get(`${BASE}/instance/status`, () =>
        HttpResponse.json({ status: 'connected' }),
      ),
    )
    const status = await adapter.getConnectionStatus(makeChannel(), creds)
    expect(status).toBe('CONNECTED')
  })

  it('returns PENDING_QR for qr status', async () => {
    server.use(
      http.get(`${BASE}/instance/status`, () =>
        HttpResponse.json({ status: 'qr' }),
      ),
    )
    const status = await adapter.getConnectionStatus(makeChannel(), creds)
    expect(status).toBe('PENDING_QR')
  })

  it('returns DISCONNECTED when external_instance_id is null', async () => {
    const status = await adapter.getConnectionStatus(
      makeChannel({ external_instance_id: null }),
      creds,
    )
    expect(status).toBe('DISCONNECTED')
  })

  it('returns ERROR when API fails', async () => {
    server.use(
      http.get(`${BASE}/instance/status`, () =>
        HttpResponse.json({}, { status: 503 }),
      ),
    )
    const status = await adapter.getConnectionStatus(makeChannel(), creds)
    expect(status).toBe('ERROR')
  })
})

// ---------------------------------------------------------------------------
// sendMessage
// ---------------------------------------------------------------------------
describe('UazapiAdapter.sendMessage', () => {
  it('returns message_id from id field', async () => {
    server.use(
      http.post(`${BASE}/message/send`, () =>
        HttpResponse.json({ id: 'uaz-out-001' }),
      ),
    )
    const result = await adapter.sendMessage(makeChannel(), creds, '5511999990000', 'Ola!')
    expect(result.message_id).toBe('uaz-out-001')
  })

  it('falls back to messageId field', async () => {
    server.use(
      http.post(`${BASE}/message/send`, () =>
        HttpResponse.json({ messageId: 'uaz-out-002' }),
      ),
    )
    const result = await adapter.sendMessage(makeChannel(), creds, '5511999990000', 'Ola!')
    expect(result.message_id).toBe('uaz-out-002')
  })

  it('throws when API fails', async () => {
    server.use(
      http.post(`${BASE}/message/send`, () =>
        HttpResponse.json({}, { status: 400 }),
      ),
    )
    await expect(
      adapter.sendMessage(makeChannel(), creds, '5511999990000', 'Ola!'),
    ).rejects.toThrow('400')
  })
})

// ---------------------------------------------------------------------------
// Header contract — createChannel must use admintoken, instance ops must use token
// ---------------------------------------------------------------------------
describe('UazapiAdapter header contract', () => {
  it('createChannel sends admintoken header (not Authorization Bearer)', async () => {
    let capturedHeaders: Record<string, string> = {}
    server.use(
      http.post(`${BASE}/instance/init`, ({ request }) => {
        request.headers.forEach((val, key) => { capturedHeaders[key] = val })
        return HttpResponse.json({ id: 'inst-hdr-001' })
      }),
    )
    await adapter.createChannel(makeChannel(), creds)
    expect(capturedHeaders['admintoken']).toBe('uaz-admin-token')
    expect(capturedHeaders['authorization']).toBeUndefined()
  })

  it('startConnection sends token header (not Authorization Bearer)', async () => {
    let capturedHeaders: Record<string, string> = {}
    server.use(
      http.post(`${BASE}/instance/connect`, ({ request }) => {
        request.headers.forEach((val, key) => { capturedHeaders[key] = val })
        return HttpResponse.json({ qrcode: 'data:image/png;base64,QR' })
      }),
    )
    await adapter.startConnection(makeChannel(), creds)
    expect(capturedHeaders['token']).toBe('uaz-instance-token')
    expect(capturedHeaders['authorization']).toBeUndefined()
  })

  it('sendMessage sends token header', async () => {
    let capturedHeaders: Record<string, string> = {}
    server.use(
      http.post(`${BASE}/message/send`, ({ request }) => {
        request.headers.forEach((val, key) => { capturedHeaders[key] = val })
        return HttpResponse.json({ id: 'msg-hdr-001' })
      }),
    )
    await adapter.sendMessage(makeChannel(), creds, '5511999990000', 'Ola!')
    expect(capturedHeaders['token']).toBe('uaz-instance-token')
    expect(capturedHeaders['authorization']).toBeUndefined()
  })

  it('throws when only api_key is provided (old creds format)', async () => {
    const oldCreds: ChannelCredentials = { instance_url: BASE, api_key: 'old-key' }
    await expect(adapter.createChannel(makeChannel(), oldCreds)).rejects.toThrow('admin_token')
  })
})

// ---------------------------------------------------------------------------
// verifyWebhookSignature
// ---------------------------------------------------------------------------
describe('UazapiAdapter.verifyWebhookSignature', () => {
  it('returns true when Authorization Bearer matches webhook_secret', () => {
    const channel = makeChannel({ webhook_secret: 'uaz_secret_token' })
    const headers = new Headers({ authorization: 'Bearer uaz_secret_token' })
    expect(adapter.verifyWebhookSignature(channel, creds, headers, '{}')).toBe(true)
  })

  it('returns false for wrong Bearer token', () => {
    const channel = makeChannel({ webhook_secret: 'uaz_secret_token' })
    const headers = new Headers({ authorization: 'Bearer wrong_token' })
    expect(adapter.verifyWebhookSignature(channel, creds, headers, '{}')).toBe(false)
  })

  it('handles missing Authorization header', () => {
    const channel = makeChannel({ webhook_secret: 'uaz_secret_token' })
    const headers = new Headers()
    expect(adapter.verifyWebhookSignature(channel, creds, headers, '{}')).toBe(false)
  })

  it('handles raw token without Bearer prefix', () => {
    const channel = makeChannel({ webhook_secret: 'uaz_secret_token' })
    // Without 'Bearer ' prefix the adapter compares the raw header value
    const headers = new Headers({ authorization: 'uaz_secret_token' })
    expect(adapter.verifyWebhookSignature(channel, creds, headers, '{}')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// normalizeEvent
// ---------------------------------------------------------------------------
describe('UazapiAdapter.normalizeEvent', () => {
  it('normalizes an inbound message', () => {
    const raw = {
      type: 'message.received',
      messageId: 'uaz-msg-001',
      from: '5511988880000',
      fromMe: false,
      body: 'Ola mundo',
    }
    const event = adapter.normalizeEvent(raw)
    expect(event.type).toBe('message.received')
    expect(event.event_id).toBe('uaz-msg-001')
    expect(event.payload.body).toBe('Ola mundo')
  })

  it('normalizes a "message" type event', () => {
    const raw = {
      type: 'message',
      messageId: 'uaz-msg-002',
      from: '5511988880001',
      fromMe: false,
      body: 'Texto',
    }
    const event = adapter.normalizeEvent(raw)
    expect(event.type).toBe('message.received')
  })

  it('marks outbound messages as message.sent', () => {
    const raw = {
      type: 'message',
      messageId: 'uaz-msg-003',
      fromMe: true,
      body: 'Resposta',
    }
    const event = adapter.normalizeEvent(raw)
    expect(event.type).toBe('message.sent')
  })

  it('normalizes QR event', () => {
    const raw = { type: 'qr', qrcode: 'data:image/png;base64,QRQR' }
    const event = adapter.normalizeEvent(raw)
    expect(event.type).toBe('qr.updated')
    expect(event.payload.qr_code).toBe('data:image/png;base64,QRQR')
  })

  it('normalizes connection event', () => {
    const raw = { type: 'connection', status: 'connected' }
    const event = adapter.normalizeEvent(raw)
    expect(event.type).toBe('connection.update')
    expect(event.payload.status).toBe('connected')
  })

  it('normalizes ack=-1 → message.failed', () => {
    const raw = {
      type: 'message.ack',
      messageId: 'uaz-ack-fail-001',
      ack: -1,
      error: 'Phone not registered',
    }
    const event = adapter.normalizeEvent(raw)
    expect(event.type).toBe('message.failed')
    expect(event.event_id).toBe('uaz-ack-fail-001-ack-1')
    expect(event.payload.message_id).toBe('uaz-ack-fail-001')
    expect(event.payload.status).toBe('failed')
    expect(event.payload.error_reason).toBe('Phone not registered')
  })

  it('normalizes ack=0 → message.failed', () => {
    const raw = {
      type: 'ack',
      messageId: 'uaz-ack-fail-002',
      ack: 0,
    }
    const event = adapter.normalizeEvent(raw)
    expect(event.type).toBe('message.failed')
    expect(event.payload.status).toBe('failed')
    expect(event.payload.error_reason).toBeNull()
  })

  it('normalizes ack=1 → message.sent', () => {
    const raw = { type: 'message.ack', messageId: 'uaz-ack-001', ack: 1 }
    const event = adapter.normalizeEvent(raw)
    expect(event.type).toBe('message.sent')
    expect(event.payload.status).toBe('sent')
  })

  it('normalizes ack=2 → message.delivered', () => {
    const raw = { type: 'message.ack', messageId: 'uaz-ack-002', ack: 2 }
    const event = adapter.normalizeEvent(raw)
    expect(event.type).toBe('message.delivered')
    expect(event.payload.status).toBe('delivered')
  })

  it('normalizes ack=3 → message.read', () => {
    const raw = { type: 'message.ack', messageId: 'uaz-ack-003', ack: 3 }
    const event = adapter.normalizeEvent(raw)
    expect(event.type).toBe('message.read')
    expect(event.payload.status).toBe('read')
  })

  it('falls back for unknown event type', () => {
    const event = adapter.normalizeEvent({ type: 'unknown' })
    expect(event.type).toBe('connection.update')
  })
})

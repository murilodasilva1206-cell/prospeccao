import { describe, it, expect } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../../mocks/server'
import { EvolutionAdapter } from '@/lib/whatsapp/adapters/evolution'
import type { Channel, ChannelCredentials } from '@/lib/whatsapp/types'

// Uses the global MSW server (managed by vitest.setup.ts).

const BASE = 'https://evo.example.com'

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    workspace_id: 'ws-1',
    name: 'Test Evolution',
    provider: 'EVOLUTION',
    status: 'DISCONNECTED',
    phone_number: null,
    external_instance_id: 'prospeccao-22222222',
    credentials_encrypted: 'fake-blob',
    webhook_secret: 'evo_secret',
    last_seen_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  }
}

const creds: ChannelCredentials = {
  instance_url: BASE,
  api_key: 'my-evo-api-key',
}

const adapter = new EvolutionAdapter()

// ---------------------------------------------------------------------------
// createChannel
// ---------------------------------------------------------------------------
describe('EvolutionAdapter.createChannel', () => {
  it('returns external_instance_id from API response', async () => {
    server.use(
      http.post(`${BASE}/instance/create`, () =>
        HttpResponse.json({ instance: { instanceName: 'prospeccao-22222222' } }),
      ),
    )
    const result = await adapter.createChannel(makeChannel(), creds)
    expect(result.external_instance_id).toBe('prospeccao-22222222')
  })

  it('falls back to generated name when API omits instanceName', async () => {
    server.use(
      http.post(`${BASE}/instance/create`, () =>
        HttpResponse.json({ instance: {} }),
      ),
    )
    const result = await adapter.createChannel(makeChannel(), creds)
    expect(result.external_instance_id).toMatch(/^prospeccao-/)
  })

  it('throws when API returns error', async () => {
    server.use(
      http.post(`${BASE}/instance/create`, () =>
        HttpResponse.json({ error: 'Forbidden' }, { status: 403 }),
      ),
    )
    await expect(adapter.createChannel(makeChannel(), creds)).rejects.toThrow('403')
  })

  it('throws when creds are missing', async () => {
    await expect(adapter.createChannel(makeChannel(), {})).rejects.toThrow('api_key')
  })
})

// ---------------------------------------------------------------------------
// startConnection
// ---------------------------------------------------------------------------
describe('EvolutionAdapter.startConnection', () => {
  it('returns PENDING_QR when QR code is returned', async () => {
    server.use(
      http.get(`${BASE}/instance/connect/prospeccao-22222222`, () =>
        HttpResponse.json({ base64: 'data:image/png;base64,AQID' }),
      ),
    )
    const result = await adapter.startConnection(makeChannel(), creds)
    expect(result.status).toBe('PENDING_QR')
    expect(result.qr_code).toBe('data:image/png;base64,AQID')
  })

  it('returns CONNECTING when no QR in response', async () => {
    server.use(
      http.get(`${BASE}/instance/connect/prospeccao-22222222`, () =>
        HttpResponse.json({}),
      ),
    )
    const result = await adapter.startConnection(makeChannel(), creds)
    expect(result.status).toBe('CONNECTING')
  })

  it('returns ERROR when API fails', async () => {
    server.use(
      http.get(`${BASE}/instance/connect/prospeccao-22222222`, () =>
        HttpResponse.json({}, { status: 500 }),
      ),
    )
    const result = await adapter.startConnection(makeChannel(), creds)
    expect(result.status).toBe('ERROR')
  })

  it('throws when external_instance_id is not set', async () => {
    const channel = makeChannel({ external_instance_id: null })
    await expect(adapter.startConnection(channel, creds)).rejects.toThrow('external_instance_id')
  })
})

// ---------------------------------------------------------------------------
// getConnectionStatus
// ---------------------------------------------------------------------------
describe('EvolutionAdapter.getConnectionStatus', () => {
  it('returns CONNECTED for state=open', async () => {
    server.use(
      http.get(`${BASE}/instance/connectionState/prospeccao-22222222`, () =>
        HttpResponse.json({ instance: { state: 'open' } }),
      ),
    )
    const status = await adapter.getConnectionStatus(makeChannel(), creds)
    expect(status).toBe('CONNECTED')
  })

  it('returns DISCONNECTED for state=close', async () => {
    server.use(
      http.get(`${BASE}/instance/connectionState/prospeccao-22222222`, () =>
        HttpResponse.json({ instance: { state: 'close' } }),
      ),
    )
    const status = await adapter.getConnectionStatus(makeChannel(), creds)
    expect(status).toBe('DISCONNECTED')
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
      http.get(`${BASE}/instance/connectionState/prospeccao-22222222`, () =>
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
describe('EvolutionAdapter.sendMessage', () => {
  it('returns message_id on success', async () => {
    server.use(
      http.post(`${BASE}/message/sendText/prospeccao-22222222`, () =>
        HttpResponse.json({ key: { id: 'evo-msg-001' } }),
      ),
    )
    const result = await adapter.sendMessage(makeChannel(), creds, '5511999990000', 'Ola!')
    expect(result.message_id).toBe('evo-msg-001')
  })

  it('throws when API returns error status', async () => {
    server.use(
      http.post(`${BASE}/message/sendText/prospeccao-22222222`, () =>
        HttpResponse.json({}, { status: 400 }),
      ),
    )
    await expect(
      adapter.sendMessage(makeChannel(), creds, '5511999990000', 'Ola!'),
    ).rejects.toThrow('400')
  })
})

// ---------------------------------------------------------------------------
// verifyWebhookSignature
// ---------------------------------------------------------------------------
describe('EvolutionAdapter.verifyWebhookSignature', () => {
  it('returns true when apikey header matches webhook_secret', () => {
    const channel = makeChannel({ webhook_secret: 'evo_secret' })
    const headers = new Headers({ apikey: 'evo_secret' })
    expect(adapter.verifyWebhookSignature(channel, creds, headers, '{}')).toBe(true)
  })

  it('returns false for wrong apikey', () => {
    const channel = makeChannel({ webhook_secret: 'evo_secret' })
    const headers = new Headers({ apikey: 'wrong_key' })
    expect(adapter.verifyWebhookSignature(channel, creds, headers, '{}')).toBe(false)
  })

  it('returns false when apikey header is absent', () => {
    const channel = makeChannel({ webhook_secret: 'evo_secret' })
    const headers = new Headers()
    expect(adapter.verifyWebhookSignature(channel, creds, headers, '{}')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// normalizeEvent
// ---------------------------------------------------------------------------
describe('EvolutionAdapter.normalizeEvent', () => {
  it('normalizes an inbound message (messages.upsert)', () => {
    const raw = {
      event: 'messages.upsert',
      data: {
        key: { id: 'evo-key-001', remoteJid: '5511@s.whatsapp.net', fromMe: false },
        message: { conversation: 'Ola!' },
      },
    }
    const event = adapter.normalizeEvent(raw)
    expect(event.type).toBe('message.received')
    expect(event.event_id).toBe('evo-key-001')
    expect(event.payload.body).toBe('Ola!')
  })

  it('normalizes an outbound message (fromMe=true)', () => {
    const raw = {
      event: 'messages.upsert',
      data: {
        key: { id: 'evo-key-002', remoteJid: '5511@s.whatsapp.net', fromMe: true },
        message: { conversation: 'Resposta' },
      },
    }
    const event = adapter.normalizeEvent(raw)
    expect(event.type).toBe('message.sent')
  })

  it('normalizes QR update event', () => {
    const raw = {
      event: 'qrcode.updated',
      data: { qrcode: { base64: 'data:image/png;base64,QR==' } },
    }
    const event = adapter.normalizeEvent(raw)
    expect(event.type).toBe('qr.updated')
    expect(event.payload.qr_code).toBe('data:image/png;base64,QR==')
  })

  it('normalizes connection.update event', () => {
    const raw = {
      event: 'connection.update',
      data: { state: 'open', instance: 'prospeccao-22222222' },
    }
    const event = adapter.normalizeEvent(raw)
    expect(event.type).toBe('connection.update')
    expect(event.payload.state).toBe('open')
  })

  it('falls back to connection.update for unknown event type', () => {
    const event = adapter.normalizeEvent({ event: 'unknown.thing', data: {} })
    expect(event.type).toBe('connection.update')
  })
})

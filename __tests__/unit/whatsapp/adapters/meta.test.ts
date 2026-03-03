import { describe, it, expect } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../../mocks/server'
import { MetaAdapter } from '@/lib/whatsapp/adapters/meta'
import type { Channel, ChannelCredentials } from '@/lib/whatsapp/types'
import { createHmac } from 'crypto'

// Uses the global MSW server (managed by vitest.setup.ts).
// Per-test handlers are registered with server.use() and reset after each test
// by the global afterEach(() => server.resetHandlers()) in vitest.setup.ts.

const GRAPH_BASE = 'https://graph.facebook.com/v18.0'

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    workspace_id: 'ws-1',
    name: 'Test Meta',
    provider: 'META_CLOUD',
    status: 'DISCONNECTED',
    phone_number: null,
    external_instance_id: null,
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

// ---------------------------------------------------------------------------
// createChannel
// ---------------------------------------------------------------------------
describe('MetaAdapter.createChannel', () => {
  it('returns external_instance_id when Graph API is valid', async () => {
    server.use(
      http.get(`${GRAPH_BASE}/${creds.phone_number_id}`, () =>
        HttpResponse.json({ id: creds.phone_number_id, display_phone_number: '+5511999990000' }),
      ),
    )
    const result = await adapter.createChannel(makeChannel(), creds)
    expect(result.external_instance_id).toBe(creds.phone_number_id)
  })

  it('throws when Graph API returns 401', async () => {
    server.use(
      http.get(`${GRAPH_BASE}/${creds.phone_number_id}`, () =>
        HttpResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      ),
    )
    await expect(adapter.createChannel(makeChannel(), creds)).rejects.toThrow('401')
  })

  it('throws when access_token is missing', async () => {
    await expect(
      adapter.createChannel(makeChannel(), { phone_number_id: '123' }),
    ).rejects.toThrow('access_token')
  })
})

// ---------------------------------------------------------------------------
// startConnection
// ---------------------------------------------------------------------------
describe('MetaAdapter.startConnection', () => {
  it('returns CONNECTED when token is valid', async () => {
    server.use(
      http.get(`${GRAPH_BASE}/${creds.phone_number_id}`, () =>
        HttpResponse.json({
          id: creds.phone_number_id,
          display_phone_number: '+5511999990000',
        }),
      ),
    )
    const result = await adapter.startConnection(makeChannel(), creds)
    expect(result.status).toBe('CONNECTED')
    expect(result.phone_number).toBe('+5511999990000')
  })

  it('returns ERROR when token is invalid', async () => {
    server.use(
      http.get(`${GRAPH_BASE}/${creds.phone_number_id}`, () =>
        HttpResponse.json({}, { status: 403 }),
      ),
    )
    const result = await adapter.startConnection(makeChannel(), creds)
    expect(result.status).toBe('ERROR')
  })
})

// ---------------------------------------------------------------------------
// getConnectionStatus
// ---------------------------------------------------------------------------
describe('MetaAdapter.getConnectionStatus', () => {
  it('returns CONNECTED when Graph API responds ok', async () => {
    server.use(
      http.get(`${GRAPH_BASE}/${creds.phone_number_id}`, () =>
        HttpResponse.json({ id: creds.phone_number_id }),
      ),
    )
    const status = await adapter.getConnectionStatus(makeChannel(), creds)
    expect(status).toBe('CONNECTED')
  })

  it('returns ERROR when Graph API fails', async () => {
    server.use(
      http.get(`${GRAPH_BASE}/${creds.phone_number_id}`, () =>
        HttpResponse.json({}, { status: 500 }),
      ),
    )
    const status = await adapter.getConnectionStatus(makeChannel(), creds)
    expect(status).toBe('ERROR')
  })

  it('returns ERROR when credentials are missing', async () => {
    const status = await adapter.getConnectionStatus(makeChannel(), {})
    expect(status).toBe('ERROR')
  })
})

// ---------------------------------------------------------------------------
// disconnect (no-op for Meta — no HTTP calls made)
// ---------------------------------------------------------------------------
describe('MetaAdapter.disconnect', () => {
  it('resolves without making any HTTP call', async () => {
    // Meta disconnect is a no-op; if any fetch occurs the unhandled request
    // handler from vitest.setup.ts would fail this test.
    await expect(adapter.disconnect(makeChannel(), creds)).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// sendMessage
// ---------------------------------------------------------------------------
describe('MetaAdapter.sendMessage', () => {
  it('returns message_id on success', async () => {
    server.use(
      http.post(`${GRAPH_BASE}/${creds.phone_number_id}/messages`, () =>
        HttpResponse.json({ messages: [{ id: 'wamid.abc123' }] }),
      ),
    )
    const result = await adapter.sendMessage(makeChannel(), creds, '5511999990000', 'Ola!')
    expect(result.message_id).toBe('wamid.abc123')
  })

  it('throws when API returns non-ok status', async () => {
    server.use(
      http.post(`${GRAPH_BASE}/${creds.phone_number_id}/messages`, () =>
        HttpResponse.json({ error: 'Bad request' }, { status: 400 }),
      ),
    )
    await expect(
      adapter.sendMessage(makeChannel(), creds, '5511999990000', 'Ola!'),
    ).rejects.toThrow('400')
  })

  it('throws when credentials are missing', async () => {
    await expect(
      adapter.sendMessage(makeChannel(), {}, '5511999990000', 'Ola!'),
    ).rejects.toThrow('access_token')
  })
})

// ---------------------------------------------------------------------------
// verifyWebhookSignature
// ---------------------------------------------------------------------------
describe('MetaAdapter.verifyWebhookSignature', () => {
  it('returns true for correct HMAC-SHA256 signature', () => {
    const rawBody = '{"test":"payload"}'
    const hmac = createHmac('sha256', creds.app_secret!).update(rawBody).digest('hex')
    const headers = new Headers({ 'x-hub-signature-256': `sha256=${hmac}` })
    expect(adapter.verifyWebhookSignature(makeChannel(), creds, headers, rawBody)).toBe(true)
  })

  it('returns false for wrong signature', () => {
    const rawBody = '{"test":"payload"}'
    const headers = new Headers({ 'x-hub-signature-256': 'sha256=wrongsig' })
    expect(adapter.verifyWebhookSignature(makeChannel(), creds, headers, rawBody)).toBe(false)
  })

  it('returns false when header is absent', () => {
    const headers = new Headers()
    expect(
      adapter.verifyWebhookSignature(makeChannel(), creds, headers, '{}'),
    ).toBe(false)
  })

  it('returns false when app_secret is missing from creds', () => {
    const rawBody = '{}'
    const headers = new Headers({ 'x-hub-signature-256': 'sha256=anything' })
    expect(adapter.verifyWebhookSignature(makeChannel(), {}, headers, rawBody)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// normalizeEvent
// ---------------------------------------------------------------------------
describe('MetaAdapter.normalizeEvent', () => {
  it('normalizes an incoming text message', () => {
    const raw = {
      entry: [{
        changes: [{
          value: {
            messages: [{
              id: 'wamid.msg001',
              from: '5511988880000',
              type: 'text',
              timestamp: '1700000000',
              text: { body: 'Ola mundo' },
            }],
          },
        }],
      }],
    }
    const event = adapter.normalizeEvent(raw)
    expect(event.type).toBe('message.received')
    expect(event.event_id).toBe('wamid.msg001')
    expect(event.payload.from).toBe('5511988880000')
    expect(event.payload.body).toBe('Ola mundo')
  })

  it('normalizes a message status update (delivered)', () => {
    const raw = {
      entry: [{
        changes: [{
          value: {
            statuses: [{
              id: 'wamid.msg001',
              status: 'delivered',
              timestamp: '1700000001',
            }],
          },
        }],
      }],
    }
    const event = adapter.normalizeEvent(raw)
    expect(event.type).toBe('message.delivered')
    expect(event.event_id).toBe('wamid.msg001-delivered')
  })

  it('normalizes a read status', () => {
    const raw = {
      entry: [{
        changes: [{
          value: {
            statuses: [{ id: 'wamid.x', status: 'read', timestamp: '1700000002' }],
          },
        }],
      }],
    }
    const event = adapter.normalizeEvent(raw)
    expect(event.type).toBe('message.read')
  })

  it('normalizes a failed status → message.failed', () => {
    const raw = {
      entry: [{
        changes: [{
          value: {
            statuses: [{
              id: 'wamid.fail001',
              status: 'failed',
              timestamp: '1700000003',
              errors: [{ code: 131026, title: 'Message Undeliverable' }],
            }],
          },
        }],
      }],
    }
    const event = adapter.normalizeEvent(raw)
    expect(event.type).toBe('message.failed')
    expect(event.event_id).toBe('wamid.fail001-failed')
    expect(event.payload.message_id).toBe('wamid.fail001')
    expect(event.payload.error_code).toBe(131026)
    expect(event.payload.error_reason).toBe('Message Undeliverable')
  })

  it('normalizes failed status without errors array — error fields are null', () => {
    const raw = {
      entry: [{
        changes: [{
          value: {
            statuses: [{ id: 'wamid.fail002', status: 'failed', timestamp: '1700000004' }],
          },
        }],
      }],
    }
    const event = adapter.normalizeEvent(raw)
    expect(event.type).toBe('message.failed')
    expect(event.payload.error_code).toBeNull()
    expect(event.payload.error_reason).toBeNull()
  })

  it('unknown status value falls through to connection.update (NOT message.sent)', () => {
    // Meta may add new statuses in the future (e.g. 'accepted', 'warning').
    // An unknown status must NEVER be promoted to message.sent as that would
    // incorrectly mark recipients as delivered.
    const raw = {
      entry: [{
        changes: [{
          value: {
            statuses: [{ id: 'wamid.unk001', status: 'accepted', timestamp: '1700000005' }],
          },
        }],
      }],
    }
    const event = adapter.normalizeEvent(raw)
    expect(event.type).not.toBe('message.sent')
    expect(event.type).toBe('connection.update')
  })

  it('falls back to connection.update for unknown payload', () => {
    const event = adapter.normalizeEvent({ unknown: true })
    expect(event.type).toBe('connection.update')
    expect(event.event_id).toBeTruthy()
  })
})

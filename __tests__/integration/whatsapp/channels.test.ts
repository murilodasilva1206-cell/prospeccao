import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { NextRequest } from 'next/server'
import pool from '@/lib/database'
import { GET as listChannels, POST as createChannel } from '@/app/api/whatsapp/channels/route'
import { GET as getChannel } from '@/app/api/whatsapp/channels/[id]/route'
import { POST as connectChannel } from '@/app/api/whatsapp/channels/[id]/connect/route'
import { GET as getStatus } from '@/app/api/whatsapp/channels/[id]/status/route'
import { POST as disconnectChannel } from '@/app/api/whatsapp/channels/[id]/disconnect/route'

// ---------------------------------------------------------------------------
// Integration tests for WhatsApp channel management endpoints.
// These tests require a live PostgreSQL with whatsapp_channels + webhook_events tables.
// Tests skip gracefully when the DB is unavailable.
// External provider APIs (Meta Graph API, Evolution) are mocked via MSW.
// ---------------------------------------------------------------------------

let dbAvailable = false
let createdChannelId: string | null = null

const GRAPH_BASE = 'https://graph.facebook.com/v18.0'
const PHONE_NUMBER_ID = '109876543210'

const server = setupServer(
  // Meta Graph API — returns valid phone number metadata
  http.get(`${GRAPH_BASE}/${PHONE_NUMBER_ID}`, () =>
    HttpResponse.json({ id: PHONE_NUMBER_ID, display_phone_number: '+5511999990000' }),
  ),
)

beforeAll(async () => {
  server.listen({ onUnhandledRequest: 'warn' })
  try {
    const client = await pool.connect()
    await client.query('SELECT 1 FROM whatsapp_channels LIMIT 1')
    client.release()
    dbAvailable = true
  } catch {
    console.warn('[integration/channels] PostgreSQL indisponivel ou tabela ausente — testes serao ignorados')
  }
})

afterAll(async () => {
  // Clean up any channels created during tests
  if (dbAvailable && createdChannelId) {
    const client = await pool.connect()
    await client.query('DELETE FROM whatsapp_channels WHERE id = $1', [createdChannelId]).catch(() => {})
    client.release()
  }
  server.close()
})

function makeRequest(url: string, method: string, body?: unknown, ip = '10.0.0.1'): NextRequest {
  return new NextRequest(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': ip,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

// ---------------------------------------------------------------------------
// POST /api/whatsapp/channels — create a channel
// ---------------------------------------------------------------------------
describe('POST /api/whatsapp/channels', () => {
  it('creates a META_CLOUD channel successfully', async (ctx) => {
    if (!dbAvailable) ctx.skip()

    const req = makeRequest('http://localhost/api/whatsapp/channels', 'POST', {
      workspace_id: 'ws-integration-test',
      name: 'Canal Meta Integracao',
      provider: 'META_CLOUD',
      credentials: {
        access_token: 'EAAtest_integration',
        phone_number_id: PHONE_NUMBER_ID,
        app_secret: 'test_app_secret',
      },
    })

    const res = await createChannel(req)
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body.data).toBeDefined()
    expect(body.data.id).toBeTruthy()
    expect(body.data.provider).toBe('META_CLOUD')
    expect(body.data.status).toBe('DISCONNECTED')
    // webhook_secret returned once at creation
    expect(body.webhook_secret).toBeTruthy()
    expect(typeof body.webhook_secret).toBe('string')
    // credentials_encrypted must NOT be exposed
    expect(body.data.credentials_encrypted).toBeUndefined()

    createdChannelId = body.data.id
  })

  it('returns 400 for invalid provider', async (ctx) => {
    if (!dbAvailable) ctx.skip()

    const req = makeRequest('http://localhost/api/whatsapp/channels', 'POST', {
      workspace_id: 'ws-1',
      name: 'Bad Provider',
      provider: 'TELEGRAM',
      credentials: {},
    })

    const res = await createChannel(req)
    expect(res.status).toBe(400)
  })

  it('returns 400 for missing required fields', async (ctx) => {
    if (!dbAvailable) ctx.skip()

    const req = makeRequest('http://localhost/api/whatsapp/channels', 'POST', {
      name: 'Missing workspace_id and provider',
    })

    const res = await createChannel(req)
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// GET /api/whatsapp/channels — list channels
// ---------------------------------------------------------------------------
describe('GET /api/whatsapp/channels', () => {
  it('returns channels for a workspace', async (ctx) => {
    if (!dbAvailable || !createdChannelId) ctx.skip()

    const req = makeRequest(
      'http://localhost/api/whatsapp/channels?workspace_id=ws-integration-test',
      'GET',
    )

    const res = await listChannels(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(Array.isArray(body.data)).toBe(true)
    expect(body.data.length).toBeGreaterThan(0)
    // Sensitive fields must not be exposed
    for (const channel of body.data) {
      expect(channel.credentials_encrypted).toBeUndefined()
      expect(channel.webhook_secret).toBeUndefined()
    }
  })

  it('returns 400 when workspace_id is missing', async (ctx) => {
    if (!dbAvailable) ctx.skip()

    const req = makeRequest('http://localhost/api/whatsapp/channels', 'GET')
    const res = await listChannels(req)
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// GET /api/whatsapp/channels/:id — get single channel
// ---------------------------------------------------------------------------
describe('GET /api/whatsapp/channels/:id', () => {
  it('returns channel by ID', async (ctx) => {
    if (!dbAvailable || !createdChannelId) ctx.skip()

    const req = makeRequest(`http://localhost/api/whatsapp/channels/${createdChannelId}`, 'GET')
    const res = await getChannel(req, { params: Promise.resolve({ id: createdChannelId! }) })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.id).toBe(createdChannelId)
    expect(body.data.credentials_encrypted).toBeUndefined()
    expect(body.data.webhook_secret).toBeUndefined()
  })

  it('returns 404 for non-existent channel', async (ctx) => {
    if (!dbAvailable) ctx.skip()

    const req = makeRequest(
      'http://localhost/api/whatsapp/channels/00000000-0000-0000-0000-000000000099',
      'GET',
    )
    const res = await getChannel(req, {
      params: Promise.resolve({ id: '00000000-0000-0000-0000-000000000099' }),
    })
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// POST /api/whatsapp/channels/:id/connect
// ---------------------------------------------------------------------------
describe('POST /api/whatsapp/channels/:id/connect', () => {
  it('connects Meta channel (returns CONNECTED immediately)', async (ctx) => {
    if (!dbAvailable || !createdChannelId) ctx.skip()

    const req = makeRequest(
      `http://localhost/api/whatsapp/channels/${createdChannelId}/connect`,
      'POST',
    )
    const res = await connectChannel(req, { params: Promise.resolve({ id: createdChannelId! }) })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.status).toBe('CONNECTED')
    expect(body.data.phone_number).toBe('+5511999990000')
  })
})

// ---------------------------------------------------------------------------
// GET /api/whatsapp/channels/:id/status
// ---------------------------------------------------------------------------
describe('GET /api/whatsapp/channels/:id/status', () => {
  it('returns current status from provider', async (ctx) => {
    if (!dbAvailable || !createdChannelId) ctx.skip()

    const req = makeRequest(
      `http://localhost/api/whatsapp/channels/${createdChannelId}/status`,
      'GET',
    )
    const res = await getStatus(req, { params: Promise.resolve({ id: createdChannelId! }) })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.channel_id).toBe(createdChannelId)
    expect(['CONNECTED', 'ERROR', 'DISCONNECTED']).toContain(body.data.status)
  })
})

// ---------------------------------------------------------------------------
// POST /api/whatsapp/channels/:id/disconnect
// ---------------------------------------------------------------------------
describe('POST /api/whatsapp/channels/:id/disconnect', () => {
  it('disconnects the channel and returns DISCONNECTED', async (ctx) => {
    if (!dbAvailable || !createdChannelId) ctx.skip()

    const req = makeRequest(
      `http://localhost/api/whatsapp/channels/${createdChannelId}/disconnect`,
      'POST',
    )
    const res = await disconnectChannel(req, { params: Promise.resolve({ id: createdChannelId! }) })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.status).toBe('DISCONNECTED')
  })
})

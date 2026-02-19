import { createHash, randomBytes } from 'crypto'
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
// These tests require a live PostgreSQL with whatsapp_channels + workspace_api_keys.
// Tests skip gracefully when the DB is unavailable.
// External provider APIs (Meta Graph API, Evolution) are mocked via MSW.
// ---------------------------------------------------------------------------

let dbAvailable = false
let createdChannelId: string | null = null

// Workspace A — the "owner" workspace used in most tests
const TEST_WORKSPACE_ID = 'ws-integration-test'
let testRawKey: string | null = null   // wk_... for TEST_WORKSPACE_ID
let testKeyId: string | null = null    // UUID in workspace_api_keys

// Workspace B — used to verify cross-workspace 403 enforcement
const OTHER_WORKSPACE_ID = 'ws-other-integration'
let otherRawKey: string | null = null  // wk_... for OTHER_WORKSPACE_ID
let otherKeyId: string | null = null

const GRAPH_BASE = 'https://graph.facebook.com/v18.0'
const PHONE_NUMBER_ID = '109876543210'

const server = setupServer(
  // Meta Graph API — returns valid phone number metadata
  http.get(`${GRAPH_BASE}/${PHONE_NUMBER_ID}`, () =>
    HttpResponse.json({ id: PHONE_NUMBER_ID, display_phone_number: '+5511999990000' }),
  ),
)

// ---------------------------------------------------------------------------
// Key generation — mirrors lib/whatsapp/auth.ts
// ---------------------------------------------------------------------------

function generateTestKey(): { rawKey: string; keyHash: string } {
  const raw = randomBytes(32).toString('hex')
  const rawKey = `wk_${raw}`
  const keyHash = createHash('sha256').update(rawKey, 'utf8').digest('hex')
  return { rawKey, keyHash }
}

beforeAll(async () => {
  server.listen({ onUnhandledRequest: 'warn' })
  try {
    const client = await pool.connect()
    try {
      await client.query('SELECT 1 FROM whatsapp_channels LIMIT 1')
      await client.query('SELECT 1 FROM workspace_api_keys LIMIT 1')
      dbAvailable = true

      // Insert workspace A key
      const keyA = generateTestKey()
      const resA = await client.query<{ id: string }>(
        `INSERT INTO workspace_api_keys (workspace_id, key_hash, label, created_by)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [TEST_WORKSPACE_ID, keyA.keyHash, 'integration-test-a', 'test-runner'],
      )
      testRawKey = keyA.rawKey
      testKeyId = resA.rows[0].id

      // Insert workspace B key
      const keyB = generateTestKey()
      const resB = await client.query<{ id: string }>(
        `INSERT INTO workspace_api_keys (workspace_id, key_hash, label, created_by)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [OTHER_WORKSPACE_ID, keyB.keyHash, 'integration-test-b', 'test-runner'],
      )
      otherRawKey = keyB.rawKey
      otherKeyId = resB.rows[0].id
    } finally {
      client.release()
    }
  } catch {
    console.warn('[integration/channels] PostgreSQL indisponivel ou tabela ausente — testes serao ignorados')
  }
})

afterAll(async () => {
  if (dbAvailable) {
    const client = await pool.connect()
    try {
      // Clean up channels created during tests
      if (createdChannelId) {
        await client.query('DELETE FROM whatsapp_channels WHERE id = $1', [createdChannelId]).catch(() => {})
      }
      // Clean up test API keys
      if (testKeyId) {
        await client.query('DELETE FROM workspace_api_keys WHERE id = $1', [testKeyId]).catch(() => {})
      }
      if (otherKeyId) {
        await client.query('DELETE FROM workspace_api_keys WHERE id = $1', [otherKeyId]).catch(() => {})
      }
    } finally {
      client.release()
    }
  }
  server.close()
})

// ---------------------------------------------------------------------------
// Helper — builds a NextRequest with optional Bearer auth
// ---------------------------------------------------------------------------

function makeRequest(
  url: string,
  method: string,
  body?: unknown,
  ip = '10.0.0.1',
  authKey?: string,
): NextRequest {
  return new NextRequest(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': ip,
      ...(authKey ? { Authorization: `Bearer ${authKey}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

// ---------------------------------------------------------------------------
// POST /api/whatsapp/channels — create a channel
// ---------------------------------------------------------------------------
describe('POST /api/whatsapp/channels', () => {
  it('returns 401 when Authorization header is missing', async (ctx) => {
    if (!dbAvailable) ctx.skip()

    const req = makeRequest('http://localhost/api/whatsapp/channels', 'POST', {
      name: 'No Auth Channel',
      provider: 'META_CLOUD',
      credentials: { access_token: 'EAA', phone_number_id: PHONE_NUMBER_ID, app_secret: 'secret' },
    })

    const res = await createChannel(req)
    expect(res.status).toBe(401)
  })

  it('creates a META_CLOUD channel successfully with valid token', async (ctx) => {
    if (!dbAvailable) ctx.skip()

    const req = makeRequest(
      'http://localhost/api/whatsapp/channels',
      'POST',
      {
        name: 'Canal Meta Integracao',
        provider: 'META_CLOUD',
        credentials: {
          access_token: 'EAAtest_integration',
          phone_number_id: PHONE_NUMBER_ID,
          app_secret: 'test_app_secret',
        },
      },
      '10.0.0.1',
      testRawKey!,
    )

    const res = await createChannel(req)
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body.data).toBeDefined()
    expect(body.data.id).toBeTruthy()
    expect(body.data.provider).toBe('META_CLOUD')
    expect(body.data.status).toBe('DISCONNECTED')
    // workspace_id must come from the token — never from the body
    expect(body.data.workspace_id).toBe(TEST_WORKSPACE_ID)
    // webhook_secret returned once at creation
    expect(body.webhook_secret).toBeTruthy()
    expect(typeof body.webhook_secret).toBe('string')
    // credentials_encrypted must NOT be exposed
    expect(body.data.credentials_encrypted).toBeUndefined()

    createdChannelId = body.data.id
  })

  it('returns 400 for invalid provider', async (ctx) => {
    if (!dbAvailable) ctx.skip()

    const req = makeRequest(
      'http://localhost/api/whatsapp/channels',
      'POST',
      { name: 'Bad Provider', provider: 'TELEGRAM', credentials: {} },
      '10.0.0.1',
      testRawKey!,
    )

    const res = await createChannel(req)
    expect(res.status).toBe(400)
  })

  it('returns 400 for missing required fields', async (ctx) => {
    if (!dbAvailable) ctx.skip()

    const req = makeRequest(
      'http://localhost/api/whatsapp/channels',
      'POST',
      { name: 'Missing provider' },
      '10.0.0.1',
      testRawKey!,
    )

    const res = await createChannel(req)
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// GET /api/whatsapp/channels — list channels for authenticated workspace
// ---------------------------------------------------------------------------
describe('GET /api/whatsapp/channels', () => {
  it('returns 401 when Authorization header is missing', async (ctx) => {
    if (!dbAvailable) ctx.skip()

    const req = makeRequest('http://localhost/api/whatsapp/channels', 'GET')
    const res = await listChannels(req)
    expect(res.status).toBe(401)
  })

  it('returns channels for the authenticated workspace', async (ctx) => {
    if (!dbAvailable || !createdChannelId) ctx.skip()

    const req = makeRequest(
      'http://localhost/api/whatsapp/channels',
      'GET',
      undefined,
      '10.0.0.1',
      testRawKey!,
    )

    const res = await listChannels(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(Array.isArray(body.data)).toBe(true)
    expect(body.data.length).toBeGreaterThan(0)
    // All returned channels must belong to the token's workspace
    for (const channel of body.data) {
      expect(channel.workspace_id).toBe(TEST_WORKSPACE_ID)
      expect(channel.credentials_encrypted).toBeUndefined()
      expect(channel.webhook_secret).toBeUndefined()
    }
  })

  it('does not return channels of other workspaces', async (ctx) => {
    if (!dbAvailable || !createdChannelId) ctx.skip()

    // Workspace B has no channels — list should be empty
    const req = makeRequest(
      'http://localhost/api/whatsapp/channels',
      'GET',
      undefined,
      '10.0.0.1',
      otherRawKey!,
    )

    const res = await listChannels(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    // createdChannelId belongs to workspace A — workspace B must not see it
    const ids = (body.data as { id: string }[]).map((c) => c.id)
    expect(ids).not.toContain(createdChannelId)
  })
})

// ---------------------------------------------------------------------------
// GET /api/whatsapp/channels/:id — get single channel
// ---------------------------------------------------------------------------
describe('GET /api/whatsapp/channels/:id', () => {
  it('returns 401 when Authorization header is missing', async (ctx) => {
    if (!dbAvailable || !createdChannelId) ctx.skip()

    const req = makeRequest(`http://localhost/api/whatsapp/channels/${createdChannelId}`, 'GET')
    const res = await getChannel(req, { params: Promise.resolve({ id: createdChannelId! }) })
    expect(res.status).toBe(401)
  })

  it('returns channel by ID for the owner workspace', async (ctx) => {
    if (!dbAvailable || !createdChannelId) ctx.skip()

    const req = makeRequest(
      `http://localhost/api/whatsapp/channels/${createdChannelId}`,
      'GET',
      undefined,
      '10.0.0.1',
      testRawKey!,
    )
    const res = await getChannel(req, { params: Promise.resolve({ id: createdChannelId! }) })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.id).toBe(createdChannelId)
    expect(body.data.credentials_encrypted).toBeUndefined()
    expect(body.data.webhook_secret).toBeUndefined()
  })

  it('returns 403 when accessing a channel from another workspace', async (ctx) => {
    if (!dbAvailable || !createdChannelId) ctx.skip()

    // otherRawKey belongs to workspace B — the channel belongs to workspace A
    const req = makeRequest(
      `http://localhost/api/whatsapp/channels/${createdChannelId}`,
      'GET',
      undefined,
      '10.0.0.1',
      otherRawKey!,
    )
    const res = await getChannel(req, { params: Promise.resolve({ id: createdChannelId! }) })
    expect(res.status).toBe(403)
  })

  it('returns 404 for non-existent channel', async (ctx) => {
    if (!dbAvailable) ctx.skip()

    const req = makeRequest(
      'http://localhost/api/whatsapp/channels/00000000-0000-0000-0000-000000000099',
      'GET',
      undefined,
      '10.0.0.1',
      testRawKey!,
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
  it('returns 401 when Authorization header is missing', async (ctx) => {
    if (!dbAvailable || !createdChannelId) ctx.skip()

    const req = makeRequest(
      `http://localhost/api/whatsapp/channels/${createdChannelId}/connect`,
      'POST',
    )
    const res = await connectChannel(req, { params: Promise.resolve({ id: createdChannelId! }) })
    expect(res.status).toBe(401)
  })

  it('connects Meta channel (returns CONNECTED immediately)', async (ctx) => {
    if (!dbAvailable || !createdChannelId) ctx.skip()

    const req = makeRequest(
      `http://localhost/api/whatsapp/channels/${createdChannelId}/connect`,
      'POST',
      undefined,
      '10.0.0.1',
      testRawKey!,
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
      undefined,
      '10.0.0.1',
      testRawKey!,
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
      undefined,
      '10.0.0.1',
      testRawKey!,
    )
    const res = await disconnectChannel(req, { params: Promise.resolve({ id: createdChannelId! }) })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.status).toBe('DISCONNECTED')
  })
})

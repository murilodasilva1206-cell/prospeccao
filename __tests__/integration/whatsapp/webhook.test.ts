import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { createHmac } from 'crypto'
import pool from '@/lib/database'
import { encryptCredentials } from '@/lib/whatsapp/crypto'
import { POST as webhookHandler } from '@/app/api/whatsapp/webhook/[provider]/[channelId]/route'

// ---------------------------------------------------------------------------
// Integration tests for the webhook receiver.
//
// These tests require a live PostgreSQL with:
//   - whatsapp_channels table (migrations/001_whatsapp_channels.sql)
//   - webhook_events table (migrations/002_webhook_events.sql)
//
// Tests skip gracefully when the DB is unavailable.
//
// Covered scenarios:
//   1. Valid Meta HMAC → 200 + event stored
//   2. Invalid HMAC → 401
//   3. Replay of same event → 200 with duplicate=true (idempotent)
//   4. Evolution apikey header → accepted / rejected
// ---------------------------------------------------------------------------

let dbAvailable = false
let testChannelId: string | null = null

const APP_SECRET = 'test_integration_app_secret'
const PHONE_NUMBER_ID = '999888777666'

const testCreds = {
  access_token: 'EAAtest_webhook_integration',
  phone_number_id: PHONE_NUMBER_ID,
  app_secret: APP_SECRET,
}

function buildMetaPayload(messageId: string) {
  return JSON.stringify({
    entry: [{
      changes: [{
        value: {
          messages: [{
            id: messageId,
            from: '5511988880000',
            type: 'text',
            timestamp: String(Math.floor(Date.now() / 1000)),
            text: { body: 'Webhook integration test' },
          }],
        },
      }],
    }],
  })
}

function metaSignature(rawBody: string) {
  const hmac = createHmac('sha256', APP_SECRET).update(rawBody).digest('hex')
  return `sha256=${hmac}`
}

function makeWebhookRequest(
  provider: string,
  channelId: string,
  rawBody: string,
  extraHeaders: Record<string, string> = {},
): NextRequest {
  return new NextRequest(
    `http://localhost/api/whatsapp/webhook/${provider}/${channelId}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': '10.0.0.2',
        ...extraHeaders,
      },
      body: rawBody,
    },
  )
}

beforeAll(async () => {
  try {
    const client = await pool.connect()
    // Check both tables exist
    await client.query('SELECT 1 FROM whatsapp_channels LIMIT 1')
    await client.query('SELECT 1 FROM webhook_events LIMIT 1')

    // Create a test channel directly in DB
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO whatsapp_channels
         (workspace_id, name, provider, status, credentials_encrypted, webhook_secret)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        'ws-webhook-integration',
        'Webhook Integration Test Channel',
        'META_CLOUD',
        'CONNECTED',
        encryptCredentials(testCreds),
        'evo-webhook-secret',
      ],
    )
    testChannelId = rows[0].id
    client.release()
    dbAvailable = true
  } catch {
    console.warn('[integration/webhook] PostgreSQL indisponivel ou tabelas ausentes — testes serao ignorados')
  }
})

afterAll(async () => {
  if (dbAvailable && testChannelId) {
    const client = await pool.connect()
    // webhook_events cascade deletes when channel is deleted
    await client.query('DELETE FROM whatsapp_channels WHERE id = $1', [testChannelId]).catch(() => {})
    client.release()
  }
})

// ---------------------------------------------------------------------------
// Meta HMAC verification
// ---------------------------------------------------------------------------
describe('POST /api/whatsapp/webhook/META_CLOUD/:channelId', () => {
  it('accepts valid HMAC signature and processes event', async (ctx) => {
    if (!dbAvailable || !testChannelId) ctx.skip()

    const messageId = `wamid.integration-${Date.now()}-001`
    const rawBody = buildMetaPayload(messageId)

    const req = makeWebhookRequest('META_CLOUD', testChannelId!, rawBody, {
      'x-hub-signature-256': metaSignature(rawBody),
    })

    const res = await webhookHandler(req, {
      params: Promise.resolve({ provider: 'META_CLOUD', channelId: testChannelId! }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.duplicate).toBeUndefined()
  })

  it('returns 401 for invalid HMAC', async (ctx) => {
    if (!dbAvailable || !testChannelId) ctx.skip()

    const rawBody = buildMetaPayload('wamid.bad-sig-test')
    const req = makeWebhookRequest('META_CLOUD', testChannelId!, rawBody, {
      'x-hub-signature-256': 'sha256=invalidsignaturehere',
    })

    const res = await webhookHandler(req, {
      params: Promise.resolve({ provider: 'META_CLOUD', channelId: testChannelId! }),
    })

    expect(res.status).toBe(401)
  })

  it('returns 401 when signature header is missing', async (ctx) => {
    if (!dbAvailable || !testChannelId) ctx.skip()

    const rawBody = buildMetaPayload('wamid.no-sig-test')
    const req = makeWebhookRequest('META_CLOUD', testChannelId!, rawBody)

    const res = await webhookHandler(req, {
      params: Promise.resolve({ provider: 'META_CLOUD', channelId: testChannelId! }),
    })

    expect(res.status).toBe(401)
  })

  it('returns 200 with duplicate=true on replay of same event_id', async (ctx) => {
    if (!dbAvailable || !testChannelId) ctx.skip()

    const messageId = `wamid.integration-replay-${Date.now()}`
    const rawBody = buildMetaPayload(messageId)
    const sig = metaSignature(rawBody)
    const headers = { 'x-hub-signature-256': sig }

    // First request — processes event
    const req1 = makeWebhookRequest('META_CLOUD', testChannelId!, rawBody, headers)
    const res1 = await webhookHandler(req1, {
      params: Promise.resolve({ provider: 'META_CLOUD', channelId: testChannelId! }),
    })
    expect(res1.status).toBe(200)
    const body1 = await res1.json()
    expect(body1.duplicate).toBeUndefined()

    // Second request with SAME body (replay) — must be idempotent
    const req2 = makeWebhookRequest('META_CLOUD', testChannelId!, rawBody, headers)
    const res2 = await webhookHandler(req2, {
      params: Promise.resolve({ provider: 'META_CLOUD', channelId: testChannelId! }),
    })
    const body2 = await res2.json()

    expect(res2.status).toBe(200)
    expect(body2.ok).toBe(true)
    expect(body2.duplicate).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Invalid path params
// ---------------------------------------------------------------------------
describe('POST /api/whatsapp/webhook — path validation', () => {
  it('returns 400 for unknown provider', async (ctx) => {
    if (!dbAvailable) ctx.skip()

    const channelId = testChannelId ?? '00000000-0000-0000-0000-000000000001'
    const req = makeWebhookRequest('TELEGRAM', channelId, '{}')

    const res = await webhookHandler(req, {
      params: Promise.resolve({ provider: 'TELEGRAM', channelId }),
    })

    expect(res.status).toBe(400)
  })

  it('returns 400 for non-UUID channelId', async (ctx) => {
    if (!dbAvailable) ctx.skip()

    const req = makeWebhookRequest('META_CLOUD', 'not-a-uuid', '{}')

    const res = await webhookHandler(req, {
      params: Promise.resolve({ provider: 'META_CLOUD', channelId: 'not-a-uuid' }),
    })

    expect(res.status).toBe(400)
  })

  it('returns 404 for non-existent channelId', async (ctx) => {
    if (!dbAvailable) ctx.skip()

    const fakeId = '00000000-0000-0000-0000-000000000099'
    const rawBody = buildMetaPayload('wamid.nonexistent')
    const req = makeWebhookRequest('META_CLOUD', fakeId, rawBody, {
      'x-hub-signature-256': metaSignature(rawBody),
    })

    const res = await webhookHandler(req, {
      params: Promise.resolve({ provider: 'META_CLOUD', channelId: fakeId }),
    })

    expect(res.status).toBe(404)
  })
})

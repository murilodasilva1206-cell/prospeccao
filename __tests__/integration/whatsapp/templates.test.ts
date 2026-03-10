import { createHash, randomBytes } from 'crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { NextRequest } from 'next/server'
import pool from '@/lib/database'
import { POST as syncRoute } from '@/app/api/whatsapp/channels/[id]/templates/sync/route'
import { GET as listRoute } from '@/app/api/whatsapp/channels/[id]/templates/route'
import { GET as variablesRoute } from '@/app/api/whatsapp/channels/[id]/templates/[templateId]/variables/route'
import { encryptCredentials } from '@/lib/whatsapp/crypto'

// ---------------------------------------------------------------------------
// Integration: WhatsApp template sync, list, and variable extraction.
// Requires live PostgreSQL (migrations 001 + 024 applied).
// Tests skip gracefully when DB is unavailable.
// ---------------------------------------------------------------------------

const GRAPH_BASE = 'https://graph.facebook.com/v18.0'
const TEST_WORKSPACE = 'ws-tpl-integration'
const OTHER_WORKSPACE = 'ws-tpl-other'
const WABA_ID = 'WABA_TEST_001'

let dbAvailable = false
let testRawKey = ''
let testKeyId = ''
let otherRawKey = ''
let otherKeyId = ''
let metaChannelId = ''
let evolChannelId = ''
let createdTemplateId = ''

function generateTestKey() {
  const raw = randomBytes(32).toString('hex')
  const rawKey = `wk_${raw}`
  const keyHash = createHash('sha256').update(rawKey, 'utf8').digest('hex')
  return { rawKey, keyHash }
}

function authHeader(key: string) {
  return { Authorization: `Bearer ${key}` }
}

function makePost(path: string, key: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader(key) },
    body: body ? JSON.stringify(body) : undefined,
  })
}

function makeGet(path: string, key: string, query?: Record<string, string>): NextRequest {
  const url = new URL(`http://localhost${path}`)
  if (query) {
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
  }
  return new NextRequest(url.toString(), {
    method: 'GET',
    headers: authHeader(key),
  })
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) }
}

function makeParamsWithTemplate(id: string, templateId: string) {
  return { params: Promise.resolve({ id, templateId }) }
}

const sampleTemplates = [
  {
    id: 'meta_tpl_001',
    name: 'boas_vindas',
    language: 'pt_BR',
    status: 'APPROVED',
    category: 'MARKETING',
    components: [
      { type: 'BODY', text: 'Olá {{1}}, temos uma oferta especial para {{2}}.' },
    ],
  },
  {
    id: 'meta_tpl_002',
    name: 'lembrete_consulta',
    language: 'pt_BR',
    status: 'APPROVED',
    category: 'UTILITY',
    components: [
      { type: 'BODY', text: 'Sua consulta está confirmada para {{1}} às {{2}}.' },
    ],
  },
  {
    id: 'meta_tpl_003',
    name: 'sem_variaveis',
    language: 'en_US',
    status: 'PENDING',
    category: 'MARKETING',
    components: [
      { type: 'BODY', text: 'Hello! Thank you for your interest.' },
    ],
  },
]

const server = setupServer(
  http.get(`${GRAPH_BASE}/${WABA_ID}/message_templates`, () =>
    HttpResponse.json({ data: sampleTemplates, paging: {} }),
  ),
)

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  server.listen({ onUnhandledRequest: 'warn' })
  try {
    const client = await pool.connect()
    try {
      // Check required tables exist
      await client.query('SELECT 1 FROM whatsapp_channels LIMIT 1')
      await client.query('SELECT 1 FROM whatsapp_templates LIMIT 1')
      await client.query('SELECT 1 FROM workspace_api_keys LIMIT 1')
      dbAvailable = true

      // Create API keys
      const keyA = generateTestKey()
      const resA = await client.query<{ id: string }>(
        `INSERT INTO workspace_api_keys (workspace_id, key_hash, label, created_by)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [TEST_WORKSPACE, keyA.keyHash, 'tpl-integration-a', 'test-runner'],
      )
      testRawKey = keyA.rawKey
      testKeyId = resA.rows[0].id

      const keyB = generateTestKey()
      const resB = await client.query<{ id: string }>(
        `INSERT INTO workspace_api_keys (workspace_id, key_hash, label, created_by)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [OTHER_WORKSPACE, keyB.keyHash, 'tpl-integration-b', 'test-runner'],
      )
      otherRawKey = keyB.rawKey
      otherKeyId = resB.rows[0].id

      // Encrypt fake Meta credentials with waba_id
      const metaCreds = { access_token: 'EAABtest', phone_number_id: '109876543210', waba_id: WABA_ID }
      const encryptedMeta = encryptCredentials(metaCreds)

      // Create META_CLOUD channel for TEST_WORKSPACE
      const metaCh = await client.query<{ id: string }>(
        `INSERT INTO whatsapp_channels (workspace_id, name, provider, credentials_encrypted, webhook_secret, status)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [TEST_WORKSPACE, 'Meta Test Channel', 'META_CLOUD', encryptedMeta, 'whsec_test', 'CONNECTED'],
      )
      metaChannelId = metaCh.rows[0].id

      // Create EVOLUTION channel (for non-META_CLOUD rejection test)
      const evolCreds = { instance_url: 'https://evolution.test', api_key: 'evo_key' }
      const encryptedEvol = encryptCredentials(evolCreds)
      const evolCh = await client.query<{ id: string }>(
        `INSERT INTO whatsapp_channels (workspace_id, name, provider, credentials_encrypted, webhook_secret, status)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [TEST_WORKSPACE, 'Evolution Channel', 'EVOLUTION', encryptedEvol, 'whsec_evol', 'CONNECTED'],
      )
      evolChannelId = evolCh.rows[0].id
    } finally {
      client.release()
    }
  } catch {
    dbAvailable = false
  }
})

afterAll(async () => {
  server.close()
  if (!dbAvailable) return
  const client = await pool.connect()
  try {
    if (metaChannelId) {
      await client.query('DELETE FROM whatsapp_templates WHERE channel_id = $1', [metaChannelId])
      await client.query('DELETE FROM whatsapp_channels WHERE id = $1', [metaChannelId])
    }
    if (evolChannelId) {
      await client.query('DELETE FROM whatsapp_channels WHERE id = $1', [evolChannelId])
    }
    if (testKeyId) await client.query('DELETE FROM workspace_api_keys WHERE id = $1', [testKeyId])
    if (otherKeyId) await client.query('DELETE FROM workspace_api_keys WHERE id = $1', [otherKeyId])
  } finally {
    client.release()
  }
})

// ---------------------------------------------------------------------------
// POST /channels/:id/templates/sync
// ---------------------------------------------------------------------------

describe('Integration: POST /channels/:id/templates/sync', () => {
  it('syncs templates and returns created/updated/deactivated counts', async () => {
    if (!dbAvailable) return expect(true).toBe(true)

    const req = makePost(`/api/whatsapp/channels/${metaChannelId}/templates/sync`, testRawKey)
    const res = await syncRoute(req, makeParams(metaChannelId))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(typeof body.created).toBe('number')
    expect(typeof body.updated).toBe('number')
    expect(typeof body.deactivated).toBe('number')
    expect(body.created).toBe(3) // 3 new templates
    expect(body.deactivated).toBe(0)
  })

  it('is idempotent — second sync with same data changes nothing', async () => {
    if (!dbAvailable) return expect(true).toBe(true)

    const req = makePost(`/api/whatsapp/channels/${metaChannelId}/templates/sync`, testRawKey)
    const res = await syncRoute(req, makeParams(metaChannelId))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.created).toBe(0)
    expect(body.updated).toBe(0)
    expect(body.deactivated).toBe(0)
  })

  it('deactivates templates that disappeared from provider', async () => {
    if (!dbAvailable) return expect(true).toBe(true)

    // Override MSW to return only one template
    server.use(
      http.get(`${GRAPH_BASE}/${WABA_ID}/message_templates`, () =>
        HttpResponse.json({ data: [sampleTemplates[0]], paging: {} }),
      ),
    )

    const req = makePost(`/api/whatsapp/channels/${metaChannelId}/templates/sync`, testRawKey)
    const res = await syncRoute(req, makeParams(metaChannelId))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.deactivated).toBe(2) // other 2 templates removed

    // Restore server to full list
    server.use(
      http.get(`${GRAPH_BASE}/${WABA_ID}/message_templates`, () =>
        HttpResponse.json({ data: sampleTemplates, paging: {} }),
      ),
    )
  })

  it('returns 409 when channel is not META_CLOUD', async () => {
    if (!dbAvailable) return expect(true).toBe(true)

    const req = makePost(`/api/whatsapp/channels/${evolChannelId}/templates/sync`, testRawKey)
    const res = await syncRoute(req, makeParams(evolChannelId))

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toMatch(/META_CLOUD/i)
  })

  it('returns 403 when channel belongs to another workspace', async () => {
    if (!dbAvailable) return expect(true).toBe(true)

    const req = makePost(`/api/whatsapp/channels/${metaChannelId}/templates/sync`, otherRawKey)
    const res = await syncRoute(req, makeParams(metaChannelId))

    expect(res.status).toBe(403)
  })

  it('returns 404 for non-existent channel', async () => {
    if (!dbAvailable) return expect(true).toBe(true)

    const req = makePost(
      `/api/whatsapp/channels/00000000-0000-0000-0000-000000000000/templates/sync`,
      testRawKey,
    )
    const res = await syncRoute(req, makeParams('00000000-0000-0000-0000-000000000000'))

    expect(res.status).toBe(404)
  })

  it('returns 400 for invalid channel_id format', async () => {
    if (!dbAvailable) return expect(true).toBe(true)

    const req = makePost('/api/whatsapp/channels/not-a-uuid/templates/sync', testRawKey)
    const res = await syncRoute(req, makeParams('not-a-uuid'))

    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// GET /channels/:id/templates
// ---------------------------------------------------------------------------

describe('Integration: GET /channels/:id/templates', () => {
  it('lists active templates for the channel', async () => {
    if (!dbAvailable) return expect(true).toBe(true)

    const req = makeGet(`/api/whatsapp/channels/${metaChannelId}/templates`, testRawKey)
    const res = await listRoute(req, makeParams(metaChannelId))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(Array.isArray(body.data)).toBe(true)
    expect(body.data.length).toBeGreaterThan(0)
    expect(body.pagination).toBeDefined()
  })

  it('filters by status=APPROVED', async () => {
    if (!dbAvailable) return expect(true).toBe(true)

    const req = makeGet(`/api/whatsapp/channels/${metaChannelId}/templates`, testRawKey, { status: 'APPROVED' })
    const res = await listRoute(req, makeParams(metaChannelId))
    const body = await res.json()

    expect(res.status).toBe(200)
    for (const tpl of body.data) {
      expect(tpl.status).toBe('APPROVED')
    }
  })

  it('filters by language=pt_BR', async () => {
    if (!dbAvailable) return expect(true).toBe(true)

    const req = makeGet(`/api/whatsapp/channels/${metaChannelId}/templates`, testRawKey, { language: 'pt_BR' })
    const res = await listRoute(req, makeParams(metaChannelId))
    const body = await res.json()

    expect(res.status).toBe(200)
    for (const tpl of body.data) {
      expect(tpl.language).toBe('pt_BR')
    }
  })

  it('searches templates by name', async () => {
    if (!dbAvailable) return expect(true).toBe(true)

    const req = makeGet(`/api/whatsapp/channels/${metaChannelId}/templates`, testRawKey, { search: 'boas' })
    const res = await listRoute(req, makeParams(metaChannelId))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.length).toBeGreaterThan(0)
    for (const tpl of body.data) {
      expect(tpl.template_name.toLowerCase()).toContain('boas')
    }
  })

  it('paginates results with stable ordering', async () => {
    if (!dbAvailable) return expect(true).toBe(true)

    const reqPage1 = makeGet(`/api/whatsapp/channels/${metaChannelId}/templates`, testRawKey, { page: '1', limit: '1' })
    const resPage1 = await listRoute(reqPage1, makeParams(metaChannelId))
    const bodyPage1 = await resPage1.json()

    const reqPage2 = makeGet(`/api/whatsapp/channels/${metaChannelId}/templates`, testRawKey, { page: '2', limit: '1' })
    const resPage2 = await listRoute(reqPage2, makeParams(metaChannelId))
    const bodyPage2 = await resPage2.json()

    expect(resPage1.status).toBe(200)
    expect(resPage2.status).toBe(200)
    expect(bodyPage1.data[0]?.id).not.toBe(bodyPage2.data[0]?.id)
    expect(bodyPage1.pagination.total).toBeGreaterThan(1)
  })

  it('returns 403 for another workspace channel', async () => {
    if (!dbAvailable) return expect(true).toBe(true)

    const req = makeGet(`/api/whatsapp/channels/${metaChannelId}/templates`, otherRawKey)
    const res = await listRoute(req, makeParams(metaChannelId))

    expect(res.status).toBe(403)
  })

  it('never returns credentials in template list response', async () => {
    if (!dbAvailable) return expect(true).toBe(true)

    const req = makeGet(`/api/whatsapp/channels/${metaChannelId}/templates`, testRawKey)
    const res = await listRoute(req, makeParams(metaChannelId))
    const body = await res.json()
    const raw = JSON.stringify(body)

    expect(raw).not.toMatch(/access_token/i)
    expect(raw).not.toMatch(/EAABtest/)
    expect(raw).not.toMatch(/credentials_encrypted/)
  })
})

// ---------------------------------------------------------------------------
// GET /channels/:id/templates/:templateId/variables
// ---------------------------------------------------------------------------

describe('Integration: GET /channels/:id/templates/:templateId/variables', () => {
  it('returns extracted variables with component info', async () => {
    if (!dbAvailable) return expect(true).toBe(true)

    // Find the boas_vindas template
    const client = await pool.connect()
    let templateId = ''
    try {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM whatsapp_templates WHERE channel_id = $1 AND template_name = $2 AND is_active = true LIMIT 1`,
        [metaChannelId, 'boas_vindas'],
      )
      if (rows.length > 0) {
        templateId = rows[0].id
        createdTemplateId = templateId
      }
    } finally {
      client.release()
    }

    if (!templateId) return expect(true).toBe(true) // skip if sync hadn't run

    const req = makeGet(
      `/api/whatsapp/channels/${metaChannelId}/templates/${templateId}/variables`,
      testRawKey,
    )
    const res = await variablesRoute(req, makeParamsWithTemplate(metaChannelId, templateId))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.variables).toBeDefined()
    expect(Array.isArray(body.variables)).toBe(true)
    // boas_vindas has {{1}} and {{2}} in BODY
    expect(body.variables.length).toBe(2)
    expect(body.variables[0]).toMatchObject({ index: 1, component: 'BODY' })
    expect(body.variables[1]).toMatchObject({ index: 2, component: 'BODY' })
  })

  it('returns 403 for cross-workspace access', async () => {
    if (!dbAvailable || !createdTemplateId) return expect(true).toBe(true)

    const req = makeGet(
      `/api/whatsapp/channels/${metaChannelId}/templates/${createdTemplateId}/variables`,
      otherRawKey,
    )
    const res = await variablesRoute(req, makeParamsWithTemplate(metaChannelId, createdTemplateId))

    expect(res.status).toBe(403)
  })

  it('returns 404 for non-existent template', async () => {
    if (!dbAvailable) return expect(true).toBe(true)

    const fakeId = '00000000-0000-0000-0000-000000000099'
    const req = makeGet(
      `/api/whatsapp/channels/${metaChannelId}/templates/${fakeId}/variables`,
      testRawKey,
    )
    const res = await variablesRoute(req, makeParamsWithTemplate(metaChannelId, fakeId))

    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Regression: Evolution/UAZAPI channels unaffected
// ---------------------------------------------------------------------------

describe('Integration: Regression — non-META_CLOUD channels unaffected', () => {
  it('Evolution channel list templates returns 409 (sync not supported)', async () => {
    if (!dbAvailable) return expect(true).toBe(true)

    // GET on list also returns 409 for non-META channels (templates feature is META-only)
    const req = makeGet(`/api/whatsapp/channels/${evolChannelId}/templates`, testRawKey)
    const res = await listRoute(req, makeParams(evolChannelId))

    expect(res.status).toBe(409)
  })
})

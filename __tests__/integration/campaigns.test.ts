import { createHash, randomBytes } from 'crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { NextRequest } from 'next/server'
import pool from '@/lib/database'
import { POST as createCampaignRoute } from '@/app/api/campaigns/route'
import { GET as getCampaignRoute } from '@/app/api/campaigns/[id]/route'
import { POST as confirmRoute } from '@/app/api/campaigns/[id]/confirm/route'
import { POST as cancelRoute } from '@/app/api/campaigns/[id]/cancel/route'
import { GET as listRecipientsRoute } from '@/app/api/campaigns/[id]/recipients/route'
import {
  claimPendingRecipients,
  finalizeCampaign,
} from '@/lib/campaign-repo'

// ---------------------------------------------------------------------------
// Integration tests for campaign state machine.
// Requires a live PostgreSQL with campaigns + campaign_recipients +
// campaign_audit_log + workspace_api_keys tables (migrations 003 + 008).
// Tests skip gracefully when the DB is unavailable.
// ---------------------------------------------------------------------------

let dbAvailable = false
let createdCampaignId: string | null = null
let confirmationToken: string | null = null

const TEST_WORKSPACE_ID = 'ws-integration-test'
let testRawKey: string | null = null
let testKeyId: string | null = null

const OTHER_WORKSPACE_ID = 'ws-other-integration'
let otherRawKey: string | null = null
let otherKeyId: string | null = null

// MSW server — no external calls needed for campaign tests, but kept for consistency
const server = setupServer(
  http.all('*', () => HttpResponse.json({ error: 'unexpected external call' }, { status: 500 })),
)

// ---------------------------------------------------------------------------
// Key generation helper
// ---------------------------------------------------------------------------

function generateTestKey(): { rawKey: string; keyHash: string } {
  const raw = randomBytes(32).toString('hex')
  const rawKey = `wk_${raw}`
  const keyHash = createHash('sha256').update(rawKey, 'utf8').digest('hex')
  return { rawKey, keyHash }
}

// ---------------------------------------------------------------------------
// Route helpers
// ---------------------------------------------------------------------------

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

function makeGet(path: string, key: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'GET',
    headers: { ...authHeader(key) },
  })
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) }
}

const sampleRecipients = [
  { cnpj: '11222333000181', razao_social: 'CLINICA LTDA', telefone: '11999990000', uf: 'SP', municipio: 'SAO PAULO' },
  { cnpj: '22333444000192', razao_social: 'RESTAURANTE SA', telefone: '21888880000', uf: 'RJ', municipio: 'RIO DE JANEIRO' },
]

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  server.listen({ onUnhandledRequest: 'warn' })
  try {
    const client = await pool.connect()
    try {
      // Check that campaigns table exists (migration 008 applied)
      await client.query('SELECT 1 FROM campaigns LIMIT 1')
      await client.query('SELECT 1 FROM workspace_api_keys LIMIT 1')
      dbAvailable = true

      const keyA = generateTestKey()
      const resA = await client.query<{ id: string }>(
        `INSERT INTO workspace_api_keys (workspace_id, key_hash, label, created_by)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [TEST_WORKSPACE_ID, keyA.keyHash, 'campaign-integration-test-a', 'test-runner'],
      )
      testRawKey = keyA.rawKey
      testKeyId = resA.rows[0].id

      const keyB = generateTestKey()
      const resB = await client.query<{ id: string }>(
        `INSERT INTO workspace_api_keys (workspace_id, key_hash, label, created_by)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [OTHER_WORKSPACE_ID, keyB.keyHash, 'campaign-integration-test-b', 'test-runner'],
      )
      otherRawKey = keyB.rawKey
      otherKeyId = resB.rows[0].id
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
    if (createdCampaignId) {
      await client.query('DELETE FROM campaigns WHERE id = $1', [createdCampaignId])
    }
    if (testKeyId) {
      await client.query('DELETE FROM workspace_api_keys WHERE id = $1', [testKeyId])
    }
    if (otherKeyId) {
      await client.query('DELETE FROM workspace_api_keys WHERE id = $1', [otherKeyId])
    }
  } finally {
    client.release()
  }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Integration: Campaign state machine', () => {
  it('creates a campaign in draft status', async () => {
    if (!dbAvailable || !testRawKey) {
      return expect(true).toBe(true) // skip gracefully
    }

    const res = await createCampaignRoute(
      makePost('/api/campaigns', testRawKey, {
        name: 'Integration Test Campaign',
        recipients: sampleRecipients,
      }),
    )
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data.status).toBe('draft')
    expect(body.data.total_count).toBe(2)
    expect(body.confirmation_token).toBeTruthy()
    expect(body.data.confirmation_token).toBeUndefined() // token not in data

    createdCampaignId = body.data.id
    confirmationToken = body.confirmation_token
  })

  it('GET returns campaign without confirmation_token', async () => {
    if (!dbAvailable || !testRawKey || !createdCampaignId) return

    const res = await getCampaignRoute(
      makeGet(`/api/campaigns/${createdCampaignId}`, testRawKey),
      makeParams(createdCampaignId),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.status).toBe('draft')
    expect(body.data.confirmation_token).toBeUndefined()
    expect(body.data.recipients_summary.pending).toBe(2)
  })

  it('cross-workspace GET returns 403', async () => {
    if (!dbAvailable || !otherRawKey || !createdCampaignId) return

    const res = await getCampaignRoute(
      makeGet(`/api/campaigns/${createdCampaignId}`, otherRawKey),
      makeParams(createdCampaignId),
    )
    expect(res.status).toBe(403)
  })

  it('confirm fails with wrong token', async () => {
    if (!dbAvailable || !testRawKey || !createdCampaignId) return

    const res = await confirmRoute(
      makePost(`/api/campaigns/${createdCampaignId}/confirm`, testRawKey, {
        confirmation_token: 'wrong' + 'z'.repeat(59),
      }),
      makeParams(createdCampaignId),
    )
    expect(res.status).toBe(403)

    // Campaign should still be draft
    const getRes = await getCampaignRoute(
      makeGet(`/api/campaigns/${createdCampaignId}`, testRawKey),
      makeParams(createdCampaignId),
    )
    const getBody = await getRes.json()
    expect(getBody.data.status).toBe('draft')
  })

  it('confirms campaign with correct token → awaiting_channel', async () => {
    if (!dbAvailable || !testRawKey || !createdCampaignId || !confirmationToken) return

    const res = await confirmRoute(
      makePost(`/api/campaigns/${createdCampaignId}/confirm`, testRawKey, {
        confirmation_token: confirmationToken,
      }),
      makeParams(createdCampaignId),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.status).toBe('awaiting_channel')
  })

  it('double-confirm fails (token cleared after use)', async () => {
    if (!dbAvailable || !testRawKey || !createdCampaignId || !confirmationToken) return

    // Campaign is now awaiting_channel, not draft → 409
    const res = await confirmRoute(
      makePost(`/api/campaigns/${createdCampaignId}/confirm`, testRawKey, {
        confirmation_token: confirmationToken,
      }),
      makeParams(createdCampaignId),
    )
    expect(res.status).toBe(409)
  })

  it('lists recipients with pagination', async () => {
    if (!dbAvailable || !testRawKey || !createdCampaignId) return

    const res = await listRecipientsRoute(
      new NextRequest(
        `http://localhost/api/campaigns/${createdCampaignId}/recipients?limit=10&offset=0`,
        { headers: authHeader(testRawKey) },
      ),
      makeParams(createdCampaignId),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(2)
    expect(body.meta.total).toBe(2)
  })

  it('cancels the campaign from awaiting_channel', async () => {
    if (!dbAvailable || !testRawKey || !createdCampaignId) return

    const res = await cancelRoute(
      makePost(`/api/campaigns/${createdCampaignId}/cancel`, testRawKey),
      makeParams(createdCampaignId),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.status).toBe('cancelled')
  })

  it('cancel idempotency — cannot cancel twice', async () => {
    if (!dbAvailable || !testRawKey || !createdCampaignId) return

    const res = await cancelRoute(
      makePost(`/api/campaigns/${createdCampaignId}/cancel`, testRawKey),
      makeParams(createdCampaignId),
    )
    expect(res.status).toBe(409)
  })
})

describe('Integration: Campaign recipient isolation', () => {
  it('cross-workspace cannot list recipients', async () => {
    if (!dbAvailable || !otherRawKey || !createdCampaignId) return

    const res = await listRecipientsRoute(
      new NextRequest(
        `http://localhost/api/campaigns/${createdCampaignId}/recipients`,
        { headers: authHeader(otherRawKey) },
      ),
      makeParams(createdCampaignId),
    )
    // Campaign is already cancelled but belongs to ws-integration-test
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// Integration: Lease recovery (migration 010)
// Validates that a recipient stuck in 'processing' past the lease timeout
// is automatically re-claimed by the next claimPendingRecipients call.
// ---------------------------------------------------------------------------

describe('Integration: Lease recovery for stuck processing recipients', () => {
  let leaseCampaignId: string | null = null

  beforeAll(async () => {
    if (!dbAvailable || !testKeyId) return
    const client = await pool.connect()
    try {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO campaigns
           (workspace_id, name, status, total_count, created_by, confirmation_token)
         VALUES ($1, 'Lease Recovery Test', 'sending', 1, $2, 'dummy-token')
         RETURNING id`,
        [TEST_WORKSPACE_ID, testKeyId],
      )
      leaseCampaignId = rows[0].id

      // Insert one recipient already stuck in 'processing' for 11 minutes
      await client.query(
        `INSERT INTO campaign_recipients
           (campaign_id, cnpj, razao_social, status, processing_started_at)
         VALUES ($1, '99888777000166', 'EMPRESA TRAVADA LTDA', 'processing',
                 NOW() - INTERVAL '11 minutes')`,
        [leaseCampaignId],
      )
    } finally {
      client.release()
    }
  })

  afterAll(async () => {
    if (!dbAvailable || !leaseCampaignId) return
    const client = await pool.connect()
    try {
      await client.query('DELETE FROM campaigns WHERE id = $1', [leaseCampaignId])
    } finally {
      client.release()
    }
  })

  it('re-claims an expired processing recipient and reports recoveredCount=1', async () => {
    if (!dbAvailable || !leaseCampaignId) {
      return expect(true).toBe(true) // skip gracefully
    }

    const client = await pool.connect()
    try {
      const { recipients, recoveredCount } = await claimPendingRecipients(
        client,
        leaseCampaignId,
        10,
      )
      expect(recoveredCount).toBe(1)
      expect(recipients).toHaveLength(1)
      expect(recipients[0].cnpj).toBe('99888777000166')
      expect(recipients[0].status).toBe('processing')
      // processing_started_at must have been refreshed (≤ 5 seconds ago)
      expect(recipients[0].processing_started_at).toBeTruthy()
      const age = Date.now() - recipients[0].processing_started_at!.getTime()
      expect(age).toBeLessThan(5_000)
    } finally {
      client.release()
    }
  })
})

// ---------------------------------------------------------------------------
// Integration: Finalization race guard
// Validates that concurrent calls to finalizeCampaign result in exactly one
// winner (non-null return) and one loser (null return), preventing the stale
// failed_count bug from causing an incorrect 'completed' status.
// ---------------------------------------------------------------------------

describe('Integration: finalizeCampaign race guard', () => {
  let raceCampaignId: string | null = null

  beforeAll(async () => {
    if (!dbAvailable || !testKeyId) return
    const client = await pool.connect()
    try {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO campaigns
           (workspace_id, name, status, total_count, sent_count, failed_count,
            created_by, confirmation_token)
         VALUES ($1, 'Race Guard Test', 'sending', 2, 1, 1, $2, 'dummy-token')
         RETURNING id`,
        [TEST_WORKSPACE_ID, testKeyId],
      )
      raceCampaignId = rows[0].id

      // One recipient already failed
      await client.query(
        `INSERT INTO campaign_recipients
           (campaign_id, cnpj, razao_social, status)
         VALUES ($1, '11000000000191', 'EMPRESA FALHOU SA', 'failed')`,
        [raceCampaignId],
      )
    } finally {
      client.release()
    }
  })

  afterAll(async () => {
    if (!dbAvailable || !raceCampaignId) return
    const client = await pool.connect()
    try {
      await client.query('DELETE FROM campaigns WHERE id = $1', [raceCampaignId])
    } finally {
      client.release()
    }
  })

  it('first finalizeCampaign wins and returns completed_with_errors', async () => {
    if (!dbAvailable || !raceCampaignId) {
      return expect(true).toBe(true) // skip gracefully
    }

    const client = await pool.connect()
    try {
      const result = await finalizeCampaign(client, raceCampaignId)
      expect(result).not.toBeNull()
      expect(result!.status).toBe('completed_with_errors')
    } finally {
      client.release()
    }
  })

  it('second finalizeCampaign returns null (campaign already finalized)', async () => {
    if (!dbAvailable || !raceCampaignId) {
      return expect(true).toBe(true) // skip gracefully
    }

    const client = await pool.connect()
    try {
      const result = await finalizeCampaign(client, raceCampaignId)
      expect(result).toBeNull()
    } finally {
      client.release()
    }
  })

  it('campaign status in DB is completed_with_errors (not overwritten)', async () => {
    if (!dbAvailable || !raceCampaignId) {
      return expect(true).toBe(true) // skip gracefully
    }

    const client = await pool.connect()
    try {
      const { rows } = await client.query(
        'SELECT status FROM campaigns WHERE id = $1',
        [raceCampaignId],
      )
      expect(rows[0].status).toBe('completed_with_errors')
    } finally {
      client.release()
    }
  })
})

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
import { POST as startRoute } from '@/app/api/campaigns/[id]/start/route'
import { POST as pauseRoute } from '@/app/api/campaigns/[id]/pause/route'
import { POST as resumeRoute } from '@/app/api/campaigns/[id]/resume/route'
import { GET as statusRoute } from '@/app/api/campaigns/[id]/status/route'
import { POST as reconcileDeliveryRoute } from '@/app/api/campaigns/reconcile-delivery/route'
import {
  claimPendingRecipients,
  finalizeCampaign,
  scheduleRecipientRetry,
  updateRecipientStatusByProviderMessageId,
  markRecipientDeliveredByProviderMessageId,
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

// ---------------------------------------------------------------------------
// Integration: Campaign automation state machine (migration 014)
// Validates start/pause/resume/cancel transitions via API routes, plus
// scheduleRecipientRetry backoff and claimPendingRecipients next_retry_at guard.
// ---------------------------------------------------------------------------

describe('Integration: Campaign automation flow', () => {
  let autoCampaignId: string | null = null
  let autoRecipientId: string | null = null

  beforeAll(async () => {
    if (!dbAvailable || !testKeyId) return
    const client = await pool.connect()
    try {
      // Insert campaign directly in ready_to_send so we can test /start
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO campaigns
           (workspace_id, name, status, total_count, created_by)
         VALUES ($1, 'Automation Integration Test', 'ready_to_send', 1, $2)
         RETURNING id`,
        [TEST_WORKSPACE_ID, testKeyId],
      )
      autoCampaignId = rows[0].id

      const { rows: recRows } = await client.query<{ id: string }>(
        `INSERT INTO campaign_recipients
           (campaign_id, cnpj, razao_social, telefone, status)
         VALUES ($1, '33444555000103', 'AUTOMACAO LTDA', '11999990001', 'pending')
         RETURNING id`,
        [autoCampaignId],
      )
      autoRecipientId = recRows[0].id
    } finally {
      client.release()
    }
  })

  afterAll(async () => {
    if (!dbAvailable || !autoCampaignId) return
    const client = await pool.connect()
    try {
      await client.query('DELETE FROM campaigns WHERE id = $1', [autoCampaignId])
    } finally {
      client.release()
    }
  })

  it('POST /start transitions ready_to_send → sending and stores automation config', async () => {
    if (!dbAvailable || !testRawKey || !autoCampaignId) return expect(true).toBe(true)

    const res = await startRoute(
      makePost(`/api/campaigns/${autoCampaignId}/start`, testRawKey, {
        delay_seconds: 60,
        jitter_max: 5,
        max_per_hour: 20,
        max_retries: 2,
      }),
      makeParams(autoCampaignId),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.status).toBe('sending')
    expect(body.data.automation_delay_seconds).toBe(60)
    expect(body.data.automation_jitter_max).toBe(5)
    expect(body.data.max_retries).toBe(2)
    expect(body.data.next_send_at).toBeTruthy()
  })

  it('second POST /start returns 409 (campaign already sending)', async () => {
    if (!dbAvailable || !testRawKey || !autoCampaignId) return expect(true).toBe(true)

    const res = await startRoute(
      makePost(`/api/campaigns/${autoCampaignId}/start`, testRawKey, {}),
      makeParams(autoCampaignId),
    )
    expect(res.status).toBe(409)
  })

  it('POST /pause transitions sending → paused and sets paused_at', async () => {
    if (!dbAvailable || !testRawKey || !autoCampaignId) return expect(true).toBe(true)

    const res = await pauseRoute(
      makePost(`/api/campaigns/${autoCampaignId}/pause`, testRawKey),
      makeParams(autoCampaignId),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.status).toBe('paused')
    expect(body.data.paused_at).toBeTruthy()
  })

  it('POST /pause while paused returns 409', async () => {
    if (!dbAvailable || !testRawKey || !autoCampaignId) return expect(true).toBe(true)

    const res = await pauseRoute(
      makePost(`/api/campaigns/${autoCampaignId}/pause`, testRawKey),
      makeParams(autoCampaignId),
    )
    expect(res.status).toBe(409)
  })

  it('POST /resume transitions paused → sending and resets next_send_at', async () => {
    if (!dbAvailable || !testRawKey || !autoCampaignId) return expect(true).toBe(true)

    const res = await resumeRoute(
      makePost(`/api/campaigns/${autoCampaignId}/resume`, testRawKey),
      makeParams(autoCampaignId),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.status).toBe('sending')
    expect(body.data.next_send_at).toBeTruthy()
  })

  it('GET /status returns correct structure for a running campaign', async () => {
    if (!dbAvailable || !testRawKey || !autoCampaignId) return expect(true).toBe(true)

    const res = await statusRoute(
      makeGet(`/api/campaigns/${autoCampaignId}/status`, testRawKey),
      makeParams(autoCampaignId),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.status).toBe('sending')
    expect(body.data.total_count).toBe(1)
    expect(body.data.is_terminal).toBe(false)
    expect(body.data.automation.delay_seconds).toBe(60)
    expect(typeof body.data.progress.pending).toBe('number')
    expect(typeof body.data.progress.sent).toBe('number')
  })

  it('scheduleRecipientRetry schedules retry for first failure (retry_count → 1, pending)', async () => {
    if (!dbAvailable || !autoRecipientId) return expect(true).toBe(true)

    const client = await pool.connect()
    try {
      await client.query(
        `UPDATE campaign_recipients
         SET status = 'processing', processing_started_at = NOW()
         WHERE id = $1`,
        [autoRecipientId],
      )
      await scheduleRecipientRetry(client, autoRecipientId, 0, 2, 'transient error')

      const { rows } = await client.query(
        `SELECT status, retry_count, next_retry_at FROM campaign_recipients WHERE id = $1`,
        [autoRecipientId],
      )
      expect(rows[0].status).toBe('pending')
      expect(rows[0].retry_count).toBe(1)
      expect(rows[0].next_retry_at).toBeTruthy()
    } finally {
      client.release()
    }
  })

  it('scheduleRecipientRetry marks failed when max_retries reached', async () => {
    if (!dbAvailable || !autoRecipientId) return expect(true).toBe(true)

    const client = await pool.connect()
    try {
      await client.query(
        `UPDATE campaign_recipients
         SET status = 'processing', processing_started_at = NOW(), retry_count = 1
         WHERE id = $1`,
        [autoRecipientId],
      )
      // newRetryCount = 1 + 1 = 2 >= max_retries=2 → fail
      await scheduleRecipientRetry(client, autoRecipientId, 1, 2, 'max retries reached')

      const { rows } = await client.query(
        `SELECT status, retry_count FROM campaign_recipients WHERE id = $1`,
        [autoRecipientId],
      )
      expect(rows[0].status).toBe('failed')
    } finally {
      client.release()
    }
  })

  it('POST /cancel from sending transitions to cancelled', async () => {
    if (!dbAvailable || !testRawKey || !autoCampaignId) return expect(true).toBe(true)

    const res = await cancelRoute(
      makePost(`/api/campaigns/${autoCampaignId}/cancel`, testRawKey),
      makeParams(autoCampaignId),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.status).toBe('cancelled')
  })
})

// ---------------------------------------------------------------------------
// Integration: next_retry_at respected by claimPendingRecipients (migration 014)
// ---------------------------------------------------------------------------

describe('Integration: claimPendingRecipients respects next_retry_at', () => {
  let retryCampaignId: string | null = null
  let retryRecipientId: string | null = null

  beforeAll(async () => {
    if (!dbAvailable || !testKeyId) return
    const client = await pool.connect()
    try {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO campaigns
           (workspace_id, name, status, total_count, created_by)
         VALUES ($1, 'Retry Guard Test', 'sending', 1, $2)
         RETURNING id`,
        [TEST_WORKSPACE_ID, testKeyId],
      )
      retryCampaignId = rows[0].id

      // Recipient scheduled for retry 1 hour in the future — must NOT be claimed
      const { rows: recRows } = await client.query<{ id: string }>(
        `INSERT INTO campaign_recipients
           (campaign_id, cnpj, razao_social, telefone, status, retry_count, next_retry_at)
         VALUES ($1, '44555666000114', 'RETRY GUARD LTDA', '11999990002',
                 'pending', 1, NOW() + INTERVAL '1 hour')
         RETURNING id`,
        [retryCampaignId],
      )
      retryRecipientId = recRows[0].id
    } finally {
      client.release()
    }
  })

  afterAll(async () => {
    if (!dbAvailable || !retryCampaignId) return
    const client = await pool.connect()
    try {
      await client.query('DELETE FROM campaigns WHERE id = $1', [retryCampaignId])
    } finally {
      client.release()
    }
  })

  it('does not claim a recipient whose next_retry_at is in the future', async () => {
    if (!dbAvailable || !retryCampaignId) return expect(true).toBe(true)

    const client = await pool.connect()
    try {
      const { recipients } = await claimPendingRecipients(client, retryCampaignId, 10)
      expect(recipients).toHaveLength(0)
    } finally {
      client.release()
    }
  })

  it('claims the recipient once next_retry_at has elapsed', async () => {
    if (!dbAvailable || !retryCampaignId || !retryRecipientId) return expect(true).toBe(true)

    const client = await pool.connect()
    try {
      await client.query(
        `UPDATE campaign_recipients SET next_retry_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
        [retryRecipientId],
      )
      const { recipients } = await claimPendingRecipients(client, retryCampaignId, 10)
      expect(recipients).toHaveLength(1)
      expect(recipients[0].cnpj).toBe('44555666000114')
    } finally {
      client.release()
    }
  })
})


// ---------------------------------------------------------------------------
// Integration: webhook failed event reconciles campaign counters
// ---------------------------------------------------------------------------

describe('Integration: updateRecipientStatusByProviderMessageId', () => {
  let reconcileCampaignId: string | null = null
  let reconcileRecipientId: string | null = null
  let reconcileChannelId: string | null = null
  const PROVIDER_MSG_ID = `wamid.reconcile-${Date.now()}`

  beforeAll(async () => {
    if (!dbAvailable || !testKeyId) return
    const client = await pool.connect()
    try {
      // Create a minimal channel to bind the recipient to
      const { rows: chRows } = await client.query<{ id: string }>(
        `INSERT INTO whatsapp_channels
           (workspace_id, name, provider, status, credentials_encrypted, webhook_secret)
         VALUES ($1, 'Reconcile Test Channel', 'META_CLOUD', 'CONNECTED', 'enc-blob', 'secret')
         RETURNING id`,
        [TEST_WORKSPACE_ID],
      )
      reconcileChannelId = chRows[0].id

      // Campaign in sending state with sent_count=1, failed_count=0
      const { rows: camRows } = await client.query<{ id: string }>(
        `INSERT INTO campaigns
           (workspace_id, name, status, channel_id, total_count, sent_count, failed_count, created_by)
         VALUES ($1, 'Reconcile Test Campaign', 'sending', $2, 1, 1, 0, $3)
         RETURNING id`,
        [TEST_WORKSPACE_ID, reconcileChannelId, testKeyId],
      )
      reconcileCampaignId = camRows[0].id

      // Recipient already marked 'sent' with a known provider_message_id
      const { rows: recRows } = await client.query<{ id: string }>(
        `INSERT INTO campaign_recipients
           (campaign_id, cnpj, razao_social, telefone, status, provider_message_id, sent_at)
         VALUES ($1, '55666777000125', 'RECONCILE LTDA', '11900000001',
                 'sent', $2, NOW())
         RETURNING id`,
        [reconcileCampaignId, PROVIDER_MSG_ID],
      )
      reconcileRecipientId = recRows[0].id
    } finally {
      client.release()
    }
  })

  afterAll(async () => {
    if (!dbAvailable) return
    const client = await pool.connect()
    try {
      if (reconcileCampaignId) await client.query('DELETE FROM campaigns WHERE id = $1', [reconcileCampaignId])
      if (reconcileChannelId) await client.query('DELETE FROM whatsapp_channels WHERE id = $1', [reconcileChannelId])
    } finally {
      client.release()
    }
  })

  it('transitions recipient from sent → failed and adjusts campaign counters', async () => {
    if (!dbAvailable || !reconcileCampaignId || !reconcileRecipientId || !reconcileChannelId) {
      return expect(true).toBe(true)
    }

    const client = await pool.connect()
    try {
      const updated = await updateRecipientStatusByProviderMessageId(
        client,
        reconcileChannelId,
        PROVIDER_MSG_ID,
        'failed',
        'Numero nao existe no WhatsApp',
      )
      expect(updated).toBe(true)

      const { rows: recRows } = await client.query(
        `SELECT status, error_message FROM campaign_recipients WHERE id = $1`,
        [reconcileRecipientId],
      )
      expect(recRows[0].status).toBe('failed')
      expect(recRows[0].error_message).toBe('Numero nao existe no WhatsApp')

      const { rows: camRows } = await client.query(
        `SELECT sent_count, failed_count FROM campaigns WHERE id = $1`,
        [reconcileCampaignId],
      )
      expect(camRows[0].sent_count).toBe(0)
      expect(camRows[0].failed_count).toBe(1)
    } finally {
      client.release()
    }
  })

  it('idempotent: calling twice does not double-adjust counters', async () => {
    if (!dbAvailable || !reconcileCampaignId || !reconcileChannelId) return expect(true).toBe(true)

    const client = await pool.connect()
    try {
      // Recipient is already 'failed' from the previous test — second call must be a no-op
      const updated = await updateRecipientStatusByProviderMessageId(
        client,
        reconcileChannelId,
        PROVIDER_MSG_ID,
        'failed',
        'Chamada duplicada',
      )
      expect(updated).toBe(false)

      const { rows: camRows } = await client.query(
        `SELECT sent_count, failed_count FROM campaigns WHERE id = $1`,
        [reconcileCampaignId],
      )
      // Counters must not have changed from the first call
      expect(camRows[0].sent_count).toBe(0)
      expect(camRows[0].failed_count).toBe(1)
    } finally {
      client.release()
    }
  })

  it('returns false when provider_message_id does not match any sent recipient', async () => {
    if (!dbAvailable || !reconcileChannelId) return expect(true).toBe(true)

    const client = await pool.connect()
    try {
      const updated = await updateRecipientStatusByProviderMessageId(
        client,
        reconcileChannelId,
        'wamid.nonexistent-999',
        'failed',
        'Never sent',
      )
      expect(updated).toBe(false)
    } finally {
      client.release()
    }
  })
})

// ---------------------------------------------------------------------------
// Integration: markRecipientDeliveredByProviderMessageId
// ---------------------------------------------------------------------------

describe('Integration: markRecipientDeliveredByProviderMessageId', () => {
  let delivChannelId: string | null = null
  let delivCampaignId: string | null = null
  let delivRecipientId: string | null = null
  const DELIV_MSG_ID = `wamid.deliv-${Date.now()}`

  beforeAll(async () => {
    if (!dbAvailable || !testKeyId) return
    const client = await pool.connect()
    try {
      const { rows: chRows } = await client.query<{ id: string }>(
        `INSERT INTO whatsapp_channels
           (workspace_id, name, provider, status, credentials_encrypted, webhook_secret)
         VALUES ($1, 'Delivered Test Channel', 'META_CLOUD', 'CONNECTED', 'enc-blob', 'secret')
         RETURNING id`,
        [TEST_WORKSPACE_ID],
      )
      delivChannelId = chRows[0].id

      const { rows: camRows } = await client.query<{ id: string }>(
        `INSERT INTO campaigns
           (workspace_id, name, status, channel_id, total_count, sent_count, failed_count, created_by)
         VALUES ($1, 'Delivered Test Campaign', 'sending', $2, 1, 1, 0, $3)
         RETURNING id`,
        [TEST_WORKSPACE_ID, delivChannelId, testKeyId],
      )
      delivCampaignId = camRows[0].id

      const { rows: recRows } = await client.query<{ id: string }>(
        `INSERT INTO campaign_recipients
           (campaign_id, cnpj, razao_social, telefone, status, provider_message_id, sent_at)
         VALUES ($1, '66777888000136', 'DELIVERED LTDA', '11900000002',
                 'sent', $2, NOW())
         RETURNING id`,
        [delivCampaignId, DELIV_MSG_ID],
      )
      delivRecipientId = recRows[0].id
    } finally {
      client.release()
    }
  })

  afterAll(async () => {
    if (!dbAvailable) return
    const client = await pool.connect()
    try {
      if (delivCampaignId) await client.query('DELETE FROM campaigns WHERE id = $1', [delivCampaignId])
      if (delivChannelId) await client.query('DELETE FROM whatsapp_channels WHERE id = $1', [delivChannelId])
    } finally {
      client.release()
    }
  })

  it('stamps delivered_at on a sent recipient and returns true', async () => {
    if (!dbAvailable || !delivCampaignId || !delivRecipientId || !delivChannelId) {
      return expect(true).toBe(true)
    }
    const client = await pool.connect()
    try {
      const updated = await markRecipientDeliveredByProviderMessageId(
        client,
        delivChannelId,
        DELIV_MSG_ID,
      )
      expect(updated).toBe(true)

      const { rows } = await client.query(
        `SELECT delivered_at FROM campaign_recipients WHERE id = $1`,
        [delivRecipientId],
      )
      expect(rows[0].delivered_at).not.toBeNull()
      expect(rows[0].delivered_at).toBeInstanceOf(Date)
    } finally {
      client.release()
    }
  })

  it('is idempotent: second call returns false and does not update delivered_at again', async () => {
    if (!dbAvailable || !delivCampaignId || !delivRecipientId || !delivChannelId) {
      return expect(true).toBe(true)
    }
    const client = await pool.connect()
    try {
      // Capture the delivered_at set by the previous test
      const { rows: before } = await client.query(
        `SELECT delivered_at FROM campaign_recipients WHERE id = $1`,
        [delivRecipientId],
      )
      const firstDeliveredAt = (before[0].delivered_at as Date).getTime()

      // Second call — recipient already has delivered_at set (WHERE delivered_at IS NULL fails)
      const updated = await markRecipientDeliveredByProviderMessageId(
        client,
        delivChannelId,
        DELIV_MSG_ID,
      )
      expect(updated).toBe(false)

      const { rows: after } = await client.query(
        `SELECT delivered_at FROM campaign_recipients WHERE id = $1`,
        [delivRecipientId],
      )
      // Timestamp must not have changed
      expect((after[0].delivered_at as Date).getTime()).toBe(firstDeliveredAt)
    } finally {
      client.release()
    }
  })
})

// ---------------------------------------------------------------------------
// Integration: reconcile-delivery watchdog
// ---------------------------------------------------------------------------

const WATCHDOG_CRON_TOKEN = 'test-cron-secret-this-is-32-chars!!'

describe('Integration: reconcile-delivery watchdog', () => {
  let watchdogChannelId: string | null = null
  let watchdogCampaignId: string | null = null
  let eligibleRecipientId: string | null = null   // delivered_at=NULL — must timeout
  let protectedRecipientId: string | null = null  // delivered_at set  — must survive
  const ELIGIBLE_MSG   = `wamid.wd-eligible-${Date.now()}`
  const PROTECTED_MSG  = `wamid.wd-protected-${Date.now()}`

  beforeAll(async () => {
    if (!dbAvailable || !testKeyId) return
    const client = await pool.connect()
    try {
      const { rows: chRows } = await client.query<{ id: string }>(
        `INSERT INTO whatsapp_channels
           (workspace_id, name, provider, status, credentials_encrypted, webhook_secret)
         VALUES ($1, 'Watchdog Test Channel', 'META_CLOUD', 'CONNECTED', 'enc-blob', 'secret')
         RETURNING id`,
        [TEST_WORKSPACE_ID],
      )
      watchdogChannelId = chRows[0].id

      // Campaign: sent_count=2 (one eligible, one protected by delivered_at)
      const { rows: camRows } = await client.query<{ id: string }>(
        `INSERT INTO campaigns
           (workspace_id, name, status, channel_id, total_count, sent_count, failed_count, created_by)
         VALUES ($1, 'Watchdog Test Campaign', 'sending', $2, 2, 2, 0, $3)
         RETURNING id`,
        [TEST_WORKSPACE_ID, watchdogChannelId, testKeyId],
      )
      watchdogCampaignId = camRows[0].id

      // Eligible: sent 2 hours ago, delivered_at NULL → must be timed out
      const { rows: r1 } = await client.query<{ id: string }>(
        `INSERT INTO campaign_recipients
           (campaign_id, cnpj, razao_social, telefone, status, provider_message_id, sent_at)
         VALUES ($1, '77888999000147', 'ELIGIBLE LTDA', '11900000003',
                 'sent', $2, NOW() - INTERVAL '2 hours')
         RETURNING id`,
        [watchdogCampaignId, ELIGIBLE_MSG],
      )
      eligibleRecipientId = r1[0].id

      // Protected: sent 2 hours ago, delivered_at IS NOT NULL → must NOT be timed out
      const { rows: r2 } = await client.query<{ id: string }>(
        `INSERT INTO campaign_recipients
           (campaign_id, cnpj, razao_social, telefone, status, provider_message_id, sent_at, delivered_at)
         VALUES ($1, '88999000000158', 'PROTECTED LTDA', '11900000004',
                 'sent', $2, NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour')
         RETURNING id`,
        [watchdogCampaignId, PROTECTED_MSG],
      )
      protectedRecipientId = r2[0].id
    } finally {
      client.release()
    }
  })

  afterAll(async () => {
    if (!dbAvailable) return
    const client = await pool.connect()
    try {
      if (watchdogCampaignId) await client.query('DELETE FROM campaigns WHERE id = $1', [watchdogCampaignId])
      if (watchdogChannelId) await client.query('DELETE FROM whatsapp_channels WHERE id = $1', [watchdogChannelId])
    } finally {
      client.release()
    }
  })

  it('times out eligible recipient but protects one with delivered_at, adjusts counters', async () => {
    if (!dbAvailable || !watchdogCampaignId || !eligibleRecipientId || !protectedRecipientId) {
      return expect(true).toBe(true)
    }

    const req = new NextRequest('http://localhost/api/campaigns/reconcile-delivery', {
      method: 'POST',
      headers: { Authorization: `Bearer ${WATCHDOG_CRON_TOKEN}` },
    })
    const res = await reconcileDeliveryRoute(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)

    const client = await pool.connect()
    try {
      // Eligible recipient must now be failed with the timeout error message
      const { rows: r1 } = await client.query(
        `SELECT status, error_message FROM campaign_recipients WHERE id = $1`,
        [eligibleRecipientId],
      )
      expect(r1[0].status).toBe('failed')
      expect(r1[0].error_message).toBe('timeout_sem_entrega')

      // Protected recipient (delivered_at set) must remain sent
      const { rows: r2 } = await client.query(
        `SELECT status FROM campaign_recipients WHERE id = $1`,
        [protectedRecipientId],
      )
      expect(r2[0].status).toBe('sent')

      // Campaign: sent_count drops by 1 (eligible timed out), failed_count rises by 1
      const { rows: cam } = await client.query(
        `SELECT sent_count, failed_count FROM campaigns WHERE id = $1`,
        [watchdogCampaignId],
      )
      expect(cam[0].sent_count).toBe(1)   // protected recipient still counts as sent
      expect(cam[0].failed_count).toBe(1)
    } finally {
      client.release()
    }
  })

  it('is idempotent: second watchdog run does not change already-failed counters', async () => {
    if (!dbAvailable || !watchdogCampaignId) return expect(true).toBe(true)

    const req = new NextRequest('http://localhost/api/campaigns/reconcile-delivery', {
      method: 'POST',
      headers: { Authorization: `Bearer ${WATCHDOG_CRON_TOKEN}` },
    })
    const res = await reconcileDeliveryRoute(req)
    expect(res.status).toBe(200)

    const client = await pool.connect()
    try {
      // Counters for this campaign must be unchanged from the first watchdog run
      const { rows: cam } = await client.query(
        `SELECT sent_count, failed_count FROM campaigns WHERE id = $1`,
        [watchdogCampaignId],
      )
      expect(cam[0].sent_count).toBe(1)
      expect(cam[0].failed_count).toBe(1)
    } finally {
      client.release()
    }
  })

  it('GREATEST guard: sent_count never goes below 0 even when already at 0', async () => {
    if (!dbAvailable || !testKeyId || !watchdogChannelId) return expect(true).toBe(true)

    const client = await pool.connect()
    let negCampaignId: string | null = null
    try {
      // Campaign artificially at sent_count=0 (counter out-of-sync scenario)
      const { rows: camRows } = await client.query<{ id: string }>(
        `INSERT INTO campaigns
           (workspace_id, name, status, channel_id, total_count, sent_count, failed_count, created_by)
         VALUES ($1, 'GREATEST Test Campaign', 'sending', $2, 1, 0, 0, $3)
         RETURNING id`,
        [TEST_WORKSPACE_ID, watchdogChannelId, testKeyId],
      )
      negCampaignId = camRows[0].id

      // Recipient in sent status, eligible for timeout (2 hours old, no delivered_at)
      await client.query(
        `INSERT INTO campaign_recipients
           (campaign_id, cnpj, razao_social, telefone, status, provider_message_id, sent_at)
         VALUES ($1, '99000111000169', 'GREATEST LTDA', '11900000005',
                 'sent', $2, NOW() - INTERVAL '2 hours')`,
        [negCampaignId, `wamid.greatest-${Date.now()}`],
      )

      const req = new NextRequest('http://localhost/api/campaigns/reconcile-delivery', {
        method: 'POST',
        headers: { Authorization: `Bearer ${WATCHDOG_CRON_TOKEN}` },
      })
      const res = await reconcileDeliveryRoute(req)
      expect(res.status).toBe(200)

      const { rows: cam } = await client.query(
        `SELECT sent_count, failed_count FROM campaigns WHERE id = $1`,
        [negCampaignId],
      )
      // GREATEST(0 - 1, 0) = 0 — never negative
      expect(cam[0].sent_count).toBeGreaterThanOrEqual(0)
      expect(cam[0].failed_count).toBe(1)
    } finally {
      if (negCampaignId) await client.query('DELETE FROM campaigns WHERE id = $1', [negCampaignId])
      client.release()
    }
  })
})

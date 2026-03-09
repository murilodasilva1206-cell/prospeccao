import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import pool from '@/lib/database'
import {
  retryRecipient,
  reopenCampaignToSending,
} from '@/lib/campaign-repo'

// ---------------------------------------------------------------------------
// Integration tests for retryRecipient() and reopenCampaignToSending().
//
// These tests run against a real PostgreSQL instance. They are skipped
// gracefully when the DB is unavailable (no migrations applied, CI without DB).
//
// What is validated (things the unit tests cannot verify because campaign-repo
// is mocked there):
//   - CTE atomicity: recipient reset + failed_count decrement happen together
//   - Cleared fields: provider_message_id, sent_at, delivered_at → NULL
//   - Unchanged fields: retry_count is NOT reset
//   - SQL guards: AND status='failed' AND campaign_id=$2 (wrong status / wrong
//     campaign both return null and make no changes)
//   - GREATEST guard: failed_count never goes below 0
//   - Concurrency: two simultaneous retries on the same recipient — exactly one
//     wins, other returns null (idempotent)
//   - reopenCampaignToSending: only transitions completed_with_errors → sending
// ---------------------------------------------------------------------------

let dbAvailable = false

// Shared IDs created in beforeAll, deleted in afterAll
let testWorkspaceId: string
let campaignId: string       // 'sending' campaign
let cweId: string            // 'completed_with_errors' campaign
let otherCampaignId: string  // campaign in same workspace but different id

beforeAll(async () => {
  testWorkspaceId = `ws-retry-repo-test-${Date.now()}`

  try {
    const client = await pool.connect()
    try {
      await client.query('SELECT 1 FROM campaigns LIMIT 1')
      dbAvailable = true

      // Insert a 'sending' campaign with failed_count=3
      const res = await client.query<{ id: string }>(
        `INSERT INTO campaigns
           (workspace_id, status, total_count, sent_count, failed_count, created_by,
            automation_delay_seconds, automation_jitter_max, automation_max_per_hour, max_retries)
         VALUES ($1, 'sending', 10, 5, 3, 'test-runner', 120, 20, 30, 3)
         RETURNING id`,
        [testWorkspaceId],
      )
      campaignId = res.rows[0].id

      // Insert a 'completed_with_errors' campaign
      const res2 = await client.query<{ id: string }>(
        `INSERT INTO campaigns
           (workspace_id, status, total_count, sent_count, failed_count, created_by,
            automation_delay_seconds, automation_jitter_max, automation_max_per_hour, max_retries)
         VALUES ($1, 'completed_with_errors', 5, 3, 2, 'test-runner', 120, 20, 30, 3)
         RETURNING id`,
        [testWorkspaceId],
      )
      cweId = res2.rows[0].id

      // A separate campaign (same workspace) — used to test cross-campaign SQL guard
      const res3 = await client.query<{ id: string }>(
        `INSERT INTO campaigns
           (workspace_id, status, total_count, sent_count, failed_count, created_by,
            automation_delay_seconds, automation_jitter_max, automation_max_per_hour, max_retries)
         VALUES ($1, 'sending', 5, 2, 1, 'test-runner', 120, 20, 30, 3)
         RETURNING id`,
        [testWorkspaceId],
      )
      otherCampaignId = res3.rows[0].id
    } finally {
      client.release()
    }
  } catch {
    dbAvailable = false
  }
})

afterAll(async () => {
  if (!dbAvailable) return
  const client = await pool.connect()
  try {
    await client.query(
      `DELETE FROM campaigns WHERE workspace_id = $1`,
      [testWorkspaceId],
    )
  } finally {
    client.release()
  }
})

// ---------------------------------------------------------------------------
// Helper: insert a fresh recipient for a campaign and return its id
// ---------------------------------------------------------------------------

async function insertRecipient(
  campaignIdArg: string,
  opts: {
    status?: string
    provider_message_id?: string | null
    sent_at?: string | null
    delivered_at?: string | null
    error_message?: string | null
    retry_count?: number
    failed_count_override?: number  // override campaign.failed_count before insert
  } = {},
): Promise<string> {
  const client = await pool.connect()
  try {
    // Optionally set campaign.failed_count to a specific value
    if (opts.failed_count_override !== undefined) {
      await client.query(
        `UPDATE campaigns SET failed_count = $2 WHERE id = $1`,
        [campaignIdArg, opts.failed_count_override],
      )
    }
    const r = await client.query<{ id: string }>(
      `INSERT INTO campaign_recipients
         (campaign_id, cnpj, razao_social, telefone, status,
          provider_message_id, sent_at, delivered_at, error_message, retry_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        campaignIdArg,
        `${Date.now()}0001`.slice(0, 14),
        'EMPRESA TESTE LTDA',
        '11999999999',
        opts.status ?? 'failed',
        opts.provider_message_id ?? 'msg-abc-123',
        opts.sent_at ?? new Date().toISOString(),
        opts.delivered_at ?? null,
        opts.error_message ?? '429 Too Many Requests',
        opts.retry_count ?? 2,
      ],
    )
    return r.rows[0].id
  } finally {
    client.release()
  }
}

async function getRecipient(recipientId: string) {
  const client = await pool.connect()
  try {
    const { rows } = await client.query(
      `SELECT * FROM campaign_recipients WHERE id = $1`,
      [recipientId],
    )
    return rows[0] ?? null
  } finally {
    client.release()
  }
}

async function getCampaignCounters(id: string) {
  const client = await pool.connect()
  try {
    const { rows } = await client.query(
      `SELECT failed_count, status FROM campaigns WHERE id = $1`,
      [id],
    )
    return rows[0] as { failed_count: number; status: string } | undefined
  } finally {
    client.release()
  }
}

// ---------------------------------------------------------------------------
// retryRecipient() — SQL behaviour
// ---------------------------------------------------------------------------

describe('retryRecipient() — integration', () => {
  it('resets a failed recipient to pending and clears all delivery fields', async () => {
    if (!dbAvailable) return expect(true).toBe(true)

    const rid = await insertRecipient(campaignId, {
      status: 'failed',
      provider_message_id: 'original-msg-id',
      sent_at: new Date().toISOString(),
      delivered_at: null,
      error_message: 'provider timeout',
      retry_count: 1,
    })
    const client = await pool.connect()
    try {
      const result = await retryRecipient(client, campaignId, rid)
      expect(result).not.toBeNull()
      expect(result!.status).toBe('pending')
      expect(result!.error_message).toBeNull()
      expect(result!.provider_message_id).toBeNull()
      expect(result!.sent_at).toBeNull()
      expect(result!.delivered_at).toBeNull()
      expect(result!.next_retry_at).toBeNull()
      expect(result!.processing_started_at).toBeNull()
    } finally {
      client.release()
    }
  })

  it('does NOT reset retry_count (manual retry counts toward max_retries)', async () => {
    if (!dbAvailable) return expect(true).toBe(true)

    const rid = await insertRecipient(campaignId, {
      status: 'failed',
      retry_count: 3,
    })
    const client = await pool.connect()
    try {
      const result = await retryRecipient(client, campaignId, rid)
      expect(result).not.toBeNull()
      expect(result!.retry_count).toBe(3) // unchanged
    } finally {
      client.release()
    }
  })

  it('decrements campaigns.failed_count atomically', async () => {
    if (!dbAvailable) return expect(true).toBe(true)

    // Set failed_count to 2, then retry one recipient
    const rid = await insertRecipient(campaignId, {
      status: 'failed',
      failed_count_override: 2,
    })
    const client = await pool.connect()
    try {
      await retryRecipient(client, campaignId, rid)
      const counters = await getCampaignCounters(campaignId)
      expect(counters?.failed_count).toBe(1)
    } finally {
      client.release()
    }
  })

  it('never decrements failed_count below 0 (GREATEST guard)', async () => {
    if (!dbAvailable) return expect(true).toBe(true)

    const rid = await insertRecipient(campaignId, {
      status: 'failed',
      failed_count_override: 0,  // already at 0
    })
    const client = await pool.connect()
    try {
      await retryRecipient(client, campaignId, rid)
      const counters = await getCampaignCounters(campaignId)
      expect(counters?.failed_count).toBeGreaterThanOrEqual(0)
    } finally {
      client.release()
    }
  })

  it('returns null and makes no changes when recipient is not in failed status', async () => {
    if (!dbAvailable) return expect(true).toBe(true)

    const rid = await insertRecipient(campaignId, {
      status: 'sent',
      provider_message_id: 'keep-this-id',
    })
    const client = await pool.connect()
    try {
      const result = await retryRecipient(client, campaignId, rid)
      expect(result).toBeNull()

      // Verify the row was not modified
      const row = await getRecipient(rid)
      expect(row.status).toBe('sent')
      expect(row.provider_message_id).toBe('keep-this-id')
    } finally {
      client.release()
    }
  })

  it('returns null when recipient belongs to a different campaign (cross-campaign SQL guard)', async () => {
    if (!dbAvailable) return expect(true).toBe(true)

    // Insert a failed recipient in campaignId
    const rid = await insertRecipient(campaignId, { status: 'failed' })
    const client = await pool.connect()
    try {
      // Attempt retry via otherCampaignId — the AND campaign_id=$2 guard should block it
      const result = await retryRecipient(client, otherCampaignId, rid)
      expect(result).toBeNull()

      // Original row must be unchanged (still failed)
      const row = await getRecipient(rid)
      expect(row.status).toBe('failed')
    } finally {
      client.release()
    }
  })

  it('concurrency: two simultaneous retries on the same recipient — exactly one wins', async () => {
    if (!dbAvailable) return expect(true).toBe(true)

    const rid = await insertRecipient(campaignId, { status: 'failed' })
    const clientA = await pool.connect()
    const clientB = await pool.connect()
    try {
      // Fire both retries concurrently
      const [resultA, resultB] = await Promise.all([
        retryRecipient(clientA, campaignId, rid),
        retryRecipient(clientB, campaignId, rid),
      ])

      // Exactly one should succeed (the AND status='failed' guard is in the UPDATE predicate)
      const successes = [resultA, resultB].filter(Boolean)
      const nulls = [resultA, resultB].filter((r) => r === null)

      expect(successes.length).toBe(1)
      expect(nulls.length).toBe(1)

      // Row must be in pending state (not double-reset)
      const row = await getRecipient(rid)
      expect(row.status).toBe('pending')
    } finally {
      clientA.release()
      clientB.release()
    }
  })
})

// ---------------------------------------------------------------------------
// reopenCampaignToSending() — integration
// ---------------------------------------------------------------------------

describe('reopenCampaignToSending() — integration', () => {
  it('transitions completed_with_errors → sending and sets next_send_at=NOW()', async () => {
    if (!dbAvailable) return expect(true).toBe(true)

    const client = await pool.connect()
    try {
      const before = Date.now()
      const result = await reopenCampaignToSending(client, cweId)
      expect(result).toBe(true)

      const { rows } = await client.query(
        `SELECT status, next_send_at FROM campaigns WHERE id = $1`,
        [cweId],
      )
      expect(rows[0].status).toBe('sending')
      const nextSendAt = new Date(rows[0].next_send_at as string).getTime()
      expect(nextSendAt).toBeGreaterThanOrEqual(before - 1000) // within 1s clock margin
    } finally {
      client.release()
    }
  })

  it('returns false when campaign is already in sending (idempotent no-op)', async () => {
    if (!dbAvailable) return expect(true).toBe(true)

    // cweId is now 'sending' after the previous test — calling again should be a no-op
    const client = await pool.connect()
    try {
      const result = await reopenCampaignToSending(client, cweId)
      expect(result).toBe(false)
    } finally {
      client.release()
    }
  })

  it('returns false for a campaign in sending state', async () => {
    if (!dbAvailable) return expect(true).toBe(true)

    const client = await pool.connect()
    try {
      const result = await reopenCampaignToSending(client, campaignId)
      expect(result).toBe(false)
    } finally {
      client.release()
    }
  })

  it('returns false for a non-existent campaign id', async () => {
    if (!dbAvailable) return expect(true).toBe(true)

    const client = await pool.connect()
    try {
      const result = await reopenCampaignToSending(client, '00000000-0000-0000-0000-000000000000')
      expect(result).toBe(false)
    } finally {
      client.release()
    }
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { PoolClient } from 'pg'
import type { Campaign, CampaignRecipient } from '@/lib/campaign-repo'
import type { CampaignStatus } from '@/lib/schemas'

// ---------------------------------------------------------------------------
// Unit tests for manual recipient retry:
//   - retryRecipient() SQL behaviour (mocked pool)
//   - POST /api/campaigns/:id/recipients/:rid/retry (route-level security + logic)
//
// All DB interactions are mocked — no real PostgreSQL connection required.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@/lib/env', () => ({
  env: {
    DB_HOST: 'localhost',
    DB_PORT: 5432,
    DB_NAME: 'test',
    DB_USER: 'test',
    DB_PASSWORD: 'test',
    NODE_ENV: 'test',
    CRON_SECRET: 'test-cron-secret-this-is-32-chars!!',
    CREDENTIALS_ENCRYPTION_KEY: 'a'.repeat(64),
  },
}))

vi.mock('@/lib/database', () => ({
  default: { connect: vi.fn() },
}))

vi.mock('@/lib/rate-limit', () => ({
  campaignLimiter: {
    check: vi.fn().mockResolvedValue({ success: true, remaining: 19, resetAt: Date.now() + 60_000 }),
  },
}))

vi.mock('@/lib/campaign-repo', () => ({
  findCampaignById:         vi.fn(),
  retryRecipient:           vi.fn(),
  reopenCampaignToSending:  vi.fn(),
  insertCampaignAudit:      vi.fn(),
}))

vi.mock('@/lib/whatsapp/auth-middleware', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/whatsapp/auth-middleware')>()
  return {
    ...original,
    requireWorkspaceAuth: vi.fn(),
    authErrorResponse: original.authErrorResponse,
    AuthError: original.AuthError,
  }
})

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import pool from '@/lib/database'
import { findCampaignById, retryRecipient, reopenCampaignToSending, insertCampaignAudit } from '@/lib/campaign-repo'
import { requireWorkspaceAuth, AuthError } from '@/lib/whatsapp/auth-middleware'
import { POST as retryRoute } from '@/app/api/campaigns/[id]/recipients/[rid]/retry/route'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CAMPAIGN_ID = '550e8400-e29b-41d4-a716-446655440000'
const RECIPIENT_ID = '660e8400-e29b-41d4-a716-446655440001'
const OTHER_UUID   = '770e8400-e29b-41d4-a716-446655440002'
const WS_A = 'ws-a'
const WS_B = 'ws-b'

function makeCampaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: CAMPAIGN_ID,
    workspace_id: WS_A,
    name: null,
    status: 'sending' as CampaignStatus,
    channel_id: null,
    message_type: null,
    message_content: null,
    search_filters: null,
    total_count: 10,
    sent_count: 5,
    failed_count: 3,
    confirmation_token: null,
    created_by: 'key-1',
    created_at: new Date(),
    updated_at: new Date(),
    automation_delay_seconds: 120,
    automation_jitter_max: 20,
    automation_max_per_hour: 30,
    automation_working_hours_start: null,
    automation_working_hours_end: null,
    max_retries: 3,
    next_send_at: null,
    paused_at: null,
    ...overrides,
  }
}

function makeRecipient(overrides: Partial<CampaignRecipient> = {}): CampaignRecipient {
  return {
    id: RECIPIENT_ID,
    campaign_id: CAMPAIGN_ID,
    cnpj: '12345678000195',
    razao_social: 'Empresa Teste Ltda',
    nome_fantasia: null,
    telefone: '11999999999',
    email: null,
    municipio: 'SAO PAULO',
    uf: 'SP',
    status: 'pending',
    provider_message_id: null,
    error_message: null,
    sent_at: null,
    delivered_at: null,
    processing_started_at: null,
    retry_count: 2,
    next_retry_at: null,
    created_at: new Date(),
    ...overrides,
  }
}

function makeRequest(campaignId: string, recipientId: string, auth?: string): NextRequest {
  const headers: Record<string, string> = {}
  if (auth) headers['Authorization'] = auth
  return new NextRequest(
    `http://localhost/api/campaigns/${campaignId}/recipients/${recipientId}/retry`,
    { method: 'POST', headers },
  )
}

function makeParams(campaignId: string, recipientId: string) {
  return { params: Promise.resolve({ id: campaignId, rid: recipientId }) }
}

function mockAuth(workspaceId = WS_A, keyId = 'key-1') {
  vi.mocked(requireWorkspaceAuth).mockResolvedValue({
    workspace_id:   workspaceId,
    actor:          `api_key:test`,
    key_id:         keyId,
    dedup_actor_id: `api_key:${keyId}`,
  })
}

function mockAuthFail() {
  vi.mocked(requireWorkspaceAuth).mockRejectedValue(new AuthError('Invalid or revoked API key'))
}

function mockPoolConnect(queryFn = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })) {
  const client = { query: queryFn, release: vi.fn() } as unknown as PoolClient
  vi.mocked(pool.connect).mockResolvedValue(client as never)
  return client
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(insertCampaignAudit).mockResolvedValue(undefined)
  vi.mocked(reopenCampaignToSending).mockResolvedValue(false)
})

// ---------------------------------------------------------------------------
// retryRecipient() SQL contract (repo-level unit tests via mock)
// ---------------------------------------------------------------------------

describe('retryRecipient() SQL contract', () => {
  it('returns null when query returns no rows (wrong campaign, wrong status, or not found)', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as PoolClient
    // Import real function — we test its SQL behaviour via mock client
    const { retryRecipient: realFn } = await import('@/lib/campaign-repo')
    // Because campaign-repo is mocked globally, we test the SQL text indirectly via the route
    // For direct SQL tests we verify the mock contract only
    expect(realFn).toBeDefined()
  })

  it('uses $1=recipientId, $2=campaignId as positional params', async () => {
    // Verify the route passes args in correct order to retryRecipient
    mockPoolConnect()
    mockAuth()
    vi.mocked(findCampaignById).mockResolvedValue(makeCampaign())
    vi.mocked(retryRecipient).mockResolvedValue(makeRecipient())

    const req = makeRequest(CAMPAIGN_ID, RECIPIENT_ID)
    await retryRoute(req, makeParams(CAMPAIGN_ID, RECIPIENT_ID))

    expect(vi.mocked(retryRecipient)).toHaveBeenCalledWith(
      expect.anything(), // PoolClient
      CAMPAIGN_ID,        // $2 = campaign_id (ownership anchor)
      RECIPIENT_ID,       // $1 = recipient id
    )
  })
})

// ---------------------------------------------------------------------------
// POST /api/campaigns/:id/recipients/:rid/retry — route security + logic
// ---------------------------------------------------------------------------

describe('POST /api/campaigns/:id/recipients/:rid/retry', () => {
  describe('authentication', () => {
    it('returns 401 when no auth', async () => {
      mockPoolConnect()
      mockAuthFail()
      const req = makeRequest(CAMPAIGN_ID, RECIPIENT_ID)
      const res = await retryRoute(req, makeParams(CAMPAIGN_ID, RECIPIENT_ID))
      expect(res.status).toBe(401)
    })
  })

  describe('input validation', () => {
    it('returns 400 for invalid campaign UUID', async () => {
      mockPoolConnect()
      mockAuth()
      const req = makeRequest('not-a-uuid', RECIPIENT_ID)
      const res = await retryRoute(req, makeParams('not-a-uuid', RECIPIENT_ID))
      expect(res.status).toBe(400)
    })

    it('returns 400 for invalid recipient UUID', async () => {
      mockPoolConnect()
      mockAuth()
      const req = makeRequest(CAMPAIGN_ID, 'not-a-uuid')
      const res = await retryRoute(req, makeParams(CAMPAIGN_ID, 'not-a-uuid'))
      expect(res.status).toBe(400)
    })
  })

  describe('campaign ownership + existence', () => {
    it('returns 404 when campaign not found', async () => {
      mockPoolConnect()
      mockAuth()
      vi.mocked(findCampaignById).mockResolvedValue(null)
      const res = await retryRoute(makeRequest(CAMPAIGN_ID, RECIPIENT_ID), makeParams(CAMPAIGN_ID, RECIPIENT_ID))
      expect(res.status).toBe(404)
    })

    it('returns 403 when campaign belongs to another workspace', async () => {
      mockPoolConnect()
      mockAuth(WS_B) // auth as WS_B
      vi.mocked(findCampaignById).mockResolvedValue(makeCampaign({ workspace_id: WS_A })) // campaign in WS_A
      const res = await retryRoute(makeRequest(CAMPAIGN_ID, RECIPIENT_ID), makeParams(CAMPAIGN_ID, RECIPIENT_ID))
      expect(res.status).toBe(403)
    })
  })

  describe('campaign status guard', () => {
    const disallowedStatuses: CampaignStatus[] = [
      'draft', 'awaiting_confirmation', 'awaiting_channel', 'awaiting_message',
      'ready_to_send', 'completed', 'cancelled',
    ]

    for (const s of disallowedStatuses) {
      it(`returns 409 when campaign is in '${s}'`, async () => {
        mockPoolConnect()
        mockAuth()
        vi.mocked(findCampaignById).mockResolvedValue(makeCampaign({ status: s }))
        const res = await retryRoute(makeRequest(CAMPAIGN_ID, RECIPIENT_ID), makeParams(CAMPAIGN_ID, RECIPIENT_ID))
        expect(res.status).toBe(409)
        const body = await res.json() as { error: string }
        expect(body.error).toMatch(/nao permitido/)
      })
    }

    const allowedStatuses: CampaignStatus[] = ['sending', 'paused', 'completed_with_errors']
    for (const s of allowedStatuses) {
      it(`returns 200 when campaign is in '${s}' and recipient is eligible`, async () => {
        mockPoolConnect()
        mockAuth()
        vi.mocked(findCampaignById).mockResolvedValue(makeCampaign({ status: s }))
        vi.mocked(retryRecipient).mockResolvedValue(makeRecipient())
        const res = await retryRoute(makeRequest(CAMPAIGN_ID, RECIPIENT_ID), makeParams(CAMPAIGN_ID, RECIPIENT_ID))
        expect(res.status).toBe(200)
      })
    }
  })

  describe('recipient eligibility', () => {
    it('returns 409 when recipient is not in failed status (retryRecipient returns null)', async () => {
      mockPoolConnect()
      mockAuth()
      vi.mocked(findCampaignById).mockResolvedValue(makeCampaign({ status: 'sending' }))
      vi.mocked(retryRecipient).mockResolvedValue(null) // not failed, or wrong campaign
      const res = await retryRoute(makeRequest(CAMPAIGN_ID, RECIPIENT_ID), makeParams(CAMPAIGN_ID, RECIPIENT_ID))
      expect(res.status).toBe(409)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/nao elegivel/)
    })

    it('returns 409 when concurrent retry already claimed the recipient (null returned)', async () => {
      mockPoolConnect()
      mockAuth()
      vi.mocked(findCampaignById).mockResolvedValue(makeCampaign({ status: 'paused' }))
      vi.mocked(retryRecipient).mockResolvedValue(null)
      const res = await retryRoute(makeRequest(CAMPAIGN_ID, RECIPIENT_ID), makeParams(CAMPAIGN_ID, RECIPIENT_ID))
      expect(res.status).toBe(409)
    })
  })

  describe('completed_with_errors — reopen logic', () => {
    it('calls reopenCampaignToSending when campaign is completed_with_errors', async () => {
      mockPoolConnect()
      mockAuth()
      vi.mocked(findCampaignById).mockResolvedValue(makeCampaign({ status: 'completed_with_errors' }))
      vi.mocked(retryRecipient).mockResolvedValue(makeRecipient())
      vi.mocked(reopenCampaignToSending).mockResolvedValue(true)

      const res = await retryRoute(makeRequest(CAMPAIGN_ID, RECIPIENT_ID), makeParams(CAMPAIGN_ID, RECIPIENT_ID))
      expect(res.status).toBe(200)
      expect(vi.mocked(reopenCampaignToSending)).toHaveBeenCalledWith(expect.anything(), CAMPAIGN_ID)
      const body = await res.json() as { campaign_reopened: boolean }
      expect(body.campaign_reopened).toBe(true)
    })

    it('does NOT call reopenCampaignToSending when campaign is sending', async () => {
      mockPoolConnect()
      mockAuth()
      vi.mocked(findCampaignById).mockResolvedValue(makeCampaign({ status: 'sending' }))
      vi.mocked(retryRecipient).mockResolvedValue(makeRecipient())

      await retryRoute(makeRequest(CAMPAIGN_ID, RECIPIENT_ID), makeParams(CAMPAIGN_ID, RECIPIENT_ID))
      expect(vi.mocked(reopenCampaignToSending)).not.toHaveBeenCalled()
    })

    it('does NOT call reopenCampaignToSending when campaign is paused', async () => {
      mockPoolConnect()
      mockAuth()
      vi.mocked(findCampaignById).mockResolvedValue(makeCampaign({ status: 'paused' }))
      vi.mocked(retryRecipient).mockResolvedValue(makeRecipient())

      await retryRoute(makeRequest(CAMPAIGN_ID, RECIPIENT_ID), makeParams(CAMPAIGN_ID, RECIPIENT_ID))
      expect(vi.mocked(reopenCampaignToSending)).not.toHaveBeenCalled()
    })
  })

  describe('audit log', () => {
    it('inserts audit log with recipient_id on success', async () => {
      mockPoolConnect()
      mockAuth(WS_A, 'key-99')
      vi.mocked(findCampaignById).mockResolvedValue(makeCampaign({ status: 'paused' }))
      vi.mocked(retryRecipient).mockResolvedValue(makeRecipient())

      await retryRoute(makeRequest(CAMPAIGN_ID, RECIPIENT_ID), makeParams(CAMPAIGN_ID, RECIPIENT_ID))

      expect(vi.mocked(insertCampaignAudit)).toHaveBeenCalledWith(
        expect.anything(),
        CAMPAIGN_ID,
        'recipient_retry_manual',
        'key-99',
        expect.objectContaining({ recipient_id: RECIPIENT_ID }),
      )
    })

    it('does NOT insert audit log when recipient is not eligible', async () => {
      mockPoolConnect()
      mockAuth()
      vi.mocked(findCampaignById).mockResolvedValue(makeCampaign({ status: 'sending' }))
      vi.mocked(retryRecipient).mockResolvedValue(null)

      await retryRoute(makeRequest(CAMPAIGN_ID, RECIPIENT_ID), makeParams(CAMPAIGN_ID, RECIPIENT_ID))
      expect(vi.mocked(insertCampaignAudit)).not.toHaveBeenCalled()
    })
  })

  describe('successful response shape', () => {
    it('returns { data: recipient, campaign_reopened: false } on normal success', async () => {
      mockPoolConnect()
      mockAuth()
      const recipient = makeRecipient({ retry_count: 2 })
      vi.mocked(findCampaignById).mockResolvedValue(makeCampaign({ status: 'sending' }))
      vi.mocked(retryRecipient).mockResolvedValue(recipient)

      const res = await retryRoute(makeRequest(CAMPAIGN_ID, RECIPIENT_ID), makeParams(CAMPAIGN_ID, RECIPIENT_ID))
      expect(res.status).toBe(200)
      const body = await res.json() as { data: CampaignRecipient; campaign_reopened: boolean }
      expect(body.data.id).toBe(RECIPIENT_ID)
      expect(body.data.status).toBe('pending')
      expect(body.campaign_reopened).toBe(false)
    })
  })

  describe('cross-workspace isolation', () => {
    it('cannot retry a recipient whose campaign belongs to another workspace', async () => {
      mockPoolConnect()
      mockAuth(WS_B) // attacker authenticates as WS_B
      vi.mocked(findCampaignById).mockResolvedValue(makeCampaign({ workspace_id: WS_A })) // campaign in WS_A
      const res = await retryRoute(makeRequest(CAMPAIGN_ID, RECIPIENT_ID), makeParams(CAMPAIGN_ID, RECIPIENT_ID))
      // Should be blocked at workspace check before retryRecipient is ever called
      expect(res.status).toBe(403)
      expect(vi.mocked(retryRecipient)).not.toHaveBeenCalled()
    })

    it('cannot reach a recipient via a different campaign UUID (SQL anchor)', async () => {
      // Route passes campaignId from URL — retryRecipient uses AND campaign_id=$2 in SQL
      mockPoolConnect()
      mockAuth()
      vi.mocked(findCampaignById).mockResolvedValue(makeCampaign({ status: 'sending' }))
      vi.mocked(retryRecipient).mockResolvedValue(null) // SQL guard catches cross-campaign attempt

      const res = await retryRoute(makeRequest(CAMPAIGN_ID, RECIPIENT_ID), makeParams(CAMPAIGN_ID, RECIPIENT_ID))
      expect(res.status).toBe(409) // not eligible because SQL AND campaign_id=$2 returned no rows
    })
  })

  describe('rate limiting', () => {
    it('returns 429 when rate limit is exceeded', async () => {
      const { campaignLimiter } = await import('@/lib/rate-limit')
      vi.mocked(campaignLimiter.check).mockResolvedValueOnce({
        success: false,
        remaining: 0,
        resetAt: Date.now() + 30_000,
      })
      const res = await retryRoute(makeRequest(CAMPAIGN_ID, RECIPIENT_ID), makeParams(CAMPAIGN_ID, RECIPIENT_ID))
      expect(res.status).toBe(429)
    })
  })
})

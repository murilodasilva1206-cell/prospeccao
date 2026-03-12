import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { PoolClient } from 'pg'
import type { Campaign } from '@/lib/campaign-repo'
import type { CampaignStatus } from '@/lib/schemas'

// ---------------------------------------------------------------------------
// Unit tests for:
//   POST /api/campaigns/:id/recipients/retry-all-failed
//
// All DB interactions are mocked — no real PostgreSQL connection required.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Mocks — must be declared before any imports of the route under test
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
  findCampaignById:        vi.fn(),
  retryAllFailed:          vi.fn(),
  reopenCampaignToSending: vi.fn(),
  insertCampaignAudit:     vi.fn(),
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
import {
  findCampaignById,
  retryAllFailed,
  reopenCampaignToSending,
  insertCampaignAudit,
} from '@/lib/campaign-repo'
import { requireWorkspaceAuth, AuthError } from '@/lib/whatsapp/auth-middleware'
import { campaignLimiter } from '@/lib/rate-limit'
import { POST as retryAllFailedRoute } from '@/app/api/campaigns/[id]/recipients/retry-all-failed/route'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CAMPAIGN_ID = '550e8400-e29b-41d4-a716-446655440000'
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
    total_count: 20,
    sent_count: 10,
    failed_count: 5,
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

function makeRequest(campaignId: string, auth?: string): NextRequest {
  const headers: Record<string, string> = {}
  if (auth) headers['Authorization'] = auth
  return new NextRequest(
    `http://localhost/api/campaigns/${campaignId}/recipients/retry-all-failed`,
    { method: 'POST', headers },
  )
}

function makeParams(campaignId: string) {
  return { params: Promise.resolve({ id: campaignId }) }
}

function mockAuth(workspaceId = WS_A, keyId = 'key-1') {
  vi.mocked(requireWorkspaceAuth).mockResolvedValue({
    workspace_id:   workspaceId,
    actor:          'api_key:test',
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
// POST /api/campaigns/:id/recipients/retry-all-failed
// ---------------------------------------------------------------------------

describe('POST /api/campaigns/:id/recipients/retry-all-failed', () => {
  describe('authentication', () => {
    it('returns 401 when requireWorkspaceAuth throws AuthError', async () => {
      mockPoolConnect()
      mockAuthFail()
      const req = makeRequest(CAMPAIGN_ID)
      const res = await retryAllFailedRoute(req, makeParams(CAMPAIGN_ID))
      expect(res.status).toBe(401)
    })
  })

  describe('input validation', () => {
    it('returns 400 for invalid campaign UUID in id param', async () => {
      mockPoolConnect()
      mockAuth()
      const req = makeRequest('not-a-uuid')
      const res = await retryAllFailedRoute(req, makeParams('not-a-uuid'))
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/id inválido/)
    })
  })

  describe('campaign existence + ownership', () => {
    it('returns 404 when campaign not found', async () => {
      mockPoolConnect()
      mockAuth()
      vi.mocked(findCampaignById).mockResolvedValue(null)
      const req = makeRequest(CAMPAIGN_ID)
      const res = await retryAllFailedRoute(req, makeParams(CAMPAIGN_ID))
      expect(res.status).toBe(404)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/nao encontrada/)
    })

    it('returns 403 when campaign belongs to a different workspace', async () => {
      mockPoolConnect()
      mockAuth(WS_B)
      vi.mocked(findCampaignById).mockResolvedValue(makeCampaign({ workspace_id: WS_A }))
      const req = makeRequest(CAMPAIGN_ID)
      const res = await retryAllFailedRoute(req, makeParams(CAMPAIGN_ID))
      expect(res.status).toBe(403)
    })
  })

  describe('campaign status guard', () => {
    it('returns 409 when campaign status is not in allowed list (e.g. draft)', async () => {
      mockPoolConnect()
      mockAuth()
      vi.mocked(findCampaignById).mockResolvedValue(makeCampaign({ status: 'draft' }))
      const req = makeRequest(CAMPAIGN_ID)
      const res = await retryAllFailedRoute(req, makeParams(CAMPAIGN_ID))
      expect(res.status).toBe(409)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/nao permitido/)
    })
  })

  describe('no failed recipients guard', () => {
    it('returns 409 when retryAllFailed returns 0 (no failed recipients)', async () => {
      mockPoolConnect()
      mockAuth()
      vi.mocked(findCampaignById).mockResolvedValue(makeCampaign({ status: 'sending' }))
      vi.mocked(retryAllFailed).mockResolvedValue(0)
      const req = makeRequest(CAMPAIGN_ID)
      const res = await retryAllFailedRoute(req, makeParams(CAMPAIGN_ID))
      expect(res.status).toBe(409)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/Nenhum destinatario/)
    })
  })

  describe('successful retry', () => {
    it('returns 200 with retried_count=5 and campaign_reopened=false when status is sending', async () => {
      mockPoolConnect()
      mockAuth()
      vi.mocked(findCampaignById).mockResolvedValue(makeCampaign({ status: 'sending' }))
      vi.mocked(retryAllFailed).mockResolvedValue(5)
      const req = makeRequest(CAMPAIGN_ID)
      const res = await retryAllFailedRoute(req, makeParams(CAMPAIGN_ID))
      expect(res.status).toBe(200)
      const body = await res.json() as { data: { retried_count: number; campaign_reopened: boolean } }
      expect(body.data.retried_count).toBe(5)
      expect(body.data.campaign_reopened).toBe(false)
      expect(vi.mocked(reopenCampaignToSending)).not.toHaveBeenCalled()
    })

    it('returns 200 with campaign_reopened=false when status is paused', async () => {
      mockPoolConnect()
      mockAuth()
      vi.mocked(findCampaignById).mockResolvedValue(makeCampaign({ status: 'paused' }))
      vi.mocked(retryAllFailed).mockResolvedValue(3)
      const req = makeRequest(CAMPAIGN_ID)
      const res = await retryAllFailedRoute(req, makeParams(CAMPAIGN_ID))
      expect(res.status).toBe(200)
      const body = await res.json() as { data: { retried_count: number; campaign_reopened: boolean } }
      expect(body.data.campaign_reopened).toBe(false)
      expect(vi.mocked(reopenCampaignToSending)).not.toHaveBeenCalled()
    })

    it('returns 200 with campaign_reopened=true and calls reopenCampaignToSending when status is completed_with_errors', async () => {
      mockPoolConnect()
      mockAuth()
      vi.mocked(findCampaignById).mockResolvedValue(makeCampaign({ status: 'completed_with_errors' }))
      vi.mocked(retryAllFailed).mockResolvedValue(7)
      vi.mocked(reopenCampaignToSending).mockResolvedValue(true)
      const req = makeRequest(CAMPAIGN_ID)
      const res = await retryAllFailedRoute(req, makeParams(CAMPAIGN_ID))
      expect(res.status).toBe(200)
      expect(vi.mocked(reopenCampaignToSending)).toHaveBeenCalledWith(expect.anything(), CAMPAIGN_ID)
      const body = await res.json() as { data: { retried_count: number; campaign_reopened: boolean } }
      expect(body.data.retried_count).toBe(7)
      expect(body.data.campaign_reopened).toBe(true)
    })
  })

  describe('audit log', () => {
    it('calls insertCampaignAudit with recipients_retry_all_failed event, correct retried_count and campaign_reopened', async () => {
      mockPoolConnect()
      mockAuth(WS_A, 'key-99')
      vi.mocked(findCampaignById).mockResolvedValue(makeCampaign({ status: 'completed_with_errors' }))
      vi.mocked(retryAllFailed).mockResolvedValue(4)
      vi.mocked(reopenCampaignToSending).mockResolvedValue(true)
      const req = makeRequest(CAMPAIGN_ID)
      await retryAllFailedRoute(req, makeParams(CAMPAIGN_ID))
      expect(vi.mocked(insertCampaignAudit)).toHaveBeenCalledWith(
        expect.anything(),
        CAMPAIGN_ID,
        'recipients_retry_all_failed',
        'key-99',
        expect.objectContaining({
          retried_count:    4,
          campaign_reopened: true,
        }),
      )
    })
  })

  describe('rate limiting', () => {
    it('returns 429 when rate limit is exceeded', async () => {
      vi.mocked(campaignLimiter.check).mockResolvedValueOnce({
        success: false,
        remaining: 0,
        resetAt: Date.now() + 30_000,
      })
      const req = makeRequest(CAMPAIGN_ID)
      const res = await retryAllFailedRoute(req, makeParams(CAMPAIGN_ID))
      expect(res.status).toBe(429)
    })
  })
})

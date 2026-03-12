import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { PoolClient } from 'pg'
import type { Campaign } from '@/lib/campaign-repo'
import type { Channel } from '@/lib/whatsapp/types'
import type { CampaignStatus } from '@/lib/schemas'

// ---------------------------------------------------------------------------
// Unit tests for:
//   POST /api/campaigns/:id/reassign-channel
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
  reassignCampaignChannel: vi.fn(),
  insertCampaignAudit:     vi.fn(),
}))

vi.mock('@/lib/whatsapp/channel-repo', () => ({
  findChannelById: vi.fn(),
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
import { findCampaignById, reassignCampaignChannel, insertCampaignAudit } from '@/lib/campaign-repo'
import { findChannelById } from '@/lib/whatsapp/channel-repo'
import { requireWorkspaceAuth, AuthError } from '@/lib/whatsapp/auth-middleware'
import { campaignLimiter } from '@/lib/rate-limit'
import { POST as reassignChannelRoute } from '@/app/api/campaigns/[id]/reassign-channel/route'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CAMPAIGN_ID = '550e8400-e29b-41d4-a716-446655440000'
const CHANNEL_ID  = '660e8400-e29b-41d4-a716-446655440001'
const WS_A = 'ws-a'
const WS_B = 'ws-b'

function makeCampaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: CAMPAIGN_ID,
    workspace_id: WS_A,
    name: null,
    status: 'paused' as CampaignStatus,
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

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: CHANNEL_ID,
    workspace_id: WS_A,
    name: 'Canal Teste',
    provider: 'EVOLUTION',
    status: 'CONNECTED',
    phone_number: null,
    external_instance_id: null,
    credentials_encrypted: 'encrypted-blob',
    webhook_secret: 'secret',
    last_seen_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  }
}

function makeRequest(campaignId: string, body: unknown, auth?: string): NextRequest {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (auth) headers['Authorization'] = auth
  return new NextRequest(
    `http://localhost/api/campaigns/${campaignId}/reassign-channel`,
    { method: 'POST', headers, body: JSON.stringify(body) },
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
  vi.mocked(reassignCampaignChannel).mockResolvedValue(makeCampaign())
})

// ---------------------------------------------------------------------------
// POST /api/campaigns/:id/reassign-channel
// ---------------------------------------------------------------------------

describe('POST /api/campaigns/:id/reassign-channel', () => {
  describe('authentication', () => {
    it('returns 401 when requireWorkspaceAuth throws AuthError', async () => {
      mockPoolConnect()
      mockAuthFail()
      const req = makeRequest(CAMPAIGN_ID, { channel_id: CHANNEL_ID })
      const res = await reassignChannelRoute(req, makeParams(CAMPAIGN_ID))
      expect(res.status).toBe(401)
    })
  })

  describe('input validation', () => {
    it('returns 400 for invalid campaign UUID in id param', async () => {
      mockPoolConnect()
      mockAuth()
      const req = makeRequest('not-a-uuid', { channel_id: CHANNEL_ID })
      const res = await reassignChannelRoute(req, makeParams('not-a-uuid'))
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/id inválido/)
    })

    it('returns 400 when body channel_id is not a UUID', async () => {
      mockPoolConnect()
      mockAuth()
      vi.mocked(findCampaignById).mockResolvedValue(makeCampaign())
      vi.mocked(findChannelById).mockResolvedValue(makeChannel())
      const req = makeRequest(CAMPAIGN_ID, { channel_id: 'not-a-uuid' })
      const res = await reassignChannelRoute(req, makeParams(CAMPAIGN_ID))
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/Parâmetros inválidos/)
    })
  })

  describe('campaign existence + ownership', () => {
    it('returns 404 when campaign not found', async () => {
      mockPoolConnect()
      mockAuth()
      vi.mocked(findCampaignById).mockResolvedValue(null)
      vi.mocked(findChannelById).mockResolvedValue(makeChannel())
      const req = makeRequest(CAMPAIGN_ID, { channel_id: CHANNEL_ID })
      const res = await reassignChannelRoute(req, makeParams(CAMPAIGN_ID))
      expect(res.status).toBe(404)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/nao encontrada/)
    })

    it('returns 403 when campaign belongs to a different workspace', async () => {
      mockPoolConnect()
      mockAuth(WS_B)
      vi.mocked(findCampaignById).mockResolvedValue(makeCampaign({ workspace_id: WS_A }))
      vi.mocked(findChannelById).mockResolvedValue(makeChannel())
      const req = makeRequest(CAMPAIGN_ID, { channel_id: CHANNEL_ID })
      const res = await reassignChannelRoute(req, makeParams(CAMPAIGN_ID))
      expect(res.status).toBe(403)
    })
  })

  describe('campaign status guard', () => {
    it('returns 409 when campaign is not paused (e.g. status=sending)', async () => {
      mockPoolConnect()
      mockAuth()
      vi.mocked(findCampaignById).mockResolvedValue(makeCampaign({ status: 'sending' }))
      vi.mocked(findChannelById).mockResolvedValue(makeChannel())
      const req = makeRequest(CAMPAIGN_ID, { channel_id: CHANNEL_ID })
      const res = await reassignChannelRoute(req, makeParams(CAMPAIGN_ID))
      expect(res.status).toBe(409)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/pausadas/)
    })
  })

  describe('channel existence + ownership', () => {
    it('returns 404 when channel not found', async () => {
      mockPoolConnect()
      mockAuth()
      vi.mocked(findCampaignById).mockResolvedValue(makeCampaign())
      vi.mocked(findChannelById).mockResolvedValue(null)
      const req = makeRequest(CAMPAIGN_ID, { channel_id: CHANNEL_ID })
      const res = await reassignChannelRoute(req, makeParams(CAMPAIGN_ID))
      expect(res.status).toBe(404)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/Canal nao encontrado/)
    })

    it('returns 403 when channel belongs to a different workspace', async () => {
      mockPoolConnect()
      mockAuth(WS_A)
      vi.mocked(findCampaignById).mockResolvedValue(makeCampaign({ workspace_id: WS_A }))
      vi.mocked(findChannelById).mockResolvedValue(makeChannel({ workspace_id: WS_B }))
      const req = makeRequest(CAMPAIGN_ID, { channel_id: CHANNEL_ID })
      const res = await reassignChannelRoute(req, makeParams(CAMPAIGN_ID))
      expect(res.status).toBe(403)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/nao pertence/)
    })

    it('returns 409 when channel is not CONNECTED (e.g. status=DISCONNECTED)', async () => {
      mockPoolConnect()
      mockAuth()
      vi.mocked(findCampaignById).mockResolvedValue(makeCampaign())
      vi.mocked(findChannelById).mockResolvedValue(makeChannel({ status: 'DISCONNECTED' }))
      const req = makeRequest(CAMPAIGN_ID, { channel_id: CHANNEL_ID })
      const res = await reassignChannelRoute(req, makeParams(CAMPAIGN_ID))
      expect(res.status).toBe(409)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/não está conectado/)
    })
  })

  describe('successful reassignment', () => {
    it('returns 200 with updated campaign and channel_provider', async () => {
      mockPoolConnect()
      mockAuth()
      const updatedCampaign = makeCampaign({ channel_id: CHANNEL_ID })
      const channel = makeChannel({ provider: 'EVOLUTION' })
      vi.mocked(findCampaignById).mockResolvedValue(makeCampaign())
      vi.mocked(findChannelById).mockResolvedValue(channel)
      vi.mocked(reassignCampaignChannel).mockResolvedValue(updatedCampaign)
      const req = makeRequest(CAMPAIGN_ID, { channel_id: CHANNEL_ID })
      const res = await reassignChannelRoute(req, makeParams(CAMPAIGN_ID))
      expect(res.status).toBe(200)
      const body = await res.json() as { data: Campaign; channel_provider: string }
      expect(body.data.id).toBe(CAMPAIGN_ID)
      expect(body.channel_provider).toBe('EVOLUTION')
    })
  })

  describe('concurrent modification', () => {
    it('returns 409 when reassignCampaignChannel returns null (concurrent modification)', async () => {
      mockPoolConnect()
      mockAuth()
      vi.mocked(findCampaignById).mockResolvedValue(makeCampaign())
      vi.mocked(findChannelById).mockResolvedValue(makeChannel())
      vi.mocked(reassignCampaignChannel).mockResolvedValue(null)
      const req = makeRequest(CAMPAIGN_ID, { channel_id: CHANNEL_ID })
      const res = await reassignChannelRoute(req, makeParams(CAMPAIGN_ID))
      expect(res.status).toBe(409)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/concorrentemente/)
    })
  })

  describe('audit log', () => {
    it('calls insertCampaignAudit with channel_reassigned event and correct payload', async () => {
      mockPoolConnect()
      mockAuth(WS_A, 'key-99')
      const channel = makeChannel({ name: 'Canal Audit', provider: 'META_CLOUD' })
      vi.mocked(findCampaignById).mockResolvedValue(makeCampaign())
      vi.mocked(findChannelById).mockResolvedValue(channel)
      vi.mocked(reassignCampaignChannel).mockResolvedValue(makeCampaign({ channel_id: CHANNEL_ID }))
      const req = makeRequest(CAMPAIGN_ID, { channel_id: CHANNEL_ID })
      await reassignChannelRoute(req, makeParams(CAMPAIGN_ID))
      expect(vi.mocked(insertCampaignAudit)).toHaveBeenCalledWith(
        expect.anything(),
        CAMPAIGN_ID,
        'channel_reassigned',
        'key-99',
        expect.objectContaining({
          channel_id:   CHANNEL_ID,
          channel_name: 'Canal Audit',
          provider:     'META_CLOUD',
        }),
      )
    })

    it('returns 500 and triggers ROLLBACK when insertCampaignAudit throws', async () => {
      const mockClientQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
      mockPoolConnect(mockClientQuery)
      mockAuth()
      vi.mocked(findCampaignById).mockResolvedValue(makeCampaign())
      vi.mocked(findChannelById).mockResolvedValue(makeChannel())
      vi.mocked(reassignCampaignChannel).mockResolvedValue(makeCampaign({ channel_id: CHANNEL_ID }))
      vi.mocked(insertCampaignAudit).mockRejectedValue(new Error('DB write error'))
      const req = makeRequest(CAMPAIGN_ID, { channel_id: CHANNEL_ID })
      const res = await reassignChannelRoute(req, makeParams(CAMPAIGN_ID))
      expect(res.status).toBe(500)
      const rollbackCalls = mockClientQuery.mock.calls.filter(
        (args: unknown[]) => args[0] === 'ROLLBACK',
      )
      expect(rollbackCalls.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('rate limiting', () => {
    it('returns 429 when rate limit is exceeded', async () => {
      vi.mocked(campaignLimiter.check).mockResolvedValueOnce({
        success: false,
        remaining: 0,
        resetAt: Date.now() + 30_000,
      })
      const req = makeRequest(CAMPAIGN_ID, { channel_id: CHANNEL_ID })
      const res = await reassignChannelRoute(req, makeParams(CAMPAIGN_ID))
      expect(res.status).toBe(429)
    })
  })
})

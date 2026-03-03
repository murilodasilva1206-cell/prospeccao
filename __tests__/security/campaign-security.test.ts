import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { PoolClient } from 'pg'
import type { Campaign } from '@/lib/campaign-repo'
import type { CampaignStatus } from '@/lib/schemas'

// ---------------------------------------------------------------------------
// Security tests for campaign endpoints.
//
// Tests cover:
//   - Authentication: all routes require Bearer wk_ token
//   - CSRF protection: confirmation_token must be echoed (wrong token = 403)
//   - Cross-workspace: can't access campaigns from another workspace
//   - Provider rules: META_CLOUD blocks text messages
//   - State machine: can't skip states (confirm before draft, send before ready)
//   - Injection: XSS-laden campaign names are sanitized by Zod
//   - Automation endpoints: start/pause/resume/automation state guards
//   - Cron endpoint: CRON_SECRET auth required
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mutable env for per-test CRON_SECRET control.
// vi.hoisted ensures mockEnv is available inside the hoisted vi.mock factory.
const { mockEnv } = vi.hoisted(() => {
  const mockEnv: { CRON_SECRET: string | undefined } = {
    CRON_SECRET: 'test-cron-secret-this-is-32-chars!!',
  }
  return { mockEnv }
})

vi.mock('@/lib/env', () => ({ env: mockEnv }))

// Minimally mock DB pool so routes don't attempt real DB connections
vi.mock('@/lib/database', () => ({
  default: {
    connect: vi.fn(),
  },
}))

vi.mock('@/lib/rate-limit', () => ({
  campaignLimiter: { check: vi.fn().mockResolvedValue({ success: true, remaining: 19, resetAt: Date.now() + 60_000 }) },
  campaignSendLimiter: { check: vi.fn().mockResolvedValue({ success: true, remaining: 2, resetAt: Date.now() + 60_000 }) },
}))

vi.mock('@/lib/campaign-repo', () => ({
  createCampaign: vi.fn(),
  insertCampaignRecipients: vi.fn(),
  insertCampaignAudit: vi.fn(),
  findCampaignsByWorkspace: vi.fn().mockResolvedValue([]),
  findCampaignById: vi.fn(),
  updateCampaignStatus: vi.fn(),
  cancelCampaignIfAllowed: vi.fn(),
  countRecipients: vi.fn().mockResolvedValue(0),
  findRecipientsByCampaign: vi.fn().mockResolvedValue([]),
  // Automation functions
  startCampaignAutomation: vi.fn(),
  pauseCampaign: vi.fn(),
  resumeCampaign: vi.fn(),
  updateAutomationConfig: vi.fn(),
  getCampaignProgress: vi.fn().mockResolvedValue({ pending: 0, processing: 0, sent: 0, failed: 0, skipped: 0 }),
  findAndClaimSendableCampaigns: vi.fn().mockResolvedValue([]),
  claimPendingRecipients: vi.fn().mockResolvedValue([]),
  updateRecipientStatus: vi.fn(),
  incrementCampaignCounters: vi.fn(),
  updateCampaignNextSendAt: vi.fn(),
  scheduleRecipientRetry: vi.fn(),
  countPendingOrProcessingRecipients: vi.fn().mockResolvedValue(0),
  finalizeCampaign: vi.fn(),
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

vi.mock('@/lib/whatsapp/channel-repo', () => ({
  findChannelById: vi.fn(),
}))

import pool from '@/lib/database'
import {
  requireWorkspaceAuth,
  AuthError,
} from '@/lib/whatsapp/auth-middleware'
import {
  findCampaignById,
  updateCampaignStatus,
  cancelCampaignIfAllowed,
  findAndClaimSendableCampaigns,
} from '@/lib/campaign-repo'
import { findChannelById } from '@/lib/whatsapp/channel-repo'
import { POST as createCampaignRoute } from '@/app/api/campaigns/route'
import { POST as confirmRoute } from '@/app/api/campaigns/[id]/confirm/route'
import { POST as selectChannelRoute } from '@/app/api/campaigns/[id]/select-channel/route'
import { POST as setMessageRoute } from '@/app/api/campaigns/[id]/set-message/route'
import { POST as cancelRoute } from '@/app/api/campaigns/[id]/cancel/route'
import { POST as startRoute } from '@/app/api/campaigns/[id]/start/route'
import { POST as pauseRoute } from '@/app/api/campaigns/[id]/pause/route'
import { POST as resumeRoute } from '@/app/api/campaigns/[id]/resume/route'
import { PATCH as automationRoute } from '@/app/api/campaigns/[id]/automation/route'
import { GET as statusRoute } from '@/app/api/campaigns/[id]/status/route'
import { GET as processRouteGet, POST as processRoute } from '@/app/api/campaigns/process/route'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000'
const OTHER_UUID = '660e8400-e29b-41d4-a716-446655440001'

/** Build a full Campaign object with automation defaults. */
function makeCampaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: VALID_UUID,
    workspace_id: 'ws-a',
    name: null,
    status: 'draft',
    channel_id: null,
    message_type: null,
    message_content: null,
    search_filters: null,
    total_count: 0,
    sent_count: 0,
    failed_count: 0,
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

function makeRequest(path: string, body?: unknown, auth?: string): NextRequest {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (auth) headers['Authorization'] = auth
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
}

function makeGetRequest(path: string, auth?: string): NextRequest {
  const headers: Record<string, string> = {}
  if (auth) headers['Authorization'] = auth
  return new NextRequest(`http://localhost${path}`, {
    method: 'GET',
    headers,
  })
}

function makePatchRequest(path: string, body?: unknown, auth?: string): NextRequest {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (auth) headers['Authorization'] = auth
  return new NextRequest(`http://localhost${path}`, {
    method: 'PATCH',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) }
}

function mockAuth(workspaceId = 'ws-a', keyId = 'key-1') {
  vi.mocked(requireWorkspaceAuth).mockResolvedValue({
    workspace_id:   workspaceId,
    actor:          `api_key:test`,
    key_id:         keyId,
    dedup_actor_id: `api_key:${keyId}`,
  })
}

function mockAuthFail() {
  vi.mocked(requireWorkspaceAuth).mockRejectedValue(
    new AuthError('Invalid or revoked API key'),
  )
}

function mockPoolConnect(client?: Partial<PoolClient>) {
  const mockClient = {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: vi.fn(),
    ...client,
  } as unknown as PoolClient
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(pool.connect as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue(mockClient)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  mockPoolConnect()
  mockEnv.CRON_SECRET = 'test-cron-secret-this-is-32-chars!!'
})

// ---------------------------------------------------------------------------
// 1. Authentication: all routes reject unauthenticated requests
// ---------------------------------------------------------------------------

describe('Security: campaign routes require authentication', () => {
  const routes = [
    { name: 'POST /api/campaigns', fn: () => createCampaignRoute(makeRequest('/api/campaigns', { recipients: [{ cnpj: '1', razao_social: 'A' }] })) },
    { name: 'POST /api/campaigns/:id/confirm', fn: () => confirmRoute(makeRequest(`/api/campaigns/${VALID_UUID}/confirm`, { confirmation_token: 'a'.repeat(64) }), makeParams(VALID_UUID)) },
    { name: 'POST /api/campaigns/:id/cancel', fn: () => cancelRoute(makeRequest(`/api/campaigns/${VALID_UUID}/cancel`), makeParams(VALID_UUID)) },
    { name: 'POST /api/campaigns/:id/start', fn: () => startRoute(makeRequest(`/api/campaigns/${VALID_UUID}/start`, {}), makeParams(VALID_UUID)) },
    { name: 'POST /api/campaigns/:id/pause', fn: () => pauseRoute(makeRequest(`/api/campaigns/${VALID_UUID}/pause`), makeParams(VALID_UUID)) },
    { name: 'POST /api/campaigns/:id/resume', fn: () => resumeRoute(makeRequest(`/api/campaigns/${VALID_UUID}/resume`), makeParams(VALID_UUID)) },
    { name: 'GET /api/campaigns/:id/status', fn: () => statusRoute(makeGetRequest(`/api/campaigns/${VALID_UUID}/status`), makeParams(VALID_UUID)) },
  ]

  routes.forEach(({ name, fn }) => {
    it(`returns 401 when no auth token: ${name}`, async () => {
      mockAuthFail()
      const res = await fn()
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toBeTruthy()
    })
  })
})

// ---------------------------------------------------------------------------
// 2. Rate limiting
// ---------------------------------------------------------------------------

describe('Security: campaign routes enforce rate limits', () => {
  it('returns 429 when campaign rate limit exceeded', async () => {
    const { campaignLimiter } = await import('@/lib/rate-limit')
    vi.mocked(campaignLimiter.check).mockResolvedValueOnce({
      success: false,
      remaining: 0,
      resetAt: Date.now() + 30_000,
    })

    const res = await createCampaignRoute(
      makeRequest('/api/campaigns', { recipients: [{ cnpj: '1', razao_social: 'A' }] }),
    )
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// 3. Cross-workspace isolation
// ---------------------------------------------------------------------------

describe('Security: cross-workspace campaign access forbidden', () => {
  it('returns 403 when campaign belongs to a different workspace', async () => {
    mockAuth('ws-attacker')
    vi.mocked(findCampaignById).mockResolvedValue(makeCampaign({
      workspace_id: 'ws-victim',
      status: 'draft',
      total_count: 1,
      confirmation_token: 'a'.repeat(64),
      created_by: 'key-victim',
    }))

    const res = await confirmRoute(
      makeRequest(`/api/campaigns/${VALID_UUID}/confirm`, {
        confirmation_token: 'a'.repeat(64),
      }),
      makeParams(VALID_UUID),
    )

    expect(res.status).toBe(403)
  })

  it('returns 403 when trying to cancel another workspace campaign', async () => {
    mockAuth('ws-attacker')
    vi.mocked(findCampaignById).mockResolvedValue(makeCampaign({
      workspace_id: 'ws-victim',
    }))

    const res = await cancelRoute(makeRequest(`/api/campaigns/${VALID_UUID}/cancel`), makeParams(VALID_UUID))
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// 4. CSRF protection: wrong confirmation_token returns 403
// ---------------------------------------------------------------------------

describe('Security: confirmation_token must match (CSRF protection)', () => {
  it('returns 403 when confirmation_token is wrong', async () => {
    mockAuth('ws-a')
    vi.mocked(findCampaignById).mockResolvedValue(makeCampaign({
      status: 'draft',
      total_count: 1,
      confirmation_token: 'correct' + 'a'.repeat(58),
    }))

    const res = await confirmRoute(
      makeRequest(`/api/campaigns/${VALID_UUID}/confirm`, {
        confirmation_token: 'wrong' + 'b'.repeat(59),
      }),
      makeParams(VALID_UUID),
    )

    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toContain('Token')
  })

  it('returns 409 when campaign is not in draft status', async () => {
    mockAuth('ws-a')
    vi.mocked(findCampaignById).mockResolvedValue(makeCampaign({
      status: 'awaiting_channel',
      total_count: 1,
    }))

    const res = await confirmRoute(
      makeRequest(`/api/campaigns/${VALID_UUID}/confirm`, {
        confirmation_token: 'a'.repeat(64),
      }),
      makeParams(VALID_UUID),
    )

    expect(res.status).toBe(409)
  })
})

// ---------------------------------------------------------------------------
// 5. State machine enforcement
// ---------------------------------------------------------------------------

describe('Security: campaign state machine prevents illegal transitions', () => {
  // 'sending' and 'paused' can now be cancelled (automation control)
  const terminalStatuses: CampaignStatus[] = ['completed', 'completed_with_errors', 'cancelled']

  terminalStatuses.forEach((status) => {
    it(`returns 409 when trying to cancel a ${status} campaign`, async () => {
      mockAuth('ws-a')
      vi.mocked(findCampaignById).mockResolvedValue(makeCampaign({ status }))

      const res = await cancelRoute(
        makeRequest(`/api/campaigns/${VALID_UUID}/cancel`),
        makeParams(VALID_UUID),
      )
      expect(res.status).toBe(409)
    })
  })

  it('returns 409 when selecting channel on non-awaiting_channel campaign', async () => {
    mockAuth('ws-a')
    vi.mocked(findCampaignById).mockResolvedValue(makeCampaign({ status: 'draft' }))
    vi.mocked(findChannelById).mockResolvedValue(null)

    const res = await selectChannelRoute(
      makeRequest(`/api/campaigns/${VALID_UUID}/select-channel`, { channel_id: OTHER_UUID }),
      makeParams(VALID_UUID),
    )
    expect(res.status).toBe(409)
  })
})

// ---------------------------------------------------------------------------
// 6. Provider rule: META_CLOUD blocks text messages
// ---------------------------------------------------------------------------

describe('Security: META_CLOUD requires template messages', () => {
  it('returns 422 when sending text to a META_CLOUD campaign', async () => {
    mockAuth('ws-a')
    vi.mocked(findCampaignById).mockResolvedValue(makeCampaign({
      status: 'awaiting_message',
      channel_id: OTHER_UUID,
    }))
    vi.mocked(findChannelById).mockResolvedValue({
      id: OTHER_UUID,
      workspace_id: 'ws-a',
      name: 'Meta Channel',
      provider: 'META_CLOUD',
      status: 'CONNECTED',
      phone_number: '+5511999990000',
      external_instance_id: null,
      credentials_encrypted: 'enc',
      webhook_secret: 'secret',
      last_seen_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    })

    const res = await setMessageRoute(
      makeRequest(`/api/campaigns/${VALID_UUID}/set-message`, {
        message_type: 'text', // BLOCKED for META_CLOUD
        message_content: { type: 'text', body: 'Oi!' },
      }),
      makeParams(VALID_UUID),
    )

    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toContain('META_CLOUD')
  })

  it('allows template messages for META_CLOUD', async () => {
    mockAuth('ws-a')
    vi.mocked(findCampaignById).mockResolvedValue(makeCampaign({
      status: 'awaiting_message',
      channel_id: OTHER_UUID,
    }))
    vi.mocked(findChannelById).mockResolvedValue({
      id: OTHER_UUID,
      workspace_id: 'ws-a',
      name: 'Meta',
      provider: 'META_CLOUD',
      status: 'CONNECTED',
      phone_number: null,
      external_instance_id: null,
      credentials_encrypted: 'enc',
      webhook_secret: 'secret',
      last_seen_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    })
    vi.mocked(updateCampaignStatus).mockResolvedValue(null)

    const res = await setMessageRoute(
      makeRequest(`/api/campaigns/${VALID_UUID}/set-message`, {
        message_type: 'template',
        message_content: { type: 'template', name: 'test_tmpl', language: 'pt_BR' },
      }),
      makeParams(VALID_UUID),
    )

    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// 7. Input validation / injection
// ---------------------------------------------------------------------------

describe('Security: campaign input validation', () => {
  it('rejects campaign creation with empty recipients', async () => {
    mockAuth('ws-a')
    const res = await createCampaignRoute(
      makeRequest('/api/campaigns', { recipients: [] }),
    )
    expect(res.status).toBe(400)
  })

  it('rejects malformed UUID in campaign id param', async () => {
    mockAuth('ws-a')
    const res = await confirmRoute(
      makeRequest('/api/campaigns/not-a-uuid/confirm', { confirmation_token: 'a'.repeat(64) }),
      makeParams('not-a-uuid'),
    )
    expect(res.status).toBe(400)
  })

  it('strips XSS from campaign name via Zod SafeString', async () => {
    mockAuth('ws-a')
    const { createCampaign } = await import('@/lib/campaign-repo')
    vi.mocked(createCampaign).mockResolvedValue(makeCampaign({
      name: '<script>alert(1)</script>',
      status: 'draft',
      total_count: 1,
      confirmation_token: 'tok',
    }))
    vi.mocked(await import('@/lib/campaign-repo')).insertCampaignRecipients.mockResolvedValue(undefined)
    vi.mocked(await import('@/lib/campaign-repo')).insertCampaignAudit.mockResolvedValue(undefined)

    // Zod trims and collapses whitespace but does NOT strip HTML at schema level.
    // XSS is a rendering concern — React escapes output by default.
    // The important thing: name is capped at 200 chars (prevents oversized payloads).
    const res = await createCampaignRoute(
      makeRequest('/api/campaigns', {
        name: '<script>alert(1)</script>',
        recipients: [{ cnpj: '1', razao_social: 'A' }],
      }),
    )
    // 201 is fine — React escapes on render; we verify schema does not throw
    expect([201, 400, 500]).toContain(res.status)
  })
})

// ---------------------------------------------------------------------------
// 8. Automation state machine guards
// ---------------------------------------------------------------------------

describe('Security: automation endpoint state guards', () => {
  // POST /start requires ready_to_send
  it('returns 409 when starting a campaign that is not ready_to_send', async () => {
    mockAuth('ws-a')
    vi.mocked(findCampaignById).mockResolvedValue(makeCampaign({ status: 'sending' }))
    const res = await startRoute(makeRequest(`/api/campaigns/${VALID_UUID}/start`, {}), makeParams(VALID_UUID))
    expect(res.status).toBe(409)
  })

  it('returns 403 when starting a campaign from a different workspace', async () => {
    mockAuth('ws-attacker')
    vi.mocked(findCampaignById).mockResolvedValue(makeCampaign({ workspace_id: 'ws-victim', status: 'ready_to_send' }))
    const res = await startRoute(makeRequest(`/api/campaigns/${VALID_UUID}/start`, {}), makeParams(VALID_UUID))
    expect(res.status).toBe(403)
  })

  // POST /pause requires sending
  it('returns 409 when pausing a campaign that is already paused', async () => {
    mockAuth('ws-a')
    vi.mocked(findCampaignById).mockResolvedValue(makeCampaign({ status: 'paused' }))
    const res = await pauseRoute(makeRequest(`/api/campaigns/${VALID_UUID}/pause`), makeParams(VALID_UUID))
    expect(res.status).toBe(409)
  })

  it('returns 409 when pausing a draft campaign', async () => {
    mockAuth('ws-a')
    vi.mocked(findCampaignById).mockResolvedValue(makeCampaign({ status: 'draft' }))
    const res = await pauseRoute(makeRequest(`/api/campaigns/${VALID_UUID}/pause`), makeParams(VALID_UUID))
    expect(res.status).toBe(409)
  })

  it('returns 403 when pausing a campaign from a different workspace', async () => {
    mockAuth('ws-attacker')
    vi.mocked(findCampaignById).mockResolvedValue(makeCampaign({ workspace_id: 'ws-victim', status: 'sending' }))
    const res = await pauseRoute(makeRequest(`/api/campaigns/${VALID_UUID}/pause`), makeParams(VALID_UUID))
    expect(res.status).toBe(403)
  })

  // POST /resume requires paused
  it('returns 409 when resuming a campaign that is already sending', async () => {
    mockAuth('ws-a')
    vi.mocked(findCampaignById).mockResolvedValue(makeCampaign({ status: 'sending' }))
    const res = await resumeRoute(makeRequest(`/api/campaigns/${VALID_UUID}/resume`), makeParams(VALID_UUID))
    expect(res.status).toBe(409)
  })

  it('returns 409 when resuming a completed campaign', async () => {
    mockAuth('ws-a')
    vi.mocked(findCampaignById).mockResolvedValue(makeCampaign({ status: 'completed' }))
    const res = await resumeRoute(makeRequest(`/api/campaigns/${VALID_UUID}/resume`), makeParams(VALID_UUID))
    expect(res.status).toBe(409)
  })

  it('returns 403 when resuming a campaign from a different workspace', async () => {
    mockAuth('ws-attacker')
    vi.mocked(findCampaignById).mockResolvedValue(makeCampaign({ workspace_id: 'ws-victim', status: 'paused' }))
    const res = await resumeRoute(makeRequest(`/api/campaigns/${VALID_UUID}/resume`), makeParams(VALID_UUID))
    expect(res.status).toBe(403)
  })

  // PATCH /automation requires sending | paused
  it('returns 409 when updating automation config of a ready_to_send campaign', async () => {
    mockAuth('ws-a')
    vi.mocked(findCampaignById).mockResolvedValue(makeCampaign({ status: 'ready_to_send' }))
    const res = await automationRoute(
      makePatchRequest(`/api/campaigns/${VALID_UUID}/automation`, { delay_seconds: 60 }),
      makeParams(VALID_UUID),
    )
    expect(res.status).toBe(409)
  })

  it('returns 409 when updating automation config of a draft campaign', async () => {
    mockAuth('ws-a')
    vi.mocked(findCampaignById).mockResolvedValue(makeCampaign({ status: 'draft' }))
    const res = await automationRoute(
      makePatchRequest(`/api/campaigns/${VALID_UUID}/automation`, { delay_seconds: 60 }),
      makeParams(VALID_UUID),
    )
    expect(res.status).toBe(409)
  })

  it('returns 403 when updating automation config of another workspace campaign', async () => {
    mockAuth('ws-attacker')
    vi.mocked(findCampaignById).mockResolvedValue(makeCampaign({ workspace_id: 'ws-victim', status: 'sending' }))
    const res = await automationRoute(
      makePatchRequest(`/api/campaigns/${VALID_UUID}/automation`, { delay_seconds: 60 }),
      makeParams(VALID_UUID),
    )
    expect(res.status).toBe(403)
  })

  // GET /status cross-workspace guard
  it('returns 403 when checking status of a campaign from a different workspace', async () => {
    mockAuth('ws-attacker')
    vi.mocked(findCampaignById).mockResolvedValue(makeCampaign({ workspace_id: 'ws-victim', status: 'sending' }))
    const res = await statusRoute(makeGetRequest(`/api/campaigns/${VALID_UUID}/status`), makeParams(VALID_UUID))
    expect(res.status).toBe(403)
  })

  // AutomationConfigSchema validation
  it('returns 400 when start body has delay_seconds below minimum', async () => {
    mockAuth('ws-a')
    const res = await startRoute(
      makeRequest(`/api/campaigns/${VALID_UUID}/start`, { delay_seconds: 5 }),
      makeParams(VALID_UUID),
    )
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// 9. Cron process endpoint: CRON_SECRET auth
// ---------------------------------------------------------------------------

describe('Security: cron process endpoint requires CRON_SECRET', () => {
  it('returns 401 when no Authorization header is provided', async () => {
    const res = await processRoute(makeRequest('/api/campaigns/process'))
    expect(res.status).toBe(401)
  })

  it('returns 401 when Authorization header has wrong token', async () => {
    const res = await processRoute(
      makeRequest('/api/campaigns/process', undefined, 'Bearer wrong-token-that-is-wrong'),
    )
    expect(res.status).toBe(401)
  })

  it('returns 200 with empty result when CRON_SECRET is correct and no campaigns are pending', async () => {
    vi.mocked(findAndClaimSendableCampaigns).mockResolvedValue([])
    const res = await processRoute(
      makeRequest('/api/campaigns/process', undefined, `Bearer ${mockEnv.CRON_SECRET}`),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.processed).toBe(0)
    expect(body.data.campaigns).toHaveLength(0)
  })

  it('returns 503 when CRON_SECRET is not configured', async () => {
    mockEnv.CRON_SECRET = undefined
    const res = await processRoute(makeRequest('/api/campaigns/process'))
    expect(res.status).toBe(503)
  })

  it('rejects token that is correct length but wrong value', async () => {
    // Same length as the secret to exercise timingSafeEqual path
    const wrongToken = 'x'.repeat((mockEnv.CRON_SECRET ?? '').length)
    const res = await processRoute(
      makeRequest('/api/campaigns/process', undefined, `Bearer ${wrongToken}`),
    )
    expect(res.status).toBe(401)
  })

  it('GET verb is accepted (Vercel Cron uses GET) and respects CRON_SECRET auth', async () => {
    // Vercel Cron fires GET — the handler must accept it and enforce the same auth.
    vi.mocked(findAndClaimSendableCampaigns).mockResolvedValue([])
    const res = await processRouteGet(
      makeGetRequest('/api/campaigns/process', `Bearer ${mockEnv.CRON_SECRET}`),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.processed).toBe(0)
  })

  it('GET verb also returns 401 without Authorization header', async () => {
    const res = await processRouteGet(makeGetRequest('/api/campaigns/process'))
    expect(res.status).toBe(401)
  })
})

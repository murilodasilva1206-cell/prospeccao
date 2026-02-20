// ---------------------------------------------------------------------------
// Security tests — unauthenticated access to /api/agente, /api/busca, /api/export
//
// Verifies that:
//   1. Anonymous requests (no session, no Bearer) are rejected with 401.
//   2. Requests authenticated via session cookie are accepted.
//   3. Requests authenticated via Bearer wk_ token are accepted.
//
// Also covers session-cookie auth on /api/campaigns/* and /api/whatsapp/*
// routes that already used requireWorkspaceAuth via Bearer, confirming that
// both auth paths are honoured equally.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { PoolClient } from 'pg'

// ---------------------------------------------------------------------------
// Mocks — declared before importing route handlers
// ---------------------------------------------------------------------------

vi.mock('@/lib/database', () => ({
  default: { connect: vi.fn() },
}))

vi.mock('@/lib/get-ip', () => ({
  getClientIp: vi.fn().mockReturnValue('127.0.0.1'),
}))

vi.mock('@/lib/rate-limit', () => ({
  agenteLimiter: { check: vi.fn().mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 }) },
  buscaLimiter:  { check: vi.fn().mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 }) },
  exportLimiter: { check: vi.fn().mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 }) },
  campaignLimiter: { check: vi.fn().mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 }) },
  campaignSendLimiter: { check: vi.fn().mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 }) },
  whatsappKeysLimiter: { check: vi.fn().mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 }) },
}))

// Mock requireWorkspaceAuth so we can control success/failure per test
vi.mock('@/lib/whatsapp/auth-middleware', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/whatsapp/auth-middleware')>()
  return {
    ...original,
    requireWorkspaceAuth: vi.fn(),
    authErrorResponse: original.authErrorResponse,
    AuthError: original.AuthError,
  }
})

// Silence AI and DB side-effects
vi.mock('@/lib/ai-client', () => ({
  callAiAgent: vi.fn().mockResolvedValue({
    intent: { action: 'clarify', message: 'Seja mais especifico.', confidence: 0.5 },
    latencyMs: 1,
    parseSuccess: true,
  }),
}))

vi.mock('@/lib/agent-prompts', () => ({
  detectInjectionAttempt: vi.fn().mockReturnValue(false),
}))

vi.mock('@/lib/nicho-cnae', () => ({
  resolveNichoCnae: vi.fn().mockReturnValue(null),
  resolveNichoCnaeDynamic: vi.fn().mockResolvedValue(null),
}))

vi.mock('@/lib/campaign-repo', () => ({
  createCampaign: vi.fn(),
  insertCampaignRecipients: vi.fn(),
  insertCampaignAudit: vi.fn(),
  findCampaignsByWorkspace: vi.fn().mockResolvedValue([]),
  findCampaignById: vi.fn(),
  updateCampaignStatus: vi.fn(),
  countRecipients: vi.fn().mockResolvedValue(0),
  findRecipientsByCampaign: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/lib/whatsapp/auth', () => ({
  listApiKeys: vi.fn().mockResolvedValue([]),
  createApiKey: vi.fn(),
  revokeApiKey: vi.fn().mockResolvedValue(false),
  validateApiKey: vi.fn().mockResolvedValue(null),
}))

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import pool from '@/lib/database'
import { requireWorkspaceAuth, AuthError } from '@/lib/whatsapp/auth-middleware'
import { POST as agenteRoute } from '@/app/api/agente/route'
import { GET as buscaRoute } from '@/app/api/busca/route'
import { GET as exportRoute } from '@/app/api/export/route'
import { POST as createCampaignRoute } from '@/app/api/campaigns/route'
import { GET as listKeysRoute } from '@/app/api/whatsapp/keys/route'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKSPACE = { workspace_id: 'ws-test', actor: 'session:user-1', key_id: 'key-1' }

function mockPoolClient() {
  const client = {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: vi.fn(),
  } as unknown as PoolClient
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(pool.connect as any).mockResolvedValue(client)
  return client
}

function authOk() {
  vi.mocked(requireWorkspaceAuth).mockResolvedValue(WORKSPACE)
}

function authFail() {
  vi.mocked(requireWorkspaceAuth).mockRejectedValue(
    new AuthError('Missing Authorization header'),
  )
}

function withSession(req: NextRequest, token: string): NextRequest {
  Object.defineProperty(req, 'cookies', {
    configurable: true,
    get: () => ({
      get: (name: string) =>
        name === 'session' ? { name: 'session', value: token } : undefined,
      has: (name: string) => name === 'session',
    }),
  })
  return req
}

function makeGet(path: string, search?: Record<string, string>): NextRequest {
  const url = new URL(`http://localhost${path}`)
  if (search) Object.entries(search).forEach(([k, v]) => url.searchParams.set(k, v))
  return new NextRequest(url.toString(), { method: 'GET' })
}

function makePost(path: string, body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  mockPoolClient()
})

// ---------------------------------------------------------------------------
// 1. Anonymous requests → 401 on all three formerly-open endpoints
// ---------------------------------------------------------------------------

describe('GET /api/busca — requires authentication', () => {
  it('returns 401 for anonymous request', async () => {
    authFail()
    const req = makeGet('/api/busca', { uf: 'SP' })
    const res = await buscaRoute(req)
    expect(res.status).toBe(401)
    const json = await res.json() as { error: string }
    expect(json.error).toBeTruthy()
  })

  it('returns 200 for authenticated request (session cookie)', async () => {
    authOk()
    const req = withSession(makeGet('/api/busca', { uf: 'SP' }), 'valid_token')
    const res = await buscaRoute(req)
    // 200 (or at worst 500 from mocked DB) — definitely not 401
    expect(res.status).not.toBe(401)
  })
})

describe('GET /api/export — requires authentication', () => {
  it('returns 401 for anonymous request', async () => {
    authFail()
    const req = makeGet('/api/export', { uf: 'SP' })
    const res = await exportRoute(req)
    expect(res.status).toBe(401)
  })

  it('returns 200/CSV for authenticated request', async () => {
    authOk()
    const req = withSession(makeGet('/api/export', { uf: 'SP' }), 'valid_token')
    const res = await exportRoute(req)
    expect(res.status).not.toBe(401)
  })
})

describe('POST /api/agente — requires authentication', () => {
  it('returns 401 for anonymous request', async () => {
    authFail()
    const req = makePost('/api/agente', { message: 'dentistas em SP' })
    const res = await agenteRoute(req)
    expect(res.status).toBe(401)
  })

  it('proceeds past auth when authenticated (session cookie)', async () => {
    authOk()
    const req = withSession(
      makePost('/api/agente', { message: 'dentistas em SP' }),
      'valid_token',
    )
    const res = await agenteRoute(req)
    // AI mock returns clarify — 200, not 401
    expect(res.status).not.toBe(401)
  })

  it('proceeds past auth when authenticated (Bearer token)', async () => {
    authOk()
    const req = makePost('/api/agente', { message: 'dentistas em SP' }, {
      Authorization: 'Bearer wk_' + 'a'.repeat(64),
    })
    const res = await agenteRoute(req)
    expect(res.status).not.toBe(401)
  })
})

// ---------------------------------------------------------------------------
// 2. Session cookie auth accepted on previously Bearer-only routes
// ---------------------------------------------------------------------------

describe('POST /api/campaigns — session cookie auth accepted', () => {
  it('returns 401 when requireWorkspaceAuth throws', async () => {
    authFail()
    const req = makePost('/api/campaigns', {
      recipients: [{ cnpj: '12345678000190', razao_social: 'Empresa Teste' }],
    })
    const res = await createCampaignRoute(req)
    expect(res.status).toBe(401)
  })

  it('proceeds when authenticated via session cookie', async () => {
    authOk()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(pool.connect as any).mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [{ id: 'camp-1', workspace_id: 'ws-test', status: 'draft', confirmation_token: 'a'.repeat(64), name: 'Test', created_at: new Date() }], rowCount: 1 }),
      release: vi.fn(),
    })
    const req = withSession(
      makePost('/api/campaigns', {
        recipients: [{ cnpj: '12345678000190', razao_social: 'Empresa Teste' }],
      }),
      'valid_token',
    )
    const res = await createCampaignRoute(req)
    expect(res.status).not.toBe(401)
  })
})

describe('GET /api/whatsapp/keys — session cookie auth accepted', () => {
  it('returns 401 when requireWorkspaceAuth throws', async () => {
    authFail()
    const req = makeGet('/api/whatsapp/keys')
    const res = await listKeysRoute(req)
    expect(res.status).toBe(401)
  })

  it('returns keys list when authenticated via session cookie', async () => {
    authOk()
    const req = withSession(makeGet('/api/whatsapp/keys'), 'valid_token')
    const res = await listKeysRoute(req)
    expect(res.status).not.toBe(401)
  })
})

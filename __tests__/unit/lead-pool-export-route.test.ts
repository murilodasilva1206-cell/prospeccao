import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { PoolClient } from 'pg'
import type { LeadPoolDetail } from '@/lib/lead-pool-repo'

// ---------------------------------------------------------------------------
// Unit tests for GET /api/lead-pools/:id/export (TDD — RED state)
//
// Tests the CSV export route for a specific lead pool.
// Will fail until app/api/lead-pools/[id]/export/route.ts is implemented.
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
  exportLimiter: {
    check: vi.fn().mockResolvedValue({ success: true, remaining: 4, resetAt: Date.now() + 60_000 }),
  },
}))

vi.mock('@/lib/lead-pool-repo', () => ({
  findLeadPoolById: vi.fn(),
}))

vi.mock('@/lib/entitlement', () => ({
  checkWorkspaceFeature: vi.fn(),
  auditBlockedFeature:   vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/whatsapp/auth-middleware', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/whatsapp/auth-middleware')>()
  return {
    ...original,
    requireWorkspaceAuth: vi.fn(),
    authErrorResponse:    original.authErrorResponse,
    AuthError:            original.AuthError,
  }
})

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import pool                                           from '@/lib/database'
import { findLeadPoolById }                           from '@/lib/lead-pool-repo'
import { checkWorkspaceFeature, auditBlockedFeature } from '@/lib/entitlement'
import { requireWorkspaceAuth, AuthError }            from '@/lib/whatsapp/auth-middleware'
import { exportLimiter }                              from '@/lib/rate-limit'
import { GET as exportRoute }                         from '@/app/api/lead-pools/[id]/export/route'

// ---------------------------------------------------------------------------
// Constants & fixtures
// ---------------------------------------------------------------------------

const WS_TEST  = 'ws-test'
const WS_OTHER = 'ws-other'
const POOL_ID  = '550e8400-e29b-41d4-a716-446655440000'

function makePoolDetail(overrides: Partial<LeadPoolDetail> = {}): LeadPoolDetail {
  return {
    id:                POOL_ID,
    workspace_id:      WS_TEST,
    name:              'Pool de Dentistas SP',
    query_fingerprint: null,
    filters_json:      null,
    lead_count:        2,
    created_at:        new Date(),
    updated_at:        new Date(),
    leads_json: [
      {
        cnpj:          '12345678000195',
        razaoSocial:   'Empresa Alpha Ltda',
        nomeFantasia:  '',
        uf:            'SP',
        municipio:     'SAO PAULO',
        cnaePrincipal: '8630501',
        situacao:      'ATIVA',
        telefone1:     '11999999999',
        telefone2:     '',
        email:         'alpha@test.com',
      },
      {
        cnpj:          '98765432000100',
        razaoSocial:   '=HYPERLINK("http://evil.com","Click")',
        nomeFantasia:  '',
        uf:            'RJ',
        municipio:     'RIO DE JANEIRO',
        cnaePrincipal: '8630501',
        situacao:      'ATIVA',
        telefone1:     '21888888888',
        telefone2:     '',
        email:         '',
      },
    ],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

function makeRequest(id: string): NextRequest {
  return new NextRequest(`http://localhost/api/lead-pools/${id}/export`, {
    method: 'GET',
  })
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) }
}

function mockPoolConnect() {
  const client = {
    query:   vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: vi.fn(),
  } as unknown as PoolClient
  vi.mocked(pool.connect).mockResolvedValue(client as never)
  return client
}

function mockAuth(workspaceId = WS_TEST) {
  vi.mocked(requireWorkspaceAuth).mockResolvedValue({
    workspace_id:   workspaceId,
    actor:          'api_key:test',
    key_id:         'key-test',
    dedup_actor_id: 'api_key:key-test',
  })
}

function mockAuthFail() {
  vi.mocked(requireWorkspaceAuth).mockRejectedValue(
    new AuthError('Invalid or revoked API key'),
  )
}

function mockFeature(enabled: boolean) {
  vi.mocked(checkWorkspaceFeature).mockResolvedValue(enabled)
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(exportLimiter.check).mockResolvedValue({
    success:   true,
    remaining: 4,
    resetAt:   Date.now() + 60_000,
  })
  vi.mocked(auditBlockedFeature).mockResolvedValue(undefined)
})

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

describe('GET /api/lead-pools/:id/export — authentication', () => {
  it('returns 401 when no auth provided', async () => {
    mockPoolConnect()
    mockAuthFail()
    const res = await exportRoute(makeRequest(POOL_ID), makeParams(POOL_ID))
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// Feature gate — csv_export
// ---------------------------------------------------------------------------

describe('GET /api/lead-pools/:id/export — feature gate (csv_export)', () => {
  it('returns 403 when workspace lacks csv_export feature', async () => {
    mockPoolConnect()
    mockAuth()
    mockFeature(false)
    const res = await exportRoute(makeRequest(POOL_ID), makeParams(POOL_ID))
    expect(res.status).toBe(403)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/plano|feature|permissão|plan/i)
  })

  it('records audit log when csv_export is blocked', async () => {
    mockPoolConnect()
    mockAuth()
    mockFeature(false)
    await exportRoute(makeRequest(POOL_ID), makeParams(POOL_ID))
    expect(auditBlockedFeature).toHaveBeenCalledWith(
      expect.anything(),
      WS_TEST,
      'csv_export',
      expect.any(String),
    )
  })

  it('feature check uses workspace_id from auth token, not from URL', async () => {
    mockPoolConnect()
    mockAuth(WS_OTHER)
    mockFeature(true)
    vi.mocked(findLeadPoolById).mockResolvedValue(null)
    await exportRoute(makeRequest(POOL_ID), makeParams(POOL_ID))
    expect(checkWorkspaceFeature).toHaveBeenCalledWith(
      expect.anything(),
      WS_OTHER,
      'csv_export',
    )
  })
})

// ---------------------------------------------------------------------------
// Input validation — invalid UUID
// ---------------------------------------------------------------------------

describe('GET /api/lead-pools/:id/export — invalid id', () => {
  it('returns 400 for a non-UUID id', async () => {
    mockPoolConnect()
    mockAuth()
    mockFeature(true)
    const res = await exportRoute(makeRequest('not-a-uuid'), makeParams('not-a-uuid'))
    expect(res.status).toBe(400)
  })

  it('returns 400 for an id with non-hex characters', async () => {
    mockPoolConnect()
    mockAuth()
    mockFeature(true)
    const badId = 'gggggggg-0000-0000-0000-000000000000'
    const res = await exportRoute(makeRequest(badId), makeParams(badId))
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Not found / workspace isolation
// ---------------------------------------------------------------------------

describe('GET /api/lead-pools/:id/export — not found', () => {
  it('returns 404 when pool does not exist', async () => {
    mockPoolConnect()
    mockAuth()
    mockFeature(true)
    vi.mocked(findLeadPoolById).mockResolvedValue(null)
    const res = await exportRoute(makeRequest(POOL_ID), makeParams(POOL_ID))
    expect(res.status).toBe(404)
  })

  it('returns 404 when pool belongs to a different workspace (repo returns null)', async () => {
    mockPoolConnect()
    mockAuth(WS_OTHER)
    mockFeature(true)
    vi.mocked(findLeadPoolById).mockResolvedValue(null)
    const res = await exportRoute(makeRequest(POOL_ID), makeParams(POOL_ID))
    expect(res.status).toBe(404)
    // Confirm repo was queried with auth workspace (not a spoofed one)
    expect(findLeadPoolById).toHaveBeenCalledWith(
      expect.anything(),
      POOL_ID,
      WS_OTHER,
    )
  })
})

// ---------------------------------------------------------------------------
// Successful CSV export
// ---------------------------------------------------------------------------

describe('GET /api/lead-pools/:id/export — CSV generation', () => {
  it('returns 200 with text/csv content-type', async () => {
    mockPoolConnect()
    mockAuth()
    mockFeature(true)
    vi.mocked(findLeadPoolById).mockResolvedValue(makePoolDetail())
    const res = await exportRoute(makeRequest(POOL_ID), makeParams(POOL_ID))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/csv/i)
  })

  it('includes Content-Disposition: attachment with .csv filename', async () => {
    mockPoolConnect()
    mockAuth()
    mockFeature(true)
    vi.mocked(findLeadPoolById).mockResolvedValue(makePoolDetail())
    const res = await exportRoute(makeRequest(POOL_ID), makeParams(POOL_ID))
    const disposition = res.headers.get('content-disposition') ?? ''
    expect(disposition).toMatch(/attachment/i)
    expect(disposition).toMatch(/\.csv/i)
  })

  it('includes Cache-Control: no-store to prevent caching of sensitive data', async () => {
    mockPoolConnect()
    mockAuth()
    mockFeature(true)
    vi.mocked(findLeadPoolById).mockResolvedValue(makePoolDetail())
    const res = await exportRoute(makeRequest(POOL_ID), makeParams(POOL_ID))
    const cc = res.headers.get('cache-control') ?? ''
    expect(cc).toMatch(/no-store/i)
  })

  it('first CSV row is the header with standard column names', async () => {
    mockPoolConnect()
    mockAuth()
    mockFeature(true)
    vi.mocked(findLeadPoolById).mockResolvedValue(makePoolDetail())
    const res = await exportRoute(makeRequest(POOL_ID), makeParams(POOL_ID))
    const csv = await res.text()
    const firstLine = csv.split('\n')[0].toLowerCase()
    expect(firstLine).toContain('cnpj')
    expect(firstLine).toContain('razaosocial')
  })

  it('exports exactly the leads in the pool (header + 2 data rows)', async () => {
    mockPoolConnect()
    mockAuth()
    mockFeature(true)
    vi.mocked(findLeadPoolById).mockResolvedValue(makePoolDetail())
    const res = await exportRoute(makeRequest(POOL_ID), makeParams(POOL_ID))
    const csv = await res.text()
    // Split on \r\n (RFC 4180) or \n; filter empty trailing line
    const lines = csv.split(/\r?\n/).filter(Boolean)
    expect(lines).toHaveLength(3) // 1 header + 2 data rows
  })

  it('sanitizes CSV injection — cell starting with = gets tab prefix', async () => {
    mockPoolConnect()
    mockAuth()
    mockFeature(true)
    vi.mocked(findLeadPoolById).mockResolvedValue(makePoolDetail())
    const res = await exportRoute(makeRequest(POOL_ID), makeParams(POOL_ID))
    const csv = await res.text()
    // The =HYPERLINK(...) value must NOT appear unescaped
    expect(csv).not.toMatch(/"=HYPERLINK/)
    // Should contain the tab-prefixed version inside the CSV cell
    expect(csv).toContain('\t=HYPERLINK')
  })

  it('contains lead CNPJ and razaoSocial in output', async () => {
    mockPoolConnect()
    mockAuth()
    mockFeature(true)
    vi.mocked(findLeadPoolById).mockResolvedValue(
      makePoolDetail({
        leads_json: [makePoolDetail().leads_json[0]],
      }),
    )
    const res = await exportRoute(makeRequest(POOL_ID), makeParams(POOL_ID))
    const csv = await res.text()
    expect(csv).toContain('12345678000195')
    expect(csv).toContain('Empresa Alpha Ltda')
  })
})

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe('GET /api/lead-pools/:id/export — rate limiting', () => {
  it('returns 429 when rate limit is exceeded', async () => {
    vi.mocked(exportLimiter.check).mockResolvedValueOnce({
      success:   false,
      remaining: 0,
      resetAt:   Date.now() + 30_000,
    })
    const res = await exportRoute(makeRequest(POOL_ID), makeParams(POOL_ID))
    expect(res.status).toBe(429)
  })

  it('returns Retry-After header when rate-limited', async () => {
    vi.mocked(exportLimiter.check).mockResolvedValueOnce({
      success:   false,
      remaining: 0,
      resetAt:   Date.now() + 30_000,
    })
    const res = await exportRoute(makeRequest(POOL_ID), makeParams(POOL_ID))
    expect(res.headers.get('retry-after')).toBeTruthy()
  })
})

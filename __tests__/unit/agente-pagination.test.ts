// ---------------------------------------------------------------------------
// Unit tests — incremental pagination + dedup loop in /api/agente
//
// Covers the loop introduced to fill requestedLimit results even when the
// first DB page has too many already-served leads:
//   - fetches a second page when page 1 yield is below the limit
//   - no duplicate CNPJs across pages (seenInBatch guard)
//   - stops correctly when DB is exhausted before filling the limit
//
// All external dependencies are mocked — no live DB or network required.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ---------------------------------------------------------------------------
// Hoisted mocks — must be vi.hoisted so factories can reference them
// ---------------------------------------------------------------------------

const {
  mockClientQuery, mockGetServedCnpjs, mockMarkAsServed, mockCallAiAgent,
  mockFindRecentPool, mockCreateLeadPool,
} = vi.hoisted(() => ({
  mockClientQuery:    vi.fn(),
  mockGetServedCnpjs: vi.fn(),
  mockMarkAsServed:   vi.fn(),
  mockCallAiAgent:    vi.fn(),
  mockFindRecentPool: vi.fn(),
  mockCreateLeadPool: vi.fn(),
}))

vi.mock('@/lib/database', () => ({
  default: {
    connect: vi.fn().mockResolvedValue({ query: mockClientQuery, release: vi.fn() }),
  },
}))

vi.mock('@/lib/rate-limit', () => ({
  agenteLimiter: { check: vi.fn().mockResolvedValue({ success: true, resetAt: 0 }) },
}))

vi.mock('@/lib/whatsapp/auth-middleware', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/whatsapp/auth-middleware')>()
  return {
    ...original,
    requireWorkspaceAuth: vi.fn().mockResolvedValue({
      workspace_id:   'ws-test',
      actor:          'api_key:test-bot',
      key_id:         'key-test',
      dedup_actor_id: 'api_key:key-test',
    }),
  }
})

vi.mock('@/lib/llm-profile-repo', () => ({
  getDefaultProfile: vi.fn().mockResolvedValue({
    apiKey: 'sk-or-test', model: 'test-model', provider: 'openrouter',
  }),
}))

vi.mock('@/lib/ai-client', () => ({
  callAiAgent:          mockCallAiAgent,
  _resetBreakerForTest: vi.fn(),
}))

// CNAE resolver is not exercised (AI returns cnae_principal directly)
vi.mock('@/lib/cnae-resolver-service', () => ({
  getCnaeResolverService: vi.fn(() => ({ resolve: vi.fn().mockResolvedValue(null) })),
}))

// Keep buildQueryFingerprint real; replace only the DB-touching functions
vi.mock('@/lib/served-leads-repo', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/served-leads-repo')>()
  return { ...original, getServedCnpjs: mockGetServedCnpjs, markAsServed: mockMarkAsServed }
})

vi.mock('@/lib/ai-narrator', () => ({
  narrateSearchResult: vi.fn().mockResolvedValue({
    headline: 'X empresas encontradas',
    subtitle: 'Resultados disponíveis',
    hasCta:   true,
    source:   'deterministic',
  }),
}))

// Auto-save must not hit mockClientQuery — findRecentPoolByFingerprint and
// createLeadPool both receive the real client and would count as extra query calls.
vi.mock('@/lib/lead-pool-repo', () => ({
  findRecentPoolByFingerprint: mockFindRecentPool,
  createLeadPool:              mockCreateLeadPool,
}))

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { POST } from '@/app/api/agente/route'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest() {
  return new NextRequest('http://localhost/api/agente', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ message: 'Clinicas em SP' }),
  })
}

/** Simulate a row returned by the DB query */
function makeRow(cnpj: string) {
  return {
    cnpj_completo:      cnpj,
    razao_social:       `Empresa ${cnpj}`,
    nome_fantasia:      null,
    uf:                 'SP',
    municipio:          'SAO PAULO',
    cnae_principal:     '8630-5/04',
    situacao_cadastral: '02',
    telefone1:          '11999990000',
    telefone2:          null,
    correio_eletronico: null,
  }
}

/** AI intent with explicit limit so we can control pagination behaviour */
function makeSearchIntent(limit: number) {
  return {
    intent: {
      action:     'search' as const,
      filters:    { uf: 'SP', cnae_principal: '8630-5/04', limit },
      confidence: 0.9,
    },
    latencyMs:    10,
    parseSuccess: true,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockMarkAsServed.mockResolvedValue(undefined)
  mockFindRecentPool.mockResolvedValue(null)
  mockCreateLeadPool.mockResolvedValue({ id: 'pool-auto', name: 'test' })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('/api/agente — incremental pagination loop', () => {
  it('fetches a second page when first page has too many served leads to fill the limit', async () => {
    mockCallAiAgent.mockResolvedValue(makeSearchIntent(3))
    // 2 CNPJs already served — only "333" from page 1 will be fresh
    mockGetServedCnpjs.mockResolvedValue(new Set(['111', '222']))

    // count → page 1 (2 served + 1 fresh) → page 2 (all fresh)
    mockClientQuery
      .mockResolvedValueOnce({ rows: [{ total: '10' }] })
      .mockResolvedValueOnce({ rows: [makeRow('111'), makeRow('222'), makeRow('333')] })
      .mockResolvedValueOnce({ rows: [makeRow('444'), makeRow('555'), makeRow('666')] })

    const res = await POST(makeRequest())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.action).toBe('search')
    expect(body.data).toHaveLength(3)

    const cnpjs = body.data.map((r: { cnpj: string }) => r.cnpj)
    expect(cnpjs).toContain('333')  // the only fresh result from page 1
    expect(cnpjs).toContain('444')  // first two from page 2 to fill the gap
    expect(cnpjs).toContain('555')
    expect(cnpjs).not.toContain('111')  // was already served
    expect(cnpjs).not.toContain('222')  // was already served
  })

  it('does not return duplicate CNPJs when DB pages overlap (unstable ordering)', async () => {
    mockCallAiAgent.mockResolvedValue(makeSearchIntent(3))
    // 1 CNPJ already served → page 1 yields 2 fresh ("222", "333"); need 1 more
    mockGetServedCnpjs.mockResolvedValue(new Set(['111']))

    // page 2 re-returns "222" and "333" (simulates unstable ordering / missing tiebreaker)
    mockClientQuery
      .mockResolvedValueOnce({ rows: [{ total: '10' }] })
      .mockResolvedValueOnce({ rows: [makeRow('111'), makeRow('222'), makeRow('333')] })
      .mockResolvedValueOnce({ rows: [makeRow('222'), makeRow('333'), makeRow('444')] })

    const res = await POST(makeRequest())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data).toHaveLength(3)

    const cnpjs = body.data.map((r: { cnpj: string }) => r.cnpj)
    expect(cnpjs).toContain('222')
    expect(cnpjs).toContain('333')
    expect(cnpjs).toContain('444')  // picked up from page 2 without duplicating 222/333

    // Crucially: no duplicate entries in the response
    expect(new Set(cnpjs).size).toBe(cnpjs.length)
  })

  it('stops and returns partial results when DB is exhausted before filling the limit', async () => {
    mockCallAiAgent.mockResolvedValue(makeSearchIntent(10))
    mockGetServedCnpjs.mockResolvedValue(new Set())

    // DB has only 2 rows (fewer than limit=10) → loop breaks after first page
    mockClientQuery
      .mockResolvedValueOnce({ rows: [{ total: '2' }] })
      .mockResolvedValueOnce({ rows: [makeRow('111'), makeRow('222')] })

    const res = await POST(makeRequest())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data).toHaveLength(2)

    // Only 2 client.query calls: 1 count + 1 contacts page (returned 2 < limit → exhausted)
    expect(mockClientQuery).toHaveBeenCalledTimes(2)
  })

  it('returns partial (empty) results and succeeds without error when pagination scan is exhausted', async () => {
    // limit=3 → MAX_PAGES = min(max(10, 3*3), 50) = 10.
    // Every page returns exactly 3 rows (all already served).
    //
    // Dynamic expansion behaviour (pageSizeThisPage captured before update):
    //   Page 1: asks for 3 → gets 3 → freshRatio=0 → pageSize doubles to 6 → 3 < 3? No → continue
    //   Page 2: asks for 6 → mock only has 3 → 3 < 6? Yes → DB exhausted → BREAK
    //
    // Total: 1 count + 2 page queries = 3 calls.
    mockCallAiAgent.mockResolvedValue(makeSearchIntent(3))
    const servedAll = new Set(['p1a', 'p1b', 'p1c', 'p2a', 'p2b', 'p2c'])
    mockGetServedCnpjs.mockResolvedValue(servedAll)

    mockClientQuery
      .mockResolvedValueOnce({ rows: [{ total: '50' }] })                                         // count
      .mockResolvedValueOnce({ rows: [makeRow('p1a'), makeRow('p1b'), makeRow('p1c')] })           // page 1 (pageSize=3)
      .mockResolvedValueOnce({ rows: [makeRow('p2a'), makeRow('p2b'), makeRow('p2c')] })           // page 2 (pageSize=6, only 3 returned → exhausted)

    const res = await POST(makeRequest())
    const body = await res.json()

    // Should return 200 with empty data — not an error
    expect(res.status).toBe(200)
    expect(body.action).toBe('search')
    expect(body.data).toHaveLength(0)

    // 1 count + 2 page queries = 3 total (DB exhausted early due to dynamic pageSize expansion)
    expect(mockClientQuery).toHaveBeenCalledTimes(3)
  })
})

// ---------------------------------------------------------------------------
// Auto-save (lead pool) behaviour
// ---------------------------------------------------------------------------

describe('/api/agente — auto-save lead pool', () => {
  /** Standard DB setup: count=5, one page with 2 fresh rows */
  function setupTwoFreshRows() {
    mockGetServedCnpjs.mockResolvedValue(new Set())
    mockClientQuery
      .mockResolvedValueOnce({ rows: [{ total: '5' }] })
      .mockResolvedValueOnce({ rows: [makeRow('111'), makeRow('222')] })
  }

  it('returns pool_id in response when auto-save creates a new pool', async () => {
    mockCallAiAgent.mockResolvedValue(makeSearchIntent(2))
    setupTwoFreshRows()
    mockFindRecentPool.mockResolvedValue(null)  // no existing pool
    mockCreateLeadPool.mockResolvedValue({ id: 'new-pool-123', name: 'test' })

    const res = await POST(makeRequest())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.pool_id).toBe('new-pool-123')
    expect(mockCreateLeadPool).toHaveBeenCalledTimes(1)
  })

  it('reuses existing pool via fingerprint within 24h and does not create a duplicate', async () => {
    mockCallAiAgent.mockResolvedValue(makeSearchIntent(2))
    setupTwoFreshRows()
    mockFindRecentPool.mockResolvedValue({ id: 'existing-pool-456', name: 'cached' })

    const res = await POST(makeRequest())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.pool_id).toBe('existing-pool-456')
    expect(mockCreateLeadPool).not.toHaveBeenCalled()
  })

  it('returns 200 with results even when auto-save throws (best-effort)', async () => {
    mockCallAiAgent.mockResolvedValue(makeSearchIntent(2))
    setupTwoFreshRows()
    mockFindRecentPool.mockRejectedValue(new Error('DB error'))

    const res = await POST(makeRequest())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.action).toBe('search')
    expect(body.data).toHaveLength(2)
    expect(body.pool_id).toBeNull()
  })
})

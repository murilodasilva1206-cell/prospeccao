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

const { mockClientQuery, mockGetServedCnpjs, mockMarkAsServed, mockCallAiAgent } = vi.hoisted(() => ({
  mockClientQuery:    vi.fn(),
  mockGetServedCnpjs: vi.fn(),
  mockMarkAsServed:   vi.fn(),
  mockCallAiAgent:    vi.fn(),
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
    situacao_cadastral: 'ATIVA',
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

  it('returns partial (empty) results and succeeds without error when pagination cap is reached', async () => {
    // limit=3 → MAX_PAGES = min(max(5,3), 20) = 5.
    // Every DB page returns exactly 3 rows (= limit), all already served.
    // The loop runs all 5 pages, accumulates nothing, and sets cappedEarly=true.
    mockCallAiAgent.mockResolvedValue(makeSearchIntent(3))
    const servedAll = new Set(['p1a', 'p1b', 'p1c', 'p2a', 'p2b', 'p2c', 'p3a', 'p3b', 'p3c', 'p4a', 'p4b', 'p4c', 'p5a', 'p5b', 'p5c'])
    mockGetServedCnpjs.mockResolvedValue(servedAll)

    // count + 5 full pages (each returns exactly requestedLimit=3 rows, so no exhaustion break)
    mockClientQuery
      .mockResolvedValueOnce({ rows: [{ total: '50' }] })
      .mockResolvedValueOnce({ rows: [makeRow('p1a'), makeRow('p1b'), makeRow('p1c')] })
      .mockResolvedValueOnce({ rows: [makeRow('p2a'), makeRow('p2b'), makeRow('p2c')] })
      .mockResolvedValueOnce({ rows: [makeRow('p3a'), makeRow('p3b'), makeRow('p3c')] })
      .mockResolvedValueOnce({ rows: [makeRow('p4a'), makeRow('p4b'), makeRow('p4c')] })
      .mockResolvedValueOnce({ rows: [makeRow('p5a'), makeRow('p5b'), makeRow('p5c')] })

    const res = await POST(makeRequest())
    const body = await res.json()

    // Should return 200 with empty data — not an error
    expect(res.status).toBe(200)
    expect(body.action).toBe('search')
    expect(body.data).toHaveLength(0)

    // 1 count + 5 page queries = 6 total
    expect(mockClientQuery).toHaveBeenCalledTimes(6)
  })
})

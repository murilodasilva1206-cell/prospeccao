// ---------------------------------------------------------------------------
// Unit tests — served-leads-repo.ts
//
// Covers:
//   - buildQueryFingerprint: deterministic SHA-256, canonical form, stability
//   - getServedCnpjs: correct SQL params (no fingerprint/retention), actor-scoped
//   - markAsServed: bulk INSERT params, ON CONFLICT, empty list no-op
//   - Dedup scenarios (migration 021 global model):
//       1. Same actor + same search: CNPJs not repeated on second call
//       2. Same actor + different filter: still excludes previously seen CNPJs
//       3. Different actor: can receive the same CNPJ
//       4. Old record (no expiry): still blocks even without time window
// All DB calls are mocked — no live PostgreSQL needed.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildQueryFingerprint, getServedCnpjs, markAsServed } from '@/lib/served-leads-repo'

// ---- Mock DB client --------------------------------------------------------
const mockQuery = vi.fn()
const mockClient = { query: mockQuery } as unknown as import('pg').PoolClient

beforeEach(() => {
  mockQuery.mockReset()
})

// ---------------------------------------------------------------------------
// buildQueryFingerprint
// ---------------------------------------------------------------------------
describe('buildQueryFingerprint', () => {
  it('returns a 64-char hex string (SHA-256)', () => {
    const fp = buildQueryFingerprint({ uf: 'SP', municipio: 'SAO PAULO' })
    expect(fp).toHaveLength(64)
    expect(fp).toMatch(/^[0-9a-f]+$/)
  })

  it('is deterministic — same inputs → same fingerprint', () => {
    const a = buildQueryFingerprint({ uf: 'RJ', municipio: 'Rio de Janeiro', cnae_principal: '8630-5/04' })
    const b = buildQueryFingerprint({ uf: 'RJ', municipio: 'Rio de Janeiro', cnae_principal: '8630-5/04' })
    expect(a).toBe(b)
  })

  it('normalises UF to uppercase', () => {
    const lower = buildQueryFingerprint({ uf: 'sp' })
    const upper = buildQueryFingerprint({ uf: 'SP' })
    expect(lower).toBe(upper)
  })

  it('normalises municipio to lowercase + trimmed', () => {
    const a = buildQueryFingerprint({ municipio: '  São Paulo  ' })
    const b = buildQueryFingerprint({ municipio: 'são paulo' })
    expect(a).toBe(b)
  })

  it('treats null and undefined fields identically', () => {
    const withNull      = buildQueryFingerprint({ uf: null, municipio: null })
    const withUndefined = buildQueryFingerprint({})
    expect(withNull).toBe(withUndefined)
  })

  it('produces different fingerprints for different filters', () => {
    const a = buildQueryFingerprint({ uf: 'SP' })
    const b = buildQueryFingerprint({ uf: 'RJ' })
    expect(a).not.toBe(b)
  })

  it('includes nicho in canonical form', () => {
    const a = buildQueryFingerprint({ uf: 'SP', nicho: 'dentistas' })
    const b = buildQueryFingerprint({ uf: 'SP', nicho: 'restaurantes' })
    expect(a).not.toBe(b)
  })
})

// ---------------------------------------------------------------------------
// getServedCnpjs — new global model (no fingerprint, no retention window)
// ---------------------------------------------------------------------------
describe('getServedCnpjs', () => {
  it('returns an empty Set when no rows are found', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const result = await getServedCnpjs(mockClient, 'ws-1', 'session:user-1')
    expect(result).toBeInstanceOf(Set)
    expect(result.size).toBe(0)
  })

  it('returns a Set containing all served CNPJs', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ cnpj: '11111111000101' }, { cnpj: '22222222000102' }],
    })
    const result = await getServedCnpjs(mockClient, 'ws-1', 'session:user-1')
    expect(result.has('11111111000101')).toBe(true)
    expect(result.has('22222222000102')).toBe(true)
    expect(result.size).toBe(2)
  })

  it('passes only workspace_id and actor_id as SQL params (no fingerprint, no retention)', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    await getServedCnpjs(mockClient, 'ws-alpha', 'api_key:bot')
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(params).toHaveLength(2)
    expect(params[0]).toBe('ws-alpha')    // $1 workspace_id
    expect(params[1]).toBe('api_key:bot') // $2 actor_id
    // Must NOT contain fingerprint or retention-related clauses
    expect(sql).not.toContain('query_fingerprint')
    expect(sql).not.toContain('served_at')
    expect(sql).not.toContain('INTERVAL')
  })

  it('scopes by actor_id — two different actors produce independent queries', async () => {
    mockQuery.mockResolvedValue({ rows: [] })

    await getServedCnpjs(mockClient, 'ws-1', 'session:user-A')
    await getServedCnpjs(mockClient, 'ws-1', 'session:user-B')

    const [, paramsA] = mockQuery.mock.calls[0] as [string, unknown[]]
    const [, paramsB] = mockQuery.mock.calls[1] as [string, unknown[]]
    expect(paramsA[1]).toBe('session:user-A')
    expect(paramsB[1]).toBe('session:user-B')
  })
})

// ---------------------------------------------------------------------------
// markAsServed
// ---------------------------------------------------------------------------
describe('markAsServed', () => {
  it('does nothing when cnpjs array is empty', async () => {
    await markAsServed(mockClient, 'ws-1', 'session:u1', 'fp-1', [])
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('inserts a single CNPJ with correct params', async () => {
    mockQuery.mockResolvedValue({ rowCount: 1 })
    await markAsServed(mockClient, 'ws-1', 'api_key:bot', 'fp-abc', ['11111111000101'])

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('INSERT INTO agent_served_leads')
    expect(sql).toContain('ON CONFLICT DO NOTHING')
    expect(params[0]).toBe('ws-1')
    expect(params[1]).toBe('api_key:bot')
    expect(params[2]).toBe('fp-abc')
    expect(params[3]).toBe('11111111000101')
  })

  it('inserts multiple CNPJs in one query', async () => {
    mockQuery.mockResolvedValue({ rowCount: 3 })
    const cnpjs = ['11111111000101', '22222222000102', '33333333000103']
    await markAsServed(mockClient, 'ws-1', 'session:u1', 'fp-1', cnpjs)

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    // workspace_id, actor_id, fingerprint + 3 cnpjs = 6 params
    expect(params).toHaveLength(6)
    expect(sql).toContain('$4')
    expect(sql).toContain('$5')
    expect(sql).toContain('$6')
    cnpjs.forEach((cnpj) => expect(params).toContain(cnpj))
  })

  it('actor_id is included in the INSERT values', async () => {
    mockQuery.mockResolvedValue({ rowCount: 1 })
    await markAsServed(mockClient, 'ws-1', 'session:user-X', 'fp-abc', ['11111111000101'])
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('actor_id')
    expect(params[1]).toBe('session:user-X')
  })
})

// ---------------------------------------------------------------------------
// Dedup scenarios — global model (migration 021)
// ---------------------------------------------------------------------------
describe('global dedup scenarios', () => {
  it('scenario 1: same actor + same search — second call returns same served set (CNPJ not repeated)', async () => {
    // The served set returned by getServedCnpjs is the same regardless of which
    // call it is — the pagination loop in the route filters based on this set.
    mockQuery.mockResolvedValue({ rows: [{ cnpj: '11111111000101' }] })

    const first  = await getServedCnpjs(mockClient, 'ws-1', 'session:user-A')
    const second = await getServedCnpjs(mockClient, 'ws-1', 'session:user-A')

    // Both calls see the same CNPJ — the route will skip it both times
    expect(first.has('11111111000101')).toBe(true)
    expect(second.has('11111111000101')).toBe(true)
  })

  it('scenario 2: same actor + different filter — still excludes previously seen CNPJ', async () => {
    // Global model: getServedCnpjs returns ALL served CNPJs for the actor,
    // not filtered by fingerprint — so a CNPJ seen with filter A is excluded
    // when the actor queries with filter B.
    mockQuery.mockResolvedValue({
      rows: [{ cnpj: '11111111000101' }, { cnpj: '22222222000102' }],
    })

    // Regardless of what filters are used to call the route, getServedCnpjs
    // always queries by actor only — both CNPJs are returned.
    const served = await getServedCnpjs(mockClient, 'ws-1', 'session:user-A')

    expect(served.has('11111111000101')).toBe(true)  // seen under filter A
    expect(served.has('22222222000102')).toBe(true)  // seen under filter B

    // SQL must NOT contain query_fingerprint (which would scope to one search)
    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).not.toContain('query_fingerprint')
  })

  it('scenario 3: different actor — can receive a CNPJ already served to actor A', async () => {
    // Actor A has '11111111000101' in its pool
    mockQuery.mockResolvedValueOnce({ rows: [{ cnpj: '11111111000101' }] })
    // Actor B has an empty pool
    mockQuery.mockResolvedValueOnce({ rows: [] })

    const servedA = await getServedCnpjs(mockClient, 'ws-1', 'session:user-A')
    const servedB = await getServedCnpjs(mockClient, 'ws-1', 'session:user-B')

    expect(servedA.has('11111111000101')).toBe(true)   // excluded for A
    expect(servedB.has('11111111000101')).toBe(false)  // available for B
  })

  it('scenario 4: old record without time window — still blocks (no expiry)', async () => {
    // The new SQL has no served_at filter — even a record from years ago blocks.
    mockQuery.mockResolvedValue({ rows: [{ cnpj: '99999999000199' }] })

    const served = await getServedCnpjs(mockClient, 'ws-1', 'api_key:bot')

    expect(served.has('99999999000199')).toBe(true)

    // SQL must not contain any time/interval filter
    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).not.toContain('served_at')
    expect(sql).not.toContain('INTERVAL')
    expect(sql).not.toContain('NOW()')
  })
})

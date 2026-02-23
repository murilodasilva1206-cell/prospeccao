// ---------------------------------------------------------------------------
// Unit tests — served-leads-repo.ts
//
// Covers:
//   - buildQueryFingerprint: deterministic SHA-256, canonical form, stability
//   - getServedCnpjs: correct SQL params, returns Set, actor_id scoped
//   - markAsServed: bulk INSERT params, ON CONFLICT, empty list no-op
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
    const withNull    = buildQueryFingerprint({ uf: null, municipio: null })
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
// getServedCnpjs
// ---------------------------------------------------------------------------
describe('getServedCnpjs', () => {
  it('returns an empty Set when no rows are found', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const result = await getServedCnpjs(mockClient, 'ws-1', 'session:user-1', 'fp-abc')
    expect(result).toBeInstanceOf(Set)
    expect(result.size).toBe(0)
  })

  it('returns a Set containing all served CNPJs', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ cnpj: '11111111000101' }, { cnpj: '22222222000102' }],
    })
    const result = await getServedCnpjs(mockClient, 'ws-1', 'session:user-1', 'fp-abc')
    expect(result.has('11111111000101')).toBe(true)
    expect(result.has('22222222000102')).toBe(true)
    expect(result.size).toBe(2)
  })

  it('passes workspace_id, actor_id, fingerprint, and retention days as SQL params', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    await getServedCnpjs(mockClient, 'ws-alpha', 'api_key:bot', 'fp-xyz')
    const [_sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(params[0]).toBe('ws-alpha')       // $1 workspace_id
    expect(params[1]).toBe('api_key:bot')    // $2 actor_id
    expect(params[2]).toBe('fp-xyz')         // $3 fingerprint
    expect(typeof params[3]).toBe('number')  // $4 retention days
  })

  it('scopes by actor_id — two different actors use different queries', async () => {
    mockQuery.mockResolvedValue({ rows: [] })

    await getServedCnpjs(mockClient, 'ws-1', 'session:user-A', 'fp-1')
    await getServedCnpjs(mockClient, 'ws-1', 'session:user-B', 'fp-1')

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

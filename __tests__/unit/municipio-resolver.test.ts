// ---------------------------------------------------------------------------
// Unit tests — lib/municipio-resolver.ts
//
// All DB calls are mocked via a fake PoolClient.  The tests verify:
//   - Numeric codes pass through without a DB call
//   - found / ambiguous / not_found flows
//   - City coverage: São Paulo, Rio de Janeiro, Manaus, Blumenau, Porto Velho
//   - Homonyms without UF → ambiguous
//   - Homonyms with UF → picks first (exact match wins via ORDER BY)
//   - DB failure → graceful fallback to not_found
//   - DB_SKIP_COUNT env flag (orthogonal — verified in route integration tests)
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { MunicipioCandidate } from '@/lib/municipio-resolver'

// ---------------------------------------------------------------------------
// Hoist mocks
// ---------------------------------------------------------------------------
const { mockQuery, mockRelease } = vi.hoisted(() => {
  const mockQuery   = vi.fn()
  const mockRelease = vi.fn()
  return { mockQuery, mockRelease }
})

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis() },
}))

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------
import { resolveMunicipio } from '@/lib/municipio-resolver'

// Fake PoolClient — only query() and release() are used by the resolver
function makeClient(rows: MunicipioCandidate[] = []) {
  mockQuery.mockResolvedValue({ rows })
  mockRelease.mockReturnValue(undefined)
  return { query: mockQuery, release: mockRelease } as unknown as import('pg').PoolClient
}

function makeClientError(err: Error) {
  mockQuery.mockRejectedValue(err)
  mockRelease.mockReturnValue(undefined)
  return { query: mockQuery, release: mockRelease } as unknown as import('pg').PoolClient
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Numeric passthrough — no DB round-trip
// ---------------------------------------------------------------------------
describe('numeric code passthrough', () => {
  it('returns found without calling DB for a pure numeric input', async () => {
    const client = makeClient([])
    const result = await resolveMunicipio(client as never, '3550308')
    expect(result).toEqual({ type: 'found', codigo: '3550308', nome: '3550308', uf: '' })
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('preserves the provided UF in the numeric passthrough', async () => {
    const client = makeClient([])
    const result = await resolveMunicipio(client as never, '3550308', 'SP')
    expect(result).toEqual({ type: 'found', codigo: '3550308', nome: '3550308', uf: 'SP' })
    expect(mockQuery).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// not_found — 0 rows
// ---------------------------------------------------------------------------
describe('not_found', () => {
  it('returns not_found when DB returns 0 rows', async () => {
    const client = makeClient([])
    const result = await resolveMunicipio(client as never, 'CidadeInexistente')
    expect(result).toEqual({ type: 'not_found' })
  })
})

// ---------------------------------------------------------------------------
// found — exactly 1 row
// ---------------------------------------------------------------------------
describe('found — 1 match', () => {
  it('São Paulo (SP) resolves to codigo_f', async () => {
    const client = makeClient([{ codigo: '3550308', nome: 'SAO PAULO', uf: 'SP' }])
    const result = await resolveMunicipio(client as never, 'São Paulo', 'SP')
    expect(result).toEqual({ type: 'found', codigo: '3550308', nome: 'SAO PAULO', uf: 'SP' })
  })

  it('Rio de Janeiro (RJ) resolves to codigo_f', async () => {
    const client = makeClient([{ codigo: '3304557', nome: 'RIO DE JANEIRO', uf: 'RJ' }])
    const result = await resolveMunicipio(client as never, 'Rio de Janeiro', 'RJ')
    expect(result).toEqual({ type: 'found', codigo: '3304557', nome: 'RIO DE JANEIRO', uf: 'RJ' })
  })

  it('Manaus (AM) resolves to codigo_f', async () => {
    const client = makeClient([{ codigo: '1302603', nome: 'MANAUS', uf: 'AM' }])
    const result = await resolveMunicipio(client as never, 'Manaus')
    expect(result).toEqual({ type: 'found', codigo: '1302603', nome: 'MANAUS', uf: 'AM' })
  })

  it('Blumenau (SC) resolves to codigo_f', async () => {
    const client = makeClient([{ codigo: '4202404', nome: 'BLUMENAU', uf: 'SC' }])
    const result = await resolveMunicipio(client as never, 'Blumenau', 'SC')
    expect(result).toEqual({ type: 'found', codigo: '4202404', nome: 'BLUMENAU', uf: 'SC' })
  })

  it('Porto Velho (RO) resolves to codigo_f', async () => {
    const client = makeClient([{ codigo: '1100205', nome: 'PORTO VELHO', uf: 'RO' }])
    const result = await resolveMunicipio(client as never, 'Porto Velho', 'RO')
    expect(result).toEqual({ type: 'found', codigo: '1100205', nome: 'PORTO VELHO', uf: 'RO' })
  })

  it('passes the correct SQL parameters to the client', async () => {
    const client = makeClient([{ codigo: '3550308', nome: 'SAO PAULO', uf: 'SP' }])
    await resolveMunicipio(client as never, 'São Paulo', 'SP')

    expect(mockQuery).toHaveBeenCalledOnce()
    const [, params] = mockQuery.mock.calls[0]
    expect(params[0]).toBe('SP')          // uf parameter
    expect(params[1]).toContain('São Paulo') // nome wrapped in %...%
    expect(params[1]).toMatch(/^%.*%$/)
  })

  it('passes null for uf when not provided', async () => {
    const client = makeClient([{ codigo: '1302603', nome: 'MANAUS', uf: 'AM' }])
    await resolveMunicipio(client as never, 'Manaus')
    const [, params] = mockQuery.mock.calls[0]
    expect(params[0]).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// ambiguous — multiple rows without UF
// ---------------------------------------------------------------------------
describe('ambiguous — multiple rows without UF', () => {
  const candidates: MunicipioCandidate[] = [
    { codigo: '3549805', nome: 'SAO JOSE', uf: 'SP' },
    { codigo: '4216602', nome: 'SAO JOSE', uf: 'SC' },
  ]

  it('returns ambiguous when 2 rows and no UF was given', async () => {
    const client = makeClient(candidates)
    const result = await resolveMunicipio(client as never, 'São José')
    expect(result.type).toBe('ambiguous')
    if (result.type === 'ambiguous') {
      expect(result.candidates).toHaveLength(2)
      expect(result.candidates[0].uf).toBe('SP')
      expect(result.candidates[1].uf).toBe('SC')
    }
  })

  it('returns found (first row) when UF is provided and multiple rows match', async () => {
    // With uf='SP' the DB WHERE clause already filters; we simulate 1 returned row.
    const client = makeClient([candidates[0]])
    const result = await resolveMunicipio(client as never, 'São José', 'SP')
    expect(result).toEqual({ type: 'found', codigo: '3549805', nome: 'SAO JOSE', uf: 'SP' })
  })

  it('picks the first row (exact match prioritized) when UF given and DB returns 2+', async () => {
    // Even if DB returns 2 rows with UF filter, we pick first (ORDER BY exact match first)
    const client = makeClient(candidates)
    const result = await resolveMunicipio(client as never, 'São José', 'SP')
    expect(result.type).toBe('found')
    if (result.type === 'found') {
      expect(result.codigo).toBe('3549805')
    }
  })
})

// ---------------------------------------------------------------------------
// DB error — graceful degradation
// ---------------------------------------------------------------------------
describe('DB error handling', () => {
  it('returns not_found and does not throw when DB query fails', async () => {
    const client = makeClientError(new Error('relation "mapeamento_municipios" does not exist'))
    const result = await resolveMunicipio(client as never, 'São Paulo', 'SP')
    expect(result).toEqual({ type: 'not_found' })
  })

  it('returns not_found when unaccent extension is missing', async () => {
    const client = makeClientError(new Error('function unaccent(text) does not exist'))
    const result = await resolveMunicipio(client as never, 'Manaus')
    expect(result).toEqual({ type: 'not_found' })
  })
})

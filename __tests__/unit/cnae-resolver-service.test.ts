// ---------------------------------------------------------------------------
// Unit tests — CnaeResolverService (lib/cnae-resolver-service.ts)
//
// Covers:
//   - Layer 1 (LRU cache): cache hit returns immediately without DB/API call
//   - Layer 2 (DB dynamic): resolveNichoCnaeDynamic match returned + cached
//   - Layer 2b (static map): fallback to static NICHO_CNAE_MAP
//   - Layer 3 (IBGE API): fetch called on miss; result cached + persisted
//   - Circuit breaker open: IBGE call returns null gracefully
//   - Empty/blank input → undefined
//   - Normalisation: accents and uppercase → same cache key
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- Hoist mocks -----------------------------------------------------------
const { mockDynamic, mockStatic, mockPool, mockClient, mockQuery, mockRelease } = vi.hoisted(() => {
  const mockQuery = vi.fn()
  const mockRelease = vi.fn()
  const mockClient = { query: mockQuery, release: mockRelease }
  const mockPool = { connect: vi.fn().mockResolvedValue(mockClient) }
  const mockDynamic = vi.fn<(q: string) => Promise<string | undefined>>()
  const mockStatic  = vi.fn<(q: string) => string | undefined>()
  return { mockDynamic, mockStatic, mockPool, mockClient, mockQuery, mockRelease }
})

vi.mock('@/lib/database', () => ({ default: mockPool }))

vi.mock('@/lib/nicho-cnae', () => ({
  resolveNichoCnaeDynamic: mockDynamic,
  resolveNichoCnae:        mockStatic,
}))

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnThis() },
}))

// ---- Import after mocks ---------------------------------------------------
import { CnaeResolverService, _resetCnaeResolverService } from '@/lib/cnae-resolver-service'

// Helper: create a fresh service instance (avoids singleton state between tests)
function makeService(): CnaeResolverService {
  _resetCnaeResolverService()
  return new CnaeResolverService(mockPool as unknown as import('pg').Pool)
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default: all layers return no match
  mockDynamic.mockResolvedValue(undefined)
  mockStatic.mockReturnValue(undefined)
  mockQuery.mockResolvedValue({ rowCount: 0 })
  mockRelease.mockReturnValue(undefined)
  _resetCnaeResolverService()

  // Reset global fetch mock
  vi.stubGlobal('fetch', vi.fn())
})

// ---------------------------------------------------------------------------
// Empty / blank input
// ---------------------------------------------------------------------------
describe('resolve — empty input', () => {
  it('returns undefined for empty string', async () => {
    const svc = makeService()
    expect(await svc.resolve('')).toBeUndefined()
  })

  it('returns undefined for whitespace-only string', async () => {
    const svc = makeService()
    expect(await svc.resolve('   ')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Layer 2: dynamic DB
// ---------------------------------------------------------------------------
describe('resolve — Layer 2: DB dynamic', () => {
  it('returns DB result when resolveNichoCnaeDynamic matches', async () => {
    mockDynamic.mockResolvedValue('8630-5/04')
    const svc = makeService()
    const result = await svc.resolve('dentistas')
    expect(result).toBe('8630-5/04')
    expect(mockDynamic).toHaveBeenCalledWith('dentistas')
  })

  it('does not call static map or IBGE when DB hits', async () => {
    mockDynamic.mockResolvedValue('8630-5/04')
    const svc = makeService()
    await svc.resolve('dentistas')
    expect(mockStatic).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Layer 2b: static map
// ---------------------------------------------------------------------------
describe('resolve — Layer 2b: static map', () => {
  it('falls back to static map when DB returns undefined', async () => {
    mockDynamic.mockResolvedValue(undefined)
    mockStatic.mockReturnValue('5611-2/01')
    const svc = makeService()
    const result = await svc.resolve('restaurantes')
    expect(result).toBe('5611-2/01')
    expect(mockStatic).toHaveBeenCalledWith('restaurantes')
  })

  it('does not call IBGE when static map matches', async () => {
    mockDynamic.mockResolvedValue(undefined)
    mockStatic.mockReturnValue('5611-2/01')
    const svc = makeService()
    await svc.resolve('restaurantes')
    expect(fetch).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Layer 3: IBGE API
// ---------------------------------------------------------------------------
describe('resolve — Layer 3: IBGE API', () => {
  it('calls IBGE when DB and static map both miss', async () => {
    mockDynamic.mockResolvedValue(undefined)
    mockStatic.mockReturnValue(undefined)

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue([
        { id: '4781-4/00', descricao: 'Comercio Varejista de Vestuario' },
      ]),
    })
    vi.stubGlobal('fetch', mockFetch)

    const svc = makeService()
    const result = await svc.resolve('roupas')
    expect(result).toBe('4781-4/00')
    expect(mockFetch).toHaveBeenCalledOnce()
    expect(mockFetch.mock.calls[0][0]).toContain('roupas')
  })

  it('persists IBGE result to cnae_dictionary', async () => {
    mockDynamic.mockResolvedValue(undefined)
    mockStatic.mockReturnValue(undefined)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue([{ id: '4781-4/00', descricao: 'Vestuario' }]),
    }))

    const svc = makeService()
    await svc.resolve('moda')
    // persistToDictionary calls pool.connect()
    expect(mockPool.connect).toHaveBeenCalled()
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO cnae_dictionary'),
      expect.arrayContaining(['4781-4/00', 'Vestuario', 'moda']),
    )
    expect(mockRelease).toHaveBeenCalled()
  })

  it('returns undefined when IBGE returns empty array', async () => {
    mockDynamic.mockResolvedValue(undefined)
    mockStatic.mockReturnValue(undefined)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue([]),
    }))

    const svc = makeService()
    expect(await svc.resolve('xyzzy')).toBeUndefined()
  })

  it('returns undefined when IBGE returns non-ok HTTP status', async () => {
    mockDynamic.mockResolvedValue(undefined)
    mockStatic.mockReturnValue(undefined)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))

    const svc = makeService()
    expect(await svc.resolve('xyzzy')).toBeUndefined()
  })

  it('returns undefined when IBGE fetch throws (circuit breaker trip)', async () => {
    mockDynamic.mockResolvedValue(undefined)
    mockStatic.mockReturnValue(undefined)

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')))

    const svc = makeService()
    expect(await svc.resolve('xyzzy')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Layer 1: LRU cache
// ---------------------------------------------------------------------------
describe('resolve — Layer 1: LRU cache', () => {
  it('returns cached result on second call without hitting DB', async () => {
    mockDynamic.mockResolvedValueOnce('8630-5/04')
    const svc = makeService()

    await svc.resolve('dentistas')
    mockDynamic.mockClear()

    const cached = await svc.resolve('dentistas')
    expect(cached).toBe('8630-5/04')
    // DB should NOT have been called again
    expect(mockDynamic).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------
describe('resolve — normalisation', () => {
  it('strips accents before resolution', async () => {
    mockDynamic.mockImplementation(async (q: string) =>
      q === 'restaurantes' ? '5611-2/01' : undefined,
    )
    const svc = makeService()
    const result = await svc.resolve('Restaurantés')  // accent + uppercase
    expect(result).toBe('5611-2/01')
  })
})

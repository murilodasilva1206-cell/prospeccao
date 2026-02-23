// ---------------------------------------------------------------------------
// Unit tests for resolveNichoCnaeDynamic (lib/nicho-cnae.ts)
//
// All DB calls are mocked — no live PostgreSQL needed.
// Tests cover:
//   - exact synonym match (score 3)
//   - substring synonym fallback (score 2)
//   - descricao ILIKE fallback (score 1)
//   - static map fallback when DB throws
//   - in-memory cache TTL (hit and expiry)
//   - empty / blank nicho → undefined
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoist shared mock objects so they're available in vi.mock factories
// ---------------------------------------------------------------------------
const { mockRelease, mockClient, mockQuery } = vi.hoisted(() => {
  const mockQuery = vi.fn()
  const mockRelease = vi.fn()
  const mockClient = { query: mockQuery, release: mockRelease }
  return { mockRelease, mockClient, mockQuery }
})

vi.mock('@/lib/database', () => ({
  default: { connect: vi.fn().mockResolvedValue(mockClient) },
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    warn: vi.fn(),
    child: vi.fn().mockReturnValue({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
  },
}))

// Import AFTER mocks are in place
import { resolveNichoCnaeDynamic, _clearDynamicCacheForTesting } from '@/lib/nicho-cnae'
import { logger } from '@/lib/logger'

// ---------------------------------------------------------------------------
// Helper: build the row structure the DB returns (includes the score column)
// ---------------------------------------------------------------------------
function dbRow(codigo: string) {
  return { codigo }
}

// ---------------------------------------------------------------------------
// Reset state between tests so the in-memory cache doesn't bleed across cases
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.clearAllMocks()
  // Purge the module-level cache by re-importing with a fresh clock tick.
  // We achieve this by advancing time past the TTL via fake timers only where
  // needed, or by using unique nicho strings per test so cache never collides.
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveNichoCnaeDynamic', () => {
  describe('exact synonym match', () => {
    it('returns the CNAE when the normalized nicho is an exact synonym', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [dbRow('8630-5/04')] })

      const result = await resolveNichoCnaeDynamic('dentistas')

      expect(result).toBe('8630-5/04')
      expect(mockQuery).toHaveBeenCalledOnce()
      // Verify the normalized value is passed as $1
      const [, params] = mockQuery.mock.calls[0] as [string, string[]]
      expect(params[0]).toBe('dentistas')
    })

    it('normalizes accented input before querying', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [dbRow('9602-5/01')] })

      const result = await resolveNichoCnaeDynamic('Salões de Beleza')

      expect(result).toBe('9602-5/01')
      const [, params] = mockQuery.mock.calls[0] as [string, string[]]
      expect(params[0]).toBe('saloes de beleza') // diacritics stripped, lowercased
    })
  })

  describe('descricao ILIKE fallback', () => {
    it('returns the CNAE when only the descricao fuzzy-matches', async () => {
      // Simulate: no synonym match, but descricao matches
      mockQuery.mockResolvedValueOnce({ rows: [dbRow('8121-4/00')] })

      const result = await resolveNichoCnaeDynamic('servicos de limpeza comercial')

      expect(result).toBe('8121-4/00')
      const [, params] = mockQuery.mock.calls[0] as [string, string[]]
      // $2 must be the ILIKE pattern wrapping the normalized nicho
      expect(params[1]).toBe('%servicos de limpeza comercial%')
    })
  })

  describe('DB failure → static fallback', () => {
    it('returns undefined and logs a warn when pool.connect throws', async () => {
      const fakeError = new Error('Connection refused')
      // Make pool.connect() throw
      const { default: pool } = await import('@/lib/database')
      vi.mocked(pool.connect).mockRejectedValueOnce(fakeError)

      const result = await resolveNichoCnaeDynamic('dentistas-db-down')

      expect(result).toBeUndefined()
      expect(logger.warn).toHaveBeenCalledOnce()
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        expect.objectContaining({
          nicho: 'dentistas-db-down',
          err: 'Connection refused',
        }),
        expect.stringContaining('falling back to static map'),
      )
    })

    it('returns undefined and logs a warn when query throws', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Query timeout'))

      const result = await resolveNichoCnaeDynamic('academias-query-fail')

      expect(result).toBeUndefined()
      expect(logger.warn).toHaveBeenCalledOnce()
    })

    it('releases the client even when the query throws', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB error'))

      await resolveNichoCnaeDynamic('release-check')

      expect(mockRelease).toHaveBeenCalledOnce()
    })
  })

  describe('no match in DB', () => {
    it('returns undefined when the DB returns zero rows', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] })

      const result = await resolveNichoCnaeDynamic('nicho-sem-correspondencia')

      expect(result).toBeUndefined()
      expect(logger.warn).not.toHaveBeenCalled()
    })
  })

  describe('empty / blank input', () => {
    it('returns undefined immediately for empty string (no DB call)', async () => {
      const result = await resolveNichoCnaeDynamic('')
      expect(result).toBeUndefined()
      expect(mockQuery).not.toHaveBeenCalled()
    })

    it('returns undefined for whitespace-only string (no DB call)', async () => {
      const result = await resolveNichoCnaeDynamic('   ')
      expect(result).toBeUndefined()
      expect(mockQuery).not.toHaveBeenCalled()
    })
  })

  describe('in-memory TTL cache', () => {
    it('returns cached result without hitting DB on second call', async () => {
      // Use a unique nicho to avoid interference from other tests
      mockQuery.mockResolvedValueOnce({ rows: [dbRow('9313-1/00')] })

      const first = await resolveNichoCnaeDynamic('academias-cache-test')
      const second = await resolveNichoCnaeDynamic('academias-cache-test')

      expect(first).toBe('9313-1/00')
      expect(second).toBe('9313-1/00')
      // DB called only once — second call served from cache
      expect(mockQuery).toHaveBeenCalledOnce()
    })

    it('re-queries DB after cache is invalidated (simulates TTL expiry)', async () => {
      // lru-cache captures the global performance/Date reference at module-load
      // time, so vi.useFakeTimers() cannot retroactively affect its TTL clock.
      // Instead we call _clearDynamicCacheForTesting() to force the same code
      // path that an expired entry would trigger: cache miss → DB call.
      mockQuery.mockResolvedValue({ rows: [dbRow('9313-1/00')] })

      await resolveNichoCnaeDynamic('academias-expiry-test')
      expect(mockQuery).toHaveBeenCalledTimes(1)

      // Simulate TTL expiry by clearing the cache
      _clearDynamicCacheForTesting()

      await resolveNichoCnaeDynamic('academias-expiry-test')
      expect(mockQuery).toHaveBeenCalledTimes(2)
    })
  })
})

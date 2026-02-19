import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRateLimiter, agenteLimiter, buscaLimiter, exportLimiter } from '@/lib/rate-limit'
import { ExportQuerySchema, BuscaQuerySchema, AgenteBodySchema } from '@/lib/schemas'

// ---------------------------------------------------------------------------
// DoS resistance tests (Fase 5)
// ---------------------------------------------------------------------------

describe('DoS — Rate limiting enforcement', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('blocks >10 requests/minute to /api/agente from same IP', async () => {
    const ip = 'dos-test-agente'
    let blocked = 0
    for (let i = 0; i < 15; i++) {
      const result = await agenteLimiter.check(ip)
      if (!result.success) blocked++
    }
    expect(blocked).toBeGreaterThan(0)
  })

  it('blocks >60 requests/minute to /api/busca from same IP', async () => {
    const ip = 'dos-test-busca'
    let blocked = 0
    for (let i = 0; i < 70; i++) {
      const result = await buscaLimiter.check(ip)
      if (!result.success) blocked++
    }
    expect(blocked).toBeGreaterThan(0)
  })

  it('blocks >5 exports/minute from same IP', async () => {
    const ip = 'dos-test-export'
    let blocked = 0
    for (let i = 0; i < 10; i++) {
      const result = await exportLimiter.check(ip)
      if (!result.success) blocked++
    }
    expect(blocked).toBeGreaterThan(0)
  })
})

describe('DoS — Input cap enforcement (schema)', () => {
  it('caps pagination limit at 100 even with large input', () => {
    expect(() => BuscaQuerySchema.parse({ limit: '99999' })).toThrow()
    expect(() => BuscaQuerySchema.parse({ limit: '1000' })).toThrow()
  })

  it('caps export maxRows at 5000 even with extreme input', () => {
    expect(() => ExportQuerySchema.parse({ maxRows: '99999' })).toThrow()
    expect(() => ExportQuerySchema.parse({ maxRows: '5001' })).toThrow()
  })

  it('enforces maximum on export maxRows = 5000', () => {
    const result = ExportQuerySchema.parse({ maxRows: '5000' })
    expect(result.maxRows).toBe(5000)
  })

  it('caps page at positive integers (no negative offsets)', () => {
    expect(() => BuscaQuerySchema.parse({ page: '-100' })).toThrow()
    expect(() => BuscaQuerySchema.parse({ page: '0' })).toThrow()
  })

  it('limits message size to 1000 chars (prevents large token consumption)', () => {
    expect(() => AgenteBodySchema.parse({ message: 'a'.repeat(1001) })).toThrow()
    expect(() => AgenteBodySchema.parse({ message: 'a'.repeat(1000) })).not.toThrow()
  })
})

describe('DoS — Rate limiter self-recovery', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('recovers after window expires (rate limit is temporary, not permanent ban)', async () => {
    const limiter = createRateLimiter({
      name: 'test-recovery',
      uniqueTokenPerInterval: 100,
      interval: 60_000,
      maxRequests: 2,
    })
    const ip = 'recovery-test'
    await limiter.check(ip)
    await limiter.check(ip)
    // 3rd request — blocked
    expect((await limiter.check(ip)).success).toBe(false)

    // Advance past window
    vi.advanceTimersByTime(61_000)
    // Should succeed again
    expect((await limiter.check(ip)).success).toBe(true)
  })
})

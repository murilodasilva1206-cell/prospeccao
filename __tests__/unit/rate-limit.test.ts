import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRateLimiter } from '@/lib/rate-limit'

describe('createRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('allows requests under the limit', async () => {
    const limiter = createRateLimiter({
      name: 'test',
      uniqueTokenPerInterval: 100,
      interval: 60_000,
      maxRequests: 5,
    })
    const result = await limiter.check('1.2.3.4')
    expect(result.success).toBe(true)
    expect(result.remaining).toBe(4)
  })

  it('blocks requests when limit is exceeded', async () => {
    const limiter = createRateLimiter({
      name: 'test',
      uniqueTokenPerInterval: 100,
      interval: 60_000,
      maxRequests: 2,
    })
    await limiter.check('1.2.3.4') // 1st
    await limiter.check('1.2.3.4') // 2nd
    const result = await limiter.check('1.2.3.4') // 3rd — exceeds limit
    expect(result.success).toBe(false)
    expect(result.remaining).toBe(0)
  })

  it('returns correct remaining count', async () => {
    const limiter = createRateLimiter({
      name: 'test',
      uniqueTokenPerInterval: 100,
      interval: 60_000,
      maxRequests: 5,
    })
    const r1 = await limiter.check('1.2.3.4')
    expect(r1.remaining).toBe(4)
    const r2 = await limiter.check('1.2.3.4')
    expect(r2.remaining).toBe(3)
    const r3 = await limiter.check('1.2.3.4')
    expect(r3.remaining).toBe(2)
  })

  it('tracks different IPs independently', async () => {
    const limiter = createRateLimiter({
      name: 'test',
      uniqueTokenPerInterval: 100,
      interval: 60_000,
      maxRequests: 1,
    })
    const r1 = await limiter.check('1.1.1.1')
    const r2 = await limiter.check('2.2.2.2')
    expect(r1.success).toBe(true)
    expect(r2.success).toBe(true)
    // First IP is now exhausted, second should also be
    const r3 = await limiter.check('1.1.1.1')
    const r4 = await limiter.check('2.2.2.2')
    expect(r3.success).toBe(false)
    expect(r4.success).toBe(false)
  })

  it('resets after the interval window expires', async () => {
    const limiter = createRateLimiter({
      name: 'test',
      uniqueTokenPerInterval: 100,
      interval: 60_000,
      maxRequests: 1,
    })
    await limiter.check('1.2.3.4') // use the 1 allowed
    const r1 = await limiter.check('1.2.3.4') // blocked
    expect(r1.success).toBe(false)

    // Advance time past the window
    vi.advanceTimersByTime(61_000)

    const r2 = await limiter.check('1.2.3.4') // window reset — allowed again
    expect(r2.success).toBe(true)
  })

  it('returns a positive resetAt timestamp', async () => {
    const limiter = createRateLimiter({
      name: 'test',
      uniqueTokenPerInterval: 100,
      interval: 60_000,
      maxRequests: 5,
    })
    const result = await limiter.check('1.2.3.4')
    expect(result.resetAt).toBeGreaterThan(Date.now())
  })
})

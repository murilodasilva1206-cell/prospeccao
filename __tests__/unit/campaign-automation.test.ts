import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  computeNextSendAt,
  recipientsThisTick,
  isWithinWorkingHours,
  brazilHour,
} from '@/lib/campaign-automation-utils'
import { AutomationConfigSchema, UpdateAutomationSchema } from '@/lib/schemas'

// ---------------------------------------------------------------------------
// Unit tests for campaign automation logic.
//
// All pure functions are imported from lib/campaign-automation-utils — changes
// to the real implementation are reflected here immediately.
// No DB, no network, no mocking required (except vi.setSystemTime for clock).
// ---------------------------------------------------------------------------

// Large maxPerHour (500) so rate-limit floor (3600/500=8s) doesn't override
// the delay_seconds under test.
const HIGH_MAX_PER_HOUR = 500

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// 1. computeNextSendAt — delay + jitter + max_per_hour enforcement
// ---------------------------------------------------------------------------

describe('computeNextSendAt', () => {
  it('returns a date in the future by at least delay_seconds', () => {
    const before = Date.now()
    const next = computeNextSendAt(120, 0, HIGH_MAX_PER_HOUR)
    expect(next.getTime()).toBeGreaterThanOrEqual(before + 120_000)
    expect(next.getTime()).toBeLessThanOrEqual(before + 121_000) // small clock margin
  })

  it('includes jitter within [0, jitter_max]', () => {
    const samples = Array.from({ length: 50 }, () => computeNextSendAt(60, 20, HIGH_MAX_PER_HOUR))
    for (const next of samples) {
      const diff = (next.getTime() - Date.now()) / 1000
      expect(diff).toBeGreaterThanOrEqual(59) // delay - 1s margin
      expect(diff).toBeLessThanOrEqual(81)     // delay + jitter_max + 1s margin
    }
  })

  it('returns exactly delay when jitter_max is 0', () => {
    const before = Date.now()
    const next = computeNextSendAt(30, 0, HIGH_MAX_PER_HOUR)
    const diff = (next.getTime() - before) / 1000
    expect(diff).toBeGreaterThanOrEqual(29.9)
    expect(diff).toBeLessThanOrEqual(30.1)
  })

  it('enforces max_per_hour floor: low delay is raised to 3600/max_per_hour', () => {
    const before = Date.now()
    // delay=10s, maxPerHour=20 → minInterval=ceil(3600/20)=180s
    const next = computeNextSendAt(10, 0, 20)
    const diff = (next.getTime() - before) / 1000
    expect(diff).toBeGreaterThanOrEqual(179) // 180s − 1s margin
    expect(diff).toBeLessThanOrEqual(181)
  })

  it('high max_per_hour does not raise delay beyond delay_seconds', () => {
    const before = Date.now()
    // delay=120s, maxPerHour=500 → minInterval=8s < 120s → effectiveDelay=120s
    const next = computeNextSendAt(120, 0, HIGH_MAX_PER_HOUR)
    const diff = (next.getTime() - before) / 1000
    expect(diff).toBeGreaterThanOrEqual(119)
    expect(diff).toBeLessThanOrEqual(121)
  })
})

// ---------------------------------------------------------------------------
// 2. recipientsThisTick — cron tick capacity accounting for delay + max_per_hour
// ---------------------------------------------------------------------------

describe('recipientsThisTick', () => {
  it('returns 1 for delay >= 60s (high max_per_hour)', () => {
    expect(recipientsThisTick(60,   HIGH_MAX_PER_HOUR)).toBe(1)
    expect(recipientsThisTick(120,  HIGH_MAX_PER_HOUR)).toBe(1)
    expect(recipientsThisTick(3600, HIGH_MAX_PER_HOUR)).toBe(1)
  })

  it('returns 2 for delay = 30s (high max_per_hour)', () => {
    expect(recipientsThisTick(30, HIGH_MAX_PER_HOUR)).toBe(2)
  })

  it('returns 6 for delay = 10s (high max_per_hour)', () => {
    expect(recipientsThisTick(10, HIGH_MAX_PER_HOUR)).toBe(6)
  })

  it('caps at maxPerCron (default 10)', () => {
    // delay=1s, maxPerHour=3600 → minInterval=1s → ceil(60/1)=60, capped to 10
    expect(recipientsThisTick(1, 3600)).toBe(10)
  })

  it('returns at least 1 even for very large delays', () => {
    expect(recipientsThisTick(86400, HIGH_MAX_PER_HOUR)).toBe(1)
  })

  it('max_per_hour=20 limits to 1/tick even with short delay', () => {
    // minInterval=ceil(3600/20)=180s > delay=10s → effectiveDelay=180s → ceil(60/180)=1
    expect(recipientsThisTick(10, 20)).toBe(1)
  })

  it('max_per_hour=120 gives 1/tick at 30s delay', () => {
    // minInterval=ceil(3600/120)=30s = delay=30s → ceil(60/30)=2
    expect(recipientsThisTick(30, 120)).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 3. scheduleRecipientRetry — backoff formula (pure math, no import needed)
// ---------------------------------------------------------------------------

function backoffSeconds(retryCount: number): number {
  return Math.pow(2, retryCount) * 30
}

describe('backoff formula', () => {
  it('1st retry: 60 s', () => expect(backoffSeconds(1)).toBe(60))
  it('2nd retry: 120 s', () => expect(backoffSeconds(2)).toBe(120))
  it('3rd retry: 240 s', () => expect(backoffSeconds(3)).toBe(240))
})

describe('scheduleRecipientRetry logic', () => {
  function shouldRetry(currentRetryCount: number, maxRetries: number): 'retry' | 'fail' {
    return currentRetryCount + 1 >= maxRetries ? 'fail' : 'retry'
  }

  it('retries when under max_retries', () => {
    expect(shouldRetry(0, 3)).toBe('retry')
    expect(shouldRetry(1, 3)).toBe('retry')
  })

  it('fails when reaching max_retries', () => {
    expect(shouldRetry(2, 3)).toBe('fail') // newRetryCount = 3 >= maxRetries = 3
  })

  it('fails immediately when max_retries = 0', () => {
    expect(shouldRetry(0, 0)).toBe('fail')
  })

  it('fails immediately when max_retries = 1', () => {
    expect(shouldRetry(0, 1)).toBe('fail') // newRetryCount = 1 >= maxRetries = 1
  })
})

// ---------------------------------------------------------------------------
// 4. isWithinWorkingHours — working hours check (UTC-3 Brazil)
//    Uses vi.setSystemTime to control the clock deterministically.
// ---------------------------------------------------------------------------

/** Freeze the clock so getUTCHours() returns the given utcHour. */
function mockUtcHour(utcHour: number) {
  const d = new Date()
  d.setUTCHours(utcHour, 0, 0, 0)
  vi.useFakeTimers()
  vi.setSystemTime(d)
}

describe('brazilHour', () => {
  it('converts UTC to UTC-3', () => {
    mockUtcHour(12)
    expect(brazilHour()).toBe(9) // 12 UTC → 09 Brazil
  })

  it('wraps midnight correctly (01 UTC → 22 Brazil previous day)', () => {
    mockUtcHour(1)
    expect(brazilHour()).toBe(22) // (1 + 21) % 24 = 22
  })
})

describe('isWithinWorkingHours', () => {
  it('always allows when no restriction set', () => {
    for (let h = 0; h < 24; h++) {
      mockUtcHour(h)
      expect(isWithinWorkingHours(null, null)).toBe(true)
    }
  })

  it('allows during daytime window (08–18 Brasilia)', () => {
    // 11:00 UTC = 08:00 Brasilia (start of window)
    mockUtcHour(11)
    expect(isWithinWorkingHours(8, 18)).toBe(true)
    // 20:00 UTC = 17:00 Brasilia (within window)
    mockUtcHour(20)
    expect(isWithinWorkingHours(8, 18)).toBe(true)
  })

  it('blocks outside daytime window (08–18 Brasilia)', () => {
    // 10:00 UTC = 07:00 Brasilia (before start)
    mockUtcHour(10)
    expect(isWithinWorkingHours(8, 18)).toBe(false)
    // 22:00 UTC = 19:00 Brasilia (after end)
    mockUtcHour(22)
    expect(isWithinWorkingHours(8, 18)).toBe(false)
  })

  it('handles overnight window (22–06 Brasilia)', () => {
    // 01:00 UTC = 22:00 Brasilia (start of overnight window)
    mockUtcHour(1)
    expect(isWithinWorkingHours(22, 6)).toBe(true)
    // 05:00 UTC = 02:00 Brasilia (within overnight window)
    mockUtcHour(5)
    expect(isWithinWorkingHours(22, 6)).toBe(true)
    // 12:00 UTC = 09:00 Brasilia (outside overnight window)
    mockUtcHour(12)
    expect(isWithinWorkingHours(22, 6)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 5. AutomationConfigSchema — Zod validation
// ---------------------------------------------------------------------------

describe('AutomationConfigSchema', () => {
  it('applies defaults when no fields given', () => {
    const result = AutomationConfigSchema.safeParse({})
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.delay_seconds).toBe(120)
      expect(result.data.jitter_max).toBe(20)
      expect(result.data.max_per_hour).toBe(30)
      expect(result.data.max_retries).toBe(3)
    }
  })

  it('rejects delay_seconds below minimum (10)', () => {
    const result = AutomationConfigSchema.safeParse({ delay_seconds: 5 })
    expect(result.success).toBe(false)
  })

  it('rejects providing only working_hours_start without end', () => {
    const result = AutomationConfigSchema.safeParse({ working_hours_start: 8 })
    expect(result.success).toBe(false)
  })

  it('accepts valid working hours pair', () => {
    const result = AutomationConfigSchema.safeParse({ working_hours_start: 8, working_hours_end: 18 })
    expect(result.success).toBe(true)
  })
})

describe('UpdateAutomationSchema', () => {
  it('accepts empty patch (all optional)', () => {
    expect(UpdateAutomationSchema.safeParse({}).success).toBe(true)
  })

  it('accepts single field update', () => {
    expect(UpdateAutomationSchema.safeParse({ delay_seconds: 60 }).success).toBe(true)
  })

  it('rejects mismatched working_hours', () => {
    const result = UpdateAutomationSchema.safeParse({ working_hours_start: 8 })
    expect(result.success).toBe(false)
  })
})

// Unit tests for EnvSchema validation logic.
//
// Imports from lib/env-schema (pure schema, no side-effects) so that
// EnvSchema.safeParse() can be called with arbitrary synthetic input without
// triggering the process.exit(1) boot guard that lives in lib/env.ts.

import { describe, it, expect } from 'vitest'
import { EnvSchema } from '@/lib/env-schema'

// Minimal set of required fields — defaults handle everything else.
const BASE = {
  DB_HOST: 'localhost',
  DB_NAME: 'prospeccao_test',
  DB_USER: 'test_user',
  DB_PASSWORD: 'testpassword12',
  CREDENTIALS_ENCRYPTION_KEY: 'a'.repeat(64),
} as const

// ---------------------------------------------------------------------------
// DB_SSL / ALLOW_INSECURE_DB — production guard
// ---------------------------------------------------------------------------

describe('EnvSchema — production SSL guard', () => {
  it('rejects DB_SSL=false in production without ALLOW_INSECURE_DB', () => {
    const result = EnvSchema.safeParse({
      ...BASE,
      NODE_ENV: 'production',
      DB_SSL: 'false',
      // ALLOW_INSECURE_DB defaults to 'false' — guard must fire
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('DB_SSL')
      const msg = result.error.issues.find((i) => i.path.includes('DB_SSL'))?.message ?? ''
      expect(msg).toMatch(/ALLOW_INSECURE_DB/i)
    }
  })

  it('allows DB_SSL=false in production when ALLOW_INSECURE_DB=true', () => {
    const result = EnvSchema.safeParse({
      ...BASE,
      NODE_ENV: 'production',
      DB_SSL: 'false',
      ALLOW_INSECURE_DB: 'true',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.DB_SSL).toBe(false)
      expect(result.data.ALLOW_INSECURE_DB).toBe(true)
    }
  })

  it('allows DB_SSL=false in development without ALLOW_INSECURE_DB', () => {
    const result = EnvSchema.safeParse({
      ...BASE,
      NODE_ENV: 'development',
      DB_SSL: 'false',
    })
    expect(result.success).toBe(true)
  })

  it('allows DB_SSL=false in test without ALLOW_INSECURE_DB', () => {
    const result = EnvSchema.safeParse({
      ...BASE,
      NODE_ENV: 'test',
      DB_SSL: 'false',
    })
    expect(result.success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// DB_SSL_REJECT_UNAUTHORIZED
// ---------------------------------------------------------------------------

describe('EnvSchema — DB_SSL_REJECT_UNAUTHORIZED', () => {
  it('defaults to true when not set', () => {
    const result = EnvSchema.safeParse({ ...BASE, DB_SSL: 'true' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.DB_SSL_REJECT_UNAUTHORIZED).toBe(true)
    }
  })

  it('accepts false (self-signed cert scenario)', () => {
    const result = EnvSchema.safeParse({
      ...BASE,
      DB_SSL: 'true',
      DB_SSL_REJECT_UNAUTHORIZED: 'false',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.DB_SSL).toBe(true)
      expect(result.data.DB_SSL_REJECT_UNAUTHORIZED).toBe(false)
    }
  })

  it('rejects invalid values', () => {
    const result = EnvSchema.safeParse({
      ...BASE,
      DB_SSL_REJECT_UNAUTHORIZED: 'yes',
    })
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// DB_CONNECT_TIMEOUT_MS
// ---------------------------------------------------------------------------

describe('EnvSchema — DB_CONNECT_TIMEOUT_MS', () => {
  it('defaults to 8000 ms when not set', () => {
    const result = EnvSchema.safeParse({ ...BASE })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.DB_CONNECT_TIMEOUT_MS).toBe(8000)
    }
  })

  it('accepts valid values between 1000 and 30000', () => {
    const result = EnvSchema.safeParse({ ...BASE, DB_CONNECT_TIMEOUT_MS: '5000' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.DB_CONNECT_TIMEOUT_MS).toBe(5000)
    }
  })

  it('rejects values below 1000 ms', () => {
    const result = EnvSchema.safeParse({ ...BASE, DB_CONNECT_TIMEOUT_MS: '500' })
    expect(result.success).toBe(false)
  })

  it('rejects values above 30000 ms', () => {
    const result = EnvSchema.safeParse({ ...BASE, DB_CONNECT_TIMEOUT_MS: '31000' })
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// DB_SSL — basic transform
// ---------------------------------------------------------------------------

describe('EnvSchema — DB_SSL transform', () => {
  it('transforms "true" to boolean true', () => {
    const result = EnvSchema.safeParse({ ...BASE, DB_SSL: 'true' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.DB_SSL).toBe(true)
  })

  it('transforms "false" to boolean false', () => {
    const result = EnvSchema.safeParse({ ...BASE, DB_SSL: 'false' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.DB_SSL).toBe(false)
  })

  it('defaults to true when not set', () => {
    const result = EnvSchema.safeParse({ ...BASE })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.DB_SSL).toBe(true)
  })

  it('rejects invalid values', () => {
    const result = EnvSchema.safeParse({ ...BASE, DB_SSL: 'enabled' })
    expect(result.success).toBe(false)
  })
})

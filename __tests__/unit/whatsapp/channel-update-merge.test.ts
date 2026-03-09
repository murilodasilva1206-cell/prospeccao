// ---------------------------------------------------------------------------
// Unit tests for credential merge logic and getFullCredsSchema helper.
// No HTTP, no DB — pure Zod/logic tests.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest'
import { getFullCredsSchema } from '@/lib/schemas'

// ---------------------------------------------------------------------------
// Credential merge algorithm (mirrors the PATCH route handler logic)
// ---------------------------------------------------------------------------

function mergeCredentials(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing }
  for (const [k, v] of Object.entries(incoming)) {
    if (v !== '' && v !== undefined) {
      merged[k] = v
    }
  }
  return merged
}

// ---------------------------------------------------------------------------
// mergeCredentials
// ---------------------------------------------------------------------------

describe('mergeCredentials', () => {
  it('incoming value overwrites existing field', () => {
    const existing = { instance_url: 'https://old.com', api_key: 'old-key' }
    const incoming = { api_key: 'new-key' }
    const result = mergeCredentials(existing, incoming)
    expect(result.api_key).toBe('new-key')
    expect(result.instance_url).toBe('https://old.com')
  })

  it('blank string in incoming keeps existing value', () => {
    const existing = { api_key: 'keep-me', instance_url: 'https://evo.com' }
    const incoming = { api_key: '', instance_url: 'https://new.com' }
    const result = mergeCredentials(existing, incoming)
    expect(result.api_key).toBe('keep-me')
    expect(result.instance_url).toBe('https://new.com')
  })

  it('undefined in incoming keeps existing value', () => {
    const existing = { api_key: 'keep-me' }
    const incoming = { api_key: undefined }
    const result = mergeCredentials(existing, incoming)
    expect(result.api_key).toBe('keep-me')
  })

  it('new field in incoming is added to merged result', () => {
    const existing = { instance_url: 'https://evo.com', api_key: 'key' }
    const incoming = { waba_id: 'new-waba' }
    const result = mergeCredentials(existing, incoming)
    expect(result.waba_id).toBe('new-waba')
    expect(result.api_key).toBe('key')
  })

  it('existing field not present in incoming is preserved', () => {
    const existing = { access_token: 'tok', phone_number_id: 'pid', app_secret: 'secret' }
    const incoming = { access_token: 'new-tok' }
    const result = mergeCredentials(existing, incoming)
    expect(result.app_secret).toBe('secret')
    expect(result.phone_number_id).toBe('pid')
    expect(result.access_token).toBe('new-tok')
  })

  it('app_secret blank keeps existing value', () => {
    const existing = { access_token: 'tok', phone_number_id: 'pid', app_secret: 'old-secret' }
    const incoming = { app_secret: '' }
    const result = mergeCredentials(existing, incoming)
    expect(result.app_secret).toBe('old-secret')
  })

  it('app_secret non-blank overwrites existing value', () => {
    const existing = { access_token: 'tok', phone_number_id: 'pid', app_secret: 'old-secret' }
    const incoming = { app_secret: 'new-secret' }
    const result = mergeCredentials(existing, incoming)
    expect(result.app_secret).toBe('new-secret')
  })
})

// ---------------------------------------------------------------------------
// getFullCredsSchema
// ---------------------------------------------------------------------------

describe('getFullCredsSchema — UAZAPI', () => {
  const schema = getFullCredsSchema('UAZAPI')

  it('passes when all required fields present', () => {
    const result = schema.safeParse({
      instance_url: 'https://uaz.example.com',
      admin_token: 'adm-tok',
      instance_token: 'inst-tok',
    })
    expect(result.success).toBe(true)
  })

  it('fails when instance_token missing after merge', () => {
    const result = schema.safeParse({
      instance_url: 'https://uaz.example.com',
      admin_token: 'adm-tok',
    })
    expect(result.success).toBe(false)
    const paths = result.error!.issues.map((i) => i.path.join('.'))
    expect(paths.some((p) => p.includes('instance_token'))).toBe(true)
  })

  it('fails when admin_token missing after merge', () => {
    const result = schema.safeParse({
      instance_url: 'https://uaz.example.com',
      instance_token: 'inst-tok',
    })
    expect(result.success).toBe(false)
  })
})

describe('getFullCredsSchema — EVOLUTION', () => {
  const schema = getFullCredsSchema('EVOLUTION')

  it('passes when all required fields present', () => {
    const result = schema.safeParse({
      instance_url: 'https://evo.example.com',
      api_key: 'evo-key',
    })
    expect(result.success).toBe(true)
  })

  it('fails when api_key missing', () => {
    const result = schema.safeParse({ instance_url: 'https://evo.example.com' })
    expect(result.success).toBe(false)
  })
})

describe('getFullCredsSchema — META_CLOUD', () => {
  const schema = getFullCredsSchema('META_CLOUD')

  it('passes when all required fields present (with optional app_secret)', () => {
    const result = schema.safeParse({
      access_token: 'EAABtest',
      phone_number_id: '12345678',
      app_secret: 'secret',
    })
    expect(result.success).toBe(true)
  })

  it('passes without optional fields', () => {
    const result = schema.safeParse({
      access_token: 'EAABtest',
      phone_number_id: '12345678',
    })
    expect(result.success).toBe(true)
  })

  it('fails when phone_number_id missing', () => {
    const result = schema.safeParse({ access_token: 'EAABtest' })
    expect(result.success).toBe(false)
  })
})

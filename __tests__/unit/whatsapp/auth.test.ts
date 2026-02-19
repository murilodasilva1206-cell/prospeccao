import { describe, it, expect, vi, beforeEach } from 'vitest'
import { generateApiKey, hashApiKey, createApiKey, validateApiKey, revokeApiKey, listApiKeys } from '@/lib/whatsapp/auth'
import type { PoolClient } from 'pg'

// ---------------------------------------------------------------------------
// generateApiKey / hashApiKey
// ---------------------------------------------------------------------------

describe('generateApiKey', () => {
  it('returns a key with wk_ prefix', () => {
    const { rawKey } = generateApiKey()
    expect(rawKey).toMatch(/^wk_[0-9a-f]{64}$/)
  })

  it('returns different keys on each call', () => {
    const a = generateApiKey().rawKey
    const b = generateApiKey().rawKey
    expect(a).not.toBe(b)
  })

  it('keyHash is sha256 hex of rawKey', () => {
    const { rawKey, keyHash } = generateApiKey()
    expect(keyHash).toBe(hashApiKey(rawKey))
    expect(keyHash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('hashApiKey', () => {
  it('is deterministic', () => {
    const key = 'wk_abc123'
    expect(hashApiKey(key)).toBe(hashApiKey(key))
  })

  it('different inputs produce different hashes', () => {
    expect(hashApiKey('wk_aaaa')).not.toBe(hashApiKey('wk_bbbb'))
  })
})

// ---------------------------------------------------------------------------
// DB operations (mocked client)
// ---------------------------------------------------------------------------

function makeMockClient(queryResult: { rows: unknown[]; rowCount?: number } = { rows: [], rowCount: 0 }): PoolClient {
  return {
    query: vi.fn().mockResolvedValue(queryResult),
  } as unknown as PoolClient
}

describe('createApiKey', () => {
  it('inserts with hashed key and returns raw key once', async () => {
    const fakeRecord = {
      id: 'key-id-1',
      workspace_id: 'ws-1',
      key_hash: 'ignored-hash',
      label: 'Test key',
      created_by: null,
      revoked_at: null,
      last_used_at: null,
      created_at: new Date(),
    }
    const client = makeMockClient({ rows: [fakeRecord] })

    const { key, record } = await createApiKey(client, { workspace_id: 'ws-1', label: 'Test key' })

    expect(key).toMatch(/^wk_[0-9a-f]{64}$/)
    expect(record.id).toBe('key-id-1')
    // key_hash must NOT be exposed on record
    expect((record as unknown as Record<string, unknown>).key_hash).toBeUndefined()

    const queryMock = client.query as ReturnType<typeof vi.fn>
    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toContain('INSERT INTO workspace_api_keys')
    // params[0] = workspace_id, params[1] = key_hash (SHA-256 of raw key)
    expect(params[0]).toBe('ws-1')
    expect(params[1]).toBe(hashApiKey(key))
  })
})

describe('validateApiKey', () => {
  it('returns ValidatedKey when key is found and updates last_used_at', async () => {
    const { rawKey } = generateApiKey()
    const client = makeMockClient({
      rows: [{ id: 'key-id-1', workspace_id: 'ws-1', label: 'Production' }],
    })

    const result = await validateApiKey(client, rawKey)

    expect(result).toEqual({ workspace_id: 'ws-1', label: 'Production', key_id: 'key-id-1' })
    const queryMock = client.query as ReturnType<typeof vi.fn>
    expect(queryMock.mock.calls[0][0]).toContain('UPDATE workspace_api_keys')
    expect(queryMock.mock.calls[0][0]).toContain('last_used_at')
  })

  it('returns null when key is not found', async () => {
    const { rawKey } = generateApiKey()
    const client = makeMockClient({ rows: [] })
    const result = await validateApiKey(client, rawKey)
    expect(result).toBeNull()
  })
})

describe('revokeApiKey', () => {
  it('returns true when key is revoked', async () => {
    const client = makeMockClient({ rows: [], rowCount: 1 })
    const result = await revokeApiKey(client, 'key-id-1', 'ws-1')
    expect(result).toBe(true)
    // Verify workspace_id guard is included in the query
    expect((client.query as ReturnType<typeof vi.fn>).mock.calls[0][1]).toContain('ws-1')
  })

  it('returns false when key not found (or belongs to another workspace)', async () => {
    const client = makeMockClient({ rows: [], rowCount: 0 })
    const result = await revokeApiKey(client, 'nonexistent', 'ws-1')
    expect(result).toBe(false)
  })
})

describe('listApiKeys', () => {
  it('returns rows without key_hash', async () => {
    const rows = [
      { id: 'k1', workspace_id: 'ws-1', label: 'Prod', created_by: null, revoked_at: null, last_used_at: null, created_at: new Date() },
    ]
    const client = makeMockClient({ rows })
    const keys = await listApiKeys(client, 'ws-1')
    expect(keys).toHaveLength(1)
    expect(keys[0].id).toBe('k1')
    expect((keys[0] as unknown as Record<string, unknown>).key_hash).toBeUndefined()
  })
})

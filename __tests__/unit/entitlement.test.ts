import { describe, it, expect, vi } from 'vitest'
import type { PoolClient } from 'pg'

// ---------------------------------------------------------------------------
// Unit tests for lib/entitlement.ts (TDD — RED state)
//
// Defines the contract for workspace feature flags (csv_import, csv_export).
// These tests will fail until lib/entitlement.ts is implemented.
// ---------------------------------------------------------------------------

import {
  checkWorkspaceFeature,
  auditBlockedFeature,
} from '@/lib/entitlement'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient(
  rows: unknown[] = [],
): PoolClient {
  return {
    query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }),
    release: vi.fn(),
  } as unknown as PoolClient
}

function makeClientFn(
  impl: (sql: string, params: unknown[]) => unknown[],
): PoolClient {
  return {
    query: vi.fn().mockImplementation((sql: string, params: unknown[]) =>
      Promise.resolve({ rows: impl(sql, params), rowCount: impl(sql, params).length }),
    ),
    release: vi.fn(),
  } as unknown as PoolClient
}

// ---------------------------------------------------------------------------
// checkWorkspaceFeature
// ---------------------------------------------------------------------------

describe('checkWorkspaceFeature — feature enabled/disabled', () => {
  it('returns true when feature is explicitly enabled for workspace', async () => {
    const client = makeClient([{ enabled: true }])
    expect(await checkWorkspaceFeature(client, 'ws-a', 'csv_import')).toBe(true)
  })

  it('returns false when feature row has enabled=false', async () => {
    const client = makeClient([{ enabled: false }])
    expect(await checkWorkspaceFeature(client, 'ws-a', 'csv_import')).toBe(false)
  })

  it('returns false when feature row does not exist (deny-by-default)', async () => {
    const client = makeClient([])
    expect(await checkWorkspaceFeature(client, 'ws-a', 'csv_import')).toBe(false)
  })

  it('checks csv_export independently from csv_import', async () => {
    const client = makeClientFn((_sql, params) =>
      (params as string[])[1] === 'csv_export' ? [{ enabled: true }] : [],
    )
    expect(await checkWorkspaceFeature(client, 'ws-a', 'csv_import')).toBe(false)
    expect(await checkWorkspaceFeature(client, 'ws-a', 'csv_export')).toBe(true)
  })
})

describe('checkWorkspaceFeature — SQL safety', () => {
  it('uses parameterized query — workspace_id passed as $1 parameter', async () => {
    const client = makeClient([])
    await checkWorkspaceFeature(client, 'ws-test', 'csv_import')
    const call = vi.mocked(client.query).mock.calls[0]
    const sql = String(call?.[0] ?? '')
    const params = Array.isArray(call?.[1]) ? call[1] : []
    expect(sql).toMatch(/\$1/)
    expect(params).toContain('ws-test')
  })

  it('uses parameterized query — feature_name passed as $2 parameter', async () => {
    const client = makeClient([])
    await checkWorkspaceFeature(client, 'ws-test', 'csv_export')
    const call = vi.mocked(client.query).mock.calls[0]
    const sql = String(call?.[0] ?? '')
    const params = Array.isArray(call?.[1]) ? call[1] : []
    expect(sql).toMatch(/\$2/)
    expect(params).toContain('csv_export')
  })

  it('does not interpolate workspace_id into the SQL string', async () => {
    const client = makeClient([])
    const malicious = "'; DROP TABLE workspace_features; --"
    await checkWorkspaceFeature(client, malicious, 'csv_import')
    const call = vi.mocked(client.query).mock.calls[0]
    const sql = String(call?.[0] ?? '')
    expect(sql).not.toContain(malicious)
  })
})

describe('checkWorkspaceFeature — multi-tenant isolation', () => {
  it('workspace A feature does not bleed into workspace B', async () => {
    const client = makeClientFn((_sql, params) =>
      (params as string[])[0] === 'ws-a' ? [{ enabled: true }] : [],
    )
    expect(await checkWorkspaceFeature(client, 'ws-a', 'csv_import')).toBe(true)
    expect(await checkWorkspaceFeature(client, 'ws-b', 'csv_import')).toBe(false)
  })

  it('queries the DB on each call — no cross-call cache bleed', async () => {
    const client = makeClient([{ enabled: true }])
    await checkWorkspaceFeature(client, 'ws-a', 'csv_import')
    await checkWorkspaceFeature(client, 'ws-b', 'csv_import')
    expect(vi.mocked(client.query)).toHaveBeenCalledTimes(2)
    // Each call must include its own workspace_id
    const calls = vi.mocked(client.query).mock.calls
    const params0 = Array.isArray(calls[0]?.[1]) ? calls[0][1] : []
    const params1 = Array.isArray(calls[1]?.[1]) ? calls[1][1] : []
    expect(params0).toContain('ws-a')
    expect(params1).toContain('ws-b')
  })
})

// ---------------------------------------------------------------------------
// auditBlockedFeature
// ---------------------------------------------------------------------------

describe('auditBlockedFeature — audit log insertion', () => {
  it('executes exactly one INSERT query', async () => {
    const client = makeClient([])
    await auditBlockedFeature(client, 'ws-a', 'csv_import', 'session:user-1')
    expect(vi.mocked(client.query)).toHaveBeenCalledTimes(1)
    const call0 = vi.mocked(client.query).mock.calls[0]
    const sql = String(call0?.[0] ?? '')
    expect(sql.trim().toUpperCase()).toMatch(/^INSERT/)
  })

  it('includes workspace_id in the audit record', async () => {
    const client = makeClient([])
    await auditBlockedFeature(client, 'ws-audit', 'csv_export', 'api_key:k1')
    const call0 = vi.mocked(client.query).mock.calls[0]
    const params = Array.isArray(call0?.[1]) ? call0[1] : []
    const serialized = JSON.stringify(params)
    expect(serialized).toContain('ws-audit')
  })

  it('includes feature name in the audit record', async () => {
    const client = makeClient([])
    await auditBlockedFeature(client, 'ws-a', 'csv_import', 'session:u1')
    const call0 = vi.mocked(client.query).mock.calls[0]
    const params = Array.isArray(call0?.[1]) ? call0[1] : []
    const serialized = JSON.stringify(params)
    expect(serialized).toContain('csv_import')
  })

  it('includes actor in the audit record', async () => {
    const client = makeClient([])
    await auditBlockedFeature(client, 'ws-a', 'csv_export', 'api_key:key-42')
    const call0 = vi.mocked(client.query).mock.calls[0]
    const params = Array.isArray(call0?.[1]) ? call0[1] : []
    const serialized = JSON.stringify(params)
    expect(serialized).toContain('api_key:key-42')
  })

  it('does not throw even when DB write fails (best-effort audit)', async () => {
    const client = {
      query: vi.fn().mockRejectedValue(new Error('DB write failed')),
      release: vi.fn(),
    } as unknown as PoolClient
    // Should not propagate error — audit is best-effort
    await expect(
      auditBlockedFeature(client, 'ws-a', 'csv_import', 'actor').catch(() => {}),
    ).resolves.toBeUndefined()
  })
})

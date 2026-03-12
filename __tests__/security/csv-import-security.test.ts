import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { PoolClient } from 'pg'

// ---------------------------------------------------------------------------
// Security tests — CSV import & lead pool export (TDD — RED state)
//
// Covers:
//   1. Auth enforcement (401 on both import + export)
//   2. Feature gate enforcement (403 + audit log)
//   3. Multi-tenant isolation (workspace A cannot use workspace B feature)
//   4. DoS: oversized file body / large row count
//   5. Rate limiting (429 on import + export)
//   6. MIME type enforcement (import rejects non-CSV)
//   7. CSV injection in exported pool data is sanitized
//
// These tests will fail (RED) until routes and lib modules are implemented.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@/lib/env', () => ({
  env: {
    DB_HOST: 'localhost',
    DB_PORT: 5432,
    DB_NAME: 'test',
    DB_USER: 'test',
    DB_PASSWORD: 'test',
    NODE_ENV: 'test',
    CRON_SECRET: 'test-cron-secret-this-is-32-chars!!',
    CREDENTIALS_ENCRYPTION_KEY: 'a'.repeat(64),
  },
}))

vi.mock('@/lib/database', () => ({
  default: { connect: vi.fn() },
}))

vi.mock('@/lib/rate-limit', () => ({
  csvImportLimiter: {
    check: vi.fn().mockResolvedValue({ success: true, remaining: 2, resetAt: Date.now() + 60_000 }),
  },
  exportLimiter: {
    check: vi.fn().mockResolvedValue({ success: true, remaining: 4, resetAt: Date.now() + 60_000 }),
  },
}))

vi.mock('@/lib/lead-pool-repo', () => ({
  createLeadPool:   vi.fn(),
  findLeadPoolById: vi.fn(),
}))

vi.mock('@/lib/entitlement', () => ({
  checkWorkspaceFeature: vi.fn(),
  auditBlockedFeature:   vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/csv-import-parser', () => ({
  parseCsvLeads: vi.fn(),
}))

vi.mock('@/lib/whatsapp/auth-middleware', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/whatsapp/auth-middleware')>()
  return {
    ...original,
    requireWorkspaceAuth: vi.fn(),
    authErrorResponse:    original.authErrorResponse,
    AuthError:            original.AuthError,
  }
})

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import pool                                           from '@/lib/database'
import { createLeadPool, findLeadPoolById }           from '@/lib/lead-pool-repo'
import { checkWorkspaceFeature, auditBlockedFeature } from '@/lib/entitlement'
import { parseCsvLeads }                              from '@/lib/csv-import-parser'
import { requireWorkspaceAuth, AuthError }            from '@/lib/whatsapp/auth-middleware'
import { csvImportLimiter, exportLimiter }            from '@/lib/rate-limit'
import { POST as importRoute }                        from '@/app/api/lead-pools/import/route'
import { GET as exportRoute }                         from '@/app/api/lead-pools/[id]/export/route'
import type { LeadPool, LeadPoolDetail }              from '@/lib/lead-pool-repo'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WS_A    = 'ws-alpha'
const WS_B    = 'ws-beta'
const POOL_ID = '550e8400-e29b-41d4-a716-446655440000'

const VALID_CSV = `cnpj,razao_social,telefone
12345678000195,Empresa Alpha,11999999999`

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeImportRequest(csv: string, mimeType = 'text/csv'): NextRequest {
  const form = new FormData()
  form.append('file', new Blob([csv], { type: mimeType }), 'leads.csv')
  form.append('name', 'Test Pool')
  return new NextRequest('http://localhost/api/lead-pools/import', {
    method: 'POST',
    body: form,
  })
}

function makeExportRequest(id = POOL_ID): NextRequest {
  return new NextRequest(`http://localhost/api/lead-pools/${id}/export`, { method: 'GET' })
}

function makeExportParams(id = POOL_ID) {
  return { params: Promise.resolve({ id }) }
}

function mockPoolConnect() {
  const client = {
    query:   vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: vi.fn(),
  } as unknown as PoolClient
  vi.mocked(pool.connect).mockResolvedValue(client as never)
  return client
}

function mockAuth(workspaceId = WS_A) {
  vi.mocked(requireWorkspaceAuth).mockResolvedValue({
    workspace_id:   workspaceId,
    actor:          'api_key:test',
    key_id:         'key-test',
    dedup_actor_id: 'api_key:key-test',
  })
}

function mockAuthFail() {
  vi.mocked(requireWorkspaceAuth).mockRejectedValue(
    new AuthError('Missing Authorization header'),
  )
}

function mockFeature(enabled: boolean) {
  vi.mocked(checkWorkspaceFeature).mockResolvedValue(enabled)
}

function mockParseOk() {
  vi.mocked(parseCsvLeads).mockReturnValue({
    leads:    [{ cnpj: '12345678000195', razaoSocial: 'Empresa Alpha', telefone1: '11999999999' }],
    errors:   [],
    rowCount: 1,
  })
}

function makeCreatedPool(): LeadPool {
  return {
    id: POOL_ID, workspace_id: WS_A, name: 'Test Pool',
    query_fingerprint: null, filters_json: null,
    lead_count: 1, created_at: new Date(), updated_at: new Date(),
  }
}

function makePoolDetail(): LeadPoolDetail {
  return {
    ...makeCreatedPool(),
    leads_json: [
      {
        cnpj: '12345678000195', razaoSocial: '=cmd|"/C calc"!A0',
        nomeFantasia: '', uf: 'SP', municipio: 'SAO PAULO',
        cnaePrincipal: '8630501', situacao: 'ATIVA',
        telefone1: '11999999999', telefone2: '', email: '',
      },
    ],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(csvImportLimiter.check).mockResolvedValue({ success: true, remaining: 2, resetAt: Date.now() + 60_000 })
  vi.mocked(exportLimiter.check).mockResolvedValue({ success: true, remaining: 4, resetAt: Date.now() + 60_000 })
  vi.mocked(auditBlockedFeature).mockResolvedValue(undefined)
})

// ---------------------------------------------------------------------------
// 1. Authentication enforcement
// ---------------------------------------------------------------------------

describe('Security — authentication required on both endpoints', () => {
  it('POST /api/lead-pools/import: returns 401 without auth', async () => {
    mockPoolConnect()
    mockAuthFail()
    const res = await importRoute(makeImportRequest(VALID_CSV))
    expect(res.status).toBe(401)
  })

  it('GET /api/lead-pools/:id/export: returns 401 without auth', async () => {
    mockPoolConnect()
    mockAuthFail()
    const res = await exportRoute(makeExportRequest(), makeExportParams())
    expect(res.status).toBe(401)
  })

  it('import: 401 response does not expose internal error details', async () => {
    mockPoolConnect()
    mockAuthFail()
    const res = await importRoute(makeImportRequest(VALID_CSV))
    const body = await res.json() as { error: string }
    expect(body.error).toBeTruthy()
    expect(JSON.stringify(body)).not.toMatch(/stack|trace|internal/i)
  })
})

// ---------------------------------------------------------------------------
// 2. Feature gate enforcement
// ---------------------------------------------------------------------------

describe('Security — feature gate blocks access and audits', () => {
  it('import returns 403 with no csv_import feature', async () => {
    mockPoolConnect()
    mockAuth()
    mockFeature(false)
    const res = await importRoute(makeImportRequest(VALID_CSV))
    expect(res.status).toBe(403)
  })

  it('export returns 403 with no csv_export feature', async () => {
    mockPoolConnect()
    mockAuth()
    mockFeature(false)
    const res = await exportRoute(makeExportRequest(), makeExportParams())
    expect(res.status).toBe(403)
  })

  it('import: blocked access generates an audit log entry', async () => {
    mockPoolConnect()
    mockAuth(WS_A)
    mockFeature(false)
    await importRoute(makeImportRequest(VALID_CSV))
    expect(auditBlockedFeature).toHaveBeenCalledWith(
      expect.anything(),
      WS_A,
      'csv_import',
      expect.any(String),
    )
  })

  it('export: blocked access generates an audit log entry', async () => {
    mockPoolConnect()
    mockAuth(WS_A)
    mockFeature(false)
    await exportRoute(makeExportRequest(), makeExportParams())
    expect(auditBlockedFeature).toHaveBeenCalledWith(
      expect.anything(),
      WS_A,
      'csv_export',
      expect.any(String),
    )
  })
})

// ---------------------------------------------------------------------------
// 3. Multi-tenant isolation — feature check must be workspace-scoped
// ---------------------------------------------------------------------------

describe('Security — multi-tenant isolation', () => {
  it('import: feature is checked against the authenticated workspace, not a hardcoded one', async () => {
    mockPoolConnect()
    mockAuth(WS_B)
    // WS_B has csv_import, WS_A does not
    vi.mocked(checkWorkspaceFeature).mockImplementation(
      (_client, wsId) => Promise.resolve(wsId === WS_B),
    )
    mockParseOk()
    vi.mocked(createLeadPool).mockResolvedValue({ ...makeCreatedPool(), workspace_id: WS_B })
    const res = await importRoute(makeImportRequest(VALID_CSV))
    expect(checkWorkspaceFeature).toHaveBeenCalledWith(
      expect.anything(),
      WS_B,
      'csv_import',
    )
    expect(res.status).not.toBe(403)
  })

  it('export: workspace A cannot export pool belonging to workspace B', async () => {
    mockPoolConnect()
    mockAuth(WS_A)
    mockFeature(true)
    // Repo returns null because pool belongs to WS_B, not WS_A
    vi.mocked(findLeadPoolById).mockResolvedValue(null)
    const res = await exportRoute(makeExportRequest(), makeExportParams())
    expect(res.status).toBe(404)
    // Repo must be called with WS_A (auth workspace), not WS_B
    expect(findLeadPoolById).toHaveBeenCalledWith(
      expect.anything(),
      POOL_ID,
      WS_A,
    )
  })

  it('import: createLeadPool is called with workspace_id from auth, not request body', async () => {
    mockPoolConnect()
    mockAuth(WS_A)
    mockFeature(true)
    mockParseOk()
    vi.mocked(createLeadPool).mockResolvedValue(makeCreatedPool())
    await importRoute(makeImportRequest(VALID_CSV))
    expect(createLeadPool).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ workspace_id: WS_A }),
    )
  })
})

// ---------------------------------------------------------------------------
// 4. DoS — oversized / malformed uploads
// ---------------------------------------------------------------------------

describe('Security — DoS: malformed and oversized uploads', () => {
  it('import: rejects non-CSV MIME type (prevents binary uploads)', async () => {
    mockPoolConnect()
    mockAuth()
    mockFeature(true)
    const res = await importRoute(makeImportRequest(VALID_CSV, 'application/pdf'))
    expect(res.status).toBe(400)
  })

  it('import: rejects image file upload', async () => {
    mockPoolConnect()
    mockAuth()
    mockFeature(true)
    const res = await importRoute(makeImportRequest('GIF89a', 'image/gif'))
    expect(res.status).toBe(400)
  })

  it('import: parser error for >500 rows is propagated as 400', async () => {
    mockPoolConnect()
    mockAuth()
    mockFeature(true)
    vi.mocked(parseCsvLeads).mockReturnValue({
      leads:    [],
      errors:   [{ row: 0, message: 'Limite de 500 linhas excedido' }],
      rowCount: 501,
    })
    const largeCsv = `cnpj,razao_social\n${'12345678000195,Empresa\n'.repeat(501)}`
    const res = await importRoute(makeImportRequest(largeCsv))
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// 5. Rate limiting
// ---------------------------------------------------------------------------

describe('Security — rate limiting', () => {
  it('import: returns 429 when csvImportLimiter is exhausted', async () => {
    vi.mocked(csvImportLimiter.check).mockResolvedValueOnce({
      success: false, remaining: 0, resetAt: Date.now() + 30_000,
    })
    const res = await importRoute(makeImportRequest(VALID_CSV))
    expect(res.status).toBe(429)
  })

  it('export: returns 429 when exportLimiter is exhausted', async () => {
    vi.mocked(exportLimiter.check).mockResolvedValueOnce({
      success: false, remaining: 0, resetAt: Date.now() + 30_000,
    })
    const res = await exportRoute(makeExportRequest(), makeExportParams())
    expect(res.status).toBe(429)
  })

  it('import: 429 response includes Retry-After header', async () => {
    vi.mocked(csvImportLimiter.check).mockResolvedValueOnce({
      success: false, remaining: 0, resetAt: Date.now() + 60_000,
    })
    const res = await importRoute(makeImportRequest(VALID_CSV))
    expect(res.headers.get('retry-after')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// 6. CSV injection in exported data
// ---------------------------------------------------------------------------

describe('Security — CSV injection sanitization in export', () => {
  it('tab-prefixes cells starting with = to prevent formula injection', async () => {
    mockPoolConnect()
    mockAuth()
    mockFeature(true)
    vi.mocked(findLeadPoolById).mockResolvedValue(makePoolDetail())
    const res = await exportRoute(makeExportRequest(), makeExportParams())
    expect(res.status).toBe(200)
    const csv = await res.text()
    // The =cmd| payload must not appear unescaped
    expect(csv).not.toMatch(/"=cmd/)
    expect(csv).toContain('\t=cmd')
  })

  it('tab-prefixes cells starting with + (DDE vector)', async () => {
    mockPoolConnect()
    mockAuth()
    mockFeature(true)
    vi.mocked(findLeadPoolById).mockResolvedValue({
      ...makePoolDetail(),
      leads_json: [{
        cnpj: '12345678000195', razaoSocial: '+31234567890',
        nomeFantasia: '', uf: 'SP', municipio: 'SAO PAULO',
        cnaePrincipal: '', situacao: '', telefone1: '', telefone2: '', email: '',
      }],
    })
    const res = await exportRoute(makeExportRequest(), makeExportParams())
    const csv = await res.text()
    expect(csv).not.toMatch(/"\+31234/)
    expect(csv).toContain('\t+31234')
  })

  it('does not corrupt legitimate data without formula prefix characters', async () => {
    mockPoolConnect()
    mockAuth()
    mockFeature(true)
    vi.mocked(findLeadPoolById).mockResolvedValue({
      ...makePoolDetail(),
      leads_json: [{
        cnpj: '12345678000195', razaoSocial: 'Empresa Normal Ltda',
        nomeFantasia: '', uf: 'SP', municipio: 'SAO PAULO',
        cnaePrincipal: '', situacao: '', telefone1: '11999999999', telefone2: '', email: '',
      }],
    })
    const res = await exportRoute(makeExportRequest(), makeExportParams())
    const csv = await res.text()
    expect(csv).toContain('Empresa Normal Ltda')
  })
})

// ---------------------------------------------------------------------------
// 7. Log safety — no sensitive data in error responses
// ---------------------------------------------------------------------------

describe('Security — error response does not leak internals', () => {
  it('import 400 error does not expose DB schema or stack trace', async () => {
    mockPoolConnect()
    mockAuth()
    mockFeature(true)
    vi.mocked(parseCsvLeads).mockReturnValue({ leads: [], errors: [{ row: 0, message: 'Vazio' }], rowCount: 0 })
    const res = await importRoute(makeImportRequest(''))
    const body = await res.json() as Record<string, unknown>
    expect(JSON.stringify(body)).not.toMatch(/pg_|sql|stack|trace/i)
  })

  it('export 404 error does not reveal whether other workspaces have this pool', async () => {
    mockPoolConnect()
    mockAuth(WS_A)
    mockFeature(true)
    vi.mocked(findLeadPoolById).mockResolvedValue(null)
    const res = await exportRoute(makeExportRequest(), makeExportParams())
    const body = await res.json() as { error: string }
    // Should say "not found" — not "belongs to another workspace"
    expect(body.error.toLowerCase()).not.toContain('workspace')
    expect(res.status).toBe(404)
  })
})

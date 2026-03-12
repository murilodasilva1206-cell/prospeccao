import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { PoolClient } from 'pg'
import type { LeadPool } from '@/lib/lead-pool-repo'

// ---------------------------------------------------------------------------
// Unit tests for POST /api/lead-pools/import (TDD — RED state)
//
// Tests the CSV import route handler.
// Will fail until app/api/lead-pools/import/route.ts is implemented.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Mocks — declared before imports
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
}))

vi.mock('@/lib/lead-pool-repo', () => ({
  createLeadPool: vi.fn(),
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
// Imports (after mocks)
// ---------------------------------------------------------------------------

import pool                                           from '@/lib/database'
import { createLeadPool }                             from '@/lib/lead-pool-repo'
import { checkWorkspaceFeature, auditBlockedFeature } from '@/lib/entitlement'
import { parseCsvLeads }                              from '@/lib/csv-import-parser'
import { requireWorkspaceAuth, AuthError }            from '@/lib/whatsapp/auth-middleware'
import { csvImportLimiter }                           from '@/lib/rate-limit'
import { POST as importRoute }                        from '@/app/api/lead-pools/import/route'

// ---------------------------------------------------------------------------
// Constants & fixtures
// ---------------------------------------------------------------------------

const WS_TEST  = 'ws-test'
const WS_OTHER = 'ws-other'
const POOL_ID  = '550e8400-e29b-41d4-a716-446655440000'

const VALID_CSV = `cnpj,razao_social,uf,municipio,telefone
12345678000195,Empresa Alpha,SP,SAO PAULO,11999999999
98765432000100,Empresa Beta,RJ,RIO DE JANEIRO,21888888888`

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

function makeImportRequest(
  csvContent: string,
  name = 'Test Pool',
  mimeType = 'text/csv',
): NextRequest {
  const form = new FormData()
  form.append('file', new Blob([csvContent], { type: mimeType }), 'leads.csv')
  form.append('name', name)
  return new NextRequest('http://localhost/api/lead-pools/import', {
    method: 'POST',
    body: form,
  })
}

function mockPoolConnect() {
  const client = {
    query:   vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: vi.fn(),
  } as unknown as PoolClient
  vi.mocked(pool.connect).mockResolvedValue(client as never)
  return client
}

function mockAuth(workspaceId = WS_TEST) {
  vi.mocked(requireWorkspaceAuth).mockResolvedValue({
    workspace_id:   workspaceId,
    actor:          'api_key:test',
    key_id:         'key-test',
    dedup_actor_id: 'api_key:key-test',
  })
}

function mockAuthFail() {
  vi.mocked(requireWorkspaceAuth).mockRejectedValue(
    new AuthError('Invalid or revoked API key'),
  )
}

function mockFeature(enabled: boolean) {
  vi.mocked(checkWorkspaceFeature).mockResolvedValue(enabled)
}

function mockParseOk(count = 2) {
  const leads = Array.from({ length: count }, (_, i) => ({
    cnpj:        String(i).padStart(14, '0'),
    razaoSocial: `Empresa ${i}`,
    telefone1:   `119999${String(i).padStart(5, '0')}`,
  }))
  vi.mocked(parseCsvLeads).mockReturnValue({ leads, errors: [], rowCount: count })
  return leads
}

function mockParseEmpty() {
  vi.mocked(parseCsvLeads).mockReturnValue({
    leads:    [],
    errors:   [{ row: 0, message: 'Arquivo vazio' }],
    rowCount: 0,
  })
}

function makeCreatedPool(leadCount: number, workspaceId = WS_TEST): LeadPool {
  return {
    id:                POOL_ID,
    workspace_id:      workspaceId,
    name:              'Test Pool',
    query_fingerprint: null,
    filters_json:      null,
    lead_count:        leadCount,
    created_at:        new Date(),
    updated_at:        new Date(),
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(csvImportLimiter.check).mockResolvedValue({
    success:   true,
    remaining: 2,
    resetAt:   Date.now() + 60_000,
  })
  vi.mocked(auditBlockedFeature).mockResolvedValue(undefined)
})

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

describe('POST /api/lead-pools/import — authentication', () => {
  it('returns 401 when no auth is provided', async () => {
    mockPoolConnect()
    mockAuthFail()
    const res = await importRoute(makeImportRequest(VALID_CSV))
    expect(res.status).toBe(401)
  })

  it('proceeds past auth when authenticated', async () => {
    mockPoolConnect()
    mockAuth()
    mockFeature(true)
    mockParseOk()
    vi.mocked(createLeadPool).mockResolvedValue(makeCreatedPool(2))
    const res = await importRoute(makeImportRequest(VALID_CSV))
    expect(res.status).not.toBe(401)
  })
})

// ---------------------------------------------------------------------------
// Feature gate — csv_import
// ---------------------------------------------------------------------------

describe('POST /api/lead-pools/import — feature gate (csv_import)', () => {
  it('returns 403 when workspace lacks csv_import feature', async () => {
    mockPoolConnect()
    mockAuth()
    mockFeature(false)
    const res = await importRoute(makeImportRequest(VALID_CSV))
    expect(res.status).toBe(403)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/plano|feature|permissão|plan/i)
  })

  it('records audit log when csv_import is blocked', async () => {
    mockPoolConnect()
    mockAuth()
    mockFeature(false)
    await importRoute(makeImportRequest(VALID_CSV))
    expect(auditBlockedFeature).toHaveBeenCalledWith(
      expect.anything(),
      WS_TEST,
      'csv_import',
      expect.any(String),
    )
  })

  it('workspace A being blocked does not affect workspace B', async () => {
    mockPoolConnect()
    mockAuth(WS_OTHER)
    // Even if WS_OTHER has the feature, the check is workspace-scoped
    vi.mocked(checkWorkspaceFeature).mockImplementation(
      (_client, workspaceId) => Promise.resolve(workspaceId === WS_OTHER),
    )
    mockParseOk()
    vi.mocked(createLeadPool).mockResolvedValue(makeCreatedPool(2, WS_OTHER))
    const res = await importRoute(makeImportRequest(VALID_CSV))
    expect(res.status).not.toBe(403)
    // feature was checked with the auth workspace, not a hardcoded one
    expect(checkWorkspaceFeature).toHaveBeenCalledWith(
      expect.anything(),
      WS_OTHER,
      'csv_import',
    )
  })
})

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('POST /api/lead-pools/import — input validation', () => {
  it('returns 400 when parser returns no leads (empty or invalid file)', async () => {
    mockPoolConnect()
    mockAuth()
    mockFeature(true)
    mockParseEmpty()
    const res = await importRoute(makeImportRequest(''))
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toBeTruthy()
  })

  it('returns 400 when file MIME type is not text/csv or application/octet-stream', async () => {
    mockPoolConnect()
    mockAuth()
    mockFeature(true)
    const res = await importRoute(makeImportRequest(VALID_CSV, 'Test Pool', 'application/pdf'))
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/csv|formato|tipo/i)
  })

  it('returns 400 when parser returns only errors (no valid leads parsed)', async () => {
    mockPoolConnect()
    mockAuth()
    mockFeature(true)
    vi.mocked(parseCsvLeads).mockReturnValue({
      leads:    [],
      errors:   [{ row: 1, message: 'Coluna obrigatoria ausente' }],
      rowCount: 1,
    })
    const res = await importRoute(makeImportRequest('foo,bar\n1,2'))
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string; details?: unknown[] }
    expect(body.error).toBeTruthy()
  })

  it('rejects when file is missing from form data (no "file" field)', async () => {
    mockPoolConnect()
    mockAuth()
    mockFeature(true)
    const form = new FormData()
    form.append('name', 'Test Pool')  // no file
    const req = new NextRequest('http://localhost/api/lead-pools/import', {
      method: 'POST',
      body: form,
    })
    const res = await importRoute(req)
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Successful import
// ---------------------------------------------------------------------------

describe('POST /api/lead-pools/import — successful import', () => {
  it('returns 201 with created pool and import meta', async () => {
    mockPoolConnect()
    mockAuth()
    mockFeature(true)
    mockParseOk(2)
    vi.mocked(createLeadPool).mockResolvedValue(makeCreatedPool(2))
    const res = await importRoute(makeImportRequest(VALID_CSV, 'Minha Lista'))
    expect(res.status).toBe(201)
    const body = await res.json() as { data: LeadPool; meta: { imported: number; errors: number } }
    expect(body.data.id).toBe(POOL_ID)
    expect(body.meta.imported).toBe(2)
    expect(body.meta.errors).toBe(0)
  })

  it('workspace_id comes from auth token, never from the form body', async () => {
    mockPoolConnect()
    mockAuth(WS_TEST)
    mockFeature(true)
    mockParseOk(1)
    vi.mocked(createLeadPool).mockResolvedValue(makeCreatedPool(1))
    await importRoute(makeImportRequest(VALID_CSV))
    expect(createLeadPool).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ workspace_id: WS_TEST }),
    )
  })

  it('uses the "name" form field as the pool name', async () => {
    mockPoolConnect()
    mockAuth()
    mockFeature(true)
    mockParseOk(1)
    vi.mocked(createLeadPool).mockResolvedValue(makeCreatedPool(1))
    await importRoute(makeImportRequest(VALID_CSV, 'Lista de Médicos SP'))
    expect(createLeadPool).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: 'Lista de Médicos SP' }),
    )
  })

  it('includes error_details in meta when some rows had parse errors (partial import)', async () => {
    mockPoolConnect()
    mockAuth()
    mockFeature(true)
    vi.mocked(parseCsvLeads).mockReturnValue({
      leads:    [{ cnpj: '12345678000195', razaoSocial: 'Empresa Alpha' }],
      errors:   [{ row: 2, message: 'CNPJ inválido na linha 2' }],
      rowCount: 2,
    })
    vi.mocked(createLeadPool).mockResolvedValue(makeCreatedPool(1))
    const res = await importRoute(makeImportRequest(VALID_CSV))
    expect(res.status).toBe(201)
    const body = await res.json() as {
      meta: { imported: number; errors: number; error_details: unknown[] }
    }
    expect(body.meta.imported).toBe(1)
    expect(body.meta.errors).toBe(1)
    expect(Array.isArray(body.meta.error_details)).toBe(true)
  })

  it('calls createLeadPool with leads from parser output', async () => {
    mockPoolConnect()
    mockAuth()
    mockFeature(true)
    const leads = mockParseOk(2)
    vi.mocked(createLeadPool).mockResolvedValue(makeCreatedPool(2))
    await importRoute(makeImportRequest(VALID_CSV))
    expect(createLeadPool).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ leads }),
    )
  })
})

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe('POST /api/lead-pools/import — rate limiting', () => {
  it('returns 429 when rate limit is exceeded', async () => {
    vi.mocked(csvImportLimiter.check).mockResolvedValueOnce({
      success:   false,
      remaining: 0,
      resetAt:   Date.now() + 30_000,
    })
    const res = await importRoute(makeImportRequest(VALID_CSV))
    expect(res.status).toBe(429)
    const body = await res.json() as { error: string }
    expect(body.error).toBeTruthy()
  })

  it('returns Retry-After header when rate-limited', async () => {
    vi.mocked(csvImportLimiter.check).mockResolvedValueOnce({
      success:   false,
      remaining: 0,
      resetAt:   Date.now() + 30_000,
    })
    const res = await importRoute(makeImportRequest(VALID_CSV))
    expect(res.headers.get('retry-after')).toBeTruthy()
  })
})

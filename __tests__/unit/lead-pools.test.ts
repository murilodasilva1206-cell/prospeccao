import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { PoolClient } from 'pg'
import type { LeadPool, LeadPoolDetail } from '@/lib/lead-pool-repo'

// ---------------------------------------------------------------------------
// Unit tests for lead-pools API routes:
//   - GET  /api/lead-pools          (list)
//   - POST /api/lead-pools          (create)
//   - GET  /api/lead-pools/:id      (detail)
//   - DELETE /api/lead-pools/:id    (delete)
//
// All DB interactions are mocked — no real PostgreSQL connection required.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Mocks — must be declared before any import of the routes under test
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
  campaignLimiter: {
    check: vi.fn().mockResolvedValue({ success: true, remaining: 19, resetAt: Date.now() + 60_000 }),
  },
}))

vi.mock('@/lib/lead-pool-repo', () => ({
  createLeadPool:            vi.fn(),
  findLeadPoolsByWorkspace:  vi.fn(),
  countLeadPools:            vi.fn(),
  findLeadPoolById:          vi.fn(),
  deleteLeadPool:            vi.fn(),
}))

vi.mock('@/lib/whatsapp/auth-middleware', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/whatsapp/auth-middleware')>()
  return {
    ...original,
    requireWorkspaceAuth: vi.fn(),
    authErrorResponse: original.authErrorResponse,
    AuthError: original.AuthError,
  }
})

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import pool from '@/lib/database'
import {
  createLeadPool,
  findLeadPoolsByWorkspace,
  countLeadPools,
  findLeadPoolById,
  deleteLeadPool,
} from '@/lib/lead-pool-repo'
import { requireWorkspaceAuth, AuthError } from '@/lib/whatsapp/auth-middleware'
import { campaignLimiter } from '@/lib/rate-limit'
import { GET as listRoute, POST as createRoute } from '@/app/api/lead-pools/route'
import { GET as detailRoute, DELETE as deleteRoute } from '@/app/api/lead-pools/[id]/route'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POOL_ID   = '550e8400-e29b-41d4-a716-446655440000'
const OTHER_ID  = '660e8400-e29b-41d4-a716-446655440001'
const WS_TEST   = 'ws-test'
const WS_OTHER  = 'ws-other'

// ---------------------------------------------------------------------------
// Fixture factories
// ---------------------------------------------------------------------------

function makeLeadPool(overrides: Partial<LeadPool> = {}): LeadPool {
  return {
    id:                POOL_ID,
    workspace_id:      WS_TEST,
    name:              'Pool de Dentistas SP',
    query_fingerprint: null,
    filters_json:      null,
    lead_count:        3,
    created_at:        new Date('2025-01-01T00:00:00Z'),
    updated_at:        new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  }
}

function makeLeadPoolDetail(overrides: Partial<LeadPoolDetail> = {}): LeadPoolDetail {
  return {
    ...makeLeadPool(),
    leads_json: [
      {
        cnpj:        '12345678000195',
        razaoSocial: 'Empresa Alpha Ltda',
        nomeFantasia: '',
        uf:          'SP',
        municipio:   'SAO PAULO',
        cnaePrincipal: '8630501',
        situacao:    'ATIVA',
        telefone1:   '11999999999',
        telefone2:   '',
        email:       '',
      },
    ],
    ...overrides,
  }
}

function makeSampleLeads() {
  return [
    {
      cnpj:          '12345678000195',
      razaoSocial:   'Empresa Alpha Ltda',
      nomeFantasia:  null,
      uf:            'SP',
      municipio:     'SAO PAULO',
      cnaePrincipal: '8630501',
    },
    {
      cnpj:          '98765432000100',
      razaoSocial:   'Empresa Beta Ltda',
      nomeFantasia:  'Beta',
      uf:            'SP',
      municipio:     'CAMPINAS',
      cnaePrincipal: '8630501',
    },
  ]
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

function makeListRequest(params = ''): NextRequest {
  return new NextRequest(
    `http://localhost/api/lead-pools${params ? `?${params}` : ''}`,
    { method: 'GET', headers: { 'Content-Type': 'application/json' } },
  )
}

function makeCreateRequest(body: unknown, auth?: string): NextRequest {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (auth) headers['Authorization'] = auth
  return new NextRequest('http://localhost/api/lead-pools', {
    method:  'POST',
    headers,
    body:    JSON.stringify(body),
  })
}

function makeDetailRequest(id: string, method: 'GET' | 'DELETE' = 'GET'): NextRequest {
  return new NextRequest(
    `http://localhost/api/lead-pools/${id}`,
    { method, headers: { 'Content-Type': 'application/json' } },
  )
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) }
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function mockAuth(workspaceId = WS_TEST, keyId = 'key-test') {
  vi.mocked(requireWorkspaceAuth).mockResolvedValue({
    workspace_id:   workspaceId,
    actor:          'api_key:test',
    key_id:         keyId,
    dedup_actor_id: `api_key:${keyId}`,
  })
}

function mockAuthFail() {
  vi.mocked(requireWorkspaceAuth).mockRejectedValue(new AuthError('Invalid or revoked API key'))
}

// ---------------------------------------------------------------------------
// Pool connect helper
// ---------------------------------------------------------------------------

function mockPoolConnect(queryFn = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })) {
  const client = { query: queryFn, release: vi.fn() } as unknown as PoolClient
  vi.mocked(pool.connect).mockResolvedValue(client as never)
  return client
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  // Restore default rate-limit behaviour
  vi.mocked(campaignLimiter.check).mockResolvedValue({
    success:   true,
    remaining: 19,
    resetAt:   Date.now() + 60_000,
  })
})

// ---------------------------------------------------------------------------
// POST /api/lead-pools — create
// ---------------------------------------------------------------------------

describe('POST /api/lead-pools', () => {
  describe('authentication', () => {
    it('returns 401 when no auth', async () => {
      mockPoolConnect()
      mockAuthFail()
      const req = makeCreateRequest({ name: 'Test Pool', leads: makeSampleLeads() })
      const res = await createRoute(req)
      expect(res.status).toBe(401)
    })
  })

  describe('input validation', () => {
    it('returns 400 when name is empty string', async () => {
      mockPoolConnect()
      mockAuth()
      const req = makeCreateRequest({ name: '', leads: makeSampleLeads() })
      const res = await createRoute(req)
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('Parametros invalidos')
    })

    it('returns 400 when leads array is empty', async () => {
      mockPoolConnect()
      mockAuth()
      const req = makeCreateRequest({ name: 'Test Pool', leads: [] })
      const res = await createRoute(req)
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('Parametros invalidos')
    })

    it('returns 400 when leads array exceeds 500 items', async () => {
      mockPoolConnect()
      mockAuth()
      const leads = Array.from({ length: 501 }, (_, i) => ({
        cnpj:          String(i).padStart(14, '0'),
        razaoSocial:   `Empresa ${i}`,
        nomeFantasia:  null,
        uf:            'SP',
        municipio:     'SAO PAULO',
        cnaePrincipal: '8630501',
      }))
      const req = makeCreateRequest({ name: 'Too Many Leads', leads })
      const res = await createRoute(req)
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('Parametros invalidos')
    })
  })

  describe('successful creation', () => {
    it('returns 201 with pool including correct lead_count', async () => {
      mockPoolConnect()
      mockAuth()
      const leads = makeSampleLeads()
      const createdPool = makeLeadPool({ lead_count: leads.length })
      vi.mocked(createLeadPool).mockResolvedValue(createdPool)

      const req = makeCreateRequest({ name: 'Pool de Dentistas SP', leads })
      const res = await createRoute(req)
      expect(res.status).toBe(201)

      const body = await res.json() as { data: LeadPool }
      expect(body.data.id).toBe(POOL_ID)
      expect(body.data.lead_count).toBe(leads.length)
      expect(body.data.name).toBe('Pool de Dentistas SP')
    })

    it('workspace_id always comes from auth token and not from request body', async () => {
      mockPoolConnect()
      mockAuth(WS_TEST)
      vi.mocked(createLeadPool).mockResolvedValue(makeLeadPool())

      // Body includes a different workspace_id — it must be ignored
      const req = makeCreateRequest({
        name:         'Pool Test',
        leads:        makeSampleLeads(),
        workspace_id: WS_OTHER, // should be silently ignored by schema + route
      })
      await createRoute(req)

      expect(vi.mocked(createLeadPool)).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ workspace_id: WS_TEST }),
      )
    })
  })

  describe('rate limiting', () => {
    it('returns 429 when rate limit is exceeded', async () => {
      vi.mocked(campaignLimiter.check).mockResolvedValueOnce({
        success:   false,
        remaining: 0,
        resetAt:   Date.now() + 30_000,
      })
      const req = makeCreateRequest({ name: 'Pool', leads: makeSampleLeads() })
      const res = await createRoute(req)
      expect(res.status).toBe(429)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('Muitas requisicoes')
    })
  })
})

// ---------------------------------------------------------------------------
// GET /api/lead-pools — list
// ---------------------------------------------------------------------------

describe('GET /api/lead-pools', () => {
  describe('authentication', () => {
    it('returns 401 when no auth', async () => {
      mockPoolConnect()
      mockAuthFail()
      const req = makeListRequest()
      const res = await listRoute(req)
      expect(res.status).toBe(401)
    })
  })

  describe('workspace isolation', () => {
    it('returns 200 with only pools for the authenticated workspace', async () => {
      mockPoolConnect()
      mockAuth(WS_TEST)
      const pools = [makeLeadPool({ workspace_id: WS_TEST })]
      vi.mocked(findLeadPoolsByWorkspace).mockResolvedValue(pools)
      vi.mocked(countLeadPools).mockResolvedValue(1)

      const req = makeListRequest()
      const res = await listRoute(req)
      expect(res.status).toBe(200)

      const body = await res.json() as { data: LeadPool[]; meta: { total: number } }
      expect(body.data).toHaveLength(1)
      expect(body.data[0].workspace_id).toBe(WS_TEST)
      expect(body.meta.total).toBe(1)

      // workspace_id must come from auth, not from a query param
      expect(vi.mocked(findLeadPoolsByWorkspace)).toHaveBeenCalledWith(
        expect.anything(),
        WS_TEST,
        expect.any(Number),
        expect.any(Number),
      )
    })
  })

  describe('pagination', () => {
    it('forwards limit and offset query params to the repo', async () => {
      mockPoolConnect()
      mockAuth(WS_TEST)
      vi.mocked(findLeadPoolsByWorkspace).mockResolvedValue([])
      vi.mocked(countLeadPools).mockResolvedValue(0)

      const req = makeListRequest('limit=10&offset=20')
      const res = await listRoute(req)
      expect(res.status).toBe(200)

      expect(vi.mocked(findLeadPoolsByWorkspace)).toHaveBeenCalledWith(
        expect.anything(),
        WS_TEST,
        10,
        20,
      )

      const body = await res.json() as { meta: { limit: number; offset: number } }
      expect(body.meta.limit).toBe(10)
      expect(body.meta.offset).toBe(20)
    })

    it('uses default limit=20 offset=0 when no params provided', async () => {
      mockPoolConnect()
      mockAuth(WS_TEST)
      vi.mocked(findLeadPoolsByWorkspace).mockResolvedValue([])
      vi.mocked(countLeadPools).mockResolvedValue(0)

      const req = makeListRequest()
      await listRoute(req)

      expect(vi.mocked(findLeadPoolsByWorkspace)).toHaveBeenCalledWith(
        expect.anything(),
        WS_TEST,
        20,
        0,
      )
    })
  })

  describe('rate limiting', () => {
    it('returns 429 when rate limit is exceeded', async () => {
      vi.mocked(campaignLimiter.check).mockResolvedValueOnce({
        success:   false,
        remaining: 0,
        resetAt:   Date.now() + 30_000,
      })
      const req = makeListRequest()
      const res = await listRoute(req)
      expect(res.status).toBe(429)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('Muitas requisicoes')
    })
  })

  describe('internal server error', () => {
    it('returns 500 when repo throws an unexpected error', async () => {
      mockPoolConnect()
      mockAuth(WS_TEST)
      vi.mocked(findLeadPoolsByWorkspace).mockRejectedValue(new Error('DB connection lost'))

      const req = makeListRequest()
      const res = await listRoute(req)
      expect(res.status).toBe(500)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('Erro interno do servidor')
    })
  })
})

// ---------------------------------------------------------------------------
// GET /api/lead-pools/:id — detail
// ---------------------------------------------------------------------------

describe('GET /api/lead-pools/:id', () => {
  describe('authentication', () => {
    it('returns 401 when no auth', async () => {
      mockPoolConnect()
      mockAuthFail()
      const req = makeDetailRequest(POOL_ID, 'GET')
      const res = await detailRoute(req, makeParams(POOL_ID))
      expect(res.status).toBe(401)
    })
  })

  describe('not found', () => {
    it('returns 404 when pool does not exist (repo returns null)', async () => {
      mockPoolConnect()
      mockAuth()
      vi.mocked(findLeadPoolById).mockResolvedValue(null)

      const req = makeDetailRequest(POOL_ID, 'GET')
      const res = await detailRoute(req, makeParams(POOL_ID))
      expect(res.status).toBe(404)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('Lead pool nao encontrado')
    })

    it('returns 404 when pool belongs to another workspace (repo returns null due to workspace_id anchor)', async () => {
      mockPoolConnect()
      mockAuth(WS_OTHER)
      // Repo enforces workspace_id in WHERE clause and returns null for cross-workspace access
      vi.mocked(findLeadPoolById).mockResolvedValue(null)

      const req = makeDetailRequest(POOL_ID, 'GET')
      const res = await detailRoute(req, makeParams(POOL_ID))
      expect(res.status).toBe(404)

      // Confirm the repo was called with WS_OTHER (the auth workspace), not WS_TEST
      expect(vi.mocked(findLeadPoolById)).toHaveBeenCalledWith(
        expect.anything(),
        POOL_ID,
        WS_OTHER,
      )
    })
  })

  describe('successful detail fetch', () => {
    it('returns 200 with pool including leads_json', async () => {
      mockPoolConnect()
      mockAuth()
      const detail = makeLeadPoolDetail()
      vi.mocked(findLeadPoolById).mockResolvedValue(detail)

      const req = makeDetailRequest(POOL_ID, 'GET')
      const res = await detailRoute(req, makeParams(POOL_ID))
      expect(res.status).toBe(200)

      const body = await res.json() as { data: LeadPoolDetail }
      expect(body.data.id).toBe(POOL_ID)
      expect(body.data.leads_json).toBeDefined()
      expect(body.data.leads_json).toHaveLength(1)
      expect(body.data.leads_json[0].cnpj).toBe('12345678000195')
    })
  })

  describe('invalid id', () => {
    it('returns 400 for a non-UUID id', async () => {
      mockPoolConnect()
      mockAuth()
      const req = makeDetailRequest('not-a-uuid', 'GET')
      const res = await detailRoute(req, makeParams('not-a-uuid'))
      expect(res.status).toBe(400)
    })
  })
})

// ---------------------------------------------------------------------------
// DELETE /api/lead-pools/:id
// ---------------------------------------------------------------------------

describe('DELETE /api/lead-pools/:id', () => {
  describe('authentication', () => {
    it('returns 401 when no auth', async () => {
      mockPoolConnect()
      mockAuthFail()
      const req = makeDetailRequest(POOL_ID, 'DELETE')
      const res = await deleteRoute(req, makeParams(POOL_ID))
      expect(res.status).toBe(401)
    })
  })

  describe('not found', () => {
    it('returns 404 when pool not found or belongs to a different workspace (deleteLeadPool returns false)', async () => {
      mockPoolConnect()
      mockAuth()
      vi.mocked(deleteLeadPool).mockResolvedValue(false)

      const req = makeDetailRequest(POOL_ID, 'DELETE')
      const res = await deleteRoute(req, makeParams(POOL_ID))
      expect(res.status).toBe(404)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('Lead pool nao encontrado')
    })
  })

  describe('successful deletion', () => {
    it('returns 200 with success:true when deleteLeadPool returns true', async () => {
      mockPoolConnect()
      mockAuth()
      vi.mocked(deleteLeadPool).mockResolvedValue(true)

      const req = makeDetailRequest(POOL_ID, 'DELETE')
      const res = await deleteRoute(req, makeParams(POOL_ID))
      expect(res.status).toBe(200)

      const body = await res.json() as { success: boolean }
      expect(body.success).toBe(true)
    })

    it('passes workspace_id from auth token as the ownership anchor to deleteLeadPool', async () => {
      mockPoolConnect()
      mockAuth(WS_TEST)
      vi.mocked(deleteLeadPool).mockResolvedValue(true)

      const req = makeDetailRequest(POOL_ID, 'DELETE')
      await deleteRoute(req, makeParams(POOL_ID))

      expect(vi.mocked(deleteLeadPool)).toHaveBeenCalledWith(
        expect.anything(),
        POOL_ID,
        WS_TEST,
      )
    })
  })

  describe('invalid id', () => {
    it('returns 400 for a non-UUID id', async () => {
      mockPoolConnect()
      mockAuth()
      const req = makeDetailRequest('bad-id', 'DELETE')
      const res = await deleteRoute(req, makeParams('bad-id'))
      expect(res.status).toBe(400)
    })
  })

  describe('rate limiting', () => {
    it('returns 429 when rate limit is exceeded', async () => {
      vi.mocked(campaignLimiter.check).mockResolvedValueOnce({
        success:   false,
        remaining: 0,
        resetAt:   Date.now() + 30_000,
      })
      const req = makeDetailRequest(POOL_ID, 'DELETE')
      const res = await deleteRoute(req, makeParams(POOL_ID))
      expect(res.status).toBe(429)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('Muitas requisicoes')
    })
  })
})

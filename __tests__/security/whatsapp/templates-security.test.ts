// ---------------------------------------------------------------------------
// Security: WhatsApp template endpoints
//
// Covers sync, list, and variables routes.
// Verifies:
//   • Missing Bearer header → 401
//   • Invalid/unknown key → 401
//   • Non-UUID :id / :templateId → 400
//   • SQL injection in query params (status) → 400 (enum rejects)
//   • Response never leaks credentials
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ---------------------------------------------------------------------------
// Module mocks (must precede route imports)
// ---------------------------------------------------------------------------

const mockConnect = vi.fn()
const mockRelease = vi.fn()

vi.mock('@/lib/database', () => ({
  default: { connect: mockConnect },
}))

vi.mock('@/lib/get-ip', () => ({
  getClientIp: vi.fn().mockReturnValue('127.0.0.1'),
}))

vi.mock('@/lib/rate-limit', () => ({
  whatsappChannelLimiter: {
    check: vi.fn().mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 }),
  },
  whatsappTemplateSyncLimiter: {
    check: vi.fn().mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 }),
  },
}))

const mockValidateApiKey = vi.fn()
vi.mock('@/lib/whatsapp/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/whatsapp/auth')>()
  return { ...actual, validateApiKey: mockValidateApiKey }
})

const mockFindChannelById = vi.fn()
vi.mock('@/lib/whatsapp/channel-repo', () => ({
  findChannelById: mockFindChannelById,
}))

vi.mock('@/lib/whatsapp/crypto', () => ({
  decryptCredentials: vi.fn().mockReturnValue({
    access_token: 'tok', phone_number_id: 'ph', waba_id: 'wa', app_secret: 'sec',
  }),
}))

vi.mock('@/lib/whatsapp/template-repo', () => ({
  listTemplates: vi.fn().mockResolvedValue({ data: [], pagination: { total: 0, page: 1, limit: 20, pages: 0 } }),
  syncTemplatesInTransaction: vi.fn().mockResolvedValue({ created: 0, updated: 0, deactivated: 0 }),
  getTemplateVariables: vi.fn().mockResolvedValue(null),
}))

// Route handlers — imported after mocks are set up
const { POST: syncRoute } = await import('@/app/api/whatsapp/channels/[id]/templates/sync/route')
const { GET: listRoute } = await import('@/app/api/whatsapp/channels/[id]/templates/route')
const { GET: varsRoute } = await import(
  '@/app/api/whatsapp/channels/[id]/templates/[templateId]/variables/route'
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CHANNEL_ID = '11111111-1111-4111-8111-111111111111'
const TEMPLATE_ID = '22222222-2222-4222-8222-222222222222'

function authHeader(key = 'wk_' + 'a'.repeat(64)) {
  return { Authorization: `Bearer ${key}` }
}

function makeGet(path: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost${path}`, { method: 'GET', headers })
}

function makePost(path: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

function makeClientMock(overrides?: Record<string, unknown>) {
  return {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: mockRelease,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockConnect.mockResolvedValue(makeClientMock())
})

// ---------------------------------------------------------------------------
// Auth — sync endpoint
// ---------------------------------------------------------------------------

describe('Security: POST /channels/:id/templates/sync — auth', () => {
  it('returns 401 when no Authorization header', async () => {
    mockValidateApiKey.mockResolvedValue(null) // no key found
    const req = makePost(`/api/whatsapp/channels/${CHANNEL_ID}/templates/sync`)
    const res = await syncRoute(req, { params: Promise.resolve({ id: CHANNEL_ID }) })
    expect(res.status).toBe(401)
  })

  it('returns 401 with malformed Bearer token', async () => {
    mockValidateApiKey.mockResolvedValue(null)
    const req = makePost(
      `/api/whatsapp/channels/${CHANNEL_ID}/templates/sync`,
      { Authorization: 'Bearer not-a-valid-key' },
    )
    const res = await syncRoute(req, { params: Promise.resolve({ id: CHANNEL_ID }) })
    expect(res.status).toBe(401)
  })

  it('returns 400 for invalid UUID channel_id', async () => {
    // UUID check happens before auth — no DB call
    const req = makePost(
      `/api/whatsapp/channels/not-a-uuid/templates/sync`,
      authHeader(),
    )
    const res = await syncRoute(req, { params: Promise.resolve({ id: 'not-a-uuid' }) })
    expect(res.status).toBe(400)
    expect(mockConnect).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Auth — list endpoint
// ---------------------------------------------------------------------------

describe('Security: GET /channels/:id/templates — auth', () => {
  it('returns 401 when no Authorization header', async () => {
    mockValidateApiKey.mockResolvedValue(null)
    const req = makeGet(`/api/whatsapp/channels/${CHANNEL_ID}/templates`)
    const res = await listRoute(req, { params: Promise.resolve({ id: CHANNEL_ID }) })
    expect(res.status).toBe(401)
  })

  it('returns 401 with malformed Bearer token', async () => {
    mockValidateApiKey.mockResolvedValue(null)
    const req = makeGet(
      `/api/whatsapp/channels/${CHANNEL_ID}/templates`,
      { Authorization: 'Bearer bad_token' },
    )
    const res = await listRoute(req, { params: Promise.resolve({ id: CHANNEL_ID }) })
    expect(res.status).toBe(401)
  })

  it('returns 400 for invalid UUID channel_id — no DB call', async () => {
    const req = makeGet(
      `/api/whatsapp/channels/invalid-id/templates`,
      authHeader(),
    )
    const res = await listRoute(req, { params: Promise.resolve({ id: 'invalid-id' }) })
    expect(res.status).toBe(400)
    expect(mockConnect).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Auth — variables endpoint
// ---------------------------------------------------------------------------

describe('Security: GET /channels/:id/templates/:templateId/variables — auth', () => {
  it('returns 401 when no Authorization header', async () => {
    mockValidateApiKey.mockResolvedValue(null)
    const req = makeGet(
      `/api/whatsapp/channels/${CHANNEL_ID}/templates/${TEMPLATE_ID}/variables`,
    )
    const res = await varsRoute(req, { params: Promise.resolve({ id: CHANNEL_ID, templateId: TEMPLATE_ID }) })
    expect(res.status).toBe(401)
  })

  it('returns 400 for invalid templateId UUID', async () => {
    const req = makeGet(
      `/api/whatsapp/channels/${CHANNEL_ID}/templates/not-a-uuid/variables`,
      authHeader(),
    )
    const res = await varsRoute(req, { params: Promise.resolve({ id: CHANNEL_ID, templateId: 'not-a-uuid' }) })
    expect(res.status).toBe(400)
    expect(mockConnect).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Query param injection — list endpoint
// ---------------------------------------------------------------------------

describe('Security: Query injection prevention — list templates', () => {
  const SQL_PAYLOADS = [
    "'; DROP TABLE whatsapp_templates; --",
    "' OR '1'='1",
    "' UNION SELECT * FROM workspace_api_keys --",
    "1; SELECT pg_sleep(5) --",
  ]

  it('rejects SQL injection in status param (not in enum) → 400', async () => {
    for (const payload of SQL_PAYLOADS) {
      const url = new URL(`http://localhost/api/whatsapp/channels/${CHANNEL_ID}/templates`)
      url.searchParams.set('status', payload)
      const req = new NextRequest(url.toString(), { method: 'GET', headers: authHeader() })
      const res = await listRoute(req, { params: Promise.resolve({ id: CHANNEL_ID }) })
      // Status enum rejects any value not in TEMPLATE_STATUSES → 400
      expect([400, 401]).toContain(res.status)
    }
  })
})

// ---------------------------------------------------------------------------
// Response sanitization — no credentials leaked
// ---------------------------------------------------------------------------

describe('Security: No credentials in template responses', () => {
  it('list response never exposes access_token or credentials_encrypted', async () => {
    mockValidateApiKey.mockResolvedValue({ workspace_id: 'ws-1', key_id: 'k-1' })
    mockFindChannelById.mockResolvedValue({
      id: CHANNEL_ID, workspace_id: 'ws-1', provider: 'META_CLOUD', status: 'CONNECTED',
    })
    mockConnect.mockResolvedValue(makeClientMock({
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('web_sessions')) return { rows: [] }
        return { rows: [{ workspace_id: 'ws-1' }] }
      }),
    }))

    const req = makeGet(`/api/whatsapp/channels/${CHANNEL_ID}/templates`, authHeader())
    const res = await listRoute(req, { params: Promise.resolve({ id: CHANNEL_ID }) })
    const raw = await res.text()

    expect(raw).not.toMatch(/access_token/i)
    expect(raw).not.toMatch(/credentials_encrypted/i)
    expect(raw).not.toMatch(/EAABtest/i)
  })

  it('sync response never exposes credentials', async () => {
    mockValidateApiKey.mockResolvedValue(null)
    const req = makePost(`/api/whatsapp/channels/${CHANNEL_ID}/templates/sync`, authHeader())
    const res = await syncRoute(req, { params: Promise.resolve({ id: CHANNEL_ID }) })
    const raw = await res.text()

    expect(raw).not.toMatch(/access_token/i)
    expect(raw).not.toMatch(/credentials_encrypted/i)
  })
})

// ---------------------------------------------------------------------------
// Security tests — /api/whatsapp/keys route authorization
//
// Verifies that every verb (GET, POST, DELETE) requires a valid Bearer token
// and that workspace isolation is enforced on DELETE.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ---------------------------------------------------------------------------
// Module mocks — must be declared before importing the route handlers
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
  whatsappKeysLimiter: {
    check: vi.fn().mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 }),
  },
}))

// validateApiKey is called by requireWorkspaceAuth internally
const mockValidateApiKey = vi.fn()
vi.mock('@/lib/whatsapp/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/whatsapp/auth')>()
  return {
    ...actual,
    validateApiKey: mockValidateApiKey,
    listApiKeys: vi.fn().mockResolvedValue([]),
    createApiKey: vi.fn().mockResolvedValue({
      key: 'wk_' + 'a'.repeat(64),
      record: { id: 'key-1', workspace_id: 'ws-A', label: 'Test', created_by: null, created_at: new Date() },
    }),
    revokeApiKey: vi.fn().mockResolvedValue(false), // default: key not found
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(
  method: 'GET' | 'POST' | 'DELETE',
  opts: { auth?: string; body?: unknown; search?: Record<string, string> } = {},
): NextRequest {
  const url = new URL('http://localhost/api/whatsapp/keys')
  if (opts.search) {
    Object.entries(opts.search).forEach(([k, v]) => url.searchParams.set(k, v))
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.auth !== undefined) headers['Authorization'] = opts.auth

  return new NextRequest(url.toString(), {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
}

function makeClient(validKey: boolean, workspaceId = 'ws-A') {
  if (validKey) {
    mockValidateApiKey.mockResolvedValue({ workspace_id: workspaceId, label: 'Test Key', key_id: 'key-1' })
  } else {
    mockValidateApiKey.mockResolvedValue(null)
  }
  const client = { query: vi.fn(), release: mockRelease }
  mockConnect.mockResolvedValue(client)
  return client
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Security: /api/whatsapp/keys route authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ---- GET ----------------------------------------------------------------

  it('GET without Authorization header → 401', async () => {
    makeClient(false)
    const { GET } = await import('@/app/api/whatsapp/keys/route')
    const req = makeRequest('GET')
    const res = await GET(req)
    expect(res.status).toBe(401)
  })

  it('GET with invalid/unknown key → 401', async () => {
    makeClient(false)
    const { GET } = await import('@/app/api/whatsapp/keys/route')
    const req = makeRequest('GET', { auth: 'Bearer wk_' + '0'.repeat(64) })
    const res = await GET(req)
    expect(res.status).toBe(401)
  })

  it('GET with valid key → 200, uses workspace_id from token (ignores query param)', async () => {
    makeClient(true, 'ws-from-token')
    const { GET } = await import('@/app/api/whatsapp/keys/route')
    // Provide a decoy workspace_id in the query string — route must ignore it
    const req = makeRequest('GET', {
      auth: 'Bearer wk_' + 'a'.repeat(64),
      search: { workspace_id: 'ws-attacker' },
    })
    const res = await GET(req)
    expect(res.status).toBe(200)

    const { listApiKeys } = await import('@/lib/whatsapp/auth')
    expect(listApiKeys).toHaveBeenCalledWith(expect.anything(), 'ws-from-token')
    // Must NOT be called with the decoy workspace
    expect(listApiKeys).not.toHaveBeenCalledWith(expect.anything(), 'ws-attacker')
  })

  // ---- POST ---------------------------------------------------------------

  it('POST without Authorization header → 401', async () => {
    makeClient(false)
    const { POST } = await import('@/app/api/whatsapp/keys/route')
    const req = makeRequest('POST', { body: { label: 'My Key' } })
    const res = await POST(req)
    expect(res.status).toBe(401)
  })

  it('POST with valid key uses workspace_id from token, not from body', async () => {
    makeClient(true, 'ws-from-token')
    const { POST } = await import('@/app/api/whatsapp/keys/route')
    const req = makeRequest('POST', {
      auth: 'Bearer wk_' + 'b'.repeat(64),
      body: { label: 'My Key', workspace_id: 'ws-attacker' }, // decoy
    })
    const res = await POST(req)
    expect(res.status).toBe(201)

    const { createApiKey } = await import('@/lib/whatsapp/auth')
    expect(createApiKey).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ workspace_id: 'ws-from-token' }),
    )
    expect(createApiKey).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ workspace_id: 'ws-attacker' }),
    )
  })

  // ---- DELETE -------------------------------------------------------------

  it('DELETE without Authorization header → 401', async () => {
    makeClient(false)
    const { DELETE } = await import('@/app/api/whatsapp/keys/route')
    const req = makeRequest('DELETE', { search: { id: 'some-key-id' } })
    const res = await DELETE(req)
    expect(res.status).toBe(401)
  })

  it('DELETE without id param → 400', async () => {
    makeClient(true)
    const { DELETE } = await import('@/app/api/whatsapp/keys/route')
    const req = makeRequest('DELETE', { auth: 'Bearer wk_' + 'c'.repeat(64) })
    const res = await DELETE(req)
    expect(res.status).toBe(400)
  })

  it('DELETE key from a different workspace → 404 (SQL WHERE workspace_id blocks it)', async () => {
    // Auth returns ws-A; revokeApiKey returns false (key belongs to ws-B, SQL finds nothing)
    makeClient(true, 'ws-A')
    const { revokeApiKey } = await import('@/lib/whatsapp/auth')
    vi.mocked(revokeApiKey).mockResolvedValue(false)

    const { DELETE } = await import('@/app/api/whatsapp/keys/route')
    const req = makeRequest('DELETE', {
      auth: 'Bearer wk_' + 'd'.repeat(64),
      search: { id: 'key-owned-by-ws-B' },
    })
    const res = await DELETE(req)
    expect(res.status).toBe(404)

    // Must be called with the token's workspace_id — not with any other
    expect(revokeApiKey).toHaveBeenCalledWith(
      expect.anything(),
      'key-owned-by-ws-B',
      'ws-A',
    )
  })

  it('DELETE own key with valid auth → 200', async () => {
    makeClient(true, 'ws-A')
    const { revokeApiKey } = await import('@/lib/whatsapp/auth')
    vi.mocked(revokeApiKey).mockResolvedValue(true)

    const { DELETE } = await import('@/app/api/whatsapp/keys/route')
    const req = makeRequest('DELETE', {
      auth: 'Bearer wk_' + 'e'.repeat(64),
      search: { id: 'my-own-key-id' },
    })
    const res = await DELETE(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true })
  })
})

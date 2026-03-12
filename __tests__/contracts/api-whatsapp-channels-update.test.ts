// ---------------------------------------------------------------------------
// Contract tests for PATCH /api/whatsapp/channels/:id
//
// Auth/DB are mocked. MSW intercepts provider HTTP calls.
// Covers: auth gates, ownership, schema validation, credential merge,
//         revalidation (success/failure), and response security.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../mocks/server'
import { NextRequest } from 'next/server'

// ---------------------------------------------------------------------------
// Mocks — declared before module imports
// ---------------------------------------------------------------------------

vi.mock('@/lib/rate-limit', () => ({
  whatsappChannelLimiter: {
    check: () => Promise.resolve({ success: true, resetAt: Date.now() + 60_000 }),
  },
}))

vi.mock('@/lib/whatsapp/auth-middleware', () => ({
  requireWorkspaceAuth: () => Promise.resolve({ workspace_id: 'ws-update-test' }),
  authErrorResponse: () => null,
}))

const mockDecrypt = vi.fn()
const mockEncrypt = vi.fn()

vi.mock('@/lib/whatsapp/crypto', () => ({
  encryptCredentials: (...args: unknown[]) => mockEncrypt(...args),
  decryptCredentials: (...args: unknown[]) => mockDecrypt(...args),
  safeCompare: (a: string, b: string) => a === b,
}))

const mockFindChannelById = vi.fn()
const mockUpdateChannelConfig = vi.fn()

vi.mock('@/lib/whatsapp/channel-repo', () => ({
  findChannelById: (...args: unknown[]) => mockFindChannelById(...args),
  updateChannelConfig: (...args: unknown[]) => mockUpdateChannelConfig(...args),
  findChannelsByWorkspace: vi.fn(),
  createChannel: vi.fn(),
  updateChannelStatus: vi.fn(),
  deleteChannel: vi.fn(),
}))

vi.mock('@/lib/database', () => ({
  default: {
    connect: () =>
      Promise.resolve({
        release: vi.fn(),
        query: vi.fn(),
      }),
  },
}))

import { PATCH } from '@/app/api/whatsapp/channels/[id]/route'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UAZAPI_BASE = 'https://uaz.update-test.com'
const CHANNEL_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const OTHER_CHANNEL_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

function makeChannelRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CHANNEL_ID,
    workspace_id: 'ws-update-test',
    name: 'Canal Original',
    provider: 'UAZAPI',
    status: 'DISCONNECTED',
    phone_number: null,
    external_instance_id: 'uaz-original-inst',
    credentials_encrypted: 'fake-encrypted-blob',
    webhook_secret: 'secret-123',
    last_seen_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  }
}

function patchRequest(id: string, body: unknown) {
  return new NextRequest(`http://localhost/api/whatsapp/channels/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// NextJS dynamic route params
function routeParams(id: string) {
  return { params: Promise.resolve({ id }) }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  mockDecrypt.mockReturnValue({
    instance_url: UAZAPI_BASE,
    admin_token: 'existing-admin-token',
    instance_token: 'existing-instance-token',
  })
  mockEncrypt.mockReturnValue('new-encrypted-blob')
})

describe('PATCH /api/whatsapp/channels/:id — auth and ownership', () => {
  it('returns 400 for invalid UUID', async () => {
    const req = patchRequest('not-a-uuid', { provider: 'UAZAPI' })
    const res = await PATCH(req, routeParams('not-a-uuid'))
    expect(res.status).toBe(400)
  })

  it('returns 404 when channel does not exist', async () => {
    mockFindChannelById.mockResolvedValueOnce(null)
    const req = patchRequest(CHANNEL_ID, { provider: 'UAZAPI', name: 'New Name' })
    const res = await PATCH(req, routeParams(CHANNEL_ID))
    expect(res.status).toBe(404)
  })

  it('returns 403 when channel belongs to another workspace', async () => {
    mockFindChannelById.mockResolvedValueOnce(
      makeChannelRow({ workspace_id: 'ws-other' }),
    )
    const req = patchRequest(CHANNEL_ID, { provider: 'UAZAPI', name: 'New Name' })
    const res = await PATCH(req, routeParams(CHANNEL_ID))
    expect(res.status).toBe(403)
  })
})

describe('PATCH /api/whatsapp/channels/:id — schema validation', () => {
  it('returns 400 for invalid name (too long)', async () => {
    mockFindChannelById.mockResolvedValueOnce(makeChannelRow())
    const req = patchRequest(CHANNEL_ID, {
      provider: 'UAZAPI',
      name: 'x'.repeat(101),
    })
    const res = await PATCH(req, routeParams(CHANNEL_ID))
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string; details?: unknown[] }
    expect(body.error).toMatch(/inválido/i)
    expect(body.details).toBeDefined()
  })

  it('returns 400 for invalid JSON body', async () => {
    mockFindChannelById.mockResolvedValueOnce(makeChannelRow())
    const req = new NextRequest(`http://localhost/api/whatsapp/channels/${CHANNEL_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    })
    const res = await PATCH(req, routeParams(CHANNEL_ID))
    expect(res.status).toBe(400)
  })

  it('returns 409 when provider in body differs from channel provider', async () => {
    mockFindChannelById.mockResolvedValueOnce(makeChannelRow({ provider: 'UAZAPI' }))
    const req = patchRequest(CHANNEL_ID, {
      provider: 'EVOLUTION',
      name: 'New Name',
    })
    const res = await PATCH(req, routeParams(CHANNEL_ID))
    expect(res.status).toBe(409)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/UAZAPI/)
  })
})

describe('PATCH /api/whatsapp/channels/:id — name-only update', () => {
  it('returns 200 and updates name without touching credentials or adapter', async () => {
    mockFindChannelById.mockResolvedValueOnce(makeChannelRow())
    mockUpdateChannelConfig.mockResolvedValueOnce(makeChannelRow({ name: 'Updated Name' }))

    const req = patchRequest(CHANNEL_ID, {
      provider: 'UAZAPI',
      name: 'Updated Name',
    })
    const res = await PATCH(req, routeParams(CHANNEL_ID))
    expect(res.status).toBe(200)

    // No credential operations
    expect(mockDecrypt).not.toHaveBeenCalled()
    expect(mockEncrypt).not.toHaveBeenCalled()

    // updateChannelConfig called with name only
    expect(mockUpdateChannelConfig).toHaveBeenCalledWith(
      expect.anything(),
      CHANNEL_ID,
      expect.objectContaining({ name: 'Updated Name' }),
    )
    expect(mockUpdateChannelConfig.mock.calls[0][2]).not.toHaveProperty('credentials_encrypted')
  })

  it('returns 200 and updates phone_number without touching credentials', async () => {
    mockFindChannelById.mockResolvedValueOnce(makeChannelRow())
    mockUpdateChannelConfig.mockResolvedValueOnce(makeChannelRow({ phone_number: '+5511999990000' }))

    const req = patchRequest(CHANNEL_ID, {
      provider: 'UAZAPI',
      phone_number: '+5511999990000',
    })
    const res = await PATCH(req, routeParams(CHANNEL_ID))
    expect(res.status).toBe(200)
    expect(mockDecrypt).not.toHaveBeenCalled()
  })

  it('response never contains credentials_encrypted or webhook_secret', async () => {
    mockFindChannelById.mockResolvedValueOnce(makeChannelRow())
    mockUpdateChannelConfig.mockResolvedValueOnce(makeChannelRow({ name: 'Safe Name' }))

    const req = patchRequest(CHANNEL_ID, { provider: 'UAZAPI', name: 'Safe Name' })
    const res = await PATCH(req, routeParams(CHANNEL_ID))
    const body = await res.json() as { data: Record<string, unknown> }
    expect(body.data.credentials_encrypted).toBeUndefined()
    expect(body.data.webhook_secret).toBeUndefined()
  })
})

describe('PATCH /api/whatsapp/channels/:id — credentials update', () => {
  it('returns 200 with valid credentials (UAZAPI) — revalidate=true by default', async () => {
    // validateCredentials: instance_token only via GET /instance/status
    server.use(
      http.get(`${UAZAPI_BASE}/instance/status`, () =>
        HttpResponse.json({ status: 'disconnected' }),
      ),
    )
    mockFindChannelById.mockResolvedValueOnce(makeChannelRow())
    mockUpdateChannelConfig.mockResolvedValueOnce(makeChannelRow())

    const req = patchRequest(CHANNEL_ID, {
      provider: 'UAZAPI',
      credentials: {
        instance_url: UAZAPI_BASE,
        admin_token: 'new-admin-token',
        instance_token: 'new-instance-token',
      },
    })
    const res = await PATCH(req, routeParams(CHANNEL_ID))
    expect(res.status).toBe(200)

    expect(mockEncrypt).toHaveBeenCalledTimes(1)
    expect(mockUpdateChannelConfig).toHaveBeenCalledWith(
      expect.anything(),
      CHANNEL_ID,
      expect.objectContaining({ credentials_encrypted: 'new-encrypted-blob' }),
    )
    // external_instance_id must NOT be written by PATCH
    const callArgs = mockUpdateChannelConfig.mock.calls[0][2] as Record<string, unknown>
    expect(callArgs.external_instance_id).toBeUndefined()
  })

  it('PATCH does not call createChannel (POST /instance/init is never triggered)', async () => {
    let createChannelCalled = false
    server.use(
      http.post(`${UAZAPI_BASE}/instance/init`, () => {
        createChannelCalled = true
        return HttpResponse.json({ id: 'should-not-appear' })
      }),
      http.get(`${UAZAPI_BASE}/instance/status`, () =>
        HttpResponse.json({ status: 'disconnected' }),
      ),
    )
    mockFindChannelById.mockResolvedValueOnce(makeChannelRow())
    mockUpdateChannelConfig.mockResolvedValueOnce(makeChannelRow())

    const req = patchRequest(CHANNEL_ID, {
      provider: 'UAZAPI',
      credentials: {
        instance_url: UAZAPI_BASE,
        admin_token: 'tok',
        instance_token: 'itok',
      },
    })
    await PATCH(req, routeParams(CHANNEL_ID))
    expect(createChannelCalled).toBe(false)
  })

  it('returns 422 when provider rejects new credentials — does NOT persist', async () => {
    server.use(
      http.get(`${UAZAPI_BASE}/instance/status`, () =>
        HttpResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      ),
    )
    mockFindChannelById.mockResolvedValueOnce(makeChannelRow())

    const req = patchRequest(CHANNEL_ID, {
      provider: 'UAZAPI',
      credentials: {
        instance_url: UAZAPI_BASE,
        admin_token: 'bad-admin-token',
        instance_token: 'bad-instance-token',
      },
    })
    const res = await PATCH(req, routeParams(CHANNEL_ID))
    expect(res.status).toBe(422)

    // updateChannelConfig must NOT have been called
    expect(mockUpdateChannelConfig).not.toHaveBeenCalled()
  })

  it('returns 200 with revalidate=false — skips adapter call', async () => {
    mockFindChannelById.mockResolvedValueOnce(makeChannelRow())
    mockUpdateChannelConfig.mockResolvedValueOnce(makeChannelRow())

    const req = patchRequest(CHANNEL_ID, {
      provider: 'UAZAPI',
      credentials: {
        instance_url: UAZAPI_BASE,
        admin_token: 'any-admin',
        instance_token: 'any-inst',
      },
      revalidate: false,
    })
    const res = await PATCH(req, routeParams(CHANNEL_ID))
    expect(res.status).toBe(200)

    // Credentials were encrypted and saved
    expect(mockEncrypt).toHaveBeenCalledTimes(1)
    // But external_instance_id was not updated (no adapter call)
    const callArgs = mockUpdateChannelConfig.mock.calls[0][2] as Record<string, unknown>
    expect(callArgs.external_instance_id).toBeUndefined()
  })

  it('blank string in credentials keeps existing value (merge UX)', async () => {
    // Simulate user leaving instance_token blank — should keep existing-instance-token
    server.use(
      http.get(`${UAZAPI_BASE}/instance/status`, () =>
        HttpResponse.json({ status: 'disconnected' }),
      ),
    )
    mockFindChannelById.mockResolvedValueOnce(makeChannelRow())
    mockUpdateChannelConfig.mockResolvedValueOnce(makeChannelRow())

    const req = patchRequest(CHANNEL_ID, {
      provider: 'UAZAPI',
      credentials: {
        instance_url: UAZAPI_BASE,
        admin_token: 'new-admin',
        instance_token: '',  // blank = keep existing
      },
    })
    const res = await PATCH(req, routeParams(CHANNEL_ID))
    expect(res.status).toBe(200)

    // encryptCredentials should have been called with the merged creds
    // (instance_token from existing = 'existing-instance-token', not '')
    const encryptedWith = mockEncrypt.mock.calls[0][0] as Record<string, string>
    expect(encryptedWith.instance_token).toBe('existing-instance-token')
    expect(encryptedWith.admin_token).toBe('new-admin')
  })

  it('returns 400 when merged credentials fail full schema validation', async () => {
    // Existing creds have no instance_token (simulate corrupt state)
    mockDecrypt.mockReturnValueOnce({
      instance_url: UAZAPI_BASE,
      admin_token: 'existing-admin',
      // instance_token intentionally absent
    })
    mockFindChannelById.mockResolvedValueOnce(makeChannelRow())

    const req = patchRequest(CHANNEL_ID, {
      provider: 'UAZAPI',
      credentials: {
        instance_url: UAZAPI_BASE,
        admin_token: 'new-admin',
        instance_token: '',  // blank = keep existing — but existing is missing!
      },
    })
    const res = await PATCH(req, routeParams(CHANNEL_ID))
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string; details?: unknown[] }
    expect(body.error).toMatch(/incompleta/i)
    expect(body.details).toBeDefined()
    expect(mockUpdateChannelConfig).not.toHaveBeenCalled()
  })
})

describe('PATCH /api/whatsapp/channels/:id — other channel IDs', () => {
  it('uses the id from the URL params, not from the body', async () => {
    mockFindChannelById.mockResolvedValueOnce(null)
    const req = patchRequest(OTHER_CHANNEL_ID, { provider: 'UAZAPI', name: 'X' })
    const res = await PATCH(req, routeParams(OTHER_CHANNEL_ID))
    expect(res.status).toBe(404)
    expect(mockFindChannelById).toHaveBeenCalledWith(expect.anything(), OTHER_CHANNEL_ID)
  })
})

// ---------------------------------------------------------------------------
// META_CLOUD credential update (app_secret)
// ---------------------------------------------------------------------------

const META_PHONE_ID = '123456789'
const GRAPH_BASE = `https://graph.facebook.com/v18.0`

describe('PATCH /api/whatsapp/channels/:id — META_CLOUD credentials', () => {
  beforeEach(() => {
    // Override default decrypt to return Meta creds for these tests
    mockDecrypt.mockReturnValue({
      access_token: 'existing-access-token',
      phone_number_id: META_PHONE_ID,
      app_secret: 'existing-app-secret',
    })
  })

  it('updates app_secret and persists merged credentials', async () => {
    server.use(
      http.get(`${GRAPH_BASE}/${META_PHONE_ID}`, () =>
        HttpResponse.json({ id: META_PHONE_ID }),
      ),
    )
    mockFindChannelById.mockResolvedValueOnce(makeChannelRow({ provider: 'META_CLOUD', external_instance_id: META_PHONE_ID }))
    mockUpdateChannelConfig.mockResolvedValueOnce(makeChannelRow({ provider: 'META_CLOUD' }))

    const req = patchRequest(CHANNEL_ID, {
      provider: 'META_CLOUD',
      credentials: {
        app_secret: 'new-app-secret',
      },
    })
    const res = await PATCH(req, routeParams(CHANNEL_ID))
    expect(res.status).toBe(200)

    expect(mockEncrypt).toHaveBeenCalledTimes(1)
    const encryptedWith = mockEncrypt.mock.calls[0][0] as Record<string, string>
    // app_secret updated
    expect(encryptedWith.app_secret).toBe('new-app-secret')
    // existing fields preserved
    expect(encryptedWith.access_token).toBe('existing-access-token')
    expect(encryptedWith.phone_number_id).toBe(META_PHONE_ID)
  })

  it('blank app_secret keeps existing value', async () => {
    server.use(
      http.get(`${GRAPH_BASE}/${META_PHONE_ID}`, () =>
        HttpResponse.json({ id: META_PHONE_ID }),
      ),
    )
    mockFindChannelById.mockResolvedValueOnce(makeChannelRow({ provider: 'META_CLOUD' }))
    mockUpdateChannelConfig.mockResolvedValueOnce(makeChannelRow({ provider: 'META_CLOUD' }))

    const req = patchRequest(CHANNEL_ID, {
      provider: 'META_CLOUD',
      credentials: {
        access_token: 'new-access-token',
        app_secret: '',  // blank = keep existing
      },
    })
    const res = await PATCH(req, routeParams(CHANNEL_ID))
    expect(res.status).toBe(200)

    const encryptedWith = mockEncrypt.mock.calls[0][0] as Record<string, string>
    expect(encryptedWith.app_secret).toBe('existing-app-secret')
    expect(encryptedWith.access_token).toBe('new-access-token')
  })

  it('returns 422 with specific error when Meta rejects credentials', async () => {
    server.use(
      http.get(`${GRAPH_BASE}/${META_PHONE_ID}`, () =>
        HttpResponse.json({ error: { message: 'Invalid token' } }, { status: 401 }),
      ),
    )
    mockFindChannelById.mockResolvedValueOnce(makeChannelRow({ provider: 'META_CLOUD' }))

    const req = patchRequest(CHANNEL_ID, {
      provider: 'META_CLOUD',
      credentials: { access_token: 'bad-token' },
    })
    const res = await PATCH(req, routeParams(CHANNEL_ID))
    expect(res.status).toBe(422)

    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/inválid/i)
    expect(mockUpdateChannelConfig).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// UAZAPI credential validation (instance_token only)
// ---------------------------------------------------------------------------

describe('PATCH /api/whatsapp/channels/:id — UAZAPI credential validation', () => {
  it('returns 422 with "Token de instância inválido" when instance_token rejected (401)', async () => {
    server.use(
      http.get(`${UAZAPI_BASE}/instance/status`, () =>
        HttpResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      ),
    )
    mockFindChannelById.mockResolvedValueOnce(makeChannelRow())

    const req = patchRequest(CHANNEL_ID, {
      provider: 'UAZAPI',
      credentials: {
        instance_url: UAZAPI_BASE,
        admin_token: 'any-admin',
        instance_token: 'bad-instance-token',
      },
    })
    const res = await PATCH(req, routeParams(CHANNEL_ID))
    expect(res.status).toBe(422)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/instância/i)
    expect(mockUpdateChannelConfig).not.toHaveBeenCalled()
  })

  it('returns 422 with "Token de instância inválido" when instance_token rejected (403)', async () => {
    server.use(
      http.get(`${UAZAPI_BASE}/instance/status`, () =>
        HttpResponse.json({ error: 'Forbidden' }, { status: 403 }),
      ),
    )
    mockFindChannelById.mockResolvedValueOnce(makeChannelRow())

    const req = patchRequest(CHANNEL_ID, {
      provider: 'UAZAPI',
      credentials: {
        instance_url: UAZAPI_BASE,
        admin_token: 'any-admin',
        instance_token: 'bad-instance-token',
      },
    })
    const res = await PATCH(req, routeParams(CHANNEL_ID))
    expect(res.status).toBe(422)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/instância/i)
    expect(mockUpdateChannelConfig).not.toHaveBeenCalled()
  })

  it('returns 422 with URL error when /instance/status returns 404', async () => {
    server.use(
      http.get(`${UAZAPI_BASE}/instance/status`, () =>
        HttpResponse.json({ error: 'Not Found' }, { status: 404 }),
      ),
    )
    mockFindChannelById.mockResolvedValueOnce(makeChannelRow())

    const req = patchRequest(CHANNEL_ID, {
      provider: 'UAZAPI',
      credentials: {
        instance_url: UAZAPI_BASE,
        admin_token: 'any-admin',
        instance_token: 'any-instance-token',
      },
    })
    const res = await PATCH(req, routeParams(CHANNEL_ID))
    expect(res.status).toBe(422)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/url|rota|inválida/i)
    expect(mockUpdateChannelConfig).not.toHaveBeenCalled()
  })

  it('returns 422 and does not persist when /instance/status returns 503', async () => {
    server.use(
      http.get(`${UAZAPI_BASE}/instance/status`, () =>
        HttpResponse.json({ error: 'Service Unavailable' }, { status: 503 }),
      ),
    )
    mockFindChannelById.mockResolvedValueOnce(makeChannelRow())

    const req = patchRequest(CHANNEL_ID, {
      provider: 'UAZAPI',
      credentials: {
        instance_url: UAZAPI_BASE,
        admin_token: 'any-admin',
        instance_token: 'any-instance-token',
      },
    })
    const res = await PATCH(req, routeParams(CHANNEL_ID))
    expect(res.status).toBe(422)
    expect(mockUpdateChannelConfig).not.toHaveBeenCalled()
  })

  it('returns 200 when instance_token is valid (admin_token not validated)', async () => {
    server.use(
      http.get(`${UAZAPI_BASE}/instance/status`, () =>
        HttpResponse.json({ status: 'disconnected' }),
      ),
    )
    mockFindChannelById.mockResolvedValueOnce(makeChannelRow())
    mockUpdateChannelConfig.mockResolvedValueOnce(makeChannelRow())

    const req = patchRequest(CHANNEL_ID, {
      provider: 'UAZAPI',
      credentials: {
        instance_url: UAZAPI_BASE,
        admin_token: 'any-admin',
        instance_token: 'valid-instance',
      },
    })
    const res = await PATCH(req, routeParams(CHANNEL_ID))
    expect(res.status).toBe(200)
    expect(mockUpdateChannelConfig).toHaveBeenCalledTimes(1)
  })
})

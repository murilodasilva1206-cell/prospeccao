// ---------------------------------------------------------------------------
// Contract + regression tests for POST /api/whatsapp/channels
//
// Schema tests (no DB/auth needed):
//   - Discriminated union validates required fields per provider
//   - UAZAPI requires admin_token + instance_token (not api_key)
//   - Missing required field returns 400 with Zod issues
//
// Route handler tests (auth + DB mocked, MSW for provider HTTP):
//   - UAZAPI with wrong admin_token → adapter throws → 422
//   - UAZAPI with valid tokens → 201 with external_instance_id
//   - Evolution with valid credentials → 201 (regression)
//   - Meta Cloud with valid token → 201 (regression)
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../mocks/server'
import { NextRequest } from 'next/server'
import { ChannelCreateSchema } from '@/lib/schemas'

// ---------------------------------------------------------------------------
// Mocks — declared before module imports
// ---------------------------------------------------------------------------

vi.mock('@/lib/rate-limit', () => ({
  whatsappChannelLimiter: {
    check: () => Promise.resolve({ success: true, resetAt: Date.now() + 60_000 }),
  },
}))

vi.mock('@/lib/whatsapp/auth-middleware', () => ({
  requireWorkspaceAuth: () => Promise.resolve({ workspace_id: 'ws-contract-test' }),
  authErrorResponse: () => null,
}))

vi.mock('@/lib/whatsapp/crypto', () => ({
  encryptCredentials: () => 'fake-encrypted-blob',
  decryptCredentials: () => ({}),
  safeCompare: (a: string, b: string) => a === b,
}))

const mockCreateChannelRepo = vi.fn()
const mockUpdateChannelStatus = vi.fn()
const mockDeleteChannel = vi.fn()

vi.mock('@/lib/whatsapp/channel-repo', () => ({
  findChannelsByWorkspace: vi.fn(),
  createChannel: (...args: unknown[]) => mockCreateChannelRepo(...args),
  updateChannelStatus: (...args: unknown[]) => mockUpdateChannelStatus(...args),
  deleteChannel: (...args: unknown[]) => mockDeleteChannel(...args),
}))

const mockRelease = vi.fn()
vi.mock('@/lib/database', () => ({
  default: {
    connect: () =>
      Promise.resolve({
        release: mockRelease,
        query: vi.fn(),
      }),
  },
}))

import { POST } from '@/app/api/whatsapp/channels/route'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UAZAPI_BASE = 'https://uaz.contract-test.com'
const EVO_BASE = 'https://evo.contract-test.com'
const GRAPH_BASE = 'https://graph.facebook.com/v18.0'

function makeChannelRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    workspace_id: 'ws-contract-test',
    name: 'Test Channel',
    provider: 'UAZAPI',
    status: 'DISCONNECTED',
    phone_number: null,
    external_instance_id: null,
    credentials_encrypted: 'fake-encrypted-blob',
    webhook_secret: 'test-webhook-secret',
    last_seen_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  }
}

function postRequest(body: unknown) {
  return new NextRequest('http://localhost/api/whatsapp/channels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// ---------------------------------------------------------------------------
// Schema validation (pure Zod — no HTTP, no DB)
// ---------------------------------------------------------------------------

describe('ChannelCreateSchema — per-provider discriminated union', () => {
  describe('META_CLOUD', () => {
    it('accepts valid credentials', () => {
      const result = ChannelCreateSchema.safeParse({
        provider: 'META_CLOUD',
        name: 'Canal Meta',
        credentials: {
          access_token: 'EAABtest',
          phone_number_id: '12345678',
        },
      })
      expect(result.success).toBe(true)
    })

    it('rejects when access_token is missing', () => {
      const result = ChannelCreateSchema.safeParse({
        provider: 'META_CLOUD',
        name: 'Canal Meta',
        credentials: { phone_number_id: '12345678' },
      })
      expect(result.success).toBe(false)
      const issues = result.error!.issues.map((i) => i.path.join('.'))
      expect(issues.some((p) => p.includes('access_token'))).toBe(true)
    })

    it('rejects when phone_number_id is missing', () => {
      const result = ChannelCreateSchema.safeParse({
        provider: 'META_CLOUD',
        name: 'Canal Meta',
        credentials: { access_token: 'EAAB' },
      })
      expect(result.success).toBe(false)
    })
  })

  describe('EVOLUTION', () => {
    it('accepts valid credentials', () => {
      const result = ChannelCreateSchema.safeParse({
        provider: 'EVOLUTION',
        name: 'Canal Evo',
        credentials: {
          instance_url: 'https://evo.example.com',
          api_key: 'evo-key',
        },
      })
      expect(result.success).toBe(true)
    })

    it('rejects when api_key is missing', () => {
      const result = ChannelCreateSchema.safeParse({
        provider: 'EVOLUTION',
        name: 'Canal Evo',
        credentials: { instance_url: 'https://evo.example.com' },
      })
      expect(result.success).toBe(false)
    })

    it('rejects when instance_url is missing', () => {
      const result = ChannelCreateSchema.safeParse({
        provider: 'EVOLUTION',
        name: 'Canal Evo',
        credentials: { api_key: 'evo-key' },
      })
      expect(result.success).toBe(false)
    })
  })

  describe('UAZAPI', () => {
    it('accepts valid split-token credentials', () => {
      const result = ChannelCreateSchema.safeParse({
        provider: 'UAZAPI',
        name: 'Canal Uazapi',
        credentials: {
          instance_url: 'https://uaz.example.com',
          admin_token: 'adm-tok',
          instance_token: 'inst-tok',
        },
      })
      expect(result.success).toBe(true)
    })

    it('rejects when only api_key is provided (old format)', () => {
      const result = ChannelCreateSchema.safeParse({
        provider: 'UAZAPI',
        name: 'Canal Uazapi',
        credentials: {
          instance_url: 'https://uaz.example.com',
          api_key: 'old-key',
        },
      })
      expect(result.success).toBe(false)
      // Must require admin_token
      const issues = result.error!.issues.map((i) => i.path.join('.'))
      expect(issues.some((p) => p.includes('admin_token'))).toBe(true)
    })

    it('rejects when admin_token is missing', () => {
      const result = ChannelCreateSchema.safeParse({
        provider: 'UAZAPI',
        name: 'Canal Uazapi',
        credentials: {
          instance_url: 'https://uaz.example.com',
          instance_token: 'inst-tok',
        },
      })
      expect(result.success).toBe(false)
    })

    it('rejects when instance_token is missing', () => {
      const result = ChannelCreateSchema.safeParse({
        provider: 'UAZAPI',
        name: 'Canal Uazapi',
        credentials: {
          instance_url: 'https://uaz.example.com',
          admin_token: 'adm-tok',
        },
      })
      expect(result.success).toBe(false)
    })

    it('rejects when instance_url is missing', () => {
      const result = ChannelCreateSchema.safeParse({
        provider: 'UAZAPI',
        name: 'Canal Uazapi',
        credentials: {
          admin_token: 'adm-tok',
          instance_token: 'inst-tok',
        },
      })
      expect(result.success).toBe(false)
    })
  })

  it('rejects unknown provider', () => {
    const result = ChannelCreateSchema.safeParse({
      provider: 'UNKNOWN_PROVIDER',
      name: 'Canal',
      credentials: {},
    })
    expect(result.success).toBe(false)
  })

  it('rejects name longer than 100 chars', () => {
    const result = ChannelCreateSchema.safeParse({
      provider: 'META_CLOUD',
      name: 'x'.repeat(101),
      credentials: { access_token: 'EAAB', phone_number_id: '123' },
    })
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Route handler tests — auth/DB mocked, provider HTTP via MSW
// ---------------------------------------------------------------------------

describe('POST /api/whatsapp/channels — route handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 400 when body is missing required fields (schema validation)', async () => {
    const req = postRequest({ provider: 'UAZAPI', name: 'Test', credentials: {} })
    const res = await POST(req)
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string; details?: unknown[] }
    expect(body.error).toMatch(/inválido/i)
    expect(body.details).toBeDefined()
  })

  it('returns 422 when UAZAPI admin_token is rejected (401 from provider)', async () => {
    server.use(
      http.post(`${UAZAPI_BASE}/instance/init`, () =>
        HttpResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      ),
    )
    mockCreateChannelRepo.mockResolvedValueOnce(makeChannelRow({ provider: 'UAZAPI' }))
    mockDeleteChannel.mockResolvedValueOnce(undefined)

    const req = postRequest({
      provider: 'UAZAPI',
      name: 'Test UAZAPI',
      credentials: {
        instance_url: UAZAPI_BASE,
        admin_token: 'wrong-admin-token',
        instance_token: 'some-instance-token',
      },
    })

    const res = await POST(req)
    expect(res.status).toBe(422)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/credenciais|provider/i)
    // Channel must have been deleted after adapter failure
    expect(mockDeleteChannel).toHaveBeenCalledTimes(1)
  })

  it('returns 201 when UAZAPI credentials are valid and persists external_instance_id', async () => {
    server.use(
      http.post(`${UAZAPI_BASE}/instance/init`, () =>
        HttpResponse.json({ id: 'uaz-created-001', name: 'prospeccao-aaaaaaaa' }),
      ),
    )
    const channelRow = makeChannelRow({ provider: 'UAZAPI' })
    mockCreateChannelRepo.mockResolvedValueOnce(channelRow)
    mockUpdateChannelStatus.mockResolvedValueOnce(undefined)

    const req = postRequest({
      provider: 'UAZAPI',
      name: 'Test UAZAPI',
      credentials: {
        instance_url: UAZAPI_BASE,
        admin_token: 'valid-admin-token',
        instance_token: 'valid-instance-token',
      },
    })

    const res = await POST(req)
    expect(res.status).toBe(201)
    const body = await res.json() as { data: unknown; webhook_secret: string }
    expect(body.webhook_secret).toBeDefined()
    expect(body.data).toBeDefined()
    // updateChannelStatus called with external_instance_id from API
    expect(mockUpdateChannelStatus).toHaveBeenCalledWith(
      expect.anything(),
      channelRow.id,
      'DISCONNECTED',
      expect.objectContaining({ external_instance_id: 'uaz-created-001' }),
    )
  })

  it('returns 201 for EVOLUTION with valid credentials (regression)', async () => {
    server.use(
      http.post(`${EVO_BASE}/instance/create`, () =>
        HttpResponse.json({ instance: { instanceName: 'prospeccao-aaaaaaaa' } }),
      ),
    )
    const channelRow = makeChannelRow({ provider: 'EVOLUTION' })
    mockCreateChannelRepo.mockResolvedValueOnce(channelRow)
    mockUpdateChannelStatus.mockResolvedValueOnce(undefined)

    const req = postRequest({
      provider: 'EVOLUTION',
      name: 'Test Evolution',
      credentials: {
        instance_url: EVO_BASE,
        api_key: 'evo-api-key',
      },
    })

    const res = await POST(req)
    expect(res.status).toBe(201)
    expect(mockDeleteChannel).not.toHaveBeenCalled()
  })

  it('returns 422 for EVOLUTION when provider rejects API key (regression)', async () => {
    server.use(
      http.post(`${EVO_BASE}/instance/create`, () =>
        HttpResponse.json({ error: 'Forbidden' }, { status: 403 }),
      ),
    )
    mockCreateChannelRepo.mockResolvedValueOnce(makeChannelRow({ provider: 'EVOLUTION' }))
    mockDeleteChannel.mockResolvedValueOnce(undefined)

    const req = postRequest({
      provider: 'EVOLUTION',
      name: 'Test Evolution',
      credentials: {
        instance_url: EVO_BASE,
        api_key: 'bad-key',
      },
    })

    const res = await POST(req)
    expect(res.status).toBe(422)
    expect(mockDeleteChannel).toHaveBeenCalledTimes(1)
  })

  it('returns 201 for META_CLOUD with valid token (regression)', async () => {
    const phoneNumberId = '109876543210'
    server.use(
      http.get(`${GRAPH_BASE}/${phoneNumberId}`, () =>
        HttpResponse.json({ id: phoneNumberId, display_phone_number: '+5511999990000' }),
      ),
    )
    const channelRow = makeChannelRow({ provider: 'META_CLOUD' })
    mockCreateChannelRepo.mockResolvedValueOnce(channelRow)
    mockUpdateChannelStatus.mockResolvedValueOnce(undefined)

    const req = postRequest({
      provider: 'META_CLOUD',
      name: 'Test Meta',
      credentials: {
        access_token: 'EAABtest123',
        phone_number_id: phoneNumberId,
        app_secret: 'appsecret',
      },
    })

    const res = await POST(req)
    expect(res.status).toBe(201)
    expect(mockDeleteChannel).not.toHaveBeenCalled()
  })

  it('returns 422 for META_CLOUD when Graph API returns 401 (regression)', async () => {
    const phoneNumberId = '109876543210'
    server.use(
      http.get(`${GRAPH_BASE}/${phoneNumberId}`, () =>
        HttpResponse.json({ error: 'Invalid OAuth access token' }, { status: 401 }),
      ),
    )
    mockCreateChannelRepo.mockResolvedValueOnce(makeChannelRow({ provider: 'META_CLOUD' }))
    mockDeleteChannel.mockResolvedValueOnce(undefined)

    const req = postRequest({
      provider: 'META_CLOUD',
      name: 'Test Meta',
      credentials: {
        access_token: 'bad-token',
        phone_number_id: phoneNumberId,
      },
    })

    const res = await POST(req)
    expect(res.status).toBe(422)
    expect(mockDeleteChannel).toHaveBeenCalledTimes(1)
  })

  it('webhook_secret is never returned in credentials_encrypted field', async () => {
    server.use(
      http.post(`${UAZAPI_BASE}/instance/init`, () =>
        HttpResponse.json({ id: 'uaz-secret-test' }),
      ),
    )
    const channelRow = makeChannelRow({ provider: 'UAZAPI' })
    mockCreateChannelRepo.mockResolvedValueOnce(channelRow)
    mockUpdateChannelStatus.mockResolvedValueOnce(undefined)

    const req = postRequest({
      provider: 'UAZAPI',
      name: 'Secret Test',
      credentials: {
        instance_url: UAZAPI_BASE,
        admin_token: 'adm',
        instance_token: 'inst',
      },
    })

    const res = await POST(req)
    expect(res.status).toBe(201)
    const body = await res.json() as { data: Record<string, unknown> }
    // credentials_encrypted must not be exposed
    expect(body.data.credentials_encrypted).toBeUndefined()
    expect(body.data.webhook_secret).toBeUndefined()
  })
})

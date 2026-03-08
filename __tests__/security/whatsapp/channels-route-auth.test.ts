// ---------------------------------------------------------------------------
// Security tests — /api/whatsapp/channels/* route authorization
//
// Covers all channel routes (list, create, get, connect, status, disconnect, send).
// Verifies:
//   • Missing Bearer header → 401
//   • Invalid/unknown key → 401
//   • Channel belonging to a different workspace → 403
//   • GET /channels: query workspace_id is ignored; auth.workspace_id is used
//   • POST /channels: body workspace_id is ignored; auth.workspace_id is used
//   • Non-UUID :id on any [id] route → 400 (no DB hit)
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
  whatsappChannelLimiter: {
    check: vi.fn().mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 }),
  },
  whatsappSendLimiter: {
    check: vi.fn().mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 }),
  },
  whatsappMediaLimiter: {
    check: vi.fn().mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 }),
  },
}))

// validateApiKey is called internally by requireWorkspaceAuth
const mockValidateApiKey = vi.fn()
vi.mock('@/lib/whatsapp/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/whatsapp/auth')>()
  return { ...actual, validateApiKey: mockValidateApiKey }
})

const mockFindChannelsByWorkspace = vi.fn()
const mockFindChannelById = vi.fn()
const mockCreateChannel = vi.fn()
const mockUpdateChannelStatus = vi.fn()
const mockDeleteChannel = vi.fn()

vi.mock('@/lib/whatsapp/channel-repo', () => ({
  findChannelsByWorkspace: mockFindChannelsByWorkspace,
  findChannelById: mockFindChannelById,
  createChannel: mockCreateChannel,
  updateChannelStatus: mockUpdateChannelStatus,
  deleteChannel: mockDeleteChannel,
}))

vi.mock('@/lib/whatsapp/crypto', () => ({
  encryptCredentials: vi.fn().mockReturnValue('iv:tag:blob'),
  decryptCredentials: vi.fn().mockReturnValue({
    access_token: 'tok', phone_number_id: 'ph', waba_id: 'wa', app_secret: 'sec',
  }),
}))

const mockAdapter = {
  createChannel: vi.fn().mockResolvedValue({ external_instance_id: 'ext-1' }),
  startConnection: vi.fn().mockResolvedValue({ status: 'CONNECTED' }),
  getConnectionStatus: vi.fn().mockResolvedValue('CONNECTED'),
  disconnect: vi.fn().mockResolvedValue(undefined),
  sendMessage: vi.fn().mockResolvedValue({ message_id: 'msg-1' }),
}
vi.mock('@/lib/whatsapp/adapters/factory', () => ({
  getAdapter: vi.fn().mockReturnValue(mockAdapter),
}))

vi.mock('@/lib/whatsapp/media', () => ({
  validateMediaFile: vi.fn().mockReturnValue({ mime: 'image/jpeg', size: 1000, ext: 'jpg' }),
  uploadMedia: vi.fn().mockResolvedValue({ s3Key: 'test-key' }),
}))

vi.mock('@/lib/whatsapp/message-repo', () => ({
  insertMessage: vi.fn().mockResolvedValue({ id: 'msg-1' }),
}))

vi.mock('@/lib/whatsapp/conversation-repo', () => ({
  upsertConversation: vi.fn().mockResolvedValue({ id: 'conv-1' }),
}))

vi.mock('@/lib/whatsapp/audit-repo', () => ({
  insertAuditEvent: vi.fn().mockResolvedValue(undefined),
}))

// Mutable ref so individual tests can toggle MEDIA_STORAGE_ENABLED
let mediaEnabled = true
vi.mock('@/lib/env', () => ({
  env: { get MEDIA_STORAGE_ENABLED() { return mediaEnabled } },
}))

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const VALID_BEARER  = 'Bearer wk_' + 'a'.repeat(64)
const INVALID_BEARER = 'Bearer wk_' + '0'.repeat(64)

const CHAN_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'  // valid v4 UUID used in all :id tests

const CHANNEL_WS_A = {
  id: CHAN_UUID,
  workspace_id: 'ws-A',
  name: 'Test Channel',
  provider: 'META_CLOUD',
  status: 'CONNECTED',
  credentials_encrypted: 'iv:tag:blob',
  webhook_secret: 'secret-abc',
  phone_number: '+5511900000001',
  external_instance_id: null,
  last_seen_at: null,
}

// Same channel but owned by a different workspace
const CHANNEL_WS_B = { ...CHANNEL_WS_A, workspace_id: 'ws-B' }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(
  method: 'GET' | 'POST',
  path: string,
  opts: { auth?: string; body?: unknown; search?: Record<string, string> } = {},
): NextRequest {
  const url = new URL('http://localhost' + path)
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

function setupClient(validKey: boolean, workspaceId = 'ws-A') {
  if (validKey) {
    mockValidateApiKey.mockResolvedValue({ workspace_id: workspaceId, label: 'Test', key_id: 'key-1' })
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

describe('Security: /api/whatsapp/channels/* route authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mediaEnabled = true  // reset to default before each test
    mockFindChannelsByWorkspace.mockResolvedValue([])
    mockFindChannelById.mockResolvedValue(CHANNEL_WS_A)
    mockCreateChannel.mockResolvedValue({ ...CHANNEL_WS_A, id: 'new-chan' })
    mockUpdateChannelStatus.mockResolvedValue(undefined)
    mockDeleteChannel.mockResolvedValue(undefined)
  })

  // ---- GET /channels -------------------------------------------------------

  it('GET /channels — no Authorization header → 401', async () => {
    setupClient(false)
    const { GET } = await import('@/app/api/whatsapp/channels/route')
    const res = await GET(makeRequest('GET', '/api/whatsapp/channels'))
    expect(res.status).toBe(401)
  })

  it('GET /channels — invalid/unknown key → 401', async () => {
    setupClient(false)
    const { GET } = await import('@/app/api/whatsapp/channels/route')
    const res = await GET(makeRequest('GET', '/api/whatsapp/channels', { auth: INVALID_BEARER }))
    expect(res.status).toBe(401)
  })

  it('GET /channels — valid key uses auth.workspace_id, ignores query workspace_id', async () => {
    setupClient(true, 'ws-from-token')
    const { GET } = await import('@/app/api/whatsapp/channels/route')
    const res = await GET(makeRequest('GET', '/api/whatsapp/channels', {
      auth: VALID_BEARER,
      search: { workspace_id: 'ws-attacker' },
    }))
    expect(res.status).toBe(200)
    expect(mockFindChannelsByWorkspace).toHaveBeenCalledWith(expect.anything(), 'ws-from-token')
    expect(mockFindChannelsByWorkspace).not.toHaveBeenCalledWith(expect.anything(), 'ws-attacker')
  })

  // ---- POST /channels ------------------------------------------------------

  it('POST /channels — no Authorization header → 401', async () => {
    setupClient(false)
    const { POST } = await import('@/app/api/whatsapp/channels/route')
    const res = await POST(makeRequest('POST', '/api/whatsapp/channels', {
      body: { name: 'Chan', provider: 'META_CLOUD', credentials: {} },
    }))
    expect(res.status).toBe(401)
  })

  it('POST /channels — invalid key → 401', async () => {
    setupClient(false)
    const { POST } = await import('@/app/api/whatsapp/channels/route')
    const res = await POST(makeRequest('POST', '/api/whatsapp/channels', {
      auth: INVALID_BEARER,
      body: { name: 'Chan', provider: 'META_CLOUD', credentials: {} },
    }))
    expect(res.status).toBe(401)
  })

  it('POST /channels — uses auth.workspace_id, ignores body workspace_id', async () => {
    setupClient(true, 'ws-from-token')
    const { POST } = await import('@/app/api/whatsapp/channels/route')
    const res = await POST(makeRequest('POST', '/api/whatsapp/channels', {
      auth: VALID_BEARER,
      // Attacker tries to inject a different workspace_id — must be ignored
      body: {
        name: 'Chan',
        provider: 'META_CLOUD',
        credentials: { access_token: 'EAAB', phone_number_id: '12345678' },
        workspace_id: 'ws-attacker',
      },
    }))
    // 201 = success; adapter mock returns { external_instance_id: 'ext-1' }
    expect(res.status).toBe(201)
    expect(mockCreateChannel).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ workspace_id: 'ws-from-token' }),
    )
    expect(mockCreateChannel).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ workspace_id: 'ws-attacker' }),
    )
  })

  // ---- GET /channels/:id ---------------------------------------------------

  it('GET /channels/:id — no Authorization header → 401', async () => {
    setupClient(false)
    const { GET } = await import('@/app/api/whatsapp/channels/[id]/route')
    const res = await GET(
      makeRequest('GET', '/api/whatsapp/channels/' + CHAN_UUID),
      { params: Promise.resolve({ id: CHAN_UUID }) },
    )
    expect(res.status).toBe(401)
  })

  it('GET /channels/:id — channel belongs to a different workspace → 403', async () => {
    setupClient(true, 'ws-A')
    mockFindChannelById.mockResolvedValue(CHANNEL_WS_B)  // channel is owned by ws-B
    const { GET } = await import('@/app/api/whatsapp/channels/[id]/route')
    const res = await GET(
      makeRequest('GET', '/api/whatsapp/channels/' + CHAN_UUID, { auth: VALID_BEARER }),
      { params: Promise.resolve({ id: CHAN_UUID }) },
    )
    expect(res.status).toBe(403)
  })

  // ---- POST /channels/:id/connect ------------------------------------------

  it('POST /channels/:id/connect — no Authorization header → 401', async () => {
    setupClient(false)
    const { POST } = await import('@/app/api/whatsapp/channels/[id]/connect/route')
    const res = await POST(
      makeRequest('POST', '/api/whatsapp/channels/' + CHAN_UUID + '/connect'),
      { params: Promise.resolve({ id: CHAN_UUID }) },
    )
    expect(res.status).toBe(401)
  })

  it('POST /channels/:id/connect — channel belongs to a different workspace → 403', async () => {
    setupClient(true, 'ws-A')
    mockFindChannelById.mockResolvedValue(CHANNEL_WS_B)
    const { POST } = await import('@/app/api/whatsapp/channels/[id]/connect/route')
    const res = await POST(
      makeRequest('POST', '/api/whatsapp/channels/' + CHAN_UUID + '/connect', { auth: VALID_BEARER }),
      { params: Promise.resolve({ id: CHAN_UUID }) },
    )
    expect(res.status).toBe(403)
  })

  // ---- GET /channels/:id/status --------------------------------------------

  it('GET /channels/:id/status — no Authorization header → 401', async () => {
    setupClient(false)
    const { GET } = await import('@/app/api/whatsapp/channels/[id]/status/route')
    const res = await GET(
      makeRequest('GET', '/api/whatsapp/channels/' + CHAN_UUID + '/status'),
      { params: Promise.resolve({ id: CHAN_UUID }) },
    )
    expect(res.status).toBe(401)
  })

  it('GET /channels/:id/status — channel belongs to a different workspace → 403', async () => {
    setupClient(true, 'ws-A')
    mockFindChannelById.mockResolvedValue(CHANNEL_WS_B)
    const { GET } = await import('@/app/api/whatsapp/channels/[id]/status/route')
    const res = await GET(
      makeRequest('GET', '/api/whatsapp/channels/' + CHAN_UUID + '/status', { auth: VALID_BEARER }),
      { params: Promise.resolve({ id: CHAN_UUID }) },
    )
    expect(res.status).toBe(403)
  })

  // ---- POST /channels/:id/disconnect ---------------------------------------

  it('POST /channels/:id/disconnect — no Authorization header → 401', async () => {
    setupClient(false)
    const { POST } = await import('@/app/api/whatsapp/channels/[id]/disconnect/route')
    const res = await POST(
      makeRequest('POST', '/api/whatsapp/channels/' + CHAN_UUID + '/disconnect'),
      { params: Promise.resolve({ id: CHAN_UUID }) },
    )
    expect(res.status).toBe(401)
  })

  it('POST /channels/:id/disconnect — channel belongs to a different workspace → 403', async () => {
    setupClient(true, 'ws-A')
    mockFindChannelById.mockResolvedValue(CHANNEL_WS_B)
    const { POST } = await import('@/app/api/whatsapp/channels/[id]/disconnect/route')
    const res = await POST(
      makeRequest('POST', '/api/whatsapp/channels/' + CHAN_UUID + '/disconnect', { auth: VALID_BEARER }),
      { params: Promise.resolve({ id: CHAN_UUID }) },
    )
    expect(res.status).toBe(403)
  })

  // ---- POST /channels/:id/send ---------------------------------------------

  it('POST /channels/:id/send — no Authorization header → 401', async () => {
    setupClient(false)
    const { POST } = await import('@/app/api/whatsapp/channels/[id]/send/route')
    const res = await POST(
      makeRequest('POST', '/api/whatsapp/channels/' + CHAN_UUID + '/send', {
        body: { to: '5511900000001', message: 'Ola' },
      }),
      { params: Promise.resolve({ id: CHAN_UUID }) },
    )
    expect(res.status).toBe(401)
  })

  it('POST /channels/:id/send — channel belongs to a different workspace → 403', async () => {
    setupClient(true, 'ws-A')
    mockFindChannelById.mockResolvedValue(CHANNEL_WS_B)
    const { POST } = await import('@/app/api/whatsapp/channels/[id]/send/route')
    const res = await POST(
      makeRequest('POST', '/api/whatsapp/channels/' + CHAN_UUID + '/send', {
        auth: VALID_BEARER,
        body: { to: '5511900000001', message: 'Ola' },
      }),
      { params: Promise.resolve({ id: CHAN_UUID }) },
    )
    expect(res.status).toBe(403)
  })

  // ---- Invalid UUID :id → 400 (no DB hit) ----------------------------------
  // UUID validation fires before pool.connect(), so no auth setup needed.

  it('GET /channels/not-uuid → 400', async () => {
    const { GET } = await import('@/app/api/whatsapp/channels/[id]/route')
    const res = await GET(
      makeRequest('GET', '/api/whatsapp/channels/not-uuid'),
      { params: Promise.resolve({ id: 'not-uuid' }) },
    )
    expect(res.status).toBe(400)
    expect(mockConnect).not.toHaveBeenCalled()
  })

  it('POST /channels/not-uuid/connect → 400', async () => {
    const { POST } = await import('@/app/api/whatsapp/channels/[id]/connect/route')
    const res = await POST(
      makeRequest('POST', '/api/whatsapp/channels/not-uuid/connect'),
      { params: Promise.resolve({ id: 'not-uuid' }) },
    )
    expect(res.status).toBe(400)
    expect(mockConnect).not.toHaveBeenCalled()
  })

  it('POST /channels/not-uuid/disconnect → 400', async () => {
    const { POST } = await import('@/app/api/whatsapp/channels/[id]/disconnect/route')
    const res = await POST(
      makeRequest('POST', '/api/whatsapp/channels/not-uuid/disconnect'),
      { params: Promise.resolve({ id: 'not-uuid' }) },
    )
    expect(res.status).toBe(400)
    expect(mockConnect).not.toHaveBeenCalled()
  })

  it('GET /channels/not-uuid/status → 400', async () => {
    const { GET } = await import('@/app/api/whatsapp/channels/[id]/status/route')
    const res = await GET(
      makeRequest('GET', '/api/whatsapp/channels/not-uuid/status'),
      { params: Promise.resolve({ id: 'not-uuid' }) },
    )
    expect(res.status).toBe(400)
    expect(mockConnect).not.toHaveBeenCalled()
  })

  it('POST /channels/not-uuid/send → 400', async () => {
    const { POST } = await import('@/app/api/whatsapp/channels/[id]/send/route')
    const res = await POST(
      makeRequest('POST', '/api/whatsapp/channels/not-uuid/send', {
        body: { to: '5511900000001', message: 'Ola' },
      }),
      { params: Promise.resolve({ id: 'not-uuid' }) },
    )
    expect(res.status).toBe(400)
    expect(mockConnect).not.toHaveBeenCalled()
  })

  it('POST /channels/not-uuid/send-media → 400', async () => {
    const { POST } = await import('@/app/api/whatsapp/channels/[id]/send-media/route')
    const res = await POST(
      makeRequest('POST', '/api/whatsapp/channels/not-uuid/send-media'),
      { params: Promise.resolve({ id: 'not-uuid' }) },
    )
    expect(res.status).toBe(400)
    expect(mockConnect).not.toHaveBeenCalled()
  })

  it('POST /channels/not-uuid/send-reaction → 400', async () => {
    const { POST } = await import('@/app/api/whatsapp/channels/[id]/send-reaction/route')
    const res = await POST(
      makeRequest('POST', '/api/whatsapp/channels/not-uuid/send-reaction', {
        body: { to: '5511900000001', emoji: '👍', target_provider_message_id: 'msg-x' },
      }),
      { params: Promise.resolve({ id: 'not-uuid' }) },
    )
    expect(res.status).toBe(400)
    expect(mockConnect).not.toHaveBeenCalled()
  })

  it('POST /channels/not-uuid/send-media → 400 even when MEDIA_STORAGE_ENABLED=false', async () => {
    // UUID check now fires before the feature flag, so invalid id → 400 regardless of env
    mediaEnabled = false
    const { POST } = await import('@/app/api/whatsapp/channels/[id]/send-media/route')
    const res = await POST(
      makeRequest('POST', '/api/whatsapp/channels/not-uuid/send-media'),
      { params: Promise.resolve({ id: 'not-uuid' }) },
    )
    expect(res.status).toBe(400)
    expect(mockConnect).not.toHaveBeenCalled()
  })
})

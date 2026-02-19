// ---------------------------------------------------------------------------
// Security tests — webhook route path validation
//
// Tests the HTTP route handler (not processWebhook() internals — that is covered
// by webhook-hmac.test.ts). Verifies that invalid path params (bad UUID or
// unknown provider) are rejected with 400 before any DB access occurs.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ---------------------------------------------------------------------------
// Module mocks — declared before importing route handlers
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
  whatsappWebhookLimiter: {
    check: vi.fn().mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 }),
  },
}))

// Mock webhook-handler to avoid deep dependency chain in path-validation tests
vi.mock('@/lib/whatsapp/webhook-handler', () => ({
  processWebhook: vi.fn(),
  handleInboundMessage: vi.fn(),
  handleStatusUpdate: vi.fn(),
  ChannelNotFoundError: class ChannelNotFoundError extends Error {},
  ProviderMismatchError: class ProviderMismatchError extends Error {},
  SignatureInvalidError: class SignatureInvalidError extends Error {},
}))

vi.mock('@/lib/whatsapp/channel-repo', () => ({
  findChannelById: vi.fn(),
}))

vi.mock('@/lib/whatsapp/crypto', () => ({
  safeCompare: vi.fn(),
  encryptCredentials: vi.fn().mockReturnValue('iv:tag:blob'),
  decryptCredentials: vi.fn().mockReturnValue({}),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_CHANNEL_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function makeGetRequest(provider: string, channelId: string): NextRequest {
  const url = `http://localhost/api/whatsapp/webhook/${provider}/${channelId}`
    + '?hub.mode=subscribe&hub.verify_token=tok&hub.challenge=ch'
  return new NextRequest(url)
}

function makePostRequest(provider: string, channelId: string): NextRequest {
  return new NextRequest(
    `http://localhost/api/whatsapp/webhook/${provider}/${channelId}`,
    { method: 'POST', body: '{}' },
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Security: webhook route path validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ---- GET: invalid channelId UUID ----------------------------------------

  it('GET /webhook/meta/not-uuid → 400, no DB hit', async () => {
    const { GET } = await import('@/app/api/whatsapp/webhook/[provider]/[channelId]/route')
    const res = await GET(
      makeGetRequest('meta', 'not-uuid'),
      { params: Promise.resolve({ provider: 'meta', channelId: 'not-uuid' }) },
    )
    expect(res.status).toBe(400)
    expect(mockConnect).not.toHaveBeenCalled()
  })

  it('GET /webhook/META_CLOUD/not-uuid → 400, no DB hit', async () => {
    const { GET } = await import('@/app/api/whatsapp/webhook/[provider]/[channelId]/route')
    const res = await GET(
      makeGetRequest('META_CLOUD', 'not-uuid'),
      { params: Promise.resolve({ provider: 'META_CLOUD', channelId: 'not-uuid' }) },
    )
    expect(res.status).toBe(400)
    expect(mockConnect).not.toHaveBeenCalled()
  })

  it('GET /webhook/unknown-provider/<uuid> → 400 (unknown provider rejected by schema)', async () => {
    const { GET } = await import('@/app/api/whatsapp/webhook/[provider]/[channelId]/route')
    const res = await GET(
      makeGetRequest('unknown-provider', VALID_CHANNEL_UUID),
      { params: Promise.resolve({ provider: 'unknown-provider', channelId: VALID_CHANNEL_UUID }) },
    )
    expect(res.status).toBe(400)
    expect(mockConnect).not.toHaveBeenCalled()
  })

  // ---- POST: invalid channelId UUID ---------------------------------------

  it('POST /webhook/meta/not-uuid → 400, no DB hit', async () => {
    const { POST } = await import('@/app/api/whatsapp/webhook/[provider]/[channelId]/route')
    const res = await POST(
      makePostRequest('meta', 'not-uuid'),
      { params: Promise.resolve({ provider: 'meta', channelId: 'not-uuid' }) },
    )
    expect(res.status).toBe(400)
    expect(mockConnect).not.toHaveBeenCalled()
  })

  it('POST /webhook/META_CLOUD/not-uuid → 400, no DB hit', async () => {
    const { POST } = await import('@/app/api/whatsapp/webhook/[provider]/[channelId]/route')
    const res = await POST(
      makePostRequest('META_CLOUD', 'not-uuid'),
      { params: Promise.resolve({ provider: 'META_CLOUD', channelId: 'not-uuid' }) },
    )
    expect(res.status).toBe(400)
    expect(mockConnect).not.toHaveBeenCalled()
  })
})

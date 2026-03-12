// ---------------------------------------------------------------------------
// TDD — Cenário 21: Rate Limits em todas as rotas do Inbox
//
// send, send-media, conversations, webhook → retornam 429 com Retry-After
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ---------------------------------------------------------------------------
// Mocks de rate limiters — TODOS em um único vi.mock para evitar conflitos
// ---------------------------------------------------------------------------

const mockSendCheck = vi.fn()
const mockMediaCheck = vi.fn()
const mockConvCheck = vi.fn()
const mockWebhookCheck = vi.fn()
const mockInboxCheck = vi.fn()
const mockChannelCheck = vi.fn()
const mockSyncCheck = vi.fn()

vi.mock('@/lib/rate-limit', () => ({
  whatsappSendLimiter: { check: mockSendCheck },
  whatsappMediaLimiter: { check: mockMediaCheck },
  whatsappConversationLimiter: { check: mockConvCheck },
  whatsappWebhookLimiter: { check: mockWebhookCheck },
  whatsappInboxLimiter: { check: mockInboxCheck },
  whatsappChannelLimiter: { check: mockChannelCheck },
  whatsappTemplateSyncLimiter: { check: mockSyncCheck },
}))

vi.mock('@/lib/get-ip', () => ({ getClientIp: vi.fn().mockReturnValue('10.0.0.99') }))

// Auth, DB e outros — não chegam a ser chamados quando rate limit bloqueia
const mockRequireWorkspaceAuth = vi.fn()
vi.mock('@/lib/whatsapp/auth-middleware', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/whatsapp/auth-middleware')>()
  return { ...actual, requireWorkspaceAuth: mockRequireWorkspaceAuth }
})

vi.mock('@/lib/database', () => ({
  default: { connect: vi.fn().mockResolvedValue({ query: vi.fn(), release: vi.fn() }) },
}))

vi.mock('@/lib/whatsapp/channel-repo', () => ({
  findChannelById: vi.fn(),
  findChannelsByWorkspace: vi.fn(),
}))

vi.mock('@/lib/whatsapp/conversation-repo', () => ({
  findConversationsByWorkspace: vi.fn(),
  findConversationById: vi.fn(),
  upsertConversation: vi.fn(),
}))

vi.mock('@/lib/whatsapp/message-repo', () => ({
  findMessagesByConversation: vi.fn(),
  insertMessage: vi.fn(),
}))

vi.mock('@/lib/whatsapp/media', () => ({
  validateMediaFile: vi.fn(),
  uploadMedia: vi.fn(),
  getSignedUrl: vi.fn(),
}))

vi.mock('@/lib/whatsapp/audit-repo', () => ({ insertAuditEvent: vi.fn() }))
vi.mock('@/lib/whatsapp/template-repo', () => ({ listTemplates: vi.fn(), getTemplateVariables: vi.fn(), syncTemplatesInTransaction: vi.fn() }))
vi.mock('@/lib/whatsapp/crypto', () => ({ decryptCredentials: vi.fn(), safeCompare: vi.fn() }))
vi.mock('@/lib/whatsapp/adapters/factory', () => ({ getAdapter: vi.fn().mockReturnValue({ sendMessage: vi.fn(), sendMedia: vi.fn(), sendTemplate: vi.fn(), verifyWebhookSignature: vi.fn(), normalizeEvent: vi.fn() }) }))
vi.mock('@/lib/logger', () => ({
  logger: { child: vi.fn().mockReturnValue({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}))

// ---------------------------------------------------------------------------
// Import routes AFTER mocks
// ---------------------------------------------------------------------------

const { GET: conversationsRoute } = await import('@/app/api/whatsapp/conversations/route')
const { GET: messagesRoute, POST: messagesPostRoute } = await import(
  '@/app/api/whatsapp/conversations/[id]/messages/route'
)
const { GET: mediaRoute } = await import('@/app/api/whatsapp/media/[messageId]/route')
const { POST: sendTemplateRoute } = await import(
  '@/app/api/whatsapp/channels/[id]/send-template/route'
)
const { POST: sendMediaRoute } = await import(
  '@/app/api/whatsapp/channels/[id]/send-media/route'
)
const { POST: webhookRoute } = await import(
  '@/app/api/whatsapp/webhook/[provider]/[channelId]/route'
)
const { GET: templatesRoute } = await import('@/app/api/whatsapp/channels/[id]/templates/route')
const { POST: syncRoute } = await import(
  '@/app/api/whatsapp/channels/[id]/templates/sync/route'
)
const { GET: varsRoute } = await import(
  '@/app/api/whatsapp/channels/[id]/templates/[templateId]/variables/route'
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CHANNEL_ID = 'ch-rl-1111-1111-4111-8111-111111111111'
const CONV_ID = 'conv-rl-2222-2222-4222-8222-222222222222'
const MSG_ID = 'msg-rl-3333-3333-4333-8333-333333333333'
const TEMPLATE_ID = 'tpl-rl-4444-4444-4444-8444-444444444444'

const RATE_LIMITED = { success: false, resetAt: Date.now() + 30_000 }

function authHeader() {
  return { Authorization: `Bearer wk_${'a'.repeat(64)}` }
}

function jsonHeader() {
  return { ...authHeader(), 'Content-Type': 'application/json' }
}

function assertRateLimit(res: Response) {
  expect(res.status).toBe(429)
  expect(res.headers.get('Retry-After')).toBeTruthy()
  const retryAfter = Number(res.headers.get('Retry-After'))
  expect(retryAfter).toBeGreaterThan(0)
}

beforeEach(() => {
  vi.clearAllMocks()
  // All limiters pass by default; individual tests override
  mockSendCheck.mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 })
  mockMediaCheck.mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 })
  mockConvCheck.mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 })
  mockWebhookCheck.mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 })
  mockInboxCheck.mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 })
  mockChannelCheck.mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 })
  mockSyncCheck.mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 })
})

// ---------------------------------------------------------------------------
// Rate limit: GET /conversations
// ---------------------------------------------------------------------------

describe('Rate limit — GET /conversations', () => {
  it('retorna 429 com Retry-After quando limitado', async () => {
    mockConvCheck.mockResolvedValue(RATE_LIMITED)

    const res = await conversationsRoute(
      new NextRequest('http://localhost/api/whatsapp/conversations', {
        method: 'GET',
        headers: authHeader(),
      }),
    )

    assertRateLimit(res)
  })
})

// ---------------------------------------------------------------------------
// Rate limit: GET + POST /conversations/:id/messages
// ---------------------------------------------------------------------------

describe('Rate limit — GET /conversations/:id/messages', () => {
  it('retorna 429 quando inbox limiter está esgotado', async () => {
    mockInboxCheck.mockResolvedValue(RATE_LIMITED)

    const res = await messagesRoute(
      new NextRequest(`http://localhost/api/whatsapp/conversations/${CONV_ID}/messages`, {
        method: 'GET',
        headers: authHeader(),
      }),
      { params: Promise.resolve({ id: CONV_ID }) },
    )

    assertRateLimit(res)
  })
})

describe('Rate limit — POST /conversations/:id/messages', () => {
  it('retorna 429 quando inbox limiter está esgotado', async () => {
    mockInboxCheck.mockResolvedValue(RATE_LIMITED)

    const res = await messagesPostRoute(
      new NextRequest(`http://localhost/api/whatsapp/conversations/${CONV_ID}/messages`, {
        method: 'POST',
        headers: jsonHeader(),
        body: JSON.stringify({ text: 'teste' }),
      }),
      { params: Promise.resolve({ id: CONV_ID }) },
    )

    assertRateLimit(res)
  })
})

// ---------------------------------------------------------------------------
// Rate limit: GET /media/:messageId
// ---------------------------------------------------------------------------

describe('Rate limit — GET /media/:messageId', () => {
  it('retorna 429 com Retry-After quando inbox limiter está esgotado', async () => {
    mockInboxCheck.mockResolvedValue(RATE_LIMITED)

    const res = await mediaRoute(
      new NextRequest(`http://localhost/api/whatsapp/media/${MSG_ID}`, {
        method: 'GET',
        headers: authHeader(),
      }),
      { params: Promise.resolve({ messageId: MSG_ID }) },
    )

    assertRateLimit(res)
  })
})

// ---------------------------------------------------------------------------
// Rate limit: POST /send-template
// ---------------------------------------------------------------------------

describe('Rate limit — POST /send-template', () => {
  it('retorna 429 quando send limiter está esgotado', async () => {
    mockSendCheck.mockResolvedValue(RATE_LIMITED)

    const res = await sendTemplateRoute(
      new NextRequest(
        `http://localhost/api/whatsapp/channels/${CHANNEL_ID}/send-template`,
        {
          method: 'POST',
          headers: jsonHeader(),
          body: JSON.stringify({ to: '+5511', name: 'tpl', language: 'pt_BR' }),
        },
      ),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )

    assertRateLimit(res)
  })
})

// ---------------------------------------------------------------------------
// Rate limit: POST /send-media
// ---------------------------------------------------------------------------

describe('Rate limit — POST /send-media', () => {
  it('retorna 429 quando media limiter está esgotado', async () => {
    mockMediaCheck.mockResolvedValue(RATE_LIMITED)

    const fd = new FormData()
    fd.set('to', '+5511')
    fd.set('type', 'image')
    fd.set('file', new File([new Uint8Array(10)], 'test.jpg', { type: 'image/jpeg' }))

    const res = await sendMediaRoute(
      new NextRequest(
        `http://localhost/api/whatsapp/channels/${CHANNEL_ID}/send-media`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer wk_${'a'.repeat(64)}` },
          body: fd,
        },
      ),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )

    assertRateLimit(res)
  })
})

// ---------------------------------------------------------------------------
// Rate limit: POST /webhook/:provider/:channelId
// ---------------------------------------------------------------------------

describe('Rate limit — POST /webhook', () => {
  it('retorna 429 quando webhook limiter está esgotado', async () => {
    mockWebhookCheck.mockResolvedValue(RATE_LIMITED)

    const res = await webhookRoute(
      new NextRequest(
        `http://localhost/api/whatsapp/webhook/META_CLOUD/${CHANNEL_ID}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ object: 'whatsapp_business_account' }),
        },
      ),
      { params: Promise.resolve({ provider: 'META_CLOUD', channelId: CHANNEL_ID }) },
    )

    assertRateLimit(res)
  })
})

// ---------------------------------------------------------------------------
// Rate limit: GET /templates
// ---------------------------------------------------------------------------

describe('Rate limit — GET /templates', () => {
  it('retorna 429 quando channel limiter está esgotado', async () => {
    mockChannelCheck.mockResolvedValue(RATE_LIMITED)

    const res = await templatesRoute(
      new NextRequest(`http://localhost/api/whatsapp/channels/${CHANNEL_ID}/templates`, {
        method: 'GET',
        headers: authHeader(),
      }),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )

    assertRateLimit(res)
  })
})

// ---------------------------------------------------------------------------
// Rate limit: POST /templates/sync
// ---------------------------------------------------------------------------

describe('Rate limit — POST /templates/sync', () => {
  it('retorna 429 quando sync limiter está esgotado', async () => {
    mockSyncCheck.mockResolvedValue(RATE_LIMITED)

    const res = await syncRoute(
      new NextRequest(
        `http://localhost/api/whatsapp/channels/${CHANNEL_ID}/templates/sync`,
        { method: 'POST', headers: authHeader() },
      ),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )

    assertRateLimit(res)
  })
})

// ---------------------------------------------------------------------------
// Rate limit: GET /templates/:id/variables
// ---------------------------------------------------------------------------

describe('Rate limit — GET /templates/:id/variables', () => {
  it('retorna 429 quando channel limiter está esgotado', async () => {
    mockChannelCheck.mockResolvedValue(RATE_LIMITED)

    const res = await varsRoute(
      new NextRequest(
        `http://localhost/api/whatsapp/channels/${CHANNEL_ID}/templates/${TEMPLATE_ID}/variables`,
        { method: 'GET', headers: authHeader() },
      ),
      { params: Promise.resolve({ id: CHANNEL_ID, templateId: TEMPLATE_ID }) },
    )

    assertRateLimit(res)
  })
})

// ---------------------------------------------------------------------------
// Cabeçalho Retry-After é numérico e positivo
// ---------------------------------------------------------------------------

describe('Rate limit — Retry-After header format', () => {
  it('Retry-After é um número inteiro positivo de segundos', async () => {
    const resetAt = Date.now() + 45_000 // 45s no futuro
    mockConvCheck.mockResolvedValue({ success: false, resetAt })

    const res = await conversationsRoute(
      new NextRequest('http://localhost/api/whatsapp/conversations', {
        method: 'GET',
        headers: authHeader(),
      }),
    )

    expect(res.status).toBe(429)
    const retryAfter = res.headers.get('Retry-After')
    expect(retryAfter).toBeTruthy()
    const seconds = Number(retryAfter)
    expect(Number.isInteger(seconds)).toBe(true)
    expect(seconds).toBeGreaterThan(0)
    expect(seconds).toBeLessThanOrEqual(60)
  })
})

// ---------------------------------------------------------------------------
// Security — Cenários 28–29: Auth Sessão Expirada + CSRF
//
// 28. Auth sessão expirada: rotas retornam 401 consistente
// 29. CSRF sessão: métodos mutáveis com origin inválida bloqueados
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ---------------------------------------------------------------------------
// Helper: injeta cookie de sessão no NextRequest (workaround happy-dom)
// ---------------------------------------------------------------------------

function withSession(request: NextRequest, token: string): NextRequest {
  Object.defineProperty(request, 'cookies', {
    get() {
      return {
        get(name: string) {
          if (name === 'session') return { name: 'session', value: token }
          return undefined
        },
      }
    },
  })
  return request
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockRelease = vi.fn()
const mockClientQuery = vi.fn()
const mockConnect = vi.fn()
vi.mock('@/lib/database', () => ({ default: { connect: mockConnect } }))

vi.mock('@/lib/get-ip', () => ({ getClientIp: vi.fn().mockReturnValue('127.0.0.1') }))

const mockInboxCheck = vi.fn()
const mockConvCheck = vi.fn()
const mockSendCheck = vi.fn()
const mockChannelCheck = vi.fn()
vi.mock('@/lib/rate-limit', () => ({
  whatsappInboxLimiter: { check: mockInboxCheck },
  whatsappConversationLimiter: { check: mockConvCheck },
  whatsappSendLimiter: { check: mockSendCheck },
  whatsappChannelLimiter: { check: mockChannelCheck },
  whatsappTemplateSyncLimiter: { check: vi.fn().mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 }) },
}))

// Mock validateWebSession: expired = returns null
const mockValidateWebSession = vi.fn()
vi.mock('@/lib/web-session', () => ({
  validateWebSession: mockValidateWebSession,
}))

// Mock validateApiKey: invalid = throws AuthError
const mockValidateApiKey = vi.fn()
vi.mock('@/lib/whatsapp/auth', () => ({
  validateApiKey: mockValidateApiKey,
}))

vi.mock('@/lib/whatsapp/conversation-repo', () => ({
  findConversationsByWorkspace: vi.fn().mockResolvedValue([]),
  findConversationById: vi.fn(),
}))
vi.mock('@/lib/whatsapp/message-repo', () => ({
  findMessagesByConversation: vi.fn().mockResolvedValue([]),
  insertMessage: vi.fn(),
}))
vi.mock('@/lib/whatsapp/channel-repo', () => ({
  findChannelById: vi.fn(),
}))
vi.mock('@/lib/whatsapp/template-repo', () => ({
  listTemplates: vi.fn().mockResolvedValue({ templates: [], total: 0 }),
}))
vi.mock('@/lib/whatsapp/crypto', () => ({ decryptCredentials: vi.fn() }))
vi.mock('@/lib/whatsapp/adapters/factory', () => ({
  getAdapter: vi.fn().mockReturnValue({ sendMessage: vi.fn(), sendTemplate: vi.fn() }),
}))
vi.mock('@/lib/whatsapp/media', () => ({ getSignedUrl: vi.fn() }))
vi.mock('@/lib/whatsapp/audit-repo', () => ({ insertAuditEvent: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { child: vi.fn().mockReturnValue({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}))

// ---------------------------------------------------------------------------
// Import auth-middleware REAL (não mockado) para testar comportamento CSRF
// ---------------------------------------------------------------------------

// Importamos as rotas que internamente chamam requireWorkspaceAuth real
const { GET: conversationsRoute } = await import('@/app/api/whatsapp/conversations/route')
const { GET: messagesGet, POST: messagesPost } = await import(
  '@/app/api/whatsapp/conversations/[id]/messages/route'
)
const { POST: sendTemplateRoute } = await import(
  '@/app/api/whatsapp/channels/[id]/send-template/route'
)
const { requireWorkspaceAuth } = await import('@/lib/whatsapp/auth-middleware')

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const CHANNEL_ID = 'ccccaaaa-1111-4111-8111-111111111111'
const CONV_ID = 'conv-auth-2222-2222-4222-8222-222222222222'
const SESSION_TOKEN = 'valid-session-token-abc123'
const EXPIRED_TOKEN = 'expired-session-xyz999'

const RATE_OK = { success: true, resetAt: Date.now() + 60_000 }

function authBearer(req: NextRequest): NextRequest { return req }
function sessionReq(url: string, method = 'GET', body?: string, origin?: string): NextRequest {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (origin) headers['origin'] = origin
  const req = new NextRequest(url, { method, headers, body })
  return withSession(req, SESSION_TOKEN)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockInboxCheck.mockResolvedValue(RATE_OK)
  mockConvCheck.mockResolvedValue(RATE_OK)
  mockSendCheck.mockResolvedValue(RATE_OK)
  mockChannelCheck.mockResolvedValue(RATE_OK)
  mockConnect.mockResolvedValue({ query: mockClientQuery, release: mockRelease })
  mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  // Default: no valid session, no valid API key
  mockValidateWebSession.mockResolvedValue(null)
  mockValidateApiKey.mockResolvedValue(null)
})

// ---------------------------------------------------------------------------
// Cenário 28 — Auth sessão expirada → 401 consistente
// ---------------------------------------------------------------------------

describe('Cenário 28 — Sessão expirada retorna 401', () => {
  it('GET /conversations sem auth retorna 401', async () => {
    const res = await conversationsRoute(
      new NextRequest('http://localhost/api/whatsapp/conversations', {
        method: 'GET',
        headers: {},
      }),
    )

    expect(res.status).toBe(401)
  })

  it('GET /conversations com sessão expirada (validateWebSession=null) retorna 401', async () => {
    mockValidateWebSession.mockResolvedValue(null) // sessão inválida

    const req = withSession(
      new NextRequest('http://localhost/api/whatsapp/conversations', { method: 'GET' }),
      EXPIRED_TOKEN,
    )

    const res = await conversationsRoute(req)
    expect(res.status).toBe(401)
  })

  it('GET /conversations/:id/messages sem auth retorna 401', async () => {
    const res = await messagesGet(
      new NextRequest(`http://localhost/api/whatsapp/conversations/${CONV_ID}/messages`, {
        method: 'GET',
      }),
      { params: Promise.resolve({ id: CONV_ID }) },
    )

    expect(res.status).toBe(401)
  })

  it('POST /conversations/:id/messages sem auth retorna 401', async () => {
    const res = await messagesPost(
      new NextRequest(`http://localhost/api/whatsapp/conversations/${CONV_ID}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'teste' }),
      }),
      { params: Promise.resolve({ id: CONV_ID }) },
    )

    expect(res.status).toBe(401)
  })

  it('POST /send-template sem auth retorna 401', async () => {
    const res = await sendTemplateRoute(
      new NextRequest(`http://localhost/api/whatsapp/channels/${CHANNEL_ID}/send-template`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: '5511999999', name: 'tpl', language: 'pt_BR' }),
      }),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )

    expect(res.status).toBe(401)
  })

  it('token Bearer inválido retorna 401 (não 500)', async () => {
    const res = await conversationsRoute(
      new NextRequest('http://localhost/api/whatsapp/conversations', {
        method: 'GET',
        headers: { Authorization: 'Bearer wk_invalidtoken' },
      }),
    )

    // Deve ser 401, não 500 nem 200
    expect([401, 403]).toContain(res.status)
    expect(res.status).not.toBe(500)
    expect(res.status).not.toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Cenário 29 — CSRF: origin inválida em métodos mutáveis com sessão cookie
// ---------------------------------------------------------------------------

describe('Cenário 29 — CSRF: origin inválida bloqueia métodos mutáveis', () => {
  beforeEach(() => {
    // Sessão válida para testes CSRF
    mockValidateWebSession.mockResolvedValue({
      user_id: 'user-csrf-test',
      workspace_id: 'ws-csrf',
      session_id: 'sess-csrf-1',
    })
  })

  it('POST com sessão cookie e origin de outro domínio retorna 401/403', async () => {
    // Direct test of requireWorkspaceAuth CSRF check
    // (NextRequest in happy-dom filters origin header; test function directly)
    const mockReq = {
      cookies: { get: (name: string) => name === 'session' ? { value: SESSION_TOKEN } : undefined },
      method: 'POST',
      headers: {
        get: (name: string) => {
          if (name === 'origin') return 'https://evil-site.com'
          if (name === 'x-forwarded-host') return null
          if (name === 'host') return 'localhost'
          if (name === 'Authorization') return null
          return null
        },
      },
    } as unknown as NextRequest

    const mockClient = {} as unknown as import('pg').PoolClient

    mockValidateWebSession.mockResolvedValue({
      user_id: 'user-csrf-test',
      workspace_id: 'ws-csrf',
      session_id: 'sess-csrf-1',
    })

    await expect(requireWorkspaceAuth(mockReq, mockClient)).rejects.toMatchObject({
      name: 'AuthError',
      message: expect.stringMatching(/cross-origin|csrf/i),
    })
  })

  it('POST com sessão cookie e origin malformada retorna 401', async () => {
    const mockReq = {
      cookies: { get: (name: string) => name === 'session' ? { value: SESSION_TOKEN } : undefined },
      method: 'POST',
      headers: {
        get: (name: string) => {
          if (name === 'origin') return 'not-a-valid-url'
          if (name === 'x-forwarded-host') return null
          if (name === 'host') return 'localhost'
          if (name === 'Authorization') return null
          return null
        },
      },
    } as unknown as NextRequest

    const mockClient = {} as unknown as import('pg').PoolClient

    mockValidateWebSession.mockResolvedValue({
      user_id: 'user-csrf-test',
      workspace_id: 'ws-csrf',
      session_id: 'sess-csrf-1',
    })

    await expect(requireWorkspaceAuth(mockReq, mockClient)).rejects.toMatchObject({
      name: 'AuthError',
    })
  })

  it('GET com sessão cookie NÃO é bloqueado por CSRF (método seguro)', async () => {
    // GET é safe method — CSRF não deve bloquear
    const req = withSession(
      new NextRequest('http://localhost/api/whatsapp/conversations', {
        method: 'GET',
        headers: { origin: 'https://evil-site.com' }, // origin diferente, mas GET é safe
      }),
      SESSION_TOKEN,
    )

    const res = await conversationsRoute(req)

    // GET com origin inválida deve passar CSRF (GET é safe)
    // mas pode falhar por outros motivos (workspace_id etc.)
    // O importante: não é 403 por CSRF, pode ser 401 por workspace
    expect(res.status).not.toBe(403) // CSRF não deve bloquear GET
  })

  it('POST com Bearer token não é bloqueado por CSRF (Bearer é CSRF-safe)', async () => {
    // Bearer token é imune a CSRF — mesmo com origin diferente, deve passar auth
    // (pode falhar por motivos de negócio depois, mas não por CSRF)
    mockValidateApiKey.mockResolvedValue({
      workspace_id: 'ws-csrf',
      actor: 'api_key:test',
      key_id: 'k-csrf',
      dedup_actor_id: 'api_key:k-csrf',
    })

    const res = await sendTemplateRoute(
      new NextRequest(`http://localhost/api/whatsapp/channels/${CHANNEL_ID}/send-template`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer wk_${'a'.repeat(64)}`,
          'Content-Type': 'application/json',
          'origin': 'https://evil-site.com', // origin diferente não importa para Bearer
        },
        body: JSON.stringify({ to: '+5511', name: 'tpl', language: 'pt_BR' }),
      }),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )

    // Com Bearer token, CSRF não deve bloquear (pode falhar por canal não encontrado → 404)
    expect(res.status).not.toBe(401) // não deve ser bloqueado por CSRF
  })
})

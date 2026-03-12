// ---------------------------------------------------------------------------
// Security — Cenário 27: Segurança Multi-Tenant
//
// Todas as rotas de conversa/mensagem/mídia/template bloqueiam acesso
// cross-workspace com 403. workspace_id nunca vem de query/body.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockRelease = vi.fn()
const mockClientQuery = vi.fn()
const mockConnect = vi.fn()
vi.mock('@/lib/database', () => ({ default: { connect: mockConnect } }))

vi.mock('@/lib/get-ip', () => ({ getClientIp: vi.fn().mockReturnValue('10.0.0.55') }))

const mockInboxCheck = vi.fn()
const mockSendCheck = vi.fn()
const mockMediaCheck = vi.fn()
const mockChannelCheck = vi.fn()
const mockSyncCheck = vi.fn()
vi.mock('@/lib/rate-limit', () => ({
  whatsappInboxLimiter: { check: mockInboxCheck },
  whatsappSendLimiter: { check: mockSendCheck },
  whatsappMediaLimiter: { check: mockMediaCheck },
  whatsappChannelLimiter: { check: mockChannelCheck },
  whatsappTemplateSyncLimiter: { check: mockSyncCheck },
}))

const mockRequireWorkspaceAuth = vi.fn()
vi.mock('@/lib/whatsapp/auth-middleware', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/whatsapp/auth-middleware')>()
  return { ...actual, requireWorkspaceAuth: mockRequireWorkspaceAuth }
})

const mockFindConversationById = vi.fn()
vi.mock('@/lib/whatsapp/conversation-repo', () => ({
  findConversationById: mockFindConversationById,
  findConversationsByWorkspace: vi.fn().mockResolvedValue([]),
}))

const mockFindMessageById = vi.fn()
vi.mock('@/lib/whatsapp/message-repo', () => ({
  findMessageById: mockFindMessageById,
  findMessagesByConversation: vi.fn().mockResolvedValue([]),
  insertMessage: vi.fn().mockResolvedValue({ id: 'msg-1' }),
}))

const mockFindChannelById = vi.fn()
vi.mock('@/lib/whatsapp/channel-repo', () => ({
  findChannelById: mockFindChannelById,
  findChannelsByWorkspace: vi.fn().mockResolvedValue([]),
}))

const mockFindConversationByIdForMedia = vi.fn()
// conversation-repo já está mockado acima; findConversationById serve ambos

vi.mock('@/lib/whatsapp/template-repo', () => ({
  listTemplates: vi.fn().mockResolvedValue({ templates: [], total: 0 }),
  getTemplateVariables: vi.fn().mockResolvedValue({ id: 't1', variables: [], variables_count: 0 }),
}))

vi.mock('@/lib/whatsapp/crypto', () => ({ decryptCredentials: vi.fn().mockReturnValue({ token: 'tok' }) }))
vi.mock('@/lib/whatsapp/adapters/factory', () => ({
  getAdapter: vi.fn().mockReturnValue({
    sendMessage: vi.fn().mockResolvedValue({ message_id: 'wamid.ok' }),
    sendTemplate: vi.fn().mockResolvedValue({ message_id: 'wamid.ok' }),
  }),
}))
vi.mock('@/lib/whatsapp/media', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://s3/url'),
  validateMediaFile: vi.fn(),
  uploadMedia: vi.fn().mockResolvedValue({ s3Key: 'whatsapp/ch/uuid.jpg' }),
}))
vi.mock('@/lib/whatsapp/audit-repo', () => ({ insertAuditEvent: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { child: vi.fn().mockReturnValue({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}))

// ---------------------------------------------------------------------------
// Import routes AFTER mocks
// ---------------------------------------------------------------------------

const { GET: messagesRoute, POST: messagesPost } = await import(
  '@/app/api/whatsapp/conversations/[id]/messages/route'
)
const { GET: mediaRoute } = await import('@/app/api/whatsapp/media/[messageId]/route')
const { POST: sendTemplateRoute } = await import(
  '@/app/api/whatsapp/channels/[id]/send-template/route'
)
const { GET: listTemplatesRoute } = await import(
  '@/app/api/whatsapp/channels/[id]/templates/route'
)

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const WS_A = 'ws-tenant-a'
const WS_B = 'ws-tenant-b'

const CHANNEL_A = 'aa111111-1111-4111-8111-111111111111'
const CHANNEL_B = 'bb222222-2222-4222-8222-222222222222'
const CONV_A = 'cva-3333-3333-4333-8333-333333333333'
const CONV_B = 'cvb-4444-4444-4444-8444-444444444444'
const MSG_B = 'msg-b555-5555-5555-8555-555555555555'

const AUTH_A = { workspace_id: WS_A, actor: 'api_key:a', key_id: 'k-a', dedup_actor_id: 'api_key:k-a' }

function makeConv(workspace_id: string, conv_id: string, channel_id: string) {
  return { id: conv_id, channel_id, workspace_id, contact_phone: '+5511', status: 'open', unread_count: 0, ai_enabled: false }
}

function makeChannel(workspace_id: string, channel_id: string, provider = 'META_CLOUD') {
  return {
    id: channel_id,
    workspace_id,
    provider,
    status: 'CONNECTED',
    credentials_encrypted: 'enc',
    name: 'Canal Test',
  }
}

function makeMsg(conv_id: string, s3Key = 'whatsapp/ch/uuid.jpg') {
  return { id: MSG_B, conversation_id: conv_id, channel_id: CHANNEL_B, direction: 'inbound', message_type: 'image', status: 'delivered', media_s3_key: s3Key }
}

function authGet(url: string) {
  return new NextRequest(url, { method: 'GET', headers: { Authorization: `Bearer wk_${'a'.repeat(64)}` } })
}

function authPost(url: string, body: unknown) {
  return new NextRequest(url, {
    method: 'POST',
    headers: { Authorization: `Bearer wk_${'a'.repeat(64)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const RATE_OK = { success: true, resetAt: Date.now() + 60_000 }

beforeEach(() => {
  vi.clearAllMocks()
  mockInboxCheck.mockResolvedValue(RATE_OK)
  mockSendCheck.mockResolvedValue(RATE_OK)
  mockMediaCheck.mockResolvedValue(RATE_OK)
  mockChannelCheck.mockResolvedValue(RATE_OK)
  mockSyncCheck.mockResolvedValue(RATE_OK)
  mockRequireWorkspaceAuth.mockResolvedValue(AUTH_A)
  mockConnect.mockResolvedValue({ query: mockClientQuery, release: mockRelease })
  mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 })
})

// ---------------------------------------------------------------------------
// GET /conversations/:id/messages — cross-workspace → 403
// ---------------------------------------------------------------------------

describe('Multi-tenant — GET /messages cross-workspace', () => {
  it('WS_A não consegue ler mensagens da conversa de WS_B', async () => {
    mockFindConversationById.mockResolvedValue(makeConv(WS_B, CONV_B, CHANNEL_B))

    const res = await messagesRoute(
      authGet(`http://localhost/api/whatsapp/conversations/${CONV_B}/messages`),
      { params: Promise.resolve({ id: CONV_B }) },
    )

    expect(res.status).toBe(403)
  })

  it('resposta 403 não vaza número de telefone do WS_B', async () => {
    mockFindConversationById.mockResolvedValue({
      ...makeConv(WS_B, CONV_B, CHANNEL_B),
      contact_phone: '+5511000000099',
    })

    const res = await messagesRoute(
      authGet(`http://localhost/api/whatsapp/conversations/${CONV_B}/messages`),
      { params: Promise.resolve({ id: CONV_B }) },
    )

    const text = await res.text()
    expect(text).not.toContain('+5511000000099')
    expect(text).not.toContain(WS_B)
  })
})

// ---------------------------------------------------------------------------
// POST /conversations/:id/messages — cross-workspace → 403
// ---------------------------------------------------------------------------

describe('Multi-tenant — POST /messages cross-workspace', () => {
  it('WS_A não consegue enviar mensagem na conversa de WS_B', async () => {
    mockFindConversationById.mockResolvedValue(makeConv(WS_B, CONV_B, CHANNEL_B))

    const res = await messagesPost(
      authPost(`http://localhost/api/whatsapp/conversations/${CONV_B}/messages`, { text: 'Hack' }),
      { params: Promise.resolve({ id: CONV_B }) },
    )

    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// GET /media/:messageId — cross-workspace → 403
// ---------------------------------------------------------------------------

describe('Multi-tenant — GET /media cross-workspace', () => {
  it('WS_A não obtém signed URL de mídia do WS_B', async () => {
    mockFindMessageById.mockResolvedValue(makeMsg(CONV_B))
    // Conversa pertence ao WS_B
    mockFindConversationById.mockResolvedValue(makeConv(WS_B, CONV_B, CHANNEL_B))

    const res = await mediaRoute(
      authGet(`http://localhost/api/whatsapp/media/${MSG_B}`),
      { params: Promise.resolve({ messageId: MSG_B }) },
    )

    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// POST /send-template — cross-workspace → 403
// ---------------------------------------------------------------------------

describe('Multi-tenant — POST /send-template cross-workspace', () => {
  it('WS_A não consegue enviar template via canal de WS_B', async () => {
    // Canal pertence ao WS_B
    mockFindChannelById.mockResolvedValue(makeChannel(WS_B, CHANNEL_B))

    const res = await sendTemplateRoute(
      authPost(`http://localhost/api/whatsapp/channels/${CHANNEL_B}/send-template`, {
        to: '5511999999999',
        name: 'boas_vindas',
        language: 'pt_BR',
      }),
      { params: Promise.resolve({ id: CHANNEL_B }) },
    )

    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// GET /templates — cross-workspace → 403
// ---------------------------------------------------------------------------

describe('Multi-tenant — GET /templates cross-workspace', () => {
  it('WS_A não lista templates do canal de WS_B', async () => {
    mockFindChannelById.mockResolvedValue(makeChannel(WS_B, CHANNEL_B))

    const res = await listTemplatesRoute(
      authGet(`http://localhost/api/whatsapp/channels/${CHANNEL_B}/templates`),
      { params: Promise.resolve({ id: CHANNEL_B }) },
    )

    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// Workspace ID nunca vem de query/body
// ---------------------------------------------------------------------------

describe('Multi-tenant — workspace_id ignorado em query/body', () => {
  it('workspace_id=ws-b na querystring de /messages é ignorado', async () => {
    // Conversa pertence ao WS_A (autenticado)
    mockFindConversationById.mockResolvedValue(makeConv(WS_A, CONV_A, CHANNEL_A))

    const res = await messagesRoute(
      new NextRequest(
        `http://localhost/api/whatsapp/conversations/${CONV_A}/messages?workspace_id=${WS_B}`,
        { method: 'GET', headers: { Authorization: `Bearer wk_${'a'.repeat(64)}` } },
      ),
      { params: Promise.resolve({ id: CONV_A }) },
    )

    // Deve retornar 200 usando WS_A do token, não WS_B da query
    expect(res.status).toBe(200)
  })

  it('workspace_id=ws-b no body de /send-template é ignorado', async () => {
    // Canal pertence ao WS_A (autenticado)
    mockFindChannelById.mockResolvedValue(makeChannel(WS_A, CHANNEL_A, 'META_CLOUD'))

    const res = await sendTemplateRoute(
      new NextRequest(
        `http://localhost/api/whatsapp/channels/${CHANNEL_A}/send-template`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer wk_${'a'.repeat(64)}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspace_id: WS_B, // injetado maliciosamente
            to: '5511999999999',
            name: 'boas_vindas',
            language: 'pt_BR',
          }),
        },
      ),
      { params: Promise.resolve({ id: CHANNEL_A }) },
    )

    // Deve funcionar com WS_A do token; workspace_id do body é ignorado
    // (canal pertence ao WS_A, então retorna 201 ou erro de adapter, não 403)
    expect(res.status).not.toBe(403)
  })
})

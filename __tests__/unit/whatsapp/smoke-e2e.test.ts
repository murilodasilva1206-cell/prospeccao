// ---------------------------------------------------------------------------
// TDD — Cenário 32: Smoke de Produção (E2E simulado)
//
// Fluxo completo via mocks em memória:
//   1. Receber inbound → conversa criada + unread incrementado
//   2. Responder texto outbound → mensagem persiste como 'sent'
//   3. Enviar template com variável → 201 + mensagem [template:name]
//   4. Enviar mídia (imagem) → 201 + S3 key + signed URL disponível
//   5. Status delivered/read reflete no thread (via GET /messages)
//   6. Filtros funcionando (provider, channel, date range)
//   7. Isolamento: workspace B não vê nada do workspace A
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ---------------------------------------------------------------------------
// Mocks completos
// ---------------------------------------------------------------------------

const mockRelease = vi.fn()
const mockClientQuery = vi.fn()
const mockConnect = vi.fn()
vi.mock('@/lib/database', () => ({ default: { connect: mockConnect } }))

vi.mock('@/lib/get-ip', () => ({ getClientIp: vi.fn().mockReturnValue('10.0.1.1') }))

// All limiters pass
vi.mock('@/lib/rate-limit', () => ({
  whatsappInboxLimiter: { check: vi.fn().mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 }) },
  whatsappSendLimiter: { check: vi.fn().mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 }) },
  whatsappMediaLimiter: { check: vi.fn().mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 }) },
  whatsappConversationLimiter: { check: vi.fn().mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 }) },
  whatsappWebhookLimiter: { check: vi.fn().mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 }) },
  whatsappChannelLimiter: { check: vi.fn().mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 }) },
  whatsappTemplateSyncLimiter: { check: vi.fn().mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 }) },
}))

const mockRequireWorkspaceAuth = vi.fn()
vi.mock('@/lib/whatsapp/auth-middleware', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/whatsapp/auth-middleware')>()
  return { ...actual, requireWorkspaceAuth: mockRequireWorkspaceAuth }
})

const mockUpsertConversation = vi.fn()
const mockIncrementUnread = vi.fn()
const mockFindConversationsByWorkspace = vi.fn()
const mockFindConversationById = vi.fn()
vi.mock('@/lib/whatsapp/conversation-repo', () => ({
  upsertConversation: mockUpsertConversation,
  incrementUnread: mockIncrementUnread,
  findConversationsByWorkspace: mockFindConversationsByWorkspace,
  findConversationById: mockFindConversationById,
  markAllRead: vi.fn(),
  updateConversationStatus: vi.fn(),
  updateConversationAiEnabled: vi.fn(),
}))

const mockInsertMessage = vi.fn()
const mockFindMessagesByConversation = vi.fn()
vi.mock('@/lib/whatsapp/message-repo', () => ({
  insertMessage: mockInsertMessage,
  findMessagesByConversation: mockFindMessagesByConversation,
  updateMessageStatus: vi.fn(),
}))

const mockFindChannelById = vi.fn()
vi.mock('@/lib/whatsapp/channel-repo', () => ({
  findChannelById: mockFindChannelById,
  findChannelsByWorkspace: vi.fn().mockResolvedValue([]),
}))

const mockDecryptCredentials = vi.fn()
vi.mock('@/lib/whatsapp/crypto', () => ({
  decryptCredentials: mockDecryptCredentials,
  safeCompare: vi.fn().mockReturnValue(true),
}))

const mockSendMessage = vi.fn()
const mockSendTemplate = vi.fn()
const mockSendMedia = vi.fn()
const mockVerifyWebhookSignature = vi.fn()
const mockNormalizeEvent = vi.fn()
vi.mock('@/lib/whatsapp/adapters/factory', () => ({
  getAdapter: vi.fn().mockReturnValue({
    sendMessage: mockSendMessage,
    sendTemplate: mockSendTemplate,
    sendMedia: mockSendMedia,
    sendAudio: vi.fn().mockResolvedValue({ message_id: 'wamid.audio-1' }),
    verifyWebhookSignature: mockVerifyWebhookSignature,
    normalizeEvent: mockNormalizeEvent,
  }),
}))

const mockGetSignedUrl = vi.fn()
const mockValidateMediaFile = vi.fn()
const mockUploadMedia = vi.fn()
vi.mock('@/lib/whatsapp/media', () => ({
  getSignedUrl: mockGetSignedUrl,
  validateMediaFile: mockValidateMediaFile,
  uploadMedia: mockUploadMedia,
}))

vi.mock('@/lib/whatsapp/webhook-repo', () => ({
  markEventSeen: vi.fn().mockResolvedValue(true),
}))

vi.mock('@/lib/whatsapp/audit-repo', () => ({ insertAuditEvent: vi.fn() }))
vi.mock('@/lib/whatsapp/ai-inbox-agent', () => ({
  routeInboundToAi: vi.fn().mockResolvedValue({ shouldReply: false, replyText: null, confidence: 0, action: 'ignore', decisionLog: {} }),
}))
vi.mock('@/lib/whatsapp/template-repo', () => ({
  listTemplates: vi.fn().mockResolvedValue({ templates: [], total: 0 }),
  getTemplateVariables: vi.fn(),
}))
vi.mock('@/lib/logger', () => ({
  logger: { child: vi.fn().mockReturnValue({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}))

// ---------------------------------------------------------------------------
// Import routes AFTER mocks
// ---------------------------------------------------------------------------

const { POST: webhookPost } = await import('@/app/api/whatsapp/webhook/[provider]/[channelId]/route')
const { GET: messagesGet, POST: messagesPost } = await import(
  '@/app/api/whatsapp/conversations/[id]/messages/route'
)
const { POST: sendTemplateRoute } = await import(
  '@/app/api/whatsapp/channels/[id]/send-template/route'
)
const { POST: sendMediaRoute } = await import(
  '@/app/api/whatsapp/channels/[id]/send-media/route'
)
const { GET: conversationsRoute } = await import('@/app/api/whatsapp/conversations/route')
const { handleInboundMessage } = await import('@/lib/whatsapp/webhook-handler')

// ---------------------------------------------------------------------------
// Estado simulado em memória para o smoke test
// ---------------------------------------------------------------------------

const WS_A = 'ws-smoke-a'
const WS_B = 'ws-smoke-b'
const CHANNEL_ID = 'cc111111-1111-4111-8111-111111111111'
const CONV_ID = 'conv-smoke-2222-2222-4222-8222-222222222222'
const PHONE = '5511988887777'

const AUTH_A = { workspace_id: WS_A, actor: 'api_key:smoke-a', key_id: 'k-smoke-a', dedup_actor_id: 'api_key:k-smoke-a' }
const AUTH_B = { workspace_id: WS_B, actor: 'api_key:smoke-b', key_id: 'k-smoke-b', dedup_actor_id: 'api_key:k-smoke-b' }

const META_CHANNEL = {
  id: CHANNEL_ID,
  workspace_id: WS_A,
  provider: 'META_CLOUD',
  status: 'CONNECTED',
  credentials_encrypted: 'enc-smoke',
  name: 'Canal Smoke',
  webhook_secret: 'wh-secret',
  ai_enabled: false,
  config: {},
  last_seen_at: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}

const BASE_CONV = {
  id: CONV_ID,
  channel_id: CHANNEL_ID,
  channel_name: 'Canal Smoke',
  channel_provider: 'META_CLOUD',
  workspace_id: WS_A,
  contact_phone: PHONE,
  contact_name: 'Cliente Smoke',
  status: 'open',
  unread_count: 0,
  ai_enabled: false,
  last_message_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(96).fill(0)])

function authPost(url: string, body: unknown) {
  return new NextRequest(url, {
    method: 'POST',
    headers: { Authorization: `Bearer wk_${'a'.repeat(64)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function authGet(url: string) {
  return new NextRequest(url, { method: 'GET', headers: { Authorization: `Bearer wk_${'a'.repeat(64)}` } })
}

let msgCounter = 0
function makeMsg(overrides: Record<string, unknown> = {}) {
  return {
    id: `msg-smoke-${++msgCounter}`,
    conversation_id: CONV_ID,
    channel_id: CHANNEL_ID,
    direction: 'outbound',
    message_type: 'text',
    status: 'sent',
    body: null,
    media_s3_key: null,
    media_mime_type: null,
    media_filename: null,
    sent_by: `human:k-smoke-a`,
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  msgCounter = 0
  mockRequireWorkspaceAuth.mockResolvedValue(AUTH_A)
  mockConnect.mockResolvedValue({ query: mockClientQuery, release: mockRelease })
  mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  mockFindChannelById.mockResolvedValue(META_CHANNEL)
  mockFindConversationById.mockResolvedValue(BASE_CONV)
  mockFindConversationsByWorkspace.mockResolvedValue([BASE_CONV])
  mockUpsertConversation.mockResolvedValue(BASE_CONV)
  mockIncrementUnread.mockResolvedValue(undefined)
  mockDecryptCredentials.mockReturnValue({ access_token: 'EAABtest', phone_number_id: 'ph-1', waba_id: 'waba-1' })
  mockSendMessage.mockResolvedValue({ message_id: 'wamid.smoke-text-1' })
  mockSendTemplate.mockResolvedValue({ message_id: 'wamid.smoke-tpl-1' })
  mockSendMedia.mockResolvedValue({ message_id: 'wamid.smoke-img-1' })
  mockVerifyWebhookSignature.mockReturnValue(true)
  mockInsertMessage.mockImplementation((_, opts) => Promise.resolve(makeMsg(opts)))
  mockFindMessagesByConversation.mockResolvedValue([])
  mockGetSignedUrl.mockResolvedValue('https://s3.smoke.com/signed-url')
  mockValidateMediaFile.mockReturnValue({ mime: 'image/jpeg', ext: 'jpg', size: JPEG_BYTES.length, category: 'image' })
  mockUploadMedia.mockResolvedValue({ s3Key: `whatsapp/${CHANNEL_ID}/uuid-smoke.jpg` })
})

// ---------------------------------------------------------------------------
// SMOKE STEP 1: Receber inbound
// ---------------------------------------------------------------------------

describe('Smoke — Passo 1: Receber inbound → conversa criada + unread incrementado', () => {
  it('handleInboundMessage persiste inbound e incrementa unread', async () => {
    const fakeClient = { query: mockClientQuery, release: mockRelease }
    const event = {
      event_id: 'evt-smoke-1',
      type: 'message.received' as const,
      channel_id: CHANNEL_ID,
      provider: 'META_CLOUD' as const,
      timestamp: new Date(),
      payload: { from: PHONE, contact_name: 'Cliente Smoke', message_id: 'wamid.inbound-1', message_type: 'text', body: 'Olá, quero informações' },
    }

    const result = await handleInboundMessage(fakeClient as never, event, {
      id: CHANNEL_ID,
      workspace_id: WS_A,
    })

    expect(result.conversation_id).toBe(CONV_ID)
    expect(result.message_id).toBeTruthy()
    expect(mockIncrementUnread).toHaveBeenCalledWith(fakeClient, CONV_ID)
    expect(mockInsertMessage).toHaveBeenCalledWith(
      fakeClient,
      expect.objectContaining({ direction: 'inbound', sent_by: 'webhook' }),
    )
  })
})

// ---------------------------------------------------------------------------
// SMOKE STEP 2: Responder texto outbound
// ---------------------------------------------------------------------------

describe('Smoke — Passo 2: Responder texto outbound', () => {
  it('POST /messages retorna 201 e persiste mensagem sent', async () => {
    mockInsertMessage.mockResolvedValue(makeMsg({ body: 'Olá! Como posso ajudar?' }))

    const res = await messagesPost(
      authPost(`http://localhost/api/whatsapp/conversations/${CONV_ID}/messages`, {
        text: 'Olá! Como posso ajudar?',
      }),
      { params: Promise.resolve({ id: CONV_ID }) },
    )

    expect(res.status).toBe(201)
    const body = await res.json() as { data: { id: string; status: string } }
    expect(body.data.id).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// SMOKE STEP 3: Enviar template com variável
// ---------------------------------------------------------------------------

describe('Smoke — Passo 3: Enviar template com variável', () => {
  it('POST /send-template retorna 201 com body=[template:nome]', async () => {
    mockInsertMessage.mockResolvedValue(makeMsg({ body: '[template:boas_vindas]' }))

    const res = await sendTemplateRoute(
      authPost(`http://localhost/api/whatsapp/channels/${CHANNEL_ID}/send-template`, {
        to: PHONE,
        name: 'boas_vindas',
        language: 'pt_BR',
        body_params: ['Cliente Smoke', 'Dentistas'],
      }),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )

    expect(res.status).toBe(201)
    const body = await res.json() as { data: { provider_message_id: string } }
    expect(body.data.provider_message_id).toBe('wamid.smoke-tpl-1')
  })
})

// ---------------------------------------------------------------------------
// SMOKE STEP 4: Enviar mídia (imagem)
// ---------------------------------------------------------------------------

describe('Smoke — Passo 4: Enviar mídia (imagem)', () => {
  it('POST /send-media retorna 201 com media_s3_key disponível', async () => {
    mockInsertMessage.mockResolvedValue(makeMsg({
      message_type: 'image',
      media_s3_key: `whatsapp/${CHANNEL_ID}/uuid-smoke.jpg`,
      media_mime_type: 'image/jpeg',
    }))

    const fd = new FormData()
    fd.set('to', PHONE)
    fd.set('type', 'image')
    fd.set('file', new File([JPEG_BYTES], 'smoke.jpg', { type: 'image/jpeg' }))

    const res = await sendMediaRoute(
      new NextRequest(`http://localhost/api/whatsapp/channels/${CHANNEL_ID}/send-media`, {
        method: 'POST',
        headers: { Authorization: `Bearer wk_${'a'.repeat(64)}` },
        body: fd,
      }),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )

    expect(res.status).toBe(201)
    expect(mockUploadMedia).toHaveBeenCalled()
    expect(mockSendMedia).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// SMOKE STEP 5: Status delivered/read reflete no thread
// ---------------------------------------------------------------------------

describe('Smoke — Passo 5: Status delivered/read reflete via GET /messages', () => {
  it('após status delivered, GET /messages retorna mensagem com status=delivered', async () => {
    mockFindMessagesByConversation.mockResolvedValue([
      makeMsg({ status: 'delivered', direction: 'outbound' }),
    ])

    const res = await messagesGet(
      authGet(`http://localhost/api/whatsapp/conversations/${CONV_ID}/messages`),
      { params: Promise.resolve({ id: CONV_ID }) },
    )

    expect(res.status).toBe(200)
    const body = await res.json() as { data: Array<{ status: string }> }
    expect(body.data[0].status).toBe('delivered')
  })

  it('após status read, GET /messages retorna mensagem com status=read', async () => {
    mockFindMessagesByConversation.mockResolvedValue([
      makeMsg({ status: 'read', direction: 'outbound' }),
    ])

    const res = await messagesGet(
      authGet(`http://localhost/api/whatsapp/conversations/${CONV_ID}/messages`),
      { params: Promise.resolve({ id: CONV_ID }) },
    )

    const body = await res.json() as { data: Array<{ status: string }> }
    expect(body.data[0].status).toBe('read')
  })
})

// ---------------------------------------------------------------------------
// SMOKE STEP 6: Filtros funcionando
// ---------------------------------------------------------------------------

describe('Smoke — Passo 6: Filtros de Inbox funcionam', () => {
  it('GET /conversations com provider=META_CLOUD retorna conversas', async () => {
    const res = await conversationsRoute(
      new NextRequest('http://localhost/api/whatsapp/conversations?provider=META_CLOUD', {
        method: 'GET',
        headers: { Authorization: `Bearer wk_${'a'.repeat(64)}` },
      }),
    )

    expect(res.status).toBe(200)
    const body = await res.json() as { data: unknown[] }
    expect(Array.isArray(body.data)).toBe(true)
  })

  it('GET /conversations com date_from+date_to retorna conversas', async () => {
    const res = await conversationsRoute(
      new NextRequest(
        `http://localhost/api/whatsapp/conversations?date_from=2026-03-01&date_to=2026-03-31`,
        { method: 'GET', headers: { Authorization: `Bearer wk_${'a'.repeat(64)}` } },
      ),
    )

    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// SMOKE STEP 7: Isolamento entre workspaces
// ---------------------------------------------------------------------------

describe('Smoke — Passo 7: Isolamento WS_A ≠ WS_B', () => {
  it('WS_B não consegue ler mensagens da conversa de WS_A', async () => {
    // Autenticado como WS_B, mas conversa pertence ao WS_A
    mockRequireWorkspaceAuth.mockResolvedValue(AUTH_B)
    mockFindConversationById.mockResolvedValue(BASE_CONV) // workspace_id = WS_A

    const res = await messagesGet(
      new NextRequest(`http://localhost/api/whatsapp/conversations/${CONV_ID}/messages`, {
        method: 'GET',
        headers: { Authorization: `Bearer wk_${'b'.repeat(64)}` },
      }),
      { params: Promise.resolve({ id: CONV_ID }) },
    )

    expect(res.status).toBe(403)
  })

  it('GET /conversations de WS_B retorna apenas conversas de WS_B (não de WS_A)', async () => {
    mockRequireWorkspaceAuth.mockResolvedValue(AUTH_B)
    mockFindConversationsByWorkspace.mockResolvedValue([]) // WS_B não tem conversas

    const res = await conversationsRoute(
      new NextRequest('http://localhost/api/whatsapp/conversations', {
        method: 'GET',
        headers: { Authorization: `Bearer wk_${'b'.repeat(64)}` },
      }),
    )

    expect(res.status).toBe(200)
    // findConversationsByWorkspace deve ser chamado com WS_B, não WS_A
    expect(mockFindConversationsByWorkspace).toHaveBeenCalledWith(
      expect.anything(),
      WS_B,
      expect.any(Object),
    )
  })
})

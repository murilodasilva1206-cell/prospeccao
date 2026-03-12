// ---------------------------------------------------------------------------
// TDD — Cenários 7–9: Realtime Inbox
//
// 7. Novas mensagens: nova inbound aparece sem refresh manual (polling < 6s)
// 8. Status update: sent → delivered → read reflete no thread automaticamente
// 9. Isolamento: evento de workspace A não aparece no workspace B
//
// Estratégia: testar o comportamento do servidor (API) que habilita realtime
// via polling — os endpoints retornam dados atualizados a cada chamada.
// Os testes do hook useMessages são testados via resposta da API.
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

vi.mock('@/lib/get-ip', () => ({ getClientIp: vi.fn().mockReturnValue('127.0.0.1') }))

const mockInboxLimitCheck = vi.fn()
vi.mock('@/lib/rate-limit', () => ({
  whatsappInboxLimiter: { check: mockInboxLimitCheck },
}))

const mockRequireWorkspaceAuth = vi.fn()
vi.mock('@/lib/whatsapp/auth-middleware', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/whatsapp/auth-middleware')>()
  return { ...actual, requireWorkspaceAuth: mockRequireWorkspaceAuth }
})

const mockFindConversationById = vi.fn()
vi.mock('@/lib/whatsapp/conversation-repo', () => ({
  findConversationById: mockFindConversationById,
}))

const mockFindMessagesByConversation = vi.fn()
const mockInsertMessage = vi.fn()
vi.mock('@/lib/whatsapp/message-repo', () => ({
  findMessagesByConversation: mockFindMessagesByConversation,
  insertMessage: mockInsertMessage,
}))

const mockFindChannelById = vi.fn()
vi.mock('@/lib/whatsapp/channel-repo', () => ({
  findChannelById: mockFindChannelById,
}))

const mockDecryptCredentials = vi.fn()
vi.mock('@/lib/whatsapp/crypto', () => ({ decryptCredentials: mockDecryptCredentials }))

vi.mock('@/lib/whatsapp/adapters/factory', () => ({
  getAdapter: vi.fn().mockReturnValue({
    sendMessage: vi.fn().mockResolvedValue({ message_id: 'wamid.out1' }),
  }),
}))

const mockGetSignedUrl = vi.fn()
vi.mock('@/lib/whatsapp/media', () => ({ getSignedUrl: mockGetSignedUrl }))

vi.mock('@/lib/logger', () => ({
  logger: { child: vi.fn().mockReturnValue({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}))

// ---------------------------------------------------------------------------
// Import routes AFTER mocks
// ---------------------------------------------------------------------------

const { GET: messagesGET, POST: messagesPOST } = await import(
  '@/app/api/whatsapp/conversations/[id]/messages/route'
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WS_A = 'ws-realtime-a'
const WS_B = 'ws-realtime-b'
const CONV_A = 'conv-a-1111-1111-4111-8111-111111111111'
const CONV_B = 'conv-b-2222-2222-4222-8222-222222222222'
const CHANNEL_A = 'ch-a-3333-3333-4333-8333-333333333333'

const AUTH_WS_A = {
  workspace_id: WS_A,
  actor: 'api_key:key-a',
  key_id: 'k-a',
  dedup_actor_id: 'api_key:k-a',
}

const AUTH_WS_B = {
  workspace_id: WS_B,
  actor: 'api_key:key-b',
  key_id: 'k-b',
  dedup_actor_id: 'api_key:k-b',
}

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    conversation_id: CONV_A,
    channel_id: CHANNEL_A,
    direction: 'inbound',
    message_type: 'text',
    status: 'delivered',
    body: 'Olá!',
    sent_by: 'webhook',
    media_s3_key: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  }
}

function makeConversation(workspace_id: string, conv_id: string) {
  return {
    id: conv_id,
    channel_id: CHANNEL_A,
    workspace_id,
    contact_phone: '+5511999999999',
    contact_name: 'Test',
    status: 'open',
    unread_count: 0,
    ai_enabled: false,
    last_message_at: new Date().toISOString(),
  }
}

function makeGetMessages(convId: string): NextRequest {
  return new NextRequest(
    `http://localhost/api/whatsapp/conversations/${convId}/messages`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer wk_${'a'.repeat(64)}` },
    },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockInboxLimitCheck.mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 })
  mockRequireWorkspaceAuth.mockResolvedValue(AUTH_WS_A)
  mockConnect.mockResolvedValue({ query: mockClientQuery, release: mockRelease })
  mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  mockFindConversationById.mockResolvedValue(makeConversation(WS_A, CONV_A))
  mockFindMessagesByConversation.mockResolvedValue([])
  mockGetSignedUrl.mockResolvedValue('https://s3.example.com/signed-url?x=1')
  mockFindChannelById.mockResolvedValue({
    id: CHANNEL_A,
    workspace_id: WS_A,
    provider: 'META_CLOUD',
    status: 'CONNECTED',
    credentials_encrypted: 'enc',
  })
  mockDecryptCredentials.mockReturnValue({ access_token: 'tok', phone_number_id: 'ph-1' })
})

// ---------------------------------------------------------------------------
// Cenário 7 — Novas mensagens aparecem sem refresh manual
// ---------------------------------------------------------------------------

describe('Cenário 7 — GET /messages retorna mensagens novas a cada poll', () => {
  it('primeira chamada retorna lista vazia quando não há mensagens', async () => {
    mockFindMessagesByConversation.mockResolvedValue([])

    const res = await messagesGET(makeGetMessages(CONV_A), {
      params: Promise.resolve({ id: CONV_A }),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as { data: unknown[] }
    expect(body.data).toHaveLength(0)
  })

  it('segunda chamada (após inbound) retorna nova mensagem sem reload da página', async () => {
    // Simula: primeiro poll → vazio, segundo poll → 1 mensagem nova
    const newInbound = makeMessage({ body: 'Preciso de ajuda' })

    mockFindMessagesByConversation
      .mockResolvedValueOnce([])         // poll 1
      .mockResolvedValueOnce([newInbound]) // poll 2

    // Poll 1
    const res1 = await messagesGET(makeGetMessages(CONV_A), {
      params: Promise.resolve({ id: CONV_A }),
    })
    const body1 = await res1.json() as { data: unknown[] }
    expect(body1.data).toHaveLength(0)

    // Poll 2 (simula 5s depois)
    const res2 = await messagesGET(makeGetMessages(CONV_A), {
      params: Promise.resolve({ id: CONV_A }),
    })
    const body2 = await res2.json() as { data: Array<{ body: string }> }
    expect(body2.data).toHaveLength(1)
    expect(body2.data[0].body).toBe('Preciso de ajuda')
  })

  it('endpoint suporta múltiplas mensagens (sequência cronológica)', async () => {
    const msgs = [
      makeMessage({ body: 'msg1', created_at: '2026-03-11T10:00:00Z' }),
      makeMessage({ body: 'msg2', created_at: '2026-03-11T10:01:00Z' }),
      makeMessage({ body: 'msg3', created_at: '2026-03-11T10:02:00Z' }),
    ]
    mockFindMessagesByConversation.mockResolvedValue(msgs)

    const res = await messagesGET(makeGetMessages(CONV_A), {
      params: Promise.resolve({ id: CONV_A }),
    })
    const body = await res.json() as { data: Array<{ body: string }> }
    expect(body.data).toHaveLength(3)
  })

  it('resposta inclui signed URL para mensagens com mídia (pronto para render)', async () => {
    const mediaMsg = makeMessage({
      message_type: 'image',
      media_s3_key: 'whatsapp/ch-a/uuid-photo.jpg',
      media_mime_type: 'image/jpeg',
    })
    mockFindMessagesByConversation.mockResolvedValue([mediaMsg])

    const res = await messagesGET(makeGetMessages(CONV_A), {
      params: Promise.resolve({ id: CONV_A }),
    })
    const body = await res.json() as { data: Array<{ media_url?: string }> }
    expect(body.data[0].media_url).toBeTruthy()
    expect(body.data[0].media_url).toContain('https://s3.example.com')
  })
})

// ---------------------------------------------------------------------------
// Cenário 8 — Status update reflete automaticamente no thread
// ---------------------------------------------------------------------------

describe('Cenário 8 — Status update (sent → delivered → read) no thread', () => {
  it('GET /messages retorna mensagem com status=sent', async () => {
    mockFindMessagesByConversation.mockResolvedValue([
      makeMessage({ direction: 'outbound', status: 'sent', sent_by: 'human:k-a' }),
    ])

    const res = await messagesGET(makeGetMessages(CONV_A), {
      params: Promise.resolve({ id: CONV_A }),
    })
    const body = await res.json() as { data: Array<{ status: string }> }
    expect(body.data[0].status).toBe('sent')
  })

  it('após status update, GET /messages reflete status=delivered', async () => {
    mockFindMessagesByConversation.mockResolvedValue([
      makeMessage({ direction: 'outbound', status: 'delivered', sent_by: 'human:k-a' }),
    ])

    const res = await messagesGET(makeGetMessages(CONV_A), {
      params: Promise.resolve({ id: CONV_A }),
    })
    const body = await res.json() as { data: Array<{ status: string }> }
    expect(body.data[0].status).toBe('delivered')
  })

  it('após leitura, GET /messages reflete status=read', async () => {
    mockFindMessagesByConversation.mockResolvedValue([
      makeMessage({ direction: 'outbound', status: 'read', sent_by: 'human:k-a' }),
    ])

    const res = await messagesGET(makeGetMessages(CONV_A), {
      params: Promise.resolve({ id: CONV_A }),
    })
    const body = await res.json() as { data: Array<{ status: string }> }
    expect(body.data[0].status).toBe('read')
  })

  it('mensagem failed aparece com status=failed no thread', async () => {
    mockFindMessagesByConversation.mockResolvedValue([
      makeMessage({ direction: 'outbound', status: 'failed', sent_by: 'human:k-a' }),
    ])

    const res = await messagesGET(makeGetMessages(CONV_A), {
      params: Promise.resolve({ id: CONV_A }),
    })
    const body = await res.json() as { data: Array<{ status: string }> }
    expect(body.data[0].status).toBe('failed')
  })
})

// ---------------------------------------------------------------------------
// Cenário 9 — Isolamento: workspace A não vê mensagens do workspace B
// ---------------------------------------------------------------------------

describe('Cenário 9 — Isolamento de workspace no thread de mensagens', () => {
  it('WS_A não pode acessar conversa do WS_B — retorna 403', async () => {
    // Conversa pertence ao WS_B, mas autenticado como WS_A
    mockFindConversationById.mockResolvedValue(makeConversation(WS_B, CONV_B))
    mockRequireWorkspaceAuth.mockResolvedValue(AUTH_WS_A)

    const res = await messagesGET(
      new NextRequest(
        `http://localhost/api/whatsapp/conversations/${CONV_B}/messages`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer wk_${'a'.repeat(64)}` },
        },
      ),
      { params: Promise.resolve({ id: CONV_B }) },
    )

    expect(res.status).toBe(403)
    expect(mockFindMessagesByConversation).not.toHaveBeenCalled()
  })

  it('WS_B pode acessar sua própria conversa — retorna 200', async () => {
    mockFindConversationById.mockResolvedValue(makeConversation(WS_B, CONV_B))
    mockRequireWorkspaceAuth.mockResolvedValue(AUTH_WS_B)
    mockFindMessagesByConversation.mockResolvedValue([makeMessage({ conversation_id: CONV_B })])

    const res = await messagesGET(
      new NextRequest(
        `http://localhost/api/whatsapp/conversations/${CONV_B}/messages`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer wk_${'b'.repeat(64)}` },
        },
      ),
      { params: Promise.resolve({ id: CONV_B }) },
    )

    expect(res.status).toBe(200)
  })

  it('WS_A autenticado com token de WS_B injetado via querystring não obtém dados de WS_B', async () => {
    // Ataque: tenta injetar workspace_id na querystring
    mockFindConversationById.mockResolvedValue(makeConversation(WS_A, CONV_A))
    mockRequireWorkspaceAuth.mockResolvedValue(AUTH_WS_A)

    const res = await messagesGET(
      new NextRequest(
        `http://localhost/api/whatsapp/conversations/${CONV_A}/messages?workspace_id=${WS_B}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer wk_${'a'.repeat(64)}` },
        },
      ),
      { params: Promise.resolve({ id: CONV_A }) },
    )

    // Deve retornar 200 com mensagens de WS_A (o workspace_id da query é ignorado)
    expect(res.status).toBe(200)
    expect(mockFindConversationById).toHaveBeenCalledWith(expect.anything(), CONV_A)
  })

  it('resposta 403 não vaza informações sobre a conversa do workspace B', async () => {
    mockFindConversationById.mockResolvedValue({
      ...makeConversation(WS_B, CONV_B),
      contact_name: 'Cliente Secreto WS_B',
      contact_phone: '+5511000000001',
    })
    mockRequireWorkspaceAuth.mockResolvedValue(AUTH_WS_A)

    const res = await messagesGET(
      new NextRequest(
        `http://localhost/api/whatsapp/conversations/${CONV_B}/messages`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer wk_${'a'.repeat(64)}` },
        },
      ),
      { params: Promise.resolve({ id: CONV_B }) },
    )

    expect(res.status).toBe(403)
    const raw = await res.text()
    expect(raw).not.toContain('Cliente Secreto WS_B')
    expect(raw).not.toContain(WS_B)
  })

  it('POST /messages de WS_A em conversa de WS_B retorna 403', async () => {
    mockFindConversationById.mockResolvedValue(makeConversation(WS_B, CONV_B))
    mockRequireWorkspaceAuth.mockResolvedValue(AUTH_WS_A)

    const res = await messagesPOST(
      new NextRequest(
        `http://localhost/api/whatsapp/conversations/${CONV_B}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer wk_${'a'.repeat(64)}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ text: 'Tentativa de acesso cross-workspace' }),
        },
      ),
      { params: Promise.resolve({ id: CONV_B }) },
    )

    expect(res.status).toBe(403)
  })
})

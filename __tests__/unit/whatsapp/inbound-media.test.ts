// ---------------------------------------------------------------------------
// TDD — Cenários 10–12: Inbound Mídia
//
// 10. Persistência: webhook com image/audio/documento persiste S3 key e a
//     mensagem fica renderizável (GET /messages inclui signed URL)
// 11. Fallback: se download de mídia falha, mensagem ainda é salva com
//     status/metadata e erro tratado sem quebrar fluxo
// 12. Acesso: GET /api/whatsapp/media/:messageId só libera signed URL para
//     o workspace dono (403 para outros)
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ---------------------------------------------------------------------------
// Mocks comuns
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

const mockFindMessageById = vi.fn()
const mockFindMessagesByConversation = vi.fn()
vi.mock('@/lib/whatsapp/message-repo', () => ({
  findMessageById: mockFindMessageById,
  findMessagesByConversation: mockFindMessagesByConversation,
  insertMessage: vi.fn().mockResolvedValue({ id: 'msg-new', conversation_id: 'conv-1' }),
}))

const mockFindConversationById = vi.fn()
vi.mock('@/lib/whatsapp/conversation-repo', () => ({
  findConversationById: mockFindConversationById,
  upsertConversation: vi.fn().mockResolvedValue({ id: 'conv-1', workspace_id: 'ws-media-a' }),
  incrementUnread: vi.fn(),
  markAllRead: vi.fn(),
}))

const mockFindChannelById = vi.fn()
vi.mock('@/lib/whatsapp/channel-repo', () => ({
  findChannelById: mockFindChannelById,
}))

const mockGetSignedUrl = vi.fn()
vi.mock('@/lib/whatsapp/media', () => ({
  getSignedUrl: mockGetSignedUrl,
  validateMediaFile: vi.fn(),
  uploadMedia: vi.fn().mockResolvedValue({ s3Key: 'whatsapp/ch-1/uuid-file.jpg' }),
}))

vi.mock('@/lib/logger', () => ({
  logger: { child: vi.fn().mockReturnValue({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}))

// ---------------------------------------------------------------------------
// Import routes AFTER mocks
// ---------------------------------------------------------------------------

const { GET: mediaRoute } = await import('@/app/api/whatsapp/media/[messageId]/route')
const { GET: messagesGET } = await import(
  '@/app/api/whatsapp/conversations/[id]/messages/route'
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WS_A = 'ws-media-a'
const WS_B = 'ws-media-b'
const CHANNEL_ID = 'ch-media-1111-1111-4111-8111-111111111111'
const CONV_ID = 'conv-media-2222-2222-4222-8222-222222222222'
const MSG_IMAGE_ID = 'msg-img-3333-3333-4333-8333-333333333333'
const MSG_AUDIO_ID = 'msg-aud-4444-4444-4444-8444-444444444444'
const MSG_DOC_ID = 'msg-doc-5555-5555-5555-8555-555555555555'
const MSG_NO_MEDIA_ID = 'msg-txt-6666-6666-6666-8666-666666666666'

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

function makeMediaMessage(msgId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: msgId,
    conversation_id: CONV_ID,
    channel_id: CHANNEL_ID,
    direction: 'inbound',
    message_type: 'image',
    status: 'delivered',
    body: null,
    media_s3_key: `whatsapp/${CHANNEL_ID}/uuid-photo.jpg`,
    media_mime_type: 'image/jpeg',
    media_filename: 'photo.jpg',
    media_size_bytes: 102400,
    sent_by: 'webhook',
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

function makeConversation(workspace_id: string) {
  return {
    id: CONV_ID,
    channel_id: CHANNEL_ID,
    workspace_id,
    contact_phone: '+5511999999999',
    contact_name: 'Test',
    status: 'open',
    unread_count: 0,
    ai_enabled: false,
    last_message_at: new Date().toISOString(),
  }
}

function makeMediaRoute(msgId: string, wsAuth = AUTH_WS_A): NextRequest {
  return new NextRequest(
    `http://localhost/api/whatsapp/media/${msgId}`,
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
  mockGetSignedUrl.mockResolvedValue('https://s3.example.com/bucket/key?X-Amz-Signature=abc&expires=300')
  mockFindConversationById.mockResolvedValue(makeConversation(WS_A))
  mockFindMessageById.mockResolvedValue(makeMediaMessage(MSG_IMAGE_ID))
  mockFindChannelById.mockResolvedValue({
    id: CHANNEL_ID,
    workspace_id: WS_A,
    provider: 'META_CLOUD',
    status: 'CONNECTED',
  })
})

// ---------------------------------------------------------------------------
// Cenário 10 — Persistência: webhook com mídia → S3 key + signed URL
// ---------------------------------------------------------------------------

describe('Cenário 10 — Inbound mídia: mensagem persiste S3 key e fica renderizável', () => {
  it('GET /messages inclui signed URL para mensagem de imagem', async () => {
    mockFindMessagesByConversation.mockResolvedValue([
      makeMediaMessage(MSG_IMAGE_ID, { message_type: 'image', media_s3_key: 'whatsapp/ch-1/uuid-img.jpg' }),
    ])

    const res = await messagesGET(
      new NextRequest(
        `http://localhost/api/whatsapp/conversations/${CONV_ID}/messages`,
        { method: 'GET', headers: { Authorization: `Bearer wk_${'a'.repeat(64)}` } },
      ),
      { params: Promise.resolve({ id: CONV_ID }) },
    )

    expect(res.status).toBe(200)
    const body = await res.json() as { data: Array<{ media_url?: string; message_type: string }> }
    const imgMsg = body.data.find((m) => m.message_type === 'image')
    expect(imgMsg).toBeTruthy()
    expect(imgMsg?.media_url).toBeTruthy()
    expect(imgMsg?.media_url).toContain('https://s3.example.com')
  })

  it('GET /messages inclui signed URL para mensagem de áudio', async () => {
    mockFindMessagesByConversation.mockResolvedValue([
      makeMediaMessage(MSG_AUDIO_ID, {
        message_type: 'audio',
        media_s3_key: 'whatsapp/ch-1/uuid-audio.ogg',
        media_mime_type: 'audio/ogg',
      }),
    ])

    const res = await messagesGET(
      new NextRequest(
        `http://localhost/api/whatsapp/conversations/${CONV_ID}/messages`,
        { method: 'GET', headers: { Authorization: `Bearer wk_${'a'.repeat(64)}` } },
      ),
      { params: Promise.resolve({ id: CONV_ID }) },
    )

    const body = await res.json() as { data: Array<{ message_type: string; media_url?: string }> }
    const audioMsg = body.data.find((m) => m.message_type === 'audio')
    expect(audioMsg?.media_url).toBeTruthy()
  })

  it('GET /messages inclui signed URL para documento', async () => {
    mockFindMessagesByConversation.mockResolvedValue([
      makeMediaMessage(MSG_DOC_ID, {
        message_type: 'document',
        media_s3_key: 'whatsapp/ch-1/uuid-doc.pdf',
        media_mime_type: 'application/pdf',
        media_filename: 'contrato.pdf',
      }),
    ])

    const res = await messagesGET(
      new NextRequest(
        `http://localhost/api/whatsapp/conversations/${CONV_ID}/messages`,
        { method: 'GET', headers: { Authorization: `Bearer wk_${'a'.repeat(64)}` } },
      ),
      { params: Promise.resolve({ id: CONV_ID }) },
    )

    const body = await res.json() as { data: Array<{ message_type: string; media_url?: string; media_filename?: string }> }
    const docMsg = body.data.find((m) => m.message_type === 'document')
    expect(docMsg?.media_url).toBeTruthy()
    expect(docMsg?.media_filename).toBe('contrato.pdf')
  })

  it('GET /messages sem mídia não chama getSignedUrl', async () => {
    mockFindMessagesByConversation.mockResolvedValue([
      { ...makeMediaMessage(MSG_NO_MEDIA_ID), message_type: 'text', media_s3_key: null, body: 'Olá' },
    ])

    await messagesGET(
      new NextRequest(
        `http://localhost/api/whatsapp/conversations/${CONV_ID}/messages`,
        { method: 'GET', headers: { Authorization: `Bearer wk_${'a'.repeat(64)}` } },
      ),
      { params: Promise.resolve({ id: CONV_ID }) },
    )

    expect(mockGetSignedUrl).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Cenário 11 — Fallback: se S3 falhar, mensagem ainda é retornada
// ---------------------------------------------------------------------------

describe('Cenário 11 — Fallback: falha no download da mídia não quebra o fluxo', () => {
  it('GET /messages retorna mensagem mesmo quando getSignedUrl lança erro', async () => {
    mockGetSignedUrl.mockRejectedValue(new Error('S3 timeout: connection refused'))
    mockFindMessagesByConversation.mockResolvedValue([
      makeMediaMessage(MSG_IMAGE_ID),
    ])

    const res = await messagesGET(
      new NextRequest(
        `http://localhost/api/whatsapp/conversations/${CONV_ID}/messages`,
        { method: 'GET', headers: { Authorization: `Bearer wk_${'a'.repeat(64)}` } },
      ),
      { params: Promise.resolve({ id: CONV_ID }) },
    )

    // Não deve retornar 500 — deve degradar graciosamente
    expect(res.status).toBe(200)
    const body = await res.json() as { data: Array<{ id: string; media_url?: string }> }
    // A mensagem ainda está no array
    expect(body.data).toHaveLength(1)
    expect(body.data[0].id).toBe(MSG_IMAGE_ID)
    // media_url pode ser undefined/null (S3 falhou), mas mensagem existe
  })

  it('falha em S3 para uma msg não afeta signed URLs de outras msgs na mesma lista', async () => {
    mockGetSignedUrl
      .mockRejectedValueOnce(new Error('S3 timeout')) // primeira msg falha
      .mockResolvedValueOnce('https://s3.example.com/ok-url') // segunda funciona

    mockFindMessagesByConversation.mockResolvedValue([
      makeMediaMessage(MSG_IMAGE_ID, { id: MSG_IMAGE_ID }),
      makeMediaMessage(MSG_AUDIO_ID, {
        id: MSG_AUDIO_ID,
        message_type: 'audio',
        media_s3_key: 'whatsapp/ch-1/audio.ogg',
      }),
    ])

    const res = await messagesGET(
      new NextRequest(
        `http://localhost/api/whatsapp/conversations/${CONV_ID}/messages`,
        { method: 'GET', headers: { Authorization: `Bearer wk_${'a'.repeat(64)}` } },
      ),
      { params: Promise.resolve({ id: CONV_ID }) },
    )

    expect(res.status).toBe(200)
    const body = await res.json() as { data: Array<{ id: string; media_url?: string }> }
    expect(body.data).toHaveLength(2)
    // Segunda mensagem deve ter URL mesmo que a primeira falhou
    const second = body.data.find((m) => m.id === MSG_AUDIO_ID)
    expect(second?.media_url).toBe('https://s3.example.com/ok-url')
  })
})

// ---------------------------------------------------------------------------
// Cenário 12 — Acesso: GET /media/:messageId — workspace owner only
// ---------------------------------------------------------------------------

describe('Cenário 12 — GET /media/:messageId: acesso restrito ao workspace dono', () => {
  it('retorna 200 com signed URL para o workspace dono', async () => {
    mockFindMessageById.mockResolvedValue(makeMediaMessage(MSG_IMAGE_ID))
    mockFindConversationById.mockResolvedValue(makeConversation(WS_A))

    const res = await mediaRoute(makeMediaRoute(MSG_IMAGE_ID), {
      params: Promise.resolve({ messageId: MSG_IMAGE_ID }),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as { url: string; expires_in: number }
    expect(body.url).toBeTruthy()
    expect(body.expires_in).toBe(300)
  })

  it('retorna 403 quando conversa pertence a outro workspace', async () => {
    mockFindMessageById.mockResolvedValue(makeMediaMessage(MSG_IMAGE_ID))
    // Conversa pertence ao WS_B, mas autenticado como WS_A
    mockFindConversationById.mockResolvedValue(makeConversation(WS_B))
    mockRequireWorkspaceAuth.mockResolvedValue(AUTH_WS_A)

    const res = await mediaRoute(makeMediaRoute(MSG_IMAGE_ID), {
      params: Promise.resolve({ messageId: MSG_IMAGE_ID }),
    })

    expect(res.status).toBe(403)
    expect(mockGetSignedUrl).not.toHaveBeenCalled()
  })

  it('retorna 403 quando conversa não é encontrada (proteção conservadora)', async () => {
    mockFindMessageById.mockResolvedValue(makeMediaMessage(MSG_IMAGE_ID))
    mockFindConversationById.mockResolvedValue(null) // conversa não existe

    const res = await mediaRoute(makeMediaRoute(MSG_IMAGE_ID), {
      params: Promise.resolve({ messageId: MSG_IMAGE_ID }),
    })

    expect(res.status).toBe(403)
    expect(mockGetSignedUrl).not.toHaveBeenCalled()
  })

  it('retorna 404 quando messageId não existe', async () => {
    mockFindMessageById.mockResolvedValue(null)

    const res = await mediaRoute(makeMediaRoute(MSG_IMAGE_ID), {
      params: Promise.resolve({ messageId: MSG_IMAGE_ID }),
    })

    expect(res.status).toBe(404)
  })

  it('retorna 400 quando mensagem não tem media_s3_key', async () => {
    mockFindMessageById.mockResolvedValue({
      ...makeMediaMessage(MSG_NO_MEDIA_ID),
      message_type: 'text',
      media_s3_key: null,
    })
    mockFindConversationById.mockResolvedValue(makeConversation(WS_A))

    const res = await mediaRoute(makeMediaRoute(MSG_NO_MEDIA_ID), {
      params: Promise.resolve({ messageId: MSG_NO_MEDIA_ID }),
    })

    expect(res.status).toBe(400)
    expect(mockGetSignedUrl).not.toHaveBeenCalled()
  })

  it('resposta 403 cross-workspace não expõe URL nem S3 key do outro workspace', async () => {
    mockFindMessageById.mockResolvedValue(makeMediaMessage(MSG_IMAGE_ID))
    mockFindConversationById.mockResolvedValue(makeConversation(WS_B))

    const res = await mediaRoute(makeMediaRoute(MSG_IMAGE_ID), {
      params: Promise.resolve({ messageId: MSG_IMAGE_ID }),
    })

    expect(res.status).toBe(403)
    const raw = await res.text()
    expect(raw).not.toContain('s3.example.com')
    expect(raw).not.toContain('whatsapp/ch-1')
    expect(raw).not.toContain(WS_B)
  })

  it('WS_B autenticado pode acessar mídia da sua própria conversa', async () => {
    mockFindMessageById.mockResolvedValue({
      ...makeMediaMessage(MSG_IMAGE_ID),
      conversation_id: 'conv-b-' + CONV_ID.slice(7),
    })
    mockFindConversationById.mockResolvedValue(makeConversation(WS_B))
    mockRequireWorkspaceAuth.mockResolvedValue(AUTH_WS_B)

    const res = await mediaRoute(
      new NextRequest(`http://localhost/api/whatsapp/media/${MSG_IMAGE_ID}`, {
        method: 'GET',
        headers: { Authorization: `Bearer wk_${'b'.repeat(64)}` },
      }),
      { params: Promise.resolve({ messageId: MSG_IMAGE_ID }) },
    )

    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Cenário 13 — Mensagem sem mídia não tenta fluxo de upload
// ---------------------------------------------------------------------------

describe('Cenário 13 — Mensagem texto (sem mídia) não chama getSignedUrl', () => {
  it('GET /messages para mensagem de texto não gera signed URL', async () => {
    const textMsg = {
      id: 'msg-text-only',
      conversation_id: CONV_ID,
      channel_id: 'ch-media-a',
      direction: 'inbound',
      message_type: 'text',
      status: 'delivered',
      body: 'Mensagem só texto',
      sent_by: 'webhook',
      media_s3_key: null,
      media_mime_type: null,
      media_filename: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    mockFindMessagesByConversation.mockResolvedValue([textMsg])
    mockFindConversationById.mockResolvedValue(makeConversation(WS_A))

    const res = await messagesGET(
      new NextRequest(
        `http://localhost/api/whatsapp/conversations/${CONV_ID}/messages`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer wk_${'a'.repeat(64)}` },
        },
      ),
      { params: Promise.resolve({ id: CONV_ID }) },
    )

    expect(res.status).toBe(200)
    const body = await res.json() as { data: Array<{ media_url?: string; body: string }> }
    const msg = body.data[0]
    expect(msg.body).toBe('Mensagem só texto')
    // getSignedUrl should not be called when media_s3_key is null
    expect(mockGetSignedUrl).not.toHaveBeenCalled()
  })

  it('mensagem de texto tem media_url ausente ou null na resposta', async () => {
    const textMsg = {
      id: 'msg-pure-text',
      conversation_id: CONV_ID,
      channel_id: 'ch-media-a',
      direction: 'inbound',
      message_type: 'text',
      status: 'delivered',
      body: 'Apenas texto',
      sent_by: 'webhook',
      media_s3_key: null,
      media_mime_type: null,
      media_filename: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    mockFindMessagesByConversation.mockResolvedValue([textMsg])
    mockFindConversationById.mockResolvedValue(makeConversation(WS_A))

    const res = await messagesGET(
      new NextRequest(
        `http://localhost/api/whatsapp/conversations/${CONV_ID}/messages`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer wk_${'a'.repeat(64)}` },
        },
      ),
      { params: Promise.resolve({ id: CONV_ID }) },
    )

    const body = await res.json() as { data: Array<Record<string, unknown>> }
    const msg = body.data[0]
    // media_url should not be present or be null/undefined
    expect(msg.media_url ?? null).toBeNull()
  })
})

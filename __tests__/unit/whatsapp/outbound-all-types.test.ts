// ---------------------------------------------------------------------------
// TDD — Cenário 19: Texto/Mídia Outbound
//
// Envio de texto, imagem, áudio e documento funciona ponta a ponta e cria
// registros corretos no banco de dados.
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

const mockInboxCheck = vi.fn()
const mockMediaCheck = vi.fn()
const mockSendCheck = vi.fn()
vi.mock('@/lib/rate-limit', () => ({
  whatsappInboxLimiter: { check: mockInboxCheck },
  whatsappMediaLimiter: { check: mockMediaCheck },
  whatsappSendLimiter: { check: mockSendCheck },
}))

const mockRequireWorkspaceAuth = vi.fn()
vi.mock('@/lib/whatsapp/auth-middleware', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/whatsapp/auth-middleware')>()
  return { ...actual, requireWorkspaceAuth: mockRequireWorkspaceAuth }
})

const mockFindConversationById = vi.fn()
vi.mock('@/lib/whatsapp/conversation-repo', () => ({
  findConversationById: mockFindConversationById,
  upsertConversation: vi.fn().mockResolvedValue({
    id: 'conv-out-1',
    workspace_id: 'ws-out',
    contact_phone: '+5511999999999',
  }),
}))

const mockInsertMessage = vi.fn()
vi.mock('@/lib/whatsapp/message-repo', () => ({
  insertMessage: mockInsertMessage,
}))

const mockFindChannelById = vi.fn()
vi.mock('@/lib/whatsapp/channel-repo', () => ({
  findChannelById: mockFindChannelById,
}))

const mockDecryptCredentials = vi.fn()
vi.mock('@/lib/whatsapp/crypto', () => ({ decryptCredentials: mockDecryptCredentials }))

const mockSendMessage = vi.fn()
const mockSendMedia = vi.fn()
const mockSendAudio = vi.fn()
const mockSendSticker = vi.fn()
vi.mock('@/lib/whatsapp/adapters/factory', () => ({
  getAdapter: vi.fn().mockReturnValue({
    sendMessage: mockSendMessage,
    sendMedia: mockSendMedia,
    sendAudio: mockSendAudio,
    sendSticker: mockSendSticker,
  }),
}))

const mockValidateMediaFile = vi.fn()
const mockUploadMedia = vi.fn()
vi.mock('@/lib/whatsapp/media', () => ({
  validateMediaFile: mockValidateMediaFile,
  uploadMedia: mockUploadMedia,
}))

vi.mock('@/lib/whatsapp/audit-repo', () => ({
  insertAuditEvent: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/logger', () => ({
  logger: { child: vi.fn().mockReturnValue({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}))

// ---------------------------------------------------------------------------
// Import routes AFTER mocks
// ---------------------------------------------------------------------------

const { POST: textMessageRoute } = await import(
  '@/app/api/whatsapp/conversations/[id]/messages/route'
)
const { POST: sendMediaRoute } = await import(
  '@/app/api/whatsapp/channels/[id]/send-media/route'
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WS = 'ws-out'
const CHANNEL_ID = 'cc111111-1111-4111-8111-111111111111'
const CONV_ID = 'conv-out-2222-2222-4222-8222-222222222222'

const AUTH_WS = {
  workspace_id: WS,
  actor: 'api_key:out-key',
  key_id: 'k-out',
  dedup_actor_id: 'api_key:k-out',
}

function makeChannel(overrides: Record<string, unknown> = {}) {
  return {
    id: CHANNEL_ID,
    workspace_id: WS,
    provider: 'EVOLUTION',
    status: 'CONNECTED',
    credentials_encrypted: 'enc-out',
    name: 'Canal Out',
    ...overrides,
  }
}

function makeConversation() {
  return {
    id: CONV_ID,
    channel_id: CHANNEL_ID,
    workspace_id: WS,
    contact_phone: '+5511999999999',
    contact_name: 'Cliente',
    status: 'open',
    unread_count: 0,
    ai_enabled: false,
  }
}

// Helper para criar FormData multipart com arquivo simulado
function makeMediaFormData(
  filename: string,
  mimeType: string,
  content: Uint8Array,
  to = '5511999999999',
  type = 'image',
  caption?: string,
): FormData {
  const fd = new FormData()
  fd.set('to', to)
  fd.set('type', type)
  const ab = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer
  const file = new File([ab], filename, { type: mimeType })
  fd.set('file', file)
  if (caption) fd.set('caption', caption)
  return fd
}

// Bytes mágicos para mimes suportados
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(96).fill(0)])
const OGG_BYTES = new Uint8Array([0x4f, 0x67, 0x67, 0x53, ...new Array(96).fill(0)])
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, ...new Array(96).fill(0)])

beforeEach(() => {
  vi.clearAllMocks()
  mockInboxCheck.mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 })
  mockMediaCheck.mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 })
  mockSendCheck.mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 })
  mockRequireWorkspaceAuth.mockResolvedValue(AUTH_WS)
  mockConnect.mockResolvedValue({ query: mockClientQuery, release: mockRelease })
  mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  mockFindChannelById.mockResolvedValue(makeChannel())
  mockFindConversationById.mockResolvedValue(makeConversation())
  mockDecryptCredentials.mockReturnValue({ token: 'tok', url: 'http://evolution' })
  mockSendMessage.mockResolvedValue({ message_id: 'wamid.text-out-1' })
  mockSendMedia.mockResolvedValue({ message_id: 'wamid.media-out-1' })
  mockSendAudio.mockResolvedValue({ message_id: 'wamid.audio-out-1' })
  mockInsertMessage.mockResolvedValue({
    id: 'msg-out-1',
    conversation_id: CONV_ID,
    direction: 'outbound',
    status: 'sent',
    message_type: 'text',
  })
  mockValidateMediaFile.mockReturnValue({
    mime: 'image/jpeg',
    ext: 'jpg',
    size: JPEG_BYTES.length,
    category: 'image',
  })
  mockUploadMedia.mockResolvedValue({ s3Key: `whatsapp/${CHANNEL_ID}/uuid-test.jpg` })
})

// ---------------------------------------------------------------------------
// Cenário 19a — Envio de texto
// ---------------------------------------------------------------------------

describe('Cenário 19a — Envio de texto ponta a ponta', () => {
  it('POST /conversations/:id/messages retorna 201 com id da mensagem', async () => {
    const res = await textMessageRoute(
      new NextRequest(
        `http://localhost/api/whatsapp/conversations/${CONV_ID}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer wk_${'a'.repeat(64)}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ text: 'Olá, como posso ajudar?' }),
        },
      ),
      { params: Promise.resolve({ id: CONV_ID }) },
    )

    expect(res.status).toBe(201)
    const body = await res.json() as { data: { id: string } }
    expect(body.data.id).toBeTruthy()
  })

  it('adapter.sendMessage é chamado com o texto correto', async () => {
    await textMessageRoute(
      new NextRequest(
        `http://localhost/api/whatsapp/conversations/${CONV_ID}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer wk_${'a'.repeat(64)}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ text: 'Temos disponibilidade para amanhã.' }),
        },
      ),
      { params: Promise.resolve({ id: CONV_ID }) },
    )

    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      '+5511999999999',
      'Temos disponibilidade para amanhã.',
    )
  })

  it('persiste mensagem outbound com direction=outbound, status=sent, message_type=text', async () => {
    await textMessageRoute(
      new NextRequest(
        `http://localhost/api/whatsapp/conversations/${CONV_ID}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer wk_${'a'.repeat(64)}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ text: 'Confirmado!' }),
        },
      ),
      { params: Promise.resolve({ id: CONV_ID }) },
    )

    expect(mockInsertMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        direction: 'outbound',
        message_type: 'text',
        status: 'sent',
        body: 'Confirmado!',
      }),
    )
  })

  it('retorna 400 para texto vazio', async () => {
    const res = await textMessageRoute(
      new NextRequest(
        `http://localhost/api/whatsapp/conversations/${CONV_ID}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer wk_${'a'.repeat(64)}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ text: '   ' }),
        },
      ),
      { params: Promise.resolve({ id: CONV_ID }) },
    )

    expect(res.status).toBe(400)
    expect(mockSendMessage).not.toHaveBeenCalled()
  })

  it('retorna 400 para texto acima de 4096 chars', async () => {
    const res = await textMessageRoute(
      new NextRequest(
        `http://localhost/api/whatsapp/conversations/${CONV_ID}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer wk_${'a'.repeat(64)}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ text: 'a'.repeat(4097) }),
        },
      ),
      { params: Promise.resolve({ id: CONV_ID }) },
    )

    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Cenário 19b — Envio de imagem
// ---------------------------------------------------------------------------

describe('Cenário 19b — Envio de imagem ponta a ponta', () => {
  it('POST /send-media com imagem JPEG retorna 201', async () => {
    const fd = makeMediaFormData('photo.jpg', 'image/jpeg', JPEG_BYTES)

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

    expect(res.status).toBe(201)
    const body = await res.json() as { data: { id: string; provider_message_id: string } }
    expect(body.data.id).toBeTruthy()
    expect(body.data.provider_message_id).toBeTruthy()
  })

  it('imagem é uploaded para S3 antes de ser enviada ao provider', async () => {
    const fd = makeMediaFormData('foto.jpg', 'image/jpeg', JPEG_BYTES)

    await sendMediaRoute(
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

    expect(mockUploadMedia).toHaveBeenCalled()
    expect(mockSendMedia).toHaveBeenCalled()
  })

  it('registro de mensagem inclui media_s3_key e media_mime_type', async () => {
    mockUploadMedia.mockResolvedValue({ s3Key: 'whatsapp/ch-1/uuid-img.jpg' })

    const fd = makeMediaFormData('img.jpg', 'image/jpeg', JPEG_BYTES)
    await sendMediaRoute(
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

    expect(mockInsertMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        media_s3_key: 'whatsapp/ch-1/uuid-img.jpg',
        media_mime_type: 'image/jpeg',
        message_type: 'image',
        direction: 'outbound',
        status: 'sent',
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// Cenário 19c — Envio de áudio
// ---------------------------------------------------------------------------

describe('Cenário 19c — Envio de áudio ponta a ponta', () => {
  it('POST /send-media com áudio OGG retorna 201', async () => {
    mockValidateMediaFile.mockReturnValue({
      mime: 'audio/ogg',
      ext: 'ogg',
      size: OGG_BYTES.length,
      category: 'audio',
    })

    const fd = makeMediaFormData('audio.ogg', 'audio/ogg', OGG_BYTES, '5511999999999', 'audio')

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

    expect(res.status).toBe(201)
  })

  it('áudio usa sendAudio no adapter (não sendMedia)', async () => {
    mockValidateMediaFile.mockReturnValue({
      mime: 'audio/ogg',
      ext: 'ogg',
      size: OGG_BYTES.length,
      category: 'audio',
    })

    const fd = makeMediaFormData('voz.ogg', 'audio/ogg', OGG_BYTES, '5511999999999', 'audio')
    await sendMediaRoute(
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

    expect(mockSendAudio).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Cenário 19d — Envio de documento
// ---------------------------------------------------------------------------

describe('Cenário 19d — Envio de documento ponta a ponta', () => {
  it('POST /send-media com PDF retorna 201', async () => {
    mockValidateMediaFile.mockReturnValue({
      mime: 'application/pdf',
      ext: 'pdf',
      size: PDF_BYTES.length,
      category: 'document',
    })

    const fd = makeMediaFormData(
      'contrato.pdf',
      'application/pdf',
      PDF_BYTES,
      '5511999999999',
      'document',
    )

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

    expect(res.status).toBe(201)
  })

  it('registro de documento inclui media_filename original', async () => {
    mockValidateMediaFile.mockReturnValue({
      mime: 'application/pdf',
      ext: 'pdf',
      size: PDF_BYTES.length,
      category: 'document',
    })
    mockUploadMedia.mockResolvedValue({ s3Key: 'whatsapp/ch-1/uuid-doc.pdf' })

    const fd = makeMediaFormData(
      'proposta_comercial.pdf',
      'application/pdf',
      PDF_BYTES,
      '5511999999999',
      'document',
    )
    await sendMediaRoute(
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

    expect(mockInsertMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        media_filename: 'proposta_comercial.pdf',
        message_type: 'document',
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// TDD — Inbox: envio de template (cenários 1–5)
//
// 1. Template com variáveis: GET /variables retorna {{1}}..{{N}}
// 2. Envio válido: POST /send-template com body_params completo → 201 + persiste
// 3. Envio inválido: missing body_param obrigatório → 400
// 4. Provider errado: canal não-Meta → 409
// 5. Canal desconectado: canal Meta disconnected → 409
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

const mockSendCheck = vi.fn()
const mockChannelCheck = vi.fn()
vi.mock('@/lib/rate-limit', () => ({
  whatsappSendLimiter: { check: mockSendCheck },
  whatsappChannelLimiter: { check: mockChannelCheck },
}))

const mockRequireWorkspaceAuth = vi.fn()
vi.mock('@/lib/whatsapp/auth-middleware', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/whatsapp/auth-middleware')>()
  return { ...actual, requireWorkspaceAuth: mockRequireWorkspaceAuth }
})

const mockFindChannelById = vi.fn()
vi.mock('@/lib/whatsapp/channel-repo', () => ({ findChannelById: mockFindChannelById }))

const mockDecryptCredentials = vi.fn()
vi.mock('@/lib/whatsapp/crypto', () => ({ decryptCredentials: mockDecryptCredentials }))

const mockGetTemplateVariables = vi.fn()
vi.mock('@/lib/whatsapp/template-repo', () => ({
  getTemplateVariables: mockGetTemplateVariables,
}))

const mockAdapterSendTemplate = vi.fn()
vi.mock('@/lib/whatsapp/adapters/factory', () => ({
  getAdapter: vi.fn().mockReturnValue({ sendTemplate: mockAdapterSendTemplate }),
}))

const mockUpsertConversation = vi.fn()
const mockMarkAllRead = vi.fn()
vi.mock('@/lib/whatsapp/conversation-repo', () => ({
  upsertConversation: mockUpsertConversation,
  markAllRead: mockMarkAllRead,
}))

const mockInsertMessage = vi.fn()
vi.mock('@/lib/whatsapp/message-repo', () => ({ insertMessage: mockInsertMessage }))

vi.mock('@/lib/logger', () => ({
  logger: { child: vi.fn().mockReturnValue({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}))

// ---------------------------------------------------------------------------
// Import routes AFTER mocks
// ---------------------------------------------------------------------------

const { GET: varsRoute } = await import(
  '@/app/api/whatsapp/channels/[id]/templates/[templateId]/variables/route'
)
const { POST: sendTemplateRoute } = await import(
  '@/app/api/whatsapp/channels/[id]/send-template/route'
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CHANNEL_ID = 'cccc1111-cccc-4ccc-8ccc-cccccccccccc'
const TEMPLATE_ID = 'dddd1111-dddd-4ddd-8ddd-dddddddddddd'

const AUTH_WS = {
  workspace_id: 'ws-tpl-test',
  actor: 'api_key:test',
  key_id: 'k-tpl',
  dedup_actor_id: 'api_key:k-tpl',
}

function makeChannel(overrides: Record<string, unknown> = {}) {
  return {
    id: CHANNEL_ID,
    workspace_id: 'ws-tpl-test',
    provider: 'META_CLOUD',
    status: 'CONNECTED',
    credentials_encrypted: 'enc-creds',
    name: 'Canal Meta',
    webhook_secret: 'secret',
    ...overrides,
  }
}

function makeGet(url: string): NextRequest {
  return new NextRequest(url, {
    method: 'GET',
    headers: { Authorization: `Bearer wk_${'a'.repeat(64)}` },
  })
}

function makeSendTemplatePost(body: Record<string, unknown>): NextRequest {
  return new NextRequest(
    `http://localhost/api/whatsapp/channels/${CHANNEL_ID}/send-template`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer wk_${'a'.repeat(64)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSendCheck.mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 })
  mockChannelCheck.mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 })
  mockRequireWorkspaceAuth.mockResolvedValue(AUTH_WS)
  mockConnect.mockResolvedValue({ query: mockClientQuery, release: mockRelease })
  mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  mockFindChannelById.mockResolvedValue(makeChannel())
  mockDecryptCredentials.mockReturnValue({
    access_token: 'EAABtest',
    phone_number_id: 'ph-123',
    waba_id: 'waba-456',
  })
  mockAdapterSendTemplate.mockResolvedValue({ message_id: 'wamid.test-123' })
  mockUpsertConversation.mockResolvedValue({
    id: 'conv-tpl-1',
    channel_id: CHANNEL_ID,
    workspace_id: 'ws-tpl-test',
    contact_phone: '+5511999999999',
    unread_count: 0,
    status: 'open',
  })
  mockInsertMessage.mockResolvedValue({
    id: 'msg-tpl-1',
    conversation_id: 'conv-tpl-1',
    direction: 'outbound',
    status: 'sent',
  })
})

// ---------------------------------------------------------------------------
// Cenário 1 — Template com variáveis: GET /variables retorna {{1}}..{{N}}
// ---------------------------------------------------------------------------

describe('Cenário 1 — GET /variables retorna placeholders do template', () => {
  it('retorna 200 com array de variáveis quando template tem {{1}} e {{2}}', async () => {
    mockGetTemplateVariables.mockResolvedValue({
      id: TEMPLATE_ID,
      variables: [{ index: 1, example: 'João' }, { index: 2, example: 'Dentistas Silva' }],
      variables_count: 2,
    })

    const res = await varsRoute(
      makeGet(
        `http://localhost/api/whatsapp/channels/${CHANNEL_ID}/templates/${TEMPLATE_ID}/variables`,
      ),
      { params: Promise.resolve({ id: CHANNEL_ID, templateId: TEMPLATE_ID }) },
    )

    expect(res.status).toBe(200)
    const body = await res.json() as { variables: Array<{ index: number }> }
    expect(body.variables).toHaveLength(2)
    expect(body.variables[0].index).toBe(1)
    expect(body.variables[1].index).toBe(2)
  })

  it('retorna variables_count compatível com o número de {{N}} no template', async () => {
    mockGetTemplateVariables.mockResolvedValue({
      id: TEMPLATE_ID,
      variables: [{ index: 1, example: '' }, { index: 2, example: '' }, { index: 3, example: '' }],
      variables_count: 3,
    })

    const res = await varsRoute(
      makeGet(
        `http://localhost/api/whatsapp/channels/${CHANNEL_ID}/templates/${TEMPLATE_ID}/variables`,
      ),
      { params: Promise.resolve({ id: CHANNEL_ID, templateId: TEMPLATE_ID }) },
    )

    const body = await res.json() as { variables: Array<unknown> }
    expect(body.variables).toHaveLength(3)
  })

  it('retorna array vazio quando template não tem variáveis', async () => {
    mockGetTemplateVariables.mockResolvedValue({
      id: TEMPLATE_ID,
      variables: [],
      variables_count: 0,
    })

    const res = await varsRoute(
      makeGet(
        `http://localhost/api/whatsapp/channels/${CHANNEL_ID}/templates/${TEMPLATE_ID}/variables`,
      ),
      { params: Promise.resolve({ id: CHANNEL_ID, templateId: TEMPLATE_ID }) },
    )

    expect(res.status).toBe(200)
    const body = await res.json() as { variables: unknown[] }
    expect(body.variables).toHaveLength(0)
  })

  it('retorna 404 quando templateId não existe', async () => {
    mockGetTemplateVariables.mockResolvedValue(null)

    const res = await varsRoute(
      makeGet(
        `http://localhost/api/whatsapp/channels/${CHANNEL_ID}/templates/${TEMPLATE_ID}/variables`,
      ),
      { params: Promise.resolve({ id: CHANNEL_ID, templateId: TEMPLATE_ID }) },
    )

    expect(res.status).toBe(404)
  })

  it('retorna 400 quando templateId não é UUID válido', async () => {
    const res = await varsRoute(
      makeGet(
        `http://localhost/api/whatsapp/channels/${CHANNEL_ID}/templates/nao-e-uuid/variables`,
      ),
      { params: Promise.resolve({ id: CHANNEL_ID, templateId: 'nao-e-uuid' }) },
    )

    expect(res.status).toBe(400)
    expect(mockConnect).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Cenário 2 — Envio template válido: POST /send-template → 201 + persiste
// ---------------------------------------------------------------------------

describe('Cenário 2 — POST /send-template válido retorna 201', () => {
  it('retorna 201 com id da mensagem e provider_message_id', async () => {
    const res = await sendTemplateRoute(
      makeSendTemplatePost({
        to: '5511999999999',
        name: 'boas_vindas',
        language: 'pt_BR',
        body_params: ['João', 'Dentista'],
      }),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )

    expect(res.status).toBe(201)
    const body = await res.json() as { data: { id: string; provider_message_id: string } }
    expect(body.data.id).toBeTruthy()
    expect(body.data.provider_message_id).toBe('wamid.test-123')
  })

  it('persiste mensagem outbound com body=[template:name]', async () => {
    await sendTemplateRoute(
      makeSendTemplatePost({
        to: '5511999999999',
        name: 'boas_vindas',
        language: 'pt_BR',
        body_params: ['João', 'Dentista'],
      }),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )

    expect(mockInsertMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        direction: 'outbound',
        message_type: 'text',
        status: 'sent',
        body: '[template:boas_vindas]',
      }),
    )
  })

  it('cria/upserta conversa antes de inserir mensagem', async () => {
    await sendTemplateRoute(
      makeSendTemplatePost({
        to: '5511999999999',
        name: 'boas_vindas',
        language: 'pt_BR',
      }),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )

    expect(mockUpsertConversation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        channel_id: CHANNEL_ID,
        workspace_id: 'ws-tpl-test',
        contact_phone: '5511999999999',
      }),
    )
  })

  it('chama adapter.sendTemplate com name, language e body_params corretos', async () => {
    await sendTemplateRoute(
      makeSendTemplatePost({
        to: '5511999999999',
        name: 'promo_dentista',
        language: 'pt_BR',
        body_params: ['Oferta', 'R$ 99'],
      }),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )

    expect(mockAdapterSendTemplate).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      '5511999999999',
      'promo_dentista',
      'pt_BR',
      ['Oferta', 'R$ 99'],
    )
  })

  it('funciona sem body_params (template sem variáveis)', async () => {
    const res = await sendTemplateRoute(
      makeSendTemplatePost({
        to: '5511999999999',
        name: 'boas_vindas_simples',
        language: 'en_US',
      }),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )

    expect(res.status).toBe(201)
  })
})

// ---------------------------------------------------------------------------
// Cenário 3 — Envio inválido: body malformado → 400
// ---------------------------------------------------------------------------

describe('Cenário 3 — POST /send-template inválido retorna 400', () => {
  it('retorna 400 quando "to" está ausente', async () => {
    const res = await sendTemplateRoute(
      makeSendTemplatePost({ name: 'boas_vindas', language: 'pt_BR' }),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )

    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/param|invalid|invalido/i)
  })

  it('retorna 400 quando "name" está ausente', async () => {
    const res = await sendTemplateRoute(
      makeSendTemplatePost({ to: '5511999999999', language: 'pt_BR' }),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )

    expect(res.status).toBe(400)
  })

  it('retorna 400 quando "language" está ausente', async () => {
    const res = await sendTemplateRoute(
      makeSendTemplatePost({ to: '5511999999999', name: 'boas_vindas' }),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )

    expect(res.status).toBe(400)
  })

  it('retorna 400 quando body é JSON inválido', async () => {
    const res = await sendTemplateRoute(
      new NextRequest(
        `http://localhost/api/whatsapp/channels/${CHANNEL_ID}/send-template`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer wk_${'a'.repeat(64)}`,
            'Content-Type': 'application/json',
          },
          body: 'nao-e-json{',
        },
      ),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )

    expect(res.status).toBe(400)
  })

  it('retorna 400 quando channelId é inválido (não UUID)', async () => {
    const res = await sendTemplateRoute(
      new NextRequest(
        'http://localhost/api/whatsapp/channels/nao-uuid/send-template',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer wk_${'a'.repeat(64)}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ to: '5511999999999', name: 'tpl', language: 'pt_BR' }),
        },
      ),
      { params: Promise.resolve({ id: 'nao-uuid' }) },
    )

    expect(res.status).toBe(400)
    expect(mockConnect).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Cenário 4 — Provider errado: canal não-Meta → 409
// ---------------------------------------------------------------------------

describe('Cenário 4 — Template em canal não-Meta retorna 409', () => {
  it('retorna 409 para canal EVOLUTION', async () => {
    mockFindChannelById.mockResolvedValue(makeChannel({ provider: 'EVOLUTION' }))

    const res = await sendTemplateRoute(
      makeSendTemplatePost({
        to: '5511999999999',
        name: 'boas_vindas',
        language: 'pt_BR',
      }),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )

    expect(res.status).toBe(409)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/META_CLOUD/i)
  })

  it('retorna 409 para canal UAZAPI', async () => {
    mockFindChannelById.mockResolvedValue(makeChannel({ provider: 'UAZAPI' }))

    const res = await sendTemplateRoute(
      makeSendTemplatePost({
        to: '5511999999999',
        name: 'boas_vindas',
        language: 'pt_BR',
      }),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )

    expect(res.status).toBe(409)
  })

  it('não chama adapter quando provider não é META_CLOUD', async () => {
    mockFindChannelById.mockResolvedValue(makeChannel({ provider: 'EVOLUTION' }))

    await sendTemplateRoute(
      makeSendTemplatePost({ to: '5511999999999', name: 'tpl', language: 'pt_BR' }),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )

    expect(mockAdapterSendTemplate).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Cenário 5 — Canal desconectado: Meta DISCONNECTED → 409
// ---------------------------------------------------------------------------

describe('Cenário 5 — Template em canal Meta desconectado retorna 409', () => {
  it('retorna 409 quando status=DISCONNECTED', async () => {
    mockFindChannelById.mockResolvedValue(makeChannel({ status: 'DISCONNECTED' }))

    const res = await sendTemplateRoute(
      makeSendTemplatePost({ to: '5511999999999', name: 'boas_vindas', language: 'pt_BR' }),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )

    expect(res.status).toBe(409)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/conectado|status/i)
  })

  it('retorna 409 quando status=PENDING_QR', async () => {
    mockFindChannelById.mockResolvedValue(makeChannel({ status: 'PENDING_QR' }))

    const res = await sendTemplateRoute(
      makeSendTemplatePost({ to: '5511999999999', name: 'boas_vindas', language: 'pt_BR' }),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )

    expect(res.status).toBe(409)
  })

  it('retorna 409 quando status=CONNECTING', async () => {
    mockFindChannelById.mockResolvedValue(makeChannel({ status: 'CONNECTING' }))

    const res = await sendTemplateRoute(
      makeSendTemplatePost({ to: '5511999999999', name: 'boas_vindas', language: 'pt_BR' }),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )

    expect(res.status).toBe(409)
  })

  it('não chama adapter quando canal não está CONNECTED', async () => {
    mockFindChannelById.mockResolvedValue(makeChannel({ status: 'DISCONNECTED' }))

    await sendTemplateRoute(
      makeSendTemplatePost({ to: '5511999999999', name: 'tpl', language: 'pt_BR' }),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )

    expect(mockAdapterSendTemplate).not.toHaveBeenCalled()
  })

  it('retorna 201 quando canal está CONNECTED (happy path)', async () => {
    mockFindChannelById.mockResolvedValue(makeChannel({ status: 'CONNECTED' }))

    const res = await sendTemplateRoute(
      makeSendTemplatePost({ to: '5511999999999', name: 'boas_vindas', language: 'pt_BR' }),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )

    expect(res.status).toBe(201)
  })
})

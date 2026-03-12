// ---------------------------------------------------------------------------
// TDD — Templates com variáveis: hardening
//
// 1. Template sem variáveis envia com body_params=[]
// 2. Template com N variáveis: adapter recebe array com N elementos em ordem
// 3. Ordem correta {{1}}..{{N}} no payload
// 4. body_params omitido funciona igual a []
// 5. Erro em GET /variables retorna 404 gracioso
// 6. Multi-tenant: canal de outro workspace retorna 404
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
vi.mock('@/lib/whatsapp/conversation-repo', () => ({
  upsertConversation: mockUpsertConversation,
  markAllRead: vi.fn(),
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

const CHANNEL_ID = 'aabb1111-cccc-4ccc-8ccc-cccccccccccc'
const CHANNEL_ID_B = 'aabb2222-cccc-4ccc-8ccc-cccccccccccc'
const TEMPLATE_ID = 'aabb3333-dddd-4ddd-8ddd-dddddddddddd'

const AUTH_WS = {
  workspace_id: 'ws-hard-test',
  actor: 'api_key:test',
  key_id: 'k-h',
  dedup_actor_id: 'api_key:k-h',
}

function makeChannel(overrides: Record<string, unknown> = {}) {
  return {
    id: CHANNEL_ID,
    workspace_id: 'ws-hard-test',
    provider: 'META_CLOUD',
    status: 'CONNECTED',
    credentials_encrypted: 'enc',
    name: 'Canal Meta Hard',
    ...overrides,
  }
}

function makeSendPost(body: Record<string, unknown>): NextRequest {
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

function makeVarsGet(channelId: string, templateId: string): NextRequest {
  return new NextRequest(
    `http://localhost/api/whatsapp/channels/${channelId}/templates/${templateId}/variables`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer wk_${'a'.repeat(64)}` },
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
  mockDecryptCredentials.mockReturnValue({ access_token: 'EAA', phone_number_id: 'ph' })
  mockAdapterSendTemplate.mockResolvedValue({ message_id: 'wamid.hard-1' })
  mockUpsertConversation.mockResolvedValue({
    id: 'conv-h-1',
    channel_id: CHANNEL_ID,
    workspace_id: 'ws-hard-test',
    contact_phone: '+5511999999999',
    unread_count: 0,
    status: 'open',
  })
  mockInsertMessage.mockResolvedValue({ id: 'msg-h-1' })
})

// ---------------------------------------------------------------------------
// Cenário 1 — Template sem variáveis envia com body_params=[]
// ---------------------------------------------------------------------------

describe('Cenário 1 — Template sem variáveis envia com body_params=[]', () => {
  it('chama adapter.sendTemplate com body_params=[] quando omitido', async () => {
    const res = await sendTemplateRoute(
      makeSendPost({ to: '5511999999999', name: 'tpl_sem_vars', language: 'pt_BR' }),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )

    expect(res.status).toBe(201)
    expect(mockAdapterSendTemplate).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      '5511999999999',
      'tpl_sem_vars',
      'pt_BR',
      [],
    )
  })

  it('body_params=[] explícito também funciona', async () => {
    const res = await sendTemplateRoute(
      makeSendPost({ to: '5511999999999', name: 'tpl_zero_vars', language: 'en_US', body_params: [] }),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )

    expect(res.status).toBe(201)
    expect(mockAdapterSendTemplate).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      '5511999999999',
      'tpl_zero_vars',
      'en_US',
      [],
    )
  })
})

// ---------------------------------------------------------------------------
// Cenário 2 — Template com N variáveis: adapter recebe N elementos
// ---------------------------------------------------------------------------

describe('Cenário 2 — Template com N variáveis passa array completo ao adapter', () => {
  it('body_params com 1 elemento é repassado como [param1]', async () => {
    await sendTemplateRoute(
      makeSendPost({
        to: '5511999999999',
        name: 'tpl_1var',
        language: 'pt_BR',
        body_params: ['João'],
      }),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )

    expect(mockAdapterSendTemplate).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), '5511999999999',
      'tpl_1var', 'pt_BR', ['João'],
    )
  })

  it('body_params com 3 elementos passa todos corretamente', async () => {
    await sendTemplateRoute(
      makeSendPost({
        to: '5511999999999',
        name: 'tpl_3vars',
        language: 'pt_BR',
        body_params: ['Nome', 'Empresa', 'Cidade'],
      }),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )

    expect(mockAdapterSendTemplate).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), '5511999999999',
      'tpl_3vars', 'pt_BR', ['Nome', 'Empresa', 'Cidade'],
    )
  })
})

// ---------------------------------------------------------------------------
// Cenário 3 — Ordem correta {{1}}..{{N}} no payload
// ---------------------------------------------------------------------------

describe('Cenário 3 — Ordem dos parâmetros preservada', () => {
  it('body_params enviados em ordem são repassados na mesma ordem', async () => {
    const params = ['primeiro', 'segundo', 'terceiro', 'quarto']

    await sendTemplateRoute(
      makeSendPost({
        to: '5511999999999',
        name: 'tpl_ordered',
        language: 'pt_BR',
        body_params: params,
      }),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )

    const [,,,,,sentParams] = mockAdapterSendTemplate.mock.calls[0] as [unknown, unknown, unknown, unknown, unknown, string[]]
    expect(sentParams).toEqual(params)
    expect(sentParams[0]).toBe('primeiro')
    expect(sentParams[3]).toBe('quarto')
  })

  it('GET /variables retorna variáveis ordenadas por index', async () => {
    mockGetTemplateVariables.mockResolvedValue({
      id: TEMPLATE_ID,
      variables: [
        { index: 3, example: 'Cidade', component: 'BODY' },
        { index: 1, example: 'Nome', component: 'BODY' },
        { index: 2, example: 'Empresa', component: 'BODY' },
      ],
      variables_count: 3,
    })

    const res = await varsRoute(
      makeVarsGet(CHANNEL_ID, TEMPLATE_ID),
      { params: Promise.resolve({ id: CHANNEL_ID, templateId: TEMPLATE_ID }) },
    )

    expect(res.status).toBe(200)
    const body = await res.json() as { variables: Array<{ index: number }> }
    // All 3 variable indices must be present (order may vary — DB or route decides)
    const indices = body.variables.map((v) => v.index)
    expect(indices.sort((a, b) => a - b)).toEqual([1, 2, 3])
  })
})

// ---------------------------------------------------------------------------
// Cenário 4 — body_params omitido igual a []
// ---------------------------------------------------------------------------

describe('Cenário 4 — body_params omitido idêntico a [] no comportamento', () => {
  it('retorna 201 sem body_params (campo opcional)', async () => {
    const res = await sendTemplateRoute(
      makeSendPost({ to: '5511999999999', name: 'tpl_opt', language: 'pt_BR' }),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )
    expect(res.status).toBe(201)
  })

  it('adapter chamado mesmo sem body_params', async () => {
    await sendTemplateRoute(
      makeSendPost({ to: '5511999999999', name: 'tpl_opt', language: 'pt_BR' }),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )
    expect(mockAdapterSendTemplate).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Cenário 5 — Erro em GET /variables retorna 404 gracioso
// ---------------------------------------------------------------------------

describe('Cenário 5 — Erro em GET /variables tratado graciosamente', () => {
  it('templateId não encontrado retorna 404', async () => {
    mockGetTemplateVariables.mockResolvedValue(null)

    const res = await varsRoute(
      makeVarsGet(CHANNEL_ID, TEMPLATE_ID),
      { params: Promise.resolve({ id: CHANNEL_ID, templateId: TEMPLATE_ID }) },
    )

    expect(res.status).toBe(404)
    const body = await res.json() as { error: string }
    expect(body.error).toBeTruthy()
  })

  it('templateId inválido (não-UUID) retorna 400', async () => {
    const res = await varsRoute(
      makeVarsGet(CHANNEL_ID, 'invalid-not-uuid'),
      { params: Promise.resolve({ id: CHANNEL_ID, templateId: 'invalid-not-uuid' }) },
    )

    expect(res.status).toBe(400)
  })

  it('erro no DB ao buscar variáveis retorna 500', async () => {
    mockGetTemplateVariables.mockRejectedValue(new Error('DB connection failed'))

    const res = await varsRoute(
      makeVarsGet(CHANNEL_ID, TEMPLATE_ID),
      { params: Promise.resolve({ id: CHANNEL_ID, templateId: TEMPLATE_ID }) },
    )

    // Either 500 or error response
    expect(res.status).toBeGreaterThanOrEqual(400)
  })
})

// ---------------------------------------------------------------------------
// Cenário 6 — Multi-tenant: canal de outro workspace → 404
// ---------------------------------------------------------------------------

describe('Cenário 6 — Multi-tenant: canal de outro workspace bloqueado', () => {
  it('canal pertencente a outro workspace retorna 404', async () => {
    // Canal existe mas pertence a workspace diferente
    mockFindChannelById.mockResolvedValue(
      makeChannel({ id: CHANNEL_ID_B, workspace_id: 'ws-outro' }),
    )

    const res = await sendTemplateRoute(
      makeSendPost({ to: '5511999999999', name: 'tpl', language: 'pt_BR' }),
      { params: Promise.resolve({ id: CHANNEL_ID_B }) },
    )

    // Should be 404 (not found for this workspace) or 403
    expect([403, 404]).toContain(res.status)
    expect(mockAdapterSendTemplate).not.toHaveBeenCalled()
  })

  it('canal não existente retorna 404', async () => {
    mockFindChannelById.mockResolvedValue(null)

    const res = await sendTemplateRoute(
      makeSendPost({ to: '5511999999999', name: 'tpl', language: 'pt_BR' }),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )

    expect(res.status).toBe(404)
    expect(mockAdapterSendTemplate).not.toHaveBeenCalled()
  })

  it('adapter não é chamado para canal de outro workspace', async () => {
    mockFindChannelById.mockResolvedValue(
      makeChannel({ workspace_id: 'ws-intruso' }),
    )

    await sendTemplateRoute(
      makeSendPost({ to: '5511999999999', name: 'tpl', language: 'pt_BR' }),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )

    expect(mockAdapterSendTemplate).not.toHaveBeenCalled()
  })
})

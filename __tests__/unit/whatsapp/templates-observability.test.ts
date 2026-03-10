// ---------------------------------------------------------------------------
// Unit: Observabilidade -- logs de sync, list e variables (cenario 7)
//
// Cobre:
//   7a. Sync bem-sucedido -> log.info com { channelId, created, updated, deactivated }
//   7b. Sync com erro -> log.error chamado; credenciais nao aparecem no log
//   7c. List bem-sucedido -> log.info com { channelId, total }
//   7d. Variables bem-sucedido -> log.info com { channelId, templateId, variableCount }
//
// Todos os testes sao GREEN (rotas ja implementadas).
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ---------------------------------------------------------------------------
// Mock: logger (captura chamadas ao child logger)
// ---------------------------------------------------------------------------

const mockLogInfo = vi.fn()
const mockLogError = vi.fn()
const mockLoggerChild = vi.fn().mockReturnValue({ info: mockLogInfo, error: mockLogError })

vi.mock('@/lib/logger', () => ({
  logger: { child: mockLoggerChild },
}))

// ---------------------------------------------------------------------------
// Demais mocks
// ---------------------------------------------------------------------------

const mockRelease = vi.fn()
const mockClientQuery = vi.fn()
const mockConnect = vi.fn()
vi.mock('@/lib/database', () => ({ default: { connect: mockConnect } }))

vi.mock('@/lib/get-ip', () => ({ getClientIp: vi.fn().mockReturnValue('127.0.0.1') }))

const mockChannelCheck = vi.fn()
const mockSyncCheck = vi.fn()
vi.mock('@/lib/rate-limit', () => ({
  whatsappChannelLimiter: { check: mockChannelCheck },
  whatsappTemplateSyncLimiter: { check: mockSyncCheck },
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

const mockListTemplates = vi.fn()
const mockSyncTemplatesInTransaction = vi.fn()
const mockGetTemplateVariables = vi.fn()
vi.mock('@/lib/whatsapp/template-repo', () => ({
  listTemplates: mockListTemplates,
  syncTemplatesInTransaction: mockSyncTemplatesInTransaction,
  getTemplateVariables: mockGetTemplateVariables,
}))

// vi.hoisted garante que a variavel e inicializada antes do hoist de vi.mock
const mockAdapterSyncTemplates = vi.hoisted(() => vi.fn())
vi.mock('@/lib/whatsapp/adapters/meta', () => ({
  // Usa function regular (nao arrow) para que new MetaAdapter() funcione
  MetaAdapter: vi.fn().mockImplementation(function () {
    return { syncTemplates: mockAdapterSyncTemplates }
  }),
}))

// ---------------------------------------------------------------------------
// Importar rotas apos mocks
// ---------------------------------------------------------------------------

const { POST: syncRoute } = await import('@/app/api/whatsapp/channels/[id]/templates/sync/route')
const { GET: listRoute } = await import('@/app/api/whatsapp/channels/[id]/templates/route')
const { GET: varsRoute } = await import(
  '@/app/api/whatsapp/channels/[id]/templates/[templateId]/variables/route'
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CHANNEL_ID = 'cccc3333-cccc-4ccc-8ccc-cccccccccccc'
const TEMPLATE_ID = 'dddd4444-dddd-4ddd-8ddd-dddddddddddd'

const AUTH_CTX = {
  workspace_id: 'ws-observ',
  actor: 'api_key:obs',
  key_id: 'k-obs',
  dedup_actor_id: 'api_key:k-obs',
}

function makeMetaChannel(overrides: Record<string, unknown> = {}) {
  return {
    id: CHANNEL_ID,
    workspace_id: 'ws-observ',
    provider: 'META_CLOUD',
    status: 'CONNECTED',
    credentials_encrypted: 'enc-obs',
    ...overrides,
  }
}

function makeGet(path: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer wk_${'c'.repeat(64)}` },
  })
}

function makePost(path: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer wk_${'c'.repeat(64)}`,
      'Content-Type': 'application/json',
    },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockChannelCheck.mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 })
  mockSyncCheck.mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 })
  mockRequireWorkspaceAuth.mockResolvedValue(AUTH_CTX)
  mockConnect.mockResolvedValue({ query: mockClientQuery, release: mockRelease })
  mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  mockFindChannelById.mockResolvedValue(makeMetaChannel())
  // MetaAdapter: retorna templates vazios por padrao
  mockAdapterSyncTemplates.mockResolvedValue([])
  // Restaura mockLoggerChild para sempre retornar um novo child com os spies
  mockLoggerChild.mockReturnValue({ info: mockLogInfo, error: mockLogError })
})

// ---------------------------------------------------------------------------
// 7a. Sync bem-sucedido -- log.info com counts
// ---------------------------------------------------------------------------

describe('Observabilidade: POST /templates/sync -- sync bem-sucedido', () => {
  it('log.info inclui channelId e contagens de created/updated/deactivated', async () => {
    mockDecryptCredentials.mockReturnValue({ access_token: 'EAABtest', waba_id: 'waba-obs', phone_number_id: 'ph-obs' })
    mockAdapterSyncTemplates.mockResolvedValue([])
    mockSyncTemplatesInTransaction.mockResolvedValue({ created: 3, updated: 1, deactivated: 2 })

    const res = await syncRoute(
      makePost(`/api/whatsapp/channels/${CHANNEL_ID}/templates/sync`),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )

    expect(res.status).toBe(200)
    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: CHANNEL_ID,
        created: 3,
        updated: 1,
        deactivated: 2,
      }),
      'Templates sincronizados',
    )
  })

  it('log.info com contagens zeradas quando nenhum template muda (idempotente)', async () => {
    mockDecryptCredentials.mockReturnValue({ access_token: 'EAABtest', waba_id: 'waba-obs', phone_number_id: 'ph-obs' })
    mockAdapterSyncTemplates.mockResolvedValue([])
    mockSyncTemplatesInTransaction.mockResolvedValue({ created: 0, updated: 0, deactivated: 0 })

    await syncRoute(
      makePost(`/api/whatsapp/channels/${CHANNEL_ID}/templates/sync`),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )

    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: CHANNEL_ID, created: 0, updated: 0, deactivated: 0 }),
      'Templates sincronizados',
    )
  })
})

// ---------------------------------------------------------------------------
// 7b. Sync com erro -- log.error sem vazar credenciais
// ---------------------------------------------------------------------------

describe('Observabilidade: POST /templates/sync -- falha de sync', () => {
  it('log.error e chamado quando sync falha', async () => {
    mockDecryptCredentials.mockReturnValue({ access_token: 'EAABtest', waba_id: 'waba-obs', phone_number_id: 'ph-obs' })
    mockAdapterSyncTemplates.mockRejectedValue(new Error('timeout na Meta API'))

    const res = await syncRoute(
      makePost(`/api/whatsapp/channels/${CHANNEL_ID}/templates/sync`),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )

    expect(res.status).toBe(500)
    expect(mockLogError).toHaveBeenCalled()
  })

  it('log.error nao inclui access_token nas propriedades de primeiro nivel', async () => {
    mockDecryptCredentials.mockReturnValue({ access_token: 'EAABtest', waba_id: 'waba-obs', phone_number_id: 'ph-obs' })
    mockAdapterSyncTemplates.mockRejectedValue(new Error('falha de rede'))

    await syncRoute(
      makePost(`/api/whatsapp/channels/${CHANNEL_ID}/templates/sync`),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )

    // Verifica os argumentos passados para log.error
    const logArgs = mockLogError.mock.calls[0]
    // Primeiro argumento e o objeto de contexto; nao deve conter access_token
    const contextArg = logArgs[0] as Record<string, unknown>
    expect(JSON.stringify(contextArg)).not.toMatch(/EAABtest/)
    expect(JSON.stringify(contextArg)).not.toMatch(/access_token/i)
  })

  it('log.error nao inclui credentials_encrypted no contexto', async () => {
    mockDecryptCredentials.mockReturnValue({ access_token: 'EAABtest', waba_id: 'waba-obs', phone_number_id: 'ph-obs' })
    mockAdapterSyncTemplates.mockRejectedValue(new Error('falha'))

    await syncRoute(
      makePost(`/api/whatsapp/channels/${CHANNEL_ID}/templates/sync`),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )

    const logArgs = mockLogError.mock.calls[0]
    expect(JSON.stringify(logArgs)).not.toMatch(/credentials_encrypted/i)
  })

  it('ROLLBACK e chamado quando syncTemplatesInTransaction lanca', async () => {
    mockDecryptCredentials.mockReturnValue({ access_token: 'tok', waba_id: 'waba-obs', phone_number_id: 'ph-obs' })
    mockAdapterSyncTemplates.mockResolvedValue([])
    mockSyncTemplatesInTransaction.mockRejectedValue(new Error('constraint'))

    await syncRoute(
      makePost(`/api/whatsapp/channels/${CHANNEL_ID}/templates/sync`),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )

    // client.query deve ter sido chamado com ROLLBACK
    const calls = mockClientQuery.mock.calls.map((c: unknown[]) => c[0])
    expect(calls).toContain('ROLLBACK')
  })
})

// ---------------------------------------------------------------------------
// 7c. List bem-sucedido -- log.info com channelId e total
// ---------------------------------------------------------------------------

describe('Observabilidade: GET /templates -- list bem-sucedido', () => {
  it('log.info inclui channelId e total de templates', async () => {
    mockListTemplates.mockResolvedValue({
      data: [{ id: 't-1' }, { id: 't-2' }],
      pagination: { total: 2, page: 1, limit: 20, pages: 1 },
    })

    const res = await listRoute(
      makeGet(`/api/whatsapp/channels/${CHANNEL_ID}/templates`),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )

    expect(res.status).toBe(200)
    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: CHANNEL_ID, total: 2 }),
      'Templates listados',
    )
  })

  it('log.info com total=0 quando lista vazia', async () => {
    mockListTemplates.mockResolvedValue({
      data: [],
      pagination: { total: 0, page: 1, limit: 20, pages: 0 },
    })

    await listRoute(
      makeGet(`/api/whatsapp/channels/${CHANNEL_ID}/templates`),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )

    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: CHANNEL_ID, total: 0 }),
      'Templates listados',
    )
  })
})

// ---------------------------------------------------------------------------
// 7d. Variables bem-sucedido -- log.info com channelId, templateId, variableCount
// ---------------------------------------------------------------------------

describe('Observabilidade: GET /templates/:id/variables -- variables bem-sucedido', () => {
  it('log.info inclui channelId, templateId e variableCount', async () => {
    mockGetTemplateVariables.mockResolvedValue({
      variables: [
        { index: 1, component: 'BODY' },
        { index: 2, component: 'BODY' },
      ],
    })

    const res = await varsRoute(
      makeGet(`/api/whatsapp/channels/${CHANNEL_ID}/templates/${TEMPLATE_ID}/variables`),
      { params: Promise.resolve({ id: CHANNEL_ID, templateId: TEMPLATE_ID }) },
    )

    expect(res.status).toBe(200)
    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: CHANNEL_ID,
        templateId: TEMPLATE_ID,
        variableCount: 2,
      }),
      'Variaveis do template retornadas',
    )
  })

  it('log.info com variableCount=0 para template sem variaveis', async () => {
    mockGetTemplateVariables.mockResolvedValue({ variables: [] })

    await varsRoute(
      makeGet(`/api/whatsapp/channels/${CHANNEL_ID}/templates/${TEMPLATE_ID}/variables`),
      { params: Promise.resolve({ id: CHANNEL_ID, templateId: TEMPLATE_ID }) },
    )

    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.objectContaining({ variableCount: 0 }),
      'Variaveis do template retornadas',
    )
  })
})

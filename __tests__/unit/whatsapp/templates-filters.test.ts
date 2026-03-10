// ---------------------------------------------------------------------------
// Unit: Filtros/listagem e isolamento de workspace — GET /templates (cenários 3 e 5)
//
// Cobre:
//   3. Filtros de listagem: status, language, search, paginação
//      • Cada filtro é repassado corretamente para listTemplates()
//      • Sem filtros → valores padrão (page=1, limit=20)
//      • Lista vazia com canal selecionado → 200 + data:[]
//   5. Segurança/isolamento:
//      • workspace_id vem do token/sessão (auth), nunca da query string
//      • GET /templates não mistura dados de outro workspace
//      • POST /sync bloqueia canal de outro workspace (403)
//      • GET /variables bloqueia templateId de canal diferente (403)
//
// Todos os testes são GREEN (rotas já implementadas corretamente).
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

vi.mock('@/lib/whatsapp/crypto', () => ({
  decryptCredentials: vi.fn().mockReturnValue({ access_token: 'tok', waba_id: 'waba-1' }),
}))

const mockListTemplates = vi.fn()
const mockSyncTemplatesInTransaction = vi.fn()
const mockGetTemplateVariables = vi.fn()
vi.mock('@/lib/whatsapp/template-repo', () => ({
  listTemplates: mockListTemplates,
  syncTemplatesInTransaction: mockSyncTemplatesInTransaction,
  getTemplateVariables: mockGetTemplateVariables,
}))

vi.mock('@/lib/whatsapp/adapters/meta', () => ({
  MetaAdapter: vi.fn().mockImplementation(() => ({ syncTemplates: vi.fn().mockResolvedValue([]) })),
}))

// ---------------------------------------------------------------------------
// Importar rotas após mocks
// ---------------------------------------------------------------------------

const { GET: listRoute } = await import('@/app/api/whatsapp/channels/[id]/templates/route')
const { POST: syncRoute } = await import('@/app/api/whatsapp/channels/[id]/templates/sync/route')
const { GET: varsRoute } = await import(
  '@/app/api/whatsapp/channels/[id]/templates/[templateId]/variables/route'
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CHANNEL_ID = 'aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TEMPLATE_ID = 'bbbb2222-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const AUTH_WS1 = {
  workspace_id: 'ws-filtros-test',
  actor: 'api_key:test',
  key_id: 'k-1',
  dedup_actor_id: 'api_key:k-1',
}

const EMPTY_PAGINATION = {
  data: [],
  pagination: { total: 0, page: 1, limit: 20, pages: 0 },
}

function makeMetaChannel(overrides: Record<string, unknown> = {}) {
  return {
    id: CHANNEL_ID,
    workspace_id: 'ws-filtros-test',
    provider: 'META_CLOUD',
    status: 'CONNECTED',
    credentials_encrypted: 'enc',
    ...overrides,
  }
}

function makeGetWithQuery(params: Record<string, string>): NextRequest {
  const url = new URL(`http://localhost/api/whatsapp/channels/${CHANNEL_ID}/templates`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return new NextRequest(url.toString(), {
    method: 'GET',
    headers: { Authorization: `Bearer wk_${'b'.repeat(64)}` },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockChannelCheck.mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 })
  mockSyncCheck.mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 })
  mockRequireWorkspaceAuth.mockResolvedValue(AUTH_WS1)
  mockConnect.mockResolvedValue({ query: mockClientQuery, release: mockRelease })
  mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  mockFindChannelById.mockResolvedValue(makeMetaChannel())
  mockListTemplates.mockResolvedValue(EMPTY_PAGINATION)
})

// ---------------------------------------------------------------------------
// 3a. Filtros por status
// ---------------------------------------------------------------------------

describe('Filtro por status — GET /templates', () => {
  it('passa status=APPROVED para listTemplates', async () => {
    await listRoute(
      makeGetWithQuery({ status: 'APPROVED' }),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )
    expect(mockListTemplates).toHaveBeenCalledWith(
      expect.anything(),
      'ws-filtros-test',
      CHANNEL_ID,
      expect.objectContaining({ status: 'APPROVED' }),
    )
  })

  it('passa status=PENDING para listTemplates', async () => {
    await listRoute(
      makeGetWithQuery({ status: 'PENDING' }),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )
    expect(mockListTemplates).toHaveBeenCalledWith(
      expect.anything(),
      'ws-filtros-test',
      CHANNEL_ID,
      expect.objectContaining({ status: 'PENDING' }),
    )
  })

  it('passa status=REJECTED para listTemplates', async () => {
    await listRoute(
      makeGetWithQuery({ status: 'REJECTED' }),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )
    expect(mockListTemplates).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      CHANNEL_ID,
      expect.objectContaining({ status: 'REJECTED' }),
    )
  })

  it('omite status quando não informado (undefined)', async () => {
    await listRoute(
      makeGetWithQuery({}),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )
    const [, , , opts] = mockListTemplates.mock.calls[0] as [unknown, string, string, { status?: string }]
    expect(opts.status).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 3b. Filtros por language
// ---------------------------------------------------------------------------

describe('Filtro por language — GET /templates', () => {
  it('passa language=pt_BR para listTemplates', async () => {
    await listRoute(
      makeGetWithQuery({ language: 'pt_BR' }),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )
    expect(mockListTemplates).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      CHANNEL_ID,
      expect.objectContaining({ language: 'pt_BR' }),
    )
  })

  it('passa language=en_US para listTemplates', async () => {
    await listRoute(
      makeGetWithQuery({ language: 'en_US' }),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )
    expect(mockListTemplates).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      CHANNEL_ID,
      expect.objectContaining({ language: 'en_US' }),
    )
  })

  it('omite language quando ausente (undefined)', async () => {
    await listRoute(makeGetWithQuery({}), { params: Promise.resolve({ id: CHANNEL_ID }) })
    const [, , , opts] = mockListTemplates.mock.calls[0] as [unknown, string, string, { language?: string }]
    expect(opts.language).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 3c. Busca por nome (search)
// ---------------------------------------------------------------------------

describe('Busca por nome (search) — GET /templates', () => {
  it('passa search=boas_vindas para listTemplates', async () => {
    await listRoute(
      makeGetWithQuery({ search: 'boas_vindas' }),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )
    expect(mockListTemplates).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      CHANNEL_ID,
      expect.objectContaining({ search: 'boas_vindas' }),
    )
  })

  it('omite search quando ausente (undefined)', async () => {
    await listRoute(makeGetWithQuery({}), { params: Promise.resolve({ id: CHANNEL_ID }) })
    const [, , , opts] = mockListTemplates.mock.calls[0] as [unknown, string, string, { search?: string }]
    expect(opts.search).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 3d. Paginação (page, limit)
// ---------------------------------------------------------------------------

describe('Paginação — GET /templates', () => {
  it('usa page=1 e limit=20 como padrão quando não informados', async () => {
    await listRoute(makeGetWithQuery({}), { params: Promise.resolve({ id: CHANNEL_ID }) })
    expect(mockListTemplates).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      CHANNEL_ID,
      expect.objectContaining({ page: 1, limit: 20 }),
    )
  })

  it('passa page=3 e limit=50 quando explicitamente definidos', async () => {
    await listRoute(
      makeGetWithQuery({ page: '3', limit: '50' }),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )
    expect(mockListTemplates).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      CHANNEL_ID,
      expect.objectContaining({ page: 3, limit: 50 }),
    )
  })

  it('resposta 200 com data:[] quando lista vazia (canal válido, sem templates)', async () => {
    mockListTemplates.mockResolvedValue(EMPTY_PAGINATION)
    const res = await listRoute(
      makeGetWithQuery({}),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )
    expect(res.status).toBe(200)
    const body = await res.json() as typeof EMPTY_PAGINATION
    expect(body.data).toEqual([])
    expect(body.pagination.total).toBe(0)
  })

  it('mantém filtros ao paginar (todos os parâmetros combinados)', async () => {
    await listRoute(
      makeGetWithQuery({ page: '2', limit: '10', status: 'APPROVED', language: 'pt_BR', search: 'abc' }),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )
    expect(mockListTemplates).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      CHANNEL_ID,
      expect.objectContaining({ page: 2, limit: 10, status: 'APPROVED', language: 'pt_BR', search: 'abc' }),
    )
  })
})

// ---------------------------------------------------------------------------
// 5. Segurança — isolamento de workspace
// ---------------------------------------------------------------------------

describe('Isolamento de workspace', () => {
  it('GET /templates usa workspace_id da autenticação, não da query string', async () => {
    // Mesmo que um atacante passe workspace_id na URL, o route usa o do token
    const url = new URL(`http://localhost/api/whatsapp/channels/${CHANNEL_ID}/templates`)
    url.searchParams.set('workspace_id', 'ws-atacante')
    const req = new NextRequest(url.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer wk_${'b'.repeat(64)}` },
    })

    await listRoute(req, { params: Promise.resolve({ id: CHANNEL_ID }) })

    // listTemplates DEVE ser chamado com ws-filtros-test (do token), nunca ws-atacante
    expect(mockListTemplates).toHaveBeenCalledWith(
      expect.anything(),
      'ws-filtros-test',
      CHANNEL_ID,
      expect.any(Object),
    )
    expect(mockListTemplates).not.toHaveBeenCalledWith(
      expect.anything(),
      'ws-atacante',
      expect.any(String),
      expect.any(Object),
    )
  })

  it('GET /templates bloqueia (403) canal que pertence a outro workspace', async () => {
    // Canal existe mas é de outro workspace
    mockFindChannelById.mockResolvedValue(makeMetaChannel({ workspace_id: 'ws-outro' }))
    const res = await listRoute(
      makeGetWithQuery({}),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )
    expect(res.status).toBe(403)
    // listTemplates nunca deve ser chamado nesse caso
    expect(mockListTemplates).not.toHaveBeenCalled()
  })

  it('POST /templates/sync bloqueia (403) canal de outro workspace', async () => {
    mockFindChannelById.mockResolvedValue(makeMetaChannel({ workspace_id: 'ws-outro' }))
    const res = await syncRoute(
      new NextRequest(`http://localhost/api/whatsapp/channels/${CHANNEL_ID}/templates/sync`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer wk_${'b'.repeat(64)}`,
          'Content-Type': 'application/json',
        },
      }),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )
    expect(res.status).toBe(403)
    expect(mockSyncTemplatesInTransaction).not.toHaveBeenCalled()
  })

  it('GET /variables bloqueia (403) canal de outro workspace', async () => {
    mockFindChannelById.mockResolvedValue(makeMetaChannel({ workspace_id: 'ws-outro' }))
    const res = await varsRoute(
      new NextRequest(
        `http://localhost/api/whatsapp/channels/${CHANNEL_ID}/templates/${TEMPLATE_ID}/variables`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer wk_${'b'.repeat(64)}` },
        },
      ),
      { params: Promise.resolve({ id: CHANNEL_ID, templateId: TEMPLATE_ID }) },
    )
    expect(res.status).toBe(403)
    expect(mockGetTemplateVariables).not.toHaveBeenCalled()
  })

  it('GET /variables usa workspace_id da auth para isolar templates', async () => {
    mockFindChannelById.mockResolvedValue(makeMetaChannel())
    mockGetTemplateVariables.mockResolvedValue({ variables: [{ index: 1, component: 'BODY' }] })

    await varsRoute(
      new NextRequest(
        `http://localhost/api/whatsapp/channels/${CHANNEL_ID}/templates/${TEMPLATE_ID}/variables`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer wk_${'b'.repeat(64)}` },
        },
      ),
      { params: Promise.resolve({ id: CHANNEL_ID, templateId: TEMPLATE_ID }) },
    )

    // getTemplateVariables deve receber workspace_id do token
    expect(mockGetTemplateVariables).toHaveBeenCalledWith(
      expect.anything(),
      TEMPLATE_ID,
      'ws-filtros-test',
      CHANNEL_ID,
    )
  })
})

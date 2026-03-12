// ---------------------------------------------------------------------------
// Unit: HTTP error codes -- WhatsApp template endpoints (cenario 4)
//
// Cobre todos os codigos de erro que a UI deve tratar:
//   400 -- parâmetros de query inválidos
//   401 -- sem autenticação (delegado ao templates-security.test.ts; aqui: via mock)
//   403 -- workspace mismatch
//   404 -- canal ou template nao encontrado
//   409 -- canal não é META_CLOUD
//   422 -- canal sem waba_id (sync apenas)
//   429 -- rate limit excedido
//   500 -- erro interno inesperado
//
// Todos os testes sao GREEN (rotas ja implementadas).
// Mocks isolam completamente o banco de dados e servicos externos.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ---------------------------------------------------------------------------
// Mocks -- devem preceder qualquer import de rota
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

// Mock auth-middleware: mantem authErrorResponse real, substitui requireWorkspaceAuth
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

const mockAdapterSyncTemplates = vi.hoisted(() => vi.fn())
vi.mock('@/lib/whatsapp/adapters/meta', () => ({
  MetaAdapter: vi.fn().mockImplementation(function () {
    return { syncTemplates: mockAdapterSyncTemplates }
  }),
}))

// RetryableError: importado apos mocks para uso nos testes de 503
const { RetryableError } = await import('@/lib/whatsapp/errors')

// ---------------------------------------------------------------------------
// Importar rotas APOS os mocks
// ---------------------------------------------------------------------------

const { POST: syncRoute } = await import('@/app/api/whatsapp/channels/[id]/templates/sync/route')
const { GET: listRoute } = await import('@/app/api/whatsapp/channels/[id]/templates/route')
const { GET: varsRoute } = await import(
  '@/app/api/whatsapp/channels/[id]/templates/[templateId]/variables/route'
)

// ---------------------------------------------------------------------------
// Constantes e helpers
// ---------------------------------------------------------------------------

const CHANNEL_ID = '11111111-1111-4111-8111-111111111111'
const TEMPLATE_ID = '33333333-3333-4333-8333-333333333333'

const AUTH_WS1 = {
  workspace_id: 'ws-1',
  actor: 'api_key:test',
  key_id: 'k-1',
  dedup_actor_id: 'api_key:k-1',
}

function makeChannel(overrides: Record<string, unknown> = {}) {
  return {
    id: CHANNEL_ID,
    workspace_id: 'ws-1',
    provider: 'META_CLOUD',
    status: 'CONNECTED',
    credentials_encrypted: 'enc-abc',
    ...overrides,
  }
}

function makeGet(path: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer wk_${'a'.repeat(64)}` },
  })
}

function makePost(path: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer wk_${'a'.repeat(64)}`,
      'Content-Type': 'application/json',
    },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  // Rate limiters: liberados por padrao
  mockChannelCheck.mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 })
  mockSyncCheck.mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 })
  // Auth: sucesso por padrao
  mockRequireWorkspaceAuth.mockResolvedValue(AUTH_WS1)
  // DB client
  mockConnect.mockResolvedValue({ query: mockClientQuery, release: mockRelease })
  mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 })
})

// ---------------------------------------------------------------------------
// 429 -- Rate limit
// ---------------------------------------------------------------------------

describe('429 Rate limit excedido', () => {
  it('GET /templates retorna 429 + Retry-After quando limitado', async () => {
    mockChannelCheck.mockResolvedValueOnce({ success: false, resetAt: Date.now() + 30_000 })
    const res = await listRoute(
      makeGet(`/api/whatsapp/channels/${CHANNEL_ID}/templates`),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBeTruthy()
  })

  it('POST /templates/sync retorna 429 + Retry-After quando limitado', async () => {
    mockSyncCheck.mockResolvedValueOnce({ success: false, resetAt: Date.now() + 30_000 })
    const res = await syncRoute(
      makePost(`/api/whatsapp/channels/${CHANNEL_ID}/templates/sync`),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBeTruthy()
  })

  it('GET /templates/:id/variables retorna 429 quando limitado', async () => {
    mockChannelCheck.mockResolvedValueOnce({ success: false, resetAt: Date.now() + 30_000 })
    const res = await varsRoute(
      makeGet(`/api/whatsapp/channels/${CHANNEL_ID}/templates/${TEMPLATE_ID}/variables`),
      { params: Promise.resolve({ id: CHANNEL_ID, templateId: TEMPLATE_ID }) },
    )
    expect(res.status).toBe(429)
  })
})

// ---------------------------------------------------------------------------
// 404 -- Canal ou template nao encontrado
// ---------------------------------------------------------------------------

describe('404 Canal/template nao encontrado', () => {
  it('GET /templates retorna 404 quando canal nao existe', async () => {
    mockFindChannelById.mockResolvedValue(null)
    const res = await listRoute(
      makeGet(`/api/whatsapp/channels/${CHANNEL_ID}/templates`),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )
    expect(res.status).toBe(404)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/nao encontrado/i)
  })

  it('POST /templates/sync retorna 404 quando canal nao existe', async () => {
    mockFindChannelById.mockResolvedValue(null)
    const res = await syncRoute(
      makePost(`/api/whatsapp/channels/${CHANNEL_ID}/templates/sync`),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )
    expect(res.status).toBe(404)
  })

  it('GET /templates/:id/variables retorna 404 quando canal nao existe', async () => {
    mockFindChannelById.mockResolvedValue(null)
    const res = await varsRoute(
      makeGet(`/api/whatsapp/channels/${CHANNEL_ID}/templates/${TEMPLATE_ID}/variables`),
      { params: Promise.resolve({ id: CHANNEL_ID, templateId: TEMPLATE_ID }) },
    )
    expect(res.status).toBe(404)
  })

  it('GET /templates/:id/variables retorna 404 quando templateId nao encontrado', async () => {
    mockFindChannelById.mockResolvedValue(makeChannel())
    mockGetTemplateVariables.mockResolvedValue(null)
    const res = await varsRoute(
      makeGet(`/api/whatsapp/channels/${CHANNEL_ID}/templates/${TEMPLATE_ID}/variables`),
      { params: Promise.resolve({ id: CHANNEL_ID, templateId: TEMPLATE_ID }) },
    )
    expect(res.status).toBe(404)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/template nao encontrado/i)
  })
})

// ---------------------------------------------------------------------------
// 403 -- Acesso negado (workspace mismatch)
// ---------------------------------------------------------------------------

describe('403 Acesso negado -- workspace mismatch', () => {
  it('GET /templates retorna 403 quando canal pertence a outro workspace', async () => {
    mockFindChannelById.mockResolvedValue(makeChannel({ workspace_id: 'ws-outro' }))
    const res = await listRoute(
      makeGet(`/api/whatsapp/channels/${CHANNEL_ID}/templates`),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )
    expect(res.status).toBe(403)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/acesso negado/i)
  })

  it('POST /templates/sync retorna 403 quando canal e de outro workspace', async () => {
    mockFindChannelById.mockResolvedValue(makeChannel({ workspace_id: 'ws-outro' }))
    const res = await syncRoute(
      makePost(`/api/whatsapp/channels/${CHANNEL_ID}/templates/sync`),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )
    expect(res.status).toBe(403)
  })

  it('GET /templates/:id/variables retorna 403 quando canal e de outro workspace', async () => {
    mockFindChannelById.mockResolvedValue(makeChannel({ workspace_id: 'ws-outro' }))
    const res = await varsRoute(
      makeGet(`/api/whatsapp/channels/${CHANNEL_ID}/templates/${TEMPLATE_ID}/variables`),
      { params: Promise.resolve({ id: CHANNEL_ID, templateId: TEMPLATE_ID }) },
    )
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// 409 -- Provider nao suportado (somente META_CLOUD)
// ---------------------------------------------------------------------------

describe('409 Provider nao suportado -- somente META_CLOUD', () => {
  it('GET /templates retorna 409 para canal EVOLUTION', async () => {
    mockFindChannelById.mockResolvedValue(makeChannel({ provider: 'EVOLUTION' }))
    const res = await listRoute(
      makeGet(`/api/whatsapp/channels/${CHANNEL_ID}/templates`),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )
    expect(res.status).toBe(409)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/META_CLOUD/i)
  })

  it('GET /templates retorna 409 para canal UAZAPI', async () => {
    mockFindChannelById.mockResolvedValue(makeChannel({ provider: 'UAZAPI' }))
    const res = await listRoute(
      makeGet(`/api/whatsapp/channels/${CHANNEL_ID}/templates`),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )
    expect(res.status).toBe(409)
  })

  it('POST /templates/sync retorna 409 para canal EVOLUTION', async () => {
    mockFindChannelById.mockResolvedValue(makeChannel({ provider: 'EVOLUTION' }))
    const res = await syncRoute(
      makePost(`/api/whatsapp/channels/${CHANNEL_ID}/templates/sync`),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )
    expect(res.status).toBe(409)
  })

  it('POST /templates/sync retorna 409 para canal UAZAPI', async () => {
    mockFindChannelById.mockResolvedValue(makeChannel({ provider: 'UAZAPI' }))
    const res = await syncRoute(
      makePost(`/api/whatsapp/channels/${CHANNEL_ID}/templates/sync`),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )
    expect(res.status).toBe(409)
  })
})

// ---------------------------------------------------------------------------
// 422 -- Canal sem waba_id (sync apenas)
// ---------------------------------------------------------------------------

describe('422 Canal sem waba_id (sync)', () => {
  it('POST /templates/sync retorna 422 quando waba_id ausente nas credenciais', async () => {
    mockFindChannelById.mockResolvedValue(makeChannel())
    // Creds sem waba_id
    mockDecryptCredentials.mockReturnValue({
      access_token: 'EAABtest',
      phone_number_id: 'ph-123',
      app_secret: 'sec-abc',
      // waba_id: intencionalmente ausente
    })
    const res = await syncRoute(
      makePost(`/api/whatsapp/channels/${CHANNEL_ID}/templates/sync`),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )
    expect(res.status).toBe(422)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/waba_id/i)
  })

  it('POST /templates/sync retorna 422 quando waba_id e string vazia', async () => {
    mockFindChannelById.mockResolvedValue(makeChannel())
    mockDecryptCredentials.mockReturnValue({
      access_token: 'EAABtest',
      phone_number_id: 'ph-123',
      waba_id: '', // vazio equivale a falsy
    })
    const res = await syncRoute(
      makePost(`/api/whatsapp/channels/${CHANNEL_ID}/templates/sync`),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )
    expect(res.status).toBe(422)
  })

  it('POST /templates/sync retorna 422 quando access_token ausente', async () => {
    mockFindChannelById.mockResolvedValue(makeChannel())
    mockDecryptCredentials.mockReturnValue({
      waba_id: 'waba-123',
      phone_number_id: 'ph-123',
      // access_token: intencionalmente ausente
    })
    const res = await syncRoute(
      makePost(`/api/whatsapp/channels/${CHANNEL_ID}/templates/sync`),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )
    expect(res.status).toBe(422)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/access_token/i)
  })

  it('POST /templates/sync retorna 422 quando phone_number_id ausente', async () => {
    mockFindChannelById.mockResolvedValue(makeChannel())
    mockDecryptCredentials.mockReturnValue({
      waba_id: 'waba-123',
      access_token: 'EAABtest',
      // phone_number_id: intencionalmente ausente
    })
    const res = await syncRoute(
      makePost(`/api/whatsapp/channels/${CHANNEL_ID}/templates/sync`),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )
    expect(res.status).toBe(422)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/phone_number_id/i)
  })
})

// ---------------------------------------------------------------------------
// 503 -- Meta indisponivel (RetryableError)
// ---------------------------------------------------------------------------

describe('503 Meta indisponivel -- RetryableError', () => {
  it('POST /templates/sync retorna 503 quando MetaAdapter lanca RetryableError', async () => {
    mockFindChannelById.mockResolvedValue(makeChannel())
    mockDecryptCredentials.mockReturnValue({ access_token: 'tok', waba_id: 'waba-123', phone_number_id: 'ph-1' })
    mockAdapterSyncTemplates.mockRejectedValue(new RetryableError('Meta 503'))
    const res = await syncRoute(
      makePost(`/api/whatsapp/channels/${CHANNEL_ID}/templates/sync`),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )
    expect(res.status).toBe(503)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/Meta indisponivel/i)
  })
})

// ---------------------------------------------------------------------------
// 500 -- Erro interno inesperado
// ---------------------------------------------------------------------------

describe('500 Erro interno do servidor', () => {
  it('GET /templates retorna 500 em erro inesperado do repositorio', async () => {
    mockFindChannelById.mockResolvedValue(makeChannel())
    mockListTemplates.mockRejectedValue(new Error('DB connection lost'))
    const res = await listRoute(
      makeGet(`/api/whatsapp/channels/${CHANNEL_ID}/templates`),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )
    expect(res.status).toBe(500)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/erro interno/i)
  })

  it('POST /templates/sync retorna 500 quando MetaAdapter lanca erro inesperado', async () => {
    mockFindChannelById.mockResolvedValue(makeChannel())
    mockDecryptCredentials.mockReturnValue({ access_token: 'tok', waba_id: 'waba-123', phone_number_id: 'ph-1' })
    mockAdapterSyncTemplates.mockRejectedValue(new Error('Meta API timeout'))
    const res = await syncRoute(
      makePost(`/api/whatsapp/channels/${CHANNEL_ID}/templates/sync`),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )
    expect(res.status).toBe(500)
  })

  it('POST /templates/sync retorna 500 quando syncTemplatesInTransaction lanca', async () => {
    mockFindChannelById.mockResolvedValue(makeChannel())
    mockDecryptCredentials.mockReturnValue({ access_token: 'tok', waba_id: 'waba-123', phone_number_id: 'ph-1' })
    mockAdapterSyncTemplates.mockResolvedValue([])
    mockSyncTemplatesInTransaction.mockRejectedValue(new Error('constraint violation'))
    const res = await syncRoute(
      makePost(`/api/whatsapp/channels/${CHANNEL_ID}/templates/sync`),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )
    expect(res.status).toBe(500)
  })

  it('GET /templates/:id/variables retorna 500 em erro inesperado', async () => {
    mockFindChannelById.mockResolvedValue(makeChannel())
    mockGetTemplateVariables.mockRejectedValue(new Error('unexpected'))
    const res = await varsRoute(
      makeGet(`/api/whatsapp/channels/${CHANNEL_ID}/templates/${TEMPLATE_ID}/variables`),
      { params: Promise.resolve({ id: CHANNEL_ID, templateId: TEMPLATE_ID }) },
    )
    expect(res.status).toBe(500)
  })
})

// ---------------------------------------------------------------------------
// 400 -- Query params inválidos (list apenas)
// ---------------------------------------------------------------------------

describe('400 Query params inválidos -- GET /templates', () => {
  function makeGetWithQuery(params: Record<string, string>): NextRequest {
    const url = new URL(`http://localhost/api/whatsapp/channels/${CHANNEL_ID}/templates`)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
    return new NextRequest(url.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer wk_${'a'.repeat(64)}` },
    })
  }

  it('retorna 400 para status inválido (não está no enum)', async () => {
    const res = await listRoute(
      makeGetWithQuery({ status: 'ATIVO' }),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )
    expect(res.status).toBe(400)
  })

  it('retorna 400 para limit acima de 100', async () => {
    const res = await listRoute(
      makeGetWithQuery({ limit: '999' }),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )
    expect(res.status).toBe(400)
  })

  it('retorna 400 para search com mais de 100 chars', async () => {
    const res = await listRoute(
      makeGetWithQuery({ search: 'a'.repeat(101) }),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )
    expect(res.status).toBe(400)
  })

  it('retorna 400 para channel_id inválido (nao UUID)', async () => {
    const res = await listRoute(
      new NextRequest('http://localhost/api/whatsapp/channels/nao-uuid/templates', {
        method: 'GET',
        headers: { Authorization: `Bearer wk_${'a'.repeat(64)}` },
      }),
      { params: Promise.resolve({ id: 'nao-uuid' }) },
    )
    expect(res.status).toBe(400)
    // Nao deve chamar o DB para IDs inválidos
    expect(mockConnect).not.toHaveBeenCalled()
  })

  it('retorna 400 para templateId inválido (nao UUID) em /variables', async () => {
    const res = await varsRoute(
      makeGet(`/api/whatsapp/channels/${CHANNEL_ID}/templates/nao-uuid/variables`),
      { params: Promise.resolve({ id: CHANNEL_ID, templateId: 'nao-uuid' }) },
    )
    expect(res.status).toBe(400)
    expect(mockConnect).not.toHaveBeenCalled()
  })
})

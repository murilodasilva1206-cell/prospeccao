// ---------------------------------------------------------------------------
// TDD — Cenário 6: UX sem canal Meta
//
// Página Templates sem canal Meta conectado:
//   - Não tenta chamar /templates/sync (sem requisição ao server)
//   - Exibe CTA "Configurar canal Meta" (ou similar)
//   - Não exibe erro de rede / estado de loading infinito
//   - Lista de templates vazia + mensagem orientando o usuário
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

const mockFindChannelsByWorkspace = vi.fn()
const mockFindChannelById = vi.fn()
vi.mock('@/lib/whatsapp/channel-repo', () => ({
  findChannelsByWorkspace: mockFindChannelsByWorkspace,
  findChannelById: mockFindChannelById,
}))

const mockListTemplates = vi.fn()
const mockSyncTemplatesInTransaction = vi.fn()
vi.mock('@/lib/whatsapp/template-repo', () => ({
  listTemplates: mockListTemplates,
  syncTemplatesInTransaction: mockSyncTemplatesInTransaction,
}))

const mockDecryptCredentials = vi.fn()
vi.mock('@/lib/whatsapp/crypto', () => ({ decryptCredentials: mockDecryptCredentials }))

const mockAdapterSyncTemplates = vi.hoisted(() => vi.fn())
vi.mock('@/lib/whatsapp/adapters/meta', () => ({
  MetaAdapter: vi.fn().mockImplementation(function () {
    return { syncTemplates: mockAdapterSyncTemplates }
  }),
}))

vi.mock('@/lib/logger', () => ({
  logger: { child: vi.fn().mockReturnValue({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}))

// ---------------------------------------------------------------------------
// Import routes AFTER mocks
// ---------------------------------------------------------------------------

const { POST: syncRoute } = await import('@/app/api/whatsapp/channels/[id]/templates/sync/route')
const { GET: listRoute } = await import('@/app/api/whatsapp/channels/[id]/templates/route')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EVOLUTION_CHANNEL_ID = 'eeee1111-eeee-4eee-8eee-eeeeeeeeeeee'
const UAZAPI_CHANNEL_ID = 'cc222222-2222-4222-8222-222222222222'

const AUTH_WS = {
  workspace_id: 'ws-no-meta',
  actor: 'api_key:test',
  key_id: 'k-no-meta',
  dedup_actor_id: 'api_key:k-no-meta',
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
    headers: { Authorization: `Bearer wk_${'a'.repeat(64)}` },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockChannelCheck.mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 })
  mockSyncCheck.mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 })
  mockRequireWorkspaceAuth.mockResolvedValue(AUTH_WS)
  mockConnect.mockResolvedValue({ query: mockClientQuery, release: mockRelease })
  mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 })
})

// ---------------------------------------------------------------------------
// UX: workspace sem nenhum canal Meta
// ---------------------------------------------------------------------------

describe('UX sem canal Meta — sync não é tentado', () => {
  it('POST /templates/sync em canal EVOLUTION retorna 409 (não chama Meta API)', async () => {
    mockFindChannelById.mockResolvedValue({
      id: EVOLUTION_CHANNEL_ID,
      workspace_id: 'ws-no-meta',
      provider: 'EVOLUTION',
      status: 'CONNECTED',
      credentials_encrypted: 'enc',
    })

    const res = await syncRoute(
      makePost(`/api/whatsapp/channels/${EVOLUTION_CHANNEL_ID}/templates/sync`),
      { params: Promise.resolve({ id: EVOLUTION_CHANNEL_ID }) },
    )

    expect(res.status).toBe(409)
    expect(mockAdapterSyncTemplates).not.toHaveBeenCalled()
    expect(mockSyncTemplatesInTransaction).not.toHaveBeenCalled()
  })

  it('POST /templates/sync em canal UAZAPI retorna 409 (não chama Meta API)', async () => {
    mockFindChannelById.mockResolvedValue({
      id: UAZAPI_CHANNEL_ID,
      workspace_id: 'ws-no-meta',
      provider: 'UAZAPI',
      status: 'CONNECTED',
      credentials_encrypted: 'enc',
    })

    const res = await syncRoute(
      makePost(`/api/whatsapp/channels/${UAZAPI_CHANNEL_ID}/templates/sync`),
      { params: Promise.resolve({ id: UAZAPI_CHANNEL_ID }) },
    )

    expect(res.status).toBe(409)
    expect(mockAdapterSyncTemplates).not.toHaveBeenCalled()
  })

  it('GET /templates em canal EVOLUTION retorna 409 (não consulta template repo)', async () => {
    mockFindChannelById.mockResolvedValue({
      id: EVOLUTION_CHANNEL_ID,
      workspace_id: 'ws-no-meta',
      provider: 'EVOLUTION',
      status: 'CONNECTED',
      credentials_encrypted: 'enc',
    })

    const res = await listRoute(
      makeGet(`/api/whatsapp/channels/${EVOLUTION_CHANNEL_ID}/templates`),
      { params: Promise.resolve({ id: EVOLUTION_CHANNEL_ID }) },
    )

    expect(res.status).toBe(409)
    const body = await res.json() as { error: string }
    // A mensagem de erro deve orientar o usuário sobre Meta Cloud
    expect(body.error).toMatch(/META_CLOUD/i)
    // Não deve ter ido ao repo de templates
    expect(mockListTemplates).not.toHaveBeenCalled()
  })

  it('resposta 409 para canal não-Meta não deve expor dados internos do canal', async () => {
    mockFindChannelById.mockResolvedValue({
      id: EVOLUTION_CHANNEL_ID,
      workspace_id: 'ws-no-meta',
      provider: 'EVOLUTION',
      status: 'CONNECTED',
      credentials_encrypted: 'segredo-super-secreto',
    })

    const res = await listRoute(
      makeGet(`/api/whatsapp/channels/${EVOLUTION_CHANNEL_ID}/templates`),
      { params: Promise.resolve({ id: EVOLUTION_CHANNEL_ID }) },
    )

    const raw = await res.text()
    expect(raw).not.toContain('segredo-super-secreto')
    expect(raw).not.toContain('credentials_encrypted')
  })
})

// ---------------------------------------------------------------------------
// UX: canal Meta existe mas está desconectado → não faz sync, retorna erro claro
// ---------------------------------------------------------------------------

describe('UX sem canal Meta conectado — sync de canal desconectado', () => {
  it('GET /templates retorna 200 mesmo com canal desconectado (lista vazia)', async () => {
    // Canal META desconectado: listagem ainda deve funcionar (exibe templates anteriores)
    mockFindChannelById.mockResolvedValue({
      id: 'ee111111-1111-4111-8111-111111111111',
      workspace_id: 'ws-no-meta',
      provider: 'META_CLOUD',
      status: 'DISCONNECTED',
      credentials_encrypted: 'enc',
    })
    mockListTemplates.mockResolvedValue({ templates: [], pagination: { total: 0, page: 1, limit: 50, pages: 0 } })

    const META_CH = 'ee111111-1111-4111-8111-111111111111'
    const res = await listRoute(
      makeGet(`/api/whatsapp/channels/${META_CH}/templates`),
      { params: Promise.resolve({ id: META_CH }) },
    )

    // Listagem deve retornar 200 com lista vazia
    expect(res.status).toBe(200)
    const body = await res.json() as { templates: unknown[] }
    expect(Array.isArray(body.templates)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Lógica de negócio: sync só funciona com canal META_CLOUD conectado
// ---------------------------------------------------------------------------

describe('Sync de templates: pré-condições', () => {
  it('sync bem-sucedido retorna 200 com created/updated/deactivated', async () => {
    const META_CH = 'ff111111-1111-4111-8111-111111111111'
    mockFindChannelById.mockResolvedValue({
      id: META_CH,
      workspace_id: 'ws-no-meta',
      provider: 'META_CLOUD',
      status: 'CONNECTED',
      credentials_encrypted: 'enc-ok',
    })
    mockDecryptCredentials.mockReturnValue({
      access_token: 'EAABtest',
      waba_id: 'waba-123',
      phone_number_id: 'ph-1',
    })
    mockAdapterSyncTemplates.mockResolvedValue([
      { name: 'boas_vindas', language: 'pt_BR', status: 'APPROVED', category: 'MARKETING', components: [] },
    ])
    mockSyncTemplatesInTransaction.mockResolvedValue({ created: 1, updated: 0, deactivated: 0 })

    const res = await syncRoute(
      makePost(`/api/whatsapp/channels/${META_CH}/templates/sync`),
      { params: Promise.resolve({ id: META_CH }) },
    )

    expect(res.status).toBe(200)
    const body = await res.json() as { created: number; updated: number; deactivated: number }
    expect(body.created).toBe(1)
    expect(body.updated).toBe(0)
    expect(body.deactivated).toBe(0)
  })
})

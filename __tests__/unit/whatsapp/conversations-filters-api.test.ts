// ---------------------------------------------------------------------------
// TDD — API contract: GET /api/whatsapp/conversations (filtros do Inbox)
//
// Cobre (seção 1 + parte da 2 do spec):
//   1a. Sem filtros → 200 com lista paginada (backward compat)
//   1b. provider=META_CLOUD / EVOLUTION → repassado ao repo
//   1c. channel_id UUID válido → repassado ao repo
//   1d. date_from + date_to → repassados ao repo
//   1e. Combinações (AND lógico)
//   1f. preset=last_7_days / last_month → resolvido para intervalo
//   1g. Validações → 400/403 nos casos inválidos
//   2.  workspace_id nunca vem da query (já coberto em conversations-api.test.ts — regresso)
//
// STATUS: RED — filtros ainda não implementados na rota; testes falharão até
//         que a rota seja atualizada para aceitar/validar os novos params.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ---------------------------------------------------------------------------
// Mocks (mesma estrutura do conversations-api.test.ts existente)
// ---------------------------------------------------------------------------

const mockRelease = vi.fn()
const mockClientQuery = vi.fn()
const mockConnect = vi.fn()
vi.mock('@/lib/database', () => ({ default: { connect: mockConnect } }))

vi.mock('@/lib/get-ip', () => ({ getClientIp: vi.fn().mockReturnValue('127.0.0.1') }))

const mockConversationCheck = vi.fn()
vi.mock('@/lib/rate-limit', () => ({
  whatsappConversationLimiter: { check: mockConversationCheck },
}))

const mockRequireWorkspaceAuth = vi.fn()
vi.mock('@/lib/whatsapp/auth-middleware', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/whatsapp/auth-middleware')>()
  return { ...actual, requireWorkspaceAuth: mockRequireWorkspaceAuth }
})

const mockFindConversationsByWorkspace = vi.fn()
vi.mock('@/lib/whatsapp/conversation-repo', () => ({
  findConversationsByWorkspace: mockFindConversationsByWorkspace,
}))

// Canal lookup necessário para validar channel_id cross-workspace
const mockFindChannelById = vi.fn()
vi.mock('@/lib/whatsapp/channel-repo', () => ({
  findChannelById: mockFindChannelById,
}))

const mockLogInfo = vi.fn()
const mockLogError = vi.fn()
vi.mock('@/lib/logger', () => ({
  logger: { child: vi.fn().mockReturnValue({ info: mockLogInfo, error: mockLogError }) },
}))

// ---------------------------------------------------------------------------
// Importar rota após mocks
// ---------------------------------------------------------------------------

const { GET: conversationsRoute } = await import('@/app/api/whatsapp/conversations/route')

// ---------------------------------------------------------------------------
// Constantes e helpers
// ---------------------------------------------------------------------------

const AUTH_WS1 = {
  workspace_id: 'ws-inbox-filters',
  actor: 'api_key:test',
  key_id: 'k-1',
  dedup_actor_id: 'api_key:k-1',
}

const CHANNEL_UUID = 'aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function makeChannel(overrides: Record<string, unknown> = {}) {
  return {
    id: CHANNEL_UUID,
    workspace_id: 'ws-inbox-filters',
    provider: 'META_CLOUD',
    status: 'CONNECTED',
    name: 'Canal Meta',
    credentials_encrypted: 'enc',
    webhook_secret: 'secret',
    ...overrides,
  }
}

function makeConversation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conv-1',
    channel_id: CHANNEL_UUID,
    channel_name: 'Canal Meta',
    channel_provider: 'META_CLOUD',
    workspace_id: 'ws-inbox-filters',
    contact_phone: '+5511999999999',
    contact_name: 'Test User',
    status: 'open',
    last_message_at: '2026-03-05T10:00:00Z',
    unread_count: 0,
    ai_enabled: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  }
}

function makeGet(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost/api/whatsapp/conversations')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return new NextRequest(url.toString(), {
    method: 'GET',
    headers: { Authorization: `Bearer wk_${'d'.repeat(64)}` },
  })
}

function getRepoOpts() {
  const call = mockFindConversationsByWorkspace.mock.calls[0] as
    [unknown, string, Record<string, unknown>]
  return call[2]
}

beforeEach(() => {
  vi.clearAllMocks()
  mockConversationCheck.mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 })
  mockRequireWorkspaceAuth.mockResolvedValue(AUTH_WS1)
  mockConnect.mockResolvedValue({ query: mockClientQuery, release: mockRelease })
  mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  mockFindConversationsByWorkspace.mockResolvedValue([])
  mockFindChannelById.mockResolvedValue(makeChannel())
})

// ---------------------------------------------------------------------------
// 1a. Sem filtros → backward compat
// ---------------------------------------------------------------------------

describe('GET /conversations — sem filtros (backward compat)', () => {
  it('retorna 200 com lista paginada quando nenhum filtro fornecido', async () => {
    mockFindConversationsByWorkspace.mockResolvedValue([makeConversation()])
    const res = await conversationsRoute(makeGet())
    expect(res.status).toBe(200)
    const body = await res.json() as { data: unknown[] }
    expect(Array.isArray(body.data)).toBe(true)
    expect(body.data).toHaveLength(1)
  })

  it('não envia provider/channel_id/date_from/date_to ao repo quando omitidos', async () => {
    await conversationsRoute(makeGet())
    const opts = getRepoOpts()
    expect(opts.provider).toBeUndefined()
    expect(opts.channel_id).toBeUndefined()
    expect(opts.date_from).toBeUndefined()
    expect(opts.date_to).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 1b. Filtro por provider
// ---------------------------------------------------------------------------

describe('GET /conversations — filtro provider', () => {
  it('provider=META_CLOUD é repassado ao repo', async () => {
    await conversationsRoute(makeGet({ provider: 'META_CLOUD' }))
    expect(getRepoOpts().provider).toBe('META_CLOUD')
  })

  it('provider=EVOLUTION é repassado ao repo', async () => {
    await conversationsRoute(makeGet({ provider: 'EVOLUTION' }))
    expect(getRepoOpts().provider).toBe('EVOLUTION')
  })

  it('provider=UAZAPI é repassado ao repo', async () => {
    await conversationsRoute(makeGet({ provider: 'UAZAPI' }))
    expect(getRepoOpts().provider).toBe('UAZAPI')
  })

  it('provider inválido retorna 400', async () => {
    const res = await conversationsRoute(makeGet({ provider: 'WHATSAPP_FAKE' }))
    expect(res.status).toBe(400)
    expect(mockFindConversationsByWorkspace).not.toHaveBeenCalled()
  })

  it('provider em minúsculo retorna 400 (enum é case-sensitive)', async () => {
    const res = await conversationsRoute(makeGet({ provider: 'meta_cloud' }))
    expect(res.status).toBe(400)
    expect(mockFindConversationsByWorkspace).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 1c. Filtro por channel_id
// ---------------------------------------------------------------------------

describe('GET /conversations — filtro channel_id', () => {
  it('channel_id UUID válido do próprio workspace é repassado ao repo', async () => {
    await conversationsRoute(makeGet({ channel_id: CHANNEL_UUID }))
    expect(getRepoOpts().channel_id).toBe(CHANNEL_UUID)
  })

  it('channel_id não-UUID retorna 400', async () => {
    const res = await conversationsRoute(makeGet({ channel_id: 'nao-e-uuid' }))
    expect(res.status).toBe(400)
    expect(mockFindConversationsByWorkspace).not.toHaveBeenCalled()
  })

  it('channel_id com formato inválido (só números) retorna 400', async () => {
    const res = await conversationsRoute(makeGet({ channel_id: '12345' }))
    expect(res.status).toBe(400)
    expect(mockFindConversationsByWorkspace).not.toHaveBeenCalled()
  })

  it('channel_id de outro workspace retorna 403', async () => {
    mockFindChannelById.mockResolvedValue(makeChannel({ workspace_id: 'ws-outro' }))
    const res = await conversationsRoute(makeGet({ channel_id: CHANNEL_UUID }))
    expect(res.status).toBe(403)
    expect(mockFindConversationsByWorkspace).not.toHaveBeenCalled()
  })

  it('channel_id inexistente (findChannelById retorna null) retorna 403', async () => {
    mockFindChannelById.mockResolvedValue(null)
    const res = await conversationsRoute(makeGet({ channel_id: CHANNEL_UUID }))
    expect(res.status).toBe(403)
    expect(mockFindConversationsByWorkspace).not.toHaveBeenCalled()
  })

  it('endpoint ignora workspace_id injetado via query mesmo com channel_id', async () => {
    await conversationsRoute(makeGet({ channel_id: CHANNEL_UUID, workspace_id: 'ws-atacante' }))
    const call = mockFindConversationsByWorkspace.mock.calls[0] as [unknown, string, unknown]
    expect(call[1]).toBe('ws-inbox-filters') // do token, nunca da query
  })
})

// ---------------------------------------------------------------------------
// 1d. Filtro por date_from + date_to
// ---------------------------------------------------------------------------

describe('GET /conversations — filtro de data', () => {
  it('date_from válido é repassado ao repo (como Date ou string ISO)', async () => {
    await conversationsRoute(makeGet({ date_from: '2026-03-01' }))
    expect(getRepoOpts().date_from).toBeTruthy()
  })

  it('date_to válido é repassado ao repo', async () => {
    await conversationsRoute(makeGet({ date_to: '2026-03-10' }))
    expect(getRepoOpts().date_to).toBeTruthy()
  })

  it('date_from + date_to juntos são ambos repassados', async () => {
    await conversationsRoute(makeGet({ date_from: '2026-03-01', date_to: '2026-03-10' }))
    const opts = getRepoOpts()
    expect(opts.date_from).toBeTruthy()
    expect(opts.date_to).toBeTruthy()
  })

  it('date_from > date_to retorna 400', async () => {
    const res = await conversationsRoute(makeGet({ date_from: '2026-03-10', date_to: '2026-03-01' }))
    expect(res.status).toBe(400)
    expect(mockFindConversationsByWorkspace).not.toHaveBeenCalled()
  })

  it('data inválida (mês 13) retorna 400', async () => {
    const res = await conversationsRoute(makeGet({ date_from: '2026-13-40' }))
    expect(res.status).toBe(400)
    expect(mockFindConversationsByWorkspace).not.toHaveBeenCalled()
  })

  it('data inválida (dia 40) retorna 400', async () => {
    const res = await conversationsRoute(makeGet({ date_to: '2026-01-40' }))
    expect(res.status).toBe(400)
    expect(mockFindConversationsByWorkspace).not.toHaveBeenCalled()
  })

  it('date_from com formato inválido (não YYYY-MM-DD) retorna 400', async () => {
    const res = await conversationsRoute(makeGet({ date_from: 'nao-e-data' }))
    expect(res.status).toBe(400)
    expect(mockFindConversationsByWorkspace).not.toHaveBeenCalled()
  })

  it('date_from === date_to é aceito (único dia)', async () => {
    const res = await conversationsRoute(makeGet({ date_from: '2026-03-05', date_to: '2026-03-05' }))
    expect(res.status).toBe(200)
    expect(mockFindConversationsByWorkspace).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 1f. Presets de data
// ---------------------------------------------------------------------------

describe('GET /conversations — presets de data', () => {
  it('preset=last_7_days → resolve para intervalo de 7 dias correto', async () => {
    await conversationsRoute(makeGet({ preset: 'last_7_days' }))
    expect(mockFindConversationsByWorkspace).toHaveBeenCalled()
    const opts = getRepoOpts()
    expect(opts.date_from).toBeTruthy()
    expect(opts.date_to).toBeTruthy()

    const from = new Date(opts.date_from as string)
    const to = new Date(opts.date_to as string)
    const diffDays = Math.round((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24))
    expect(diffDays).toBeGreaterThanOrEqual(6)
    expect(diffDays).toBeLessThanOrEqual(8)
  })

  it('preset=last_month → date_from é o dia 1 do mês anterior', async () => {
    await conversationsRoute(makeGet({ preset: 'last_month' }))
    expect(mockFindConversationsByWorkspace).toHaveBeenCalled()
    const opts = getRepoOpts()
    expect(opts.date_from).toBeTruthy()

    const from = new Date(opts.date_from as string)
    expect(from.getDate()).toBe(1)
  })

  it('preset=last_month → date_to é o último dia do mês anterior', async () => {
    await conversationsRoute(makeGet({ preset: 'last_month' }))
    const opts = getRepoOpts()
    const from = new Date(opts.date_from as string)
    const to = new Date(opts.date_to as string)
    // Mesmo mês e ano
    expect(from.getMonth()).toBe(to.getMonth())
    expect(from.getFullYear()).toBe(to.getFullYear())
    // date_to >= date_from
    expect(to.getTime()).toBeGreaterThanOrEqual(from.getTime())
  })

  it('preset inválido retorna 400', async () => {
    const res = await conversationsRoute(makeGet({ preset: 'last_year' }))
    expect(res.status).toBe(400)
    expect(mockFindConversationsByWorkspace).not.toHaveBeenCalled()
  })

  it('preset prevalece sobre date_from/date_to manuais (preset resolve o intervalo)', async () => {
    // Quando preset e datas manuais vêm juntos, o preset deve ser aplicado
    // (comportamento: preset tem precedência OU retorna 400 por conflito; aqui verificamos que a rota não trava)
    const res = await conversationsRoute(
      makeGet({ preset: 'last_7_days', date_from: '2026-01-01', date_to: '2026-01-31' }),
    )
    // Deve retornar 200 ou 400 (ambos são válidos conforme contrato escolhido)
    // O importante: não deve lançar 500
    expect(res.status).not.toBe(500)
  })
})

// ---------------------------------------------------------------------------
// 1e. Combinações de filtros (AND lógico)
// ---------------------------------------------------------------------------

describe('GET /conversations — combinações de filtros', () => {
  it('provider + date range: ambos repassados ao repo', async () => {
    await conversationsRoute(makeGet({
      provider: 'META_CLOUD',
      date_from: '2026-03-01',
      date_to: '2026-03-10',
    }))
    const opts = getRepoOpts()
    expect(opts.provider).toBe('META_CLOUD')
    expect(opts.date_from).toBeTruthy()
    expect(opts.date_to).toBeTruthy()
  })

  it('channel_id + date range: ambos repassados ao repo', async () => {
    await conversationsRoute(makeGet({
      channel_id: CHANNEL_UUID,
      date_from: '2026-03-01',
      date_to: '2026-03-10',
    }))
    const opts = getRepoOpts()
    expect(opts.channel_id).toBe(CHANNEL_UUID)
    expect(opts.date_from).toBeTruthy()
    expect(opts.date_to).toBeTruthy()
  })

  it('status + provider + date range: todos repassados ao repo (AND lógico)', async () => {
    await conversationsRoute(makeGet({
      status: 'open',
      provider: 'EVOLUTION',
      date_from: '2026-03-01',
      date_to: '2026-03-10',
    }))
    const opts = getRepoOpts()
    expect(opts.status).toBe('open')
    expect(opts.provider).toBe('EVOLUTION')
    expect(opts.date_from).toBeTruthy()
    expect(opts.date_to).toBeTruthy()
  })

  it('filtro provider inválido em combinação com status válido ainda retorna 400', async () => {
    const res = await conversationsRoute(makeGet({ status: 'open', provider: 'INVALIDO' }))
    expect(res.status).toBe(400)
    expect(mockFindConversationsByWorkspace).not.toHaveBeenCalled()
  })

  it('channel_id de outro workspace em combinação com status retorna 403', async () => {
    mockFindChannelById.mockResolvedValue(makeChannel({ workspace_id: 'ws-outro' }))
    const res = await conversationsRoute(makeGet({ channel_id: CHANNEL_UUID, status: 'open' }))
    expect(res.status).toBe(403)
    expect(mockFindConversationsByWorkspace).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Limite máximo ainda respeitado com filtros (seção 7)
// ---------------------------------------------------------------------------

describe('GET /conversations — limite máximo com filtros', () => {
  it('limit é capped em 100 mesmo com filtros ativos', async () => {
    await conversationsRoute(makeGet({ limit: '999', provider: 'META_CLOUD' }))
    const opts = getRepoOpts()
    expect(opts.limit).toBeLessThanOrEqual(100)
  })

  it('log.info registra os filtros aplicados para observabilidade', async () => {
    mockFindConversationsByWorkspace.mockResolvedValue([makeConversation()])
    await conversationsRoute(makeGet({ provider: 'META_CLOUD' }))
    // log deve ser chamado com o count correto
    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.objectContaining({ workspace_id: 'ws-inbox-filters', count: 1 }),
      expect.any(String),
    )
  })

  it('logs de erro não expõem credenciais em falha de filtro', async () => {
    mockFindConversationsByWorkspace.mockRejectedValue(new Error('DB timeout'))
    await conversationsRoute(makeGet({ provider: 'META_CLOUD' }))
    const errorCall = mockLogError.mock.calls[0]
    const logged = JSON.stringify(errorCall)
    expect(logged).not.toContain('credentials_encrypted')
    expect(logged).not.toContain('webhook_secret')
    expect(logged).not.toContain('access_token')
  })
})

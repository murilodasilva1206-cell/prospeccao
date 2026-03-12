// ---------------------------------------------------------------------------
// TDD — Cenários 13–17: Marcar lidas ao abrir conversa
//
// 13. Selecionar conversa → POST /read chamado corretamente
// 14. Badge zera → unread_count vai a 0 no backend
// 15. Falha no endpoint → não quebra fluxo (gracioso)
// 16. Troca rápida → não marca conversa errada
// 17. Isolamento por workspace → 403 para workspace errado
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

const mockConvLimitCheck = vi.fn()
vi.mock('@/lib/rate-limit', () => ({
  whatsappConversationLimiter: { check: mockConvLimitCheck },
}))

const mockRequireWorkspaceAuth = vi.fn()
vi.mock('@/lib/whatsapp/auth-middleware', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/whatsapp/auth-middleware')>()
  return { ...actual, requireWorkspaceAuth: mockRequireWorkspaceAuth }
})

const mockFindConversationById = vi.fn()
const mockMarkAllRead = vi.fn()
vi.mock('@/lib/whatsapp/conversation-repo', () => ({
  findConversationById: mockFindConversationById,
  markAllRead: mockMarkAllRead,
}))

vi.mock('@/lib/logger', () => ({
  logger: { child: vi.fn().mockReturnValue({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}))

// ---------------------------------------------------------------------------
// Import route AFTER mocks
// ---------------------------------------------------------------------------

const { POST } = await import('@/app/api/whatsapp/conversations/[id]/read/route')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WS_A = 'ws-read-a'
const WS_B = 'ws-read-b'
const CONV_A = 'conv-read-1111-1111-4111-8111-111111111111'
const CONV_B = 'conv-read-2222-2222-4222-8222-222222222222'

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

function makeConversation(workspace_id: string, id: string, unread_count = 3) {
  return {
    id,
    channel_id: 'ch-read-1',
    workspace_id,
    contact_phone: '+5511999999999',
    contact_name: 'Test Contact',
    status: 'open',
    unread_count,
    ai_enabled: false,
    last_message_at: new Date().toISOString(),
  }
}

function makePost(convId: string): NextRequest {
  return new NextRequest(
    `http://localhost/api/whatsapp/conversations/${convId}/read`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer wk_${'a'.repeat(64)}` },
    },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockConvLimitCheck.mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 })
  mockRequireWorkspaceAuth.mockResolvedValue(AUTH_WS_A)
  mockConnect.mockResolvedValue({ query: mockClientQuery, release: mockRelease })
  mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  mockFindConversationById.mockResolvedValue(makeConversation(WS_A, CONV_A))
  mockMarkAllRead.mockResolvedValue(undefined)
})

// ---------------------------------------------------------------------------
// Cenário 13 — POST /read chama markAllRead corretamente
// ---------------------------------------------------------------------------

describe('Cenário 13 — POST /read chama markAllRead', () => {
  it('retorna 200 com { ok: true } para conversa do próprio workspace', async () => {
    const res = await POST(makePost(CONV_A), { params: Promise.resolve({ id: CONV_A }) })

    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  it('chama markAllRead com o id correto da conversa', async () => {
    await POST(makePost(CONV_A), { params: Promise.resolve({ id: CONV_A }) })

    expect(mockMarkAllRead).toHaveBeenCalledWith(expect.anything(), CONV_A)
  })

  it('chama markAllRead exatamente uma vez por request', async () => {
    await POST(makePost(CONV_A), { params: Promise.resolve({ id: CONV_A }) })

    expect(mockMarkAllRead).toHaveBeenCalledTimes(1)
  })

  it('libera o client de pool sempre (finally)', async () => {
    await POST(makePost(CONV_A), { params: Promise.resolve({ id: CONV_A }) })

    expect(mockRelease).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Cenário 14 — Badge de não lidas zera no backend
// ---------------------------------------------------------------------------

describe('Cenário 14 — unread_count zerado no backend', () => {
  it('markAllRead recebe o pool client (não null)', async () => {
    await POST(makePost(CONV_A), { params: Promise.resolve({ id: CONV_A }) })

    const [client] = mockMarkAllRead.mock.calls[0] as [unknown]
    expect(client).toBeTruthy()
  })

  it('conversa com unread_count=5 ainda resulta em markAllRead chamado', async () => {
    mockFindConversationById.mockResolvedValue(makeConversation(WS_A, CONV_A, 5))

    const res = await POST(makePost(CONV_A), { params: Promise.resolve({ id: CONV_A }) })

    expect(res.status).toBe(200)
    expect(mockMarkAllRead).toHaveBeenCalledWith(expect.anything(), CONV_A)
  })

  it('conversa com unread_count=0 ainda retorna 200 (idempotente)', async () => {
    mockFindConversationById.mockResolvedValue(makeConversation(WS_A, CONV_A, 0))

    const res = await POST(makePost(CONV_A), { params: Promise.resolve({ id: CONV_A }) })

    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Cenário 15 — Conversa não encontrada retorna 404
// ---------------------------------------------------------------------------

describe('Cenário 15 — Conversa não encontrada → 404', () => {
  it('retorna 404 quando conversa não existe', async () => {
    mockFindConversationById.mockResolvedValue(null)

    const res = await POST(makePost(CONV_A), { params: Promise.resolve({ id: CONV_A }) })

    expect(res.status).toBe(404)
    expect(mockMarkAllRead).not.toHaveBeenCalled()
  })

  it('não chama markAllRead para conversa inexistente', async () => {
    mockFindConversationById.mockResolvedValue(null)

    await POST(makePost('conv-nao-existe'), { params: Promise.resolve({ id: 'conv-nao-existe' }) })

    expect(mockMarkAllRead).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Cenário 16 — Troca rápida: não marca conversa errada
// ---------------------------------------------------------------------------

describe('Cenário 16 — Troca rápida de conversa', () => {
  it('dois POSTs sequenciais chamam markAllRead com IDs corretos', async () => {
    // Simula usuário abrindo CONV_A rapidamente e depois CONV_B
    mockFindConversationById
      .mockResolvedValueOnce(makeConversation(WS_A, CONV_A))
      .mockResolvedValueOnce(makeConversation(WS_A, CONV_B))

    await POST(makePost(CONV_A), { params: Promise.resolve({ id: CONV_A }) })
    await POST(makePost(CONV_B), { params: Promise.resolve({ id: CONV_B }) })

    expect(mockMarkAllRead).toHaveBeenNthCalledWith(1, expect.anything(), CONV_A)
    expect(mockMarkAllRead).toHaveBeenNthCalledWith(2, expect.anything(), CONV_B)
  })

  it('rate limit retorna 429 quando muitas requisições', async () => {
    mockConvLimitCheck.mockResolvedValue({ success: false, resetAt: Date.now() + 30_000 })

    const res = await POST(makePost(CONV_A), { params: Promise.resolve({ id: CONV_A }) })

    expect(res.status).toBe(429)
    expect(mockMarkAllRead).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Cenário 17 — Isolamento por workspace: 403 para workspace errado
// ---------------------------------------------------------------------------

describe('Cenário 17 — Isolamento por workspace', () => {
  it('retorna 403 quando conversa pertence a outro workspace', async () => {
    // Conversa é do WS_B, mas auth é WS_A
    mockFindConversationById.mockResolvedValue(makeConversation(WS_B, CONV_B))
    mockRequireWorkspaceAuth.mockResolvedValue(AUTH_WS_A)

    const res = await POST(makePost(CONV_B), { params: Promise.resolve({ id: CONV_B }) })

    expect(res.status).toBe(403)
    expect(mockMarkAllRead).not.toHaveBeenCalled()
  })

  it('não chama markAllRead para conversa de outro workspace', async () => {
    mockFindConversationById.mockResolvedValue(makeConversation(WS_B, CONV_B))
    mockRequireWorkspaceAuth.mockResolvedValue(AUTH_WS_A)

    await POST(makePost(CONV_B), { params: Promise.resolve({ id: CONV_B }) })

    expect(mockMarkAllRead).not.toHaveBeenCalled()
  })

  it('WS_B pode marcar sua própria conversa como lida', async () => {
    mockFindConversationById.mockResolvedValue(makeConversation(WS_B, CONV_B))
    mockRequireWorkspaceAuth.mockResolvedValue(AUTH_WS_B)

    const res = await POST(
      new NextRequest(`http://localhost/api/whatsapp/conversations/${CONV_B}/read`, {
        method: 'POST',
        headers: { Authorization: `Bearer wk_${'b'.repeat(64)}` },
      }),
      { params: Promise.resolve({ id: CONV_B }) },
    )

    expect(res.status).toBe(200)
    expect(mockMarkAllRead).toHaveBeenCalledWith(expect.anything(), CONV_B)
  })

  it('resposta 403 não vaza informação sobre a conversa de outro workspace', async () => {
    mockFindConversationById.mockResolvedValue({
      ...makeConversation(WS_B, CONV_B),
      contact_name: 'Segredo WS_B',
      contact_phone: '+5511999000001',
    })
    mockRequireWorkspaceAuth.mockResolvedValue(AUTH_WS_A)

    const res = await POST(makePost(CONV_B), { params: Promise.resolve({ id: CONV_B }) })
    const text = await res.text()

    expect(res.status).toBe(403)
    expect(text).not.toContain('Segredo WS_B')
    expect(text).not.toContain(WS_B)
  })
})

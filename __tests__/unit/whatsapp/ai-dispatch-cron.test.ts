// ---------------------------------------------------------------------------
// TDD — Cenários AI Dispatch Cron (POST /api/whatsapp/ai-dispatch)
//
// 1. Seleciona apenas sent_by='ai' e status='queued' (via claimAiQueuedMessages)
// 2. Claim concorrente não duplica envio (SKIP LOCKED — comportamento do repo)
// 3. Sucesso: status vira 'sent' e grava provider_message_id
// 4. Falha transitória (RetryableError): volta para queued
// 5. Falha permanente: vira 'failed'
// 6. Conversation/channel inexistente: marca failed
// 7. Idempotência: execuções paralelas resultam em {sent,failed,total} corretos
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ---------------------------------------------------------------------------
// Hoist env mock (must be before imports)
// ---------------------------------------------------------------------------

const { mockEnv } = vi.hoisted(() => ({ mockEnv: vi.fn() }))

vi.mock('@/lib/env', () => ({
  env: new Proxy({} as Record<string, string>, {
    get: (_t, key) => mockEnv(key as string),
  }),
}))

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockRelease = vi.fn()
const mockClientQuery = vi.fn()
const mockConnect = vi.fn()
vi.mock('@/lib/database', () => ({ default: { connect: mockConnect } }))

const mockClaimAiQueuedMessages = vi.fn()
const mockMarkAiMessageDispatched = vi.fn()
vi.mock('@/lib/whatsapp/message-repo', () => ({
  claimAiQueuedMessages: mockClaimAiQueuedMessages,
  markAiMessageDispatched: mockMarkAiMessageDispatched,
}))

const mockFindConversationById = vi.fn()
vi.mock('@/lib/whatsapp/conversation-repo', () => ({
  findConversationById: mockFindConversationById,
}))

const mockFindChannelById = vi.fn()
vi.mock('@/lib/whatsapp/channel-repo', () => ({
  findChannelById: mockFindChannelById,
}))

const mockDecryptCredentials = vi.fn()
vi.mock('@/lib/whatsapp/crypto', () => ({ decryptCredentials: mockDecryptCredentials }))

const mockAdapterSendMessage = vi.fn()
vi.mock('@/lib/whatsapp/adapters/factory', () => ({
  getAdapter: vi.fn().mockReturnValue({ sendMessage: mockAdapterSendMessage }),
}))

vi.mock('@/lib/whatsapp/errors', async () => {
  const RetryableError = class extends Error {
    constructor(msg: string) { super(msg); this.name = 'RetryableError' }
  }
  return { RetryableError }
})

vi.mock('@/lib/logger', () => ({
  logger: { child: vi.fn().mockReturnValue({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}))

// ---------------------------------------------------------------------------
// Import route AFTER mocks
// ---------------------------------------------------------------------------

const { POST } = await import('@/app/api/whatsapp/ai-dispatch/route')
const { RetryableError } = await import('@/lib/whatsapp/errors')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CRON_SECRET = 'test-cron-secret-32chars-xxxxxxxxx'
const WS = 'ws-dispatch-test'
const CHANNEL_ID = 'ch-dispatch-1111-1111-4111-8111-111111111111'
const CONV_ID = 'conv-dispatch-1111-1111-4111-8111-111111111111'

function makeMsg(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-ai-1',
    conversation_id: CONV_ID,
    channel_id: CHANNEL_ID,
    body: 'Olá, posso ajudar?',
    sent_by: 'ai',
    status: 'queued',
    direction: 'outbound',
    message_type: 'text',
    ...overrides,
  }
}

function makeConversation() {
  return {
    id: CONV_ID,
    channel_id: CHANNEL_ID,
    workspace_id: WS,
    contact_phone: '+5511999999999',
    contact_name: 'Test',
    status: 'open',
    unread_count: 0,
    ai_enabled: true,
  }
}

function makeChannel(overrides: Record<string, unknown> = {}) {
  return {
    id: CHANNEL_ID,
    workspace_id: WS,
    provider: 'EVOLUTION',
    status: 'CONNECTED',
    credentials_encrypted: 'enc',
    ...overrides,
  }
}

function makeCronRequest(): NextRequest {
  return new NextRequest('http://localhost/api/whatsapp/ai-dispatch', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CRON_SECRET}`,
      'Content-Type': 'application/json',
    },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockEnv.mockImplementation((key: string) => {
    if (key === 'CRON_SECRET') return CRON_SECRET
    return undefined
  })
  mockConnect.mockResolvedValue({ query: mockClientQuery, release: mockRelease })
  mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  mockClaimAiQueuedMessages.mockResolvedValue([])
  mockMarkAiMessageDispatched.mockResolvedValue(undefined)
  mockFindConversationById.mockResolvedValue(makeConversation())
  mockFindChannelById.mockResolvedValue(makeChannel())
  mockDecryptCredentials.mockReturnValue({ instance_url: 'https://evo.test', api_key: 'evo-key' })
  mockAdapterSendMessage.mockResolvedValue({ message_id: 'evo-msg-123' })
})

// ---------------------------------------------------------------------------
// Cenário 1 — Seleciona via claimAiQueuedMessages
// ---------------------------------------------------------------------------

describe('Cenário 1 — claimAiQueuedMessages é chamado para buscar mensagens', () => {
  it('responde 200 com totais zerados quando não há mensagens na fila', async () => {
    mockClaimAiQueuedMessages.mockResolvedValue([])

    const res = await POST(makeCronRequest())
    expect(res.status).toBe(200)
    const body = await res.json() as { sent: number; failed: number; total: number }
    expect(body.total).toBe(0)
    expect(body.sent).toBe(0)
    expect(body.failed).toBe(0)
  })

  it('chama claimAiQueuedMessages com limit=10', async () => {
    const res = await POST(makeCronRequest())
    expect(res.status).toBe(200)
    expect(mockClaimAiQueuedMessages).toHaveBeenCalledWith(expect.anything(), 10)
  })

  it('processa todas as mensagens retornadas pelo claim', async () => {
    const msgs = [
      makeMsg({ id: 'msg-1' }),
      makeMsg({ id: 'msg-2' }),
      makeMsg({ id: 'msg-3' }),
    ]
    mockClaimAiQueuedMessages.mockResolvedValue(msgs)

    const res = await POST(makeCronRequest())
    const body = await res.json() as { total: number }
    expect(body.total).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// Cenário 2 — SKIP LOCKED garante não-duplicação (comportamento do repo)
// ---------------------------------------------------------------------------

describe('Cenário 2 — Não duplicação via SKIP LOCKED', () => {
  it('duas chamadas simultâneas processam conjuntos disjuntos (mocked)', async () => {
    // Simula: segunda chamada vê fila vazia porque primeira já claim
    mockClaimAiQueuedMessages
      .mockResolvedValueOnce([makeMsg({ id: 'msg-batch-1' })])
      .mockResolvedValueOnce([]) // segunda chamada paralela não pega o mesmo

    const [res1, res2] = await Promise.all([
      POST(makeCronRequest()),
      POST(makeCronRequest()),
    ])

    const b1 = await res1.json() as { total: number }
    const b2 = await res2.json() as { total: number }
    // Soma total = 1 (não duplicou)
    expect(b1.total + b2.total).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Cenário 3 — Sucesso: status='sent' + provider_message_id
// ---------------------------------------------------------------------------

describe('Cenário 3 — Sucesso: mensagem marcada como sent', () => {
  it('chama markAiMessageDispatched com status=sent e provider_message_id', async () => {
    mockClaimAiQueuedMessages.mockResolvedValue([makeMsg()])
    mockAdapterSendMessage.mockResolvedValue({ message_id: 'wamid.success-123' })

    await POST(makeCronRequest())

    expect(mockMarkAiMessageDispatched).toHaveBeenCalledWith(
      expect.anything(),
      'msg-ai-1',
      { status: 'sent', provider_message_id: 'wamid.success-123' },
    )
  })

  it('retorna sent=1 quando um envio é bem-sucedido', async () => {
    mockClaimAiQueuedMessages.mockResolvedValue([makeMsg()])

    const res = await POST(makeCronRequest())
    const body = await res.json() as { sent: number; failed: number }
    expect(body.sent).toBe(1)
    expect(body.failed).toBe(0)
  })

  it('remove dígitos não-numéricos do contact_phone ao chamar sendMessage', async () => {
    mockClaimAiQueuedMessages.mockResolvedValue([makeMsg()])
    mockFindConversationById.mockResolvedValue({
      ...makeConversation(),
      contact_phone: '+55 (11) 99999-9999',
    })

    await POST(makeCronRequest())

    expect(mockAdapterSendMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      '5511999999999',
      expect.anything(),
    )
  })
})

// ---------------------------------------------------------------------------
// Cenário 4 — Falha transitória: volta para queued
// ---------------------------------------------------------------------------

describe('Cenário 4 — Falha transitória (RetryableError) → re-enfileira', () => {
  it('RetryableError → UPDATE status=queued via SQL direto', async () => {
    mockClaimAiQueuedMessages.mockResolvedValue([makeMsg({ id: 'msg-retry' })])
    mockAdapterSendMessage.mockRejectedValue(new RetryableError('Rate limit 429'))

    await POST(makeCronRequest())

    // Should call raw SQL to set status back to queued
    expect(mockClientQuery).toHaveBeenCalledWith(
      expect.stringContaining("status = 'queued'"),
      ['msg-retry'],
    )
    // Should NOT call markAiMessageDispatched for retry case
    expect(mockMarkAiMessageDispatched).not.toHaveBeenCalled()
  })

  it('RetryableError não conta como failed no resultado', async () => {
    mockClaimAiQueuedMessages.mockResolvedValue([makeMsg()])
    mockAdapterSendMessage.mockRejectedValue(new RetryableError('503 temporary'))

    const res = await POST(makeCronRequest())
    const body = await res.json() as { sent: number; failed: number }
    expect(body.failed).toBe(0)
    expect(body.sent).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Cenário 5 — Falha permanente: vira failed
// ---------------------------------------------------------------------------

describe('Cenário 5 — Falha permanente → marcada como failed', () => {
  it('erro não-retryable → markAiMessageDispatched com status=failed', async () => {
    mockClaimAiQueuedMessages.mockResolvedValue([makeMsg({ id: 'msg-perm-fail' })])
    mockAdapterSendMessage.mockRejectedValue(new Error('400 Bad Request'))

    await POST(makeCronRequest())

    expect(mockMarkAiMessageDispatched).toHaveBeenCalledWith(
      expect.anything(),
      'msg-perm-fail',
      { status: 'failed', provider_message_id: null },
    )
  })

  it('falha permanente conta no resultado como failed=1', async () => {
    mockClaimAiQueuedMessages.mockResolvedValue([makeMsg()])
    mockAdapterSendMessage.mockRejectedValue(new Error('Invalid recipient'))

    const res = await POST(makeCronRequest())
    const body = await res.json() as { sent: number; failed: number }
    expect(body.failed).toBe(1)
    expect(body.sent).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Cenário 6 — Conversation/channel inexistente → failed
// ---------------------------------------------------------------------------

describe('Cenário 6 — Conversa ou canal inexistente → failed', () => {
  it('conversation null → markAiMessageDispatched failed e continua', async () => {
    mockClaimAiQueuedMessages.mockResolvedValue([makeMsg({ id: 'msg-no-conv' })])
    mockFindConversationById.mockResolvedValue(null)

    const res = await POST(makeCronRequest())

    expect(mockMarkAiMessageDispatched).toHaveBeenCalledWith(
      expect.anything(),
      'msg-no-conv',
      { status: 'failed' },
    )
    const body = await res.json() as { failed: number }
    expect(body.failed).toBe(1)
  })

  it('channel null → markAiMessageDispatched failed', async () => {
    mockClaimAiQueuedMessages.mockResolvedValue([makeMsg({ id: 'msg-no-ch' })])
    mockFindChannelById.mockResolvedValue(null)

    const res = await POST(makeCronRequest())

    expect(mockMarkAiMessageDispatched).toHaveBeenCalledWith(
      expect.anything(),
      'msg-no-ch',
      { status: 'failed' },
    )
  })

  it('channel status DISCONNECTED → failed', async () => {
    mockClaimAiQueuedMessages.mockResolvedValue([makeMsg({ id: 'msg-disconn' })])
    mockFindChannelById.mockResolvedValue(makeChannel({ status: 'DISCONNECTED' }))

    const res = await POST(makeCronRequest())

    expect(mockMarkAiMessageDispatched).toHaveBeenCalledWith(
      expect.anything(),
      'msg-disconn',
      { status: 'failed' },
    )
    expect(mockAdapterSendMessage).not.toHaveBeenCalled()
  })

  it('falha em um item não impede processamento dos demais', async () => {
    mockClaimAiQueuedMessages.mockResolvedValue([
      makeMsg({ id: 'msg-fail-1' }),
      makeMsg({ id: 'msg-ok-1' }),
    ])
    // First message: conversation not found
    mockFindConversationById
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(makeConversation())

    const res = await POST(makeCronRequest())
    const body = await res.json() as { sent: number; failed: number; total: number }
    expect(body.total).toBe(2)
    expect(body.failed).toBe(1)
    expect(body.sent).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Cenário 7 — Auth e idempotência
// ---------------------------------------------------------------------------

describe('Cenário 7 — Auth e idempotência do cron', () => {
  it('retorna 503 quando CRON_SECRET não está configurado', async () => {
    mockEnv.mockImplementation(() => undefined)

    const res = await POST(makeCronRequest())
    expect(res.status).toBe(503)
  })

  it('retorna 401 quando token incorreto', async () => {
    const res = await POST(
      new NextRequest('http://localhost/api/whatsapp/ai-dispatch', {
        method: 'POST',
        headers: { Authorization: 'Bearer wrong-secret' },
      }),
    )
    expect(res.status).toBe(401)
    expect(mockClaimAiQueuedMessages).not.toHaveBeenCalled()
  })

  it('retorna 401 quando header Authorization ausente', async () => {
    const res = await POST(
      new NextRequest('http://localhost/api/whatsapp/ai-dispatch', { method: 'POST' }),
    )
    expect(res.status).toBe(401)
  })

  it('libera client de pool mesmo quando há erros de envio', async () => {
    mockClaimAiQueuedMessages.mockResolvedValue([makeMsg()])
    mockAdapterSendMessage.mockRejectedValue(new Error('send failed'))

    await POST(makeCronRequest())

    expect(mockRelease).toHaveBeenCalledTimes(1)
  })
})

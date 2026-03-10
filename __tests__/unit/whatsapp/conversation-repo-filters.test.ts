// ---------------------------------------------------------------------------
// TDD — Repositório: findConversationsByWorkspace com filtros (seção 2)
//
// Cobre:
//   2a. workspace_id sempre aplicado
//   2b. status filter
//   2c. provider filter (via JOIN em whatsapp_channels)
//   2d. channel_id filter
//   2e. date_from filter (last_message_at >=)
//   2f. date_to filter (last_message_at <=)
//   2g. Ordenação mantém last_message_at DESC NULLS LAST com filtros
//   2h. Paginação limit/offset correta com filtros
//   2i. Sem filtros: comportamento atual mantido (backward compat)
//
// STATUS: RED — FindConversationsOptions não tem os campos novos ainda;
//         os testes de SQL clause falharão até a implementação.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest'
import type { PoolClient } from 'pg'
import { findConversationsByWorkspace } from '@/lib/whatsapp/conversation-repo'

// ---------------------------------------------------------------------------
// Helper: cria um mock de PoolClient capturando SQL e params da query
// ---------------------------------------------------------------------------

function makeMockClient(rows: unknown[] = []) {
  const mockQuery = vi.fn().mockResolvedValue({ rows })
  const client = { query: mockQuery } as unknown as PoolClient
  return { client, mockQuery }
}

/** Extrai SQL (string) e params (array) da primeira chamada ao mockQuery */
function getQueryCall(mockQuery: ReturnType<typeof vi.fn>): [string, unknown[]] {
  return mockQuery.mock.calls[0] as [string, unknown[]]
}

// ---------------------------------------------------------------------------
// 2a. workspace_id SEMPRE aplicado
// ---------------------------------------------------------------------------

describe('findConversationsByWorkspace — isolamento por workspace_id', () => {
  it('WHERE c.workspace_id = $1 sempre presente no SQL', async () => {
    const { client, mockQuery } = makeMockClient()
    await findConversationsByWorkspace(client, 'ws-abc', {})
    const [sql] = getQueryCall(mockQuery)
    expect(sql).toMatch(/WHERE c\.workspace_id\s*=\s*\$1/i)
  })

  it('workspace_id é o primeiro parâmetro ($1)', async () => {
    const { client, mockQuery } = makeMockClient()
    await findConversationsByWorkspace(client, 'ws-xyz', {})
    const [, params] = getQueryCall(mockQuery)
    expect(params[0]).toBe('ws-xyz')
  })

  it('workspace_id de workspace diferente produz query diferente', async () => {
    const { client: c1, mockQuery: q1 } = makeMockClient()
    const { client: c2, mockQuery: q2 } = makeMockClient()
    await findConversationsByWorkspace(c1, 'ws-a', {})
    await findConversationsByWorkspace(c2, 'ws-b', {})
    const [, p1] = getQueryCall(q1)
    const [, p2] = getQueryCall(q2)
    expect(p1[0]).toBe('ws-a')
    expect(p2[0]).toBe('ws-b')
  })
})

// ---------------------------------------------------------------------------
// 2b. Filtro por status
// ---------------------------------------------------------------------------

describe('findConversationsByWorkspace — filtro status', () => {
  it('sem status: nenhuma cláusula c.status no SQL', async () => {
    const { client, mockQuery } = makeMockClient()
    await findConversationsByWorkspace(client, 'ws-abc', {})
    const [sql] = getQueryCall(mockQuery)
    expect(sql).not.toMatch(/AND c\.status\s*=/)
  })

  it("status='open' → AND c.status = $N com parâmetro correto", async () => {
    const { client, mockQuery } = makeMockClient()
    await findConversationsByWorkspace(client, 'ws-abc', { status: 'open' })
    const [sql, params] = getQueryCall(mockQuery)
    expect(sql).toMatch(/AND c\.status\s*=\s*\$\d+/i)
    expect(params).toContain('open')
  })

  it("status='resolved' → parâmetro 'resolved' na query", async () => {
    const { client, mockQuery } = makeMockClient()
    await findConversationsByWorkspace(client, 'ws-abc', { status: 'resolved' })
    const [, params] = getQueryCall(mockQuery)
    expect(params).toContain('resolved')
  })

  it("status='ai_handled' → parâmetro 'ai_handled' na query", async () => {
    const { client, mockQuery } = makeMockClient()
    await findConversationsByWorkspace(client, 'ws-abc', { status: 'ai_handled' })
    const [, params] = getQueryCall(mockQuery)
    expect(params).toContain('ai_handled')
  })
})

// ---------------------------------------------------------------------------
// 2c. Filtro por provider (via JOIN whatsapp_channels)
// ---------------------------------------------------------------------------

describe('findConversationsByWorkspace — filtro provider', () => {
  it('sem provider: nenhuma cláusula wc.provider no SQL', async () => {
    const { client, mockQuery } = makeMockClient()
    await findConversationsByWorkspace(client, 'ws-abc', {})
    const [sql] = getQueryCall(mockQuery)
    expect(sql).not.toMatch(/AND wc\.provider\s*=/)
  })

  it("provider='META_CLOUD' → AND wc.provider = $N", async () => {
    const { client, mockQuery } = makeMockClient()
    await findConversationsByWorkspace(client, 'ws-abc', { provider: 'META_CLOUD' })
    const [sql, params] = getQueryCall(mockQuery)
    expect(sql).toMatch(/AND wc\.provider\s*=\s*\$\d+/i)
    expect(params).toContain('META_CLOUD')
  })

  it("provider='EVOLUTION' → parâmetro 'EVOLUTION' nos params", async () => {
    const { client, mockQuery } = makeMockClient()
    await findConversationsByWorkspace(client, 'ws-abc', { provider: 'EVOLUTION' })
    const [, params] = getQueryCall(mockQuery)
    expect(params).toContain('EVOLUTION')
  })

  it("provider='UAZAPI' → parâmetro 'UAZAPI' nos params", async () => {
    const { client, mockQuery } = makeMockClient()
    await findConversationsByWorkspace(client, 'ws-abc', { provider: 'UAZAPI' })
    const [, params] = getQueryCall(mockQuery)
    expect(params).toContain('UAZAPI')
  })

  it('JOIN em whatsapp_channels já existe para o filtro de provider', async () => {
    const { client, mockQuery } = makeMockClient()
    await findConversationsByWorkspace(client, 'ws-abc', { provider: 'META_CLOUD' })
    const [sql] = getQueryCall(mockQuery)
    // O JOIN em whatsapp_channels deve existir (tanto com como sem filtro)
    expect(sql).toMatch(/JOIN\s+whatsapp_channels\s+wc/i)
  })
})

// ---------------------------------------------------------------------------
// 2d. Filtro por channel_id
// ---------------------------------------------------------------------------

describe('findConversationsByWorkspace — filtro channel_id', () => {
  it('sem channel_id: nenhuma cláusula AND c.channel_id extra no SQL', async () => {
    const { client, mockQuery } = makeMockClient()
    await findConversationsByWorkspace(client, 'ws-abc', {})
    const [sql] = getQueryCall(mockQuery)
    // channel_id pode aparecer no JOIN mas não como filtro extra
    expect(sql).not.toMatch(/AND c\.channel_id\s*=\s*\$\d+/)
  })

  it('channel_id UUID → AND c.channel_id = $N com UUID correto', async () => {
    const { client, mockQuery } = makeMockClient()
    const uuid = 'aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    await findConversationsByWorkspace(client, 'ws-abc', { channel_id: uuid })
    const [sql, params] = getQueryCall(mockQuery)
    expect(sql).toMatch(/AND c\.channel_id\s*=\s*\$\d+/i)
    expect(params).toContain(uuid)
  })
})

// ---------------------------------------------------------------------------
// 2e-f. Filtros de data (date_from / date_to)
// ---------------------------------------------------------------------------

describe('findConversationsByWorkspace — filtro date_from / date_to', () => {
  it('sem datas: nenhuma cláusula de last_message_at com >= ou <=', async () => {
    const { client, mockQuery } = makeMockClient()
    await findConversationsByWorkspace(client, 'ws-abc', {})
    const [sql] = getQueryCall(mockQuery)
    expect(sql).not.toMatch(/c\.last_message_at\s*>=/)
    expect(sql).not.toMatch(/c\.last_message_at\s*<=/)
  })

  it('date_from → AND c.last_message_at >= $N com valor Date correto', async () => {
    const { client, mockQuery } = makeMockClient()
    const from = new Date('2026-03-01T00:00:00Z')
    await findConversationsByWorkspace(client, 'ws-abc', { date_from: from })
    const [sql, params] = getQueryCall(mockQuery)
    expect(sql).toMatch(/AND c\.last_message_at\s*>=\s*\$\d+/i)
    expect(params).toContain(from)
  })

  it('date_to → AND c.last_message_at <= $N com valor Date correto', async () => {
    const { client, mockQuery } = makeMockClient()
    const to = new Date('2026-03-10T23:59:59Z')
    await findConversationsByWorkspace(client, 'ws-abc', { date_to: to })
    const [sql, params] = getQueryCall(mockQuery)
    expect(sql).toMatch(/AND c\.last_message_at\s*<=\s*\$\d+/i)
    expect(params).toContain(to)
  })

  it('date_from + date_to: ambas as cláusulas presentes no SQL', async () => {
    const { client, mockQuery } = makeMockClient()
    const from = new Date('2026-03-01T00:00:00Z')
    const to = new Date('2026-03-10T23:59:59Z')
    await findConversationsByWorkspace(client, 'ws-abc', { date_from: from, date_to: to })
    const [sql, params] = getQueryCall(mockQuery)
    expect(sql).toMatch(/AND c\.last_message_at\s*>=\s*\$\d+/i)
    expect(sql).toMatch(/AND c\.last_message_at\s*<=\s*\$\d+/i)
    expect(params).toContain(from)
    expect(params).toContain(to)
  })

  it('apenas date_from: apenas >= presente (sem <=)', async () => {
    const { client, mockQuery } = makeMockClient()
    await findConversationsByWorkspace(client, 'ws-abc', { date_from: new Date('2026-03-01') })
    const [sql] = getQueryCall(mockQuery)
    expect(sql).toMatch(/c\.last_message_at\s*>=/i)
    expect(sql).not.toMatch(/c\.last_message_at\s*<=/i)
  })
})

// ---------------------------------------------------------------------------
// 2g. Ordenação
// ---------------------------------------------------------------------------

describe('findConversationsByWorkspace — ordenação', () => {
  it('ORDER BY c.last_message_at DESC NULLS LAST sempre presente', async () => {
    const { client, mockQuery } = makeMockClient()
    await findConversationsByWorkspace(client, 'ws-abc', {})
    const [sql] = getQueryCall(mockQuery)
    expect(sql).toMatch(/ORDER BY c\.last_message_at\s+DESC\s+NULLS\s+LAST/i)
  })

  it('ordenação mantida com filtro provider', async () => {
    const { client, mockQuery } = makeMockClient()
    await findConversationsByWorkspace(client, 'ws-abc', { provider: 'META_CLOUD' })
    const [sql] = getQueryCall(mockQuery)
    expect(sql).toMatch(/ORDER BY c\.last_message_at\s+DESC\s+NULLS\s+LAST/i)
  })

  it('ordenação mantida com filtro date_from + date_to', async () => {
    const { client, mockQuery } = makeMockClient()
    await findConversationsByWorkspace(client, 'ws-abc', {
      date_from: new Date('2026-03-01'),
      date_to: new Date('2026-03-10'),
    })
    const [sql] = getQueryCall(mockQuery)
    expect(sql).toMatch(/ORDER BY c\.last_message_at\s+DESC\s+NULLS\s+LAST/i)
  })
})

// ---------------------------------------------------------------------------
// 2h. Paginação com filtros
// ---------------------------------------------------------------------------

describe('findConversationsByWorkspace — paginação com filtros', () => {
  it('LIMIT $N com limit=25 e filtro provider', async () => {
    const { client, mockQuery } = makeMockClient()
    await findConversationsByWorkspace(client, 'ws-abc', { limit: 25, provider: 'EVOLUTION' })
    const [, params] = getQueryCall(mockQuery)
    expect(params).toContain(25)
  })

  it('OFFSET $N com offset=50 e filtro channel_id', async () => {
    const { client, mockQuery } = makeMockClient()
    const uuid = 'bbbb2222-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    await findConversationsByWorkspace(client, 'ws-abc', { limit: 20, offset: 50, channel_id: uuid })
    const [, params] = getQueryCall(mockQuery)
    expect(params).toContain(50)
  })

  it('todos os filtros em combinação ainda produzem apenas uma query', async () => {
    const { client, mockQuery } = makeMockClient()
    await findConversationsByWorkspace(client, 'ws-abc', {
      status: 'open',
      provider: 'META_CLOUD',
      channel_id: 'cccc3333-cccc-4ccc-8ccc-cccccccccccc',
      date_from: new Date('2026-03-01'),
      date_to: new Date('2026-03-10'),
      limit: 10,
      offset: 20,
    })
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })

  it('parâmetros $N são sequenciais (sem buracos na numeração)', async () => {
    const { client, mockQuery } = makeMockClient()
    await findConversationsByWorkspace(client, 'ws-abc', {
      status: 'open',
      provider: 'META_CLOUD',
      date_from: new Date('2026-03-01'),
      date_to: new Date('2026-03-10'),
    })
    const [sql] = getQueryCall(mockQuery)
    // Extrai todos os placeholders $1, $2, ... e verifica sequência contínua
    const placeholders = [...sql.matchAll(/\$(\d+)/g)].map((m) => parseInt(m[1]))
    const unique = [...new Set(placeholders)].sort((a, b) => a - b)
    // Deve ser [1, 2, 3, ..., N] sem saltos
    for (let i = 0; i < unique.length; i++) {
      expect(unique[i]).toBe(i + 1)
    }
  })
})

// ---------------------------------------------------------------------------
// 2i. Backward compat — sem filtros
// ---------------------------------------------------------------------------

describe('findConversationsByWorkspace — backward compat sem filtros', () => {
  it('sem filtros: executa exatamente uma query', async () => {
    const { client, mockQuery } = makeMockClient()
    await findConversationsByWorkspace(client, 'ws-test', {})
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })

  it('sem filtros: retorna array vazio quando repo retorna []', async () => {
    const { client } = makeMockClient([])
    const result = await findConversationsByWorkspace(client, 'ws-test', {})
    expect(result).toEqual([])
  })

  it('sem filtros: SQL contém SELECT e FROM conversations', async () => {
    const { client, mockQuery } = makeMockClient()
    await findConversationsByWorkspace(client, 'ws-test', {})
    const [sql] = getQueryCall(mockQuery)
    expect(sql).toMatch(/SELECT/i)
    expect(sql).toMatch(/FROM conversations/i)
  })

  it('sem filtros: usa limit padrão quando não especificado', async () => {
    const { client, mockQuery } = makeMockClient()
    await findConversationsByWorkspace(client, 'ws-test')
    const [, params] = getQueryCall(mockQuery)
    // limit deve ser um número positivo (padrão atual é 20)
    const limitParam = params.find((p) => typeof p === 'number' && p > 0 && p <= 100)
    expect(limitParam).toBeTruthy()
  })
})

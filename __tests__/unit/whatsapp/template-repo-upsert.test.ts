import { describe, it, expect, vi } from 'vitest'
import type { PoolClient } from 'pg'
import { upsertTemplate } from '@/lib/whatsapp/template-repo'
import type { MetaTemplateItem } from '@/lib/schemas'

// ---------------------------------------------------------------------------
// Unit: upsertTemplate classification (created / updated / unchanged)
// Uses a mock PoolClient — no real DB connection required.
// ---------------------------------------------------------------------------

function makeClient(existingRows: { status: string; category: string; components_text: string }[]) {
  let callCount = 0
  const client = {
    query: vi.fn().mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        // Step 1: SELECT — return the existing row (or empty)
        return Promise.resolve({ rows: existingRows })
      }
      // Step 2: INSERT … ON CONFLICT DO UPDATE
      return Promise.resolve({ rows: [], rowCount: 1 })
    }),
  } as unknown as PoolClient
  return client
}

const baseTemplate: MetaTemplateItem = {
  id: 'meta-tpl-001',
  name: 'boas_vindas',
  language: 'pt_BR',
  status: 'APPROVED',
  category: 'MARKETING',
  components: [
    { type: 'BODY', text: 'Olá {{1}}, bem-vindo!' },
  ],
}

describe('upsertTemplate classification', () => {
  it('returns "created" when no existing row', async () => {
    const client = makeClient([])
    const result = await upsertTemplate(client, 'ws-1', 'ch-1', baseTemplate)
    expect(result).toBe('created')
  })

  it('returns "unchanged" when existing row is identical', async () => {
    const componentsJson = JSON.stringify(baseTemplate.components)
    const client = makeClient([
      {
        status: 'APPROVED',
        category: 'MARKETING',
        components_text: componentsJson,
      },
    ])
    const result = await upsertTemplate(client, 'ws-1', 'ch-1', baseTemplate)
    expect(result).toBe('unchanged')
  })

  it('returns "updated" when status changes', async () => {
    const componentsJson = JSON.stringify(baseTemplate.components)
    const client = makeClient([
      {
        status: 'PENDING',          // was PENDING, now APPROVED
        category: 'MARKETING',
        components_text: componentsJson,
      },
    ])
    const result = await upsertTemplate(client, 'ws-1', 'ch-1', baseTemplate)
    expect(result).toBe('updated')
  })

  it('returns "updated" when category changes', async () => {
    const componentsJson = JSON.stringify(baseTemplate.components)
    const client = makeClient([
      {
        status: 'APPROVED',
        category: 'UTILITY',        // was UTILITY, now MARKETING
        components_text: componentsJson,
      },
    ])
    const result = await upsertTemplate(client, 'ws-1', 'ch-1', baseTemplate)
    expect(result).toBe('updated')
  })

  it('returns "updated" when components change', async () => {
    const client = makeClient([
      {
        status: 'APPROVED',
        category: 'MARKETING',
        components_text: JSON.stringify([{ type: 'BODY', text: 'Texto antigo' }]),
      },
    ])
    const result = await upsertTemplate(client, 'ws-1', 'ch-1', baseTemplate)
    expect(result).toBe('updated')
  })

  it('issues exactly 2 queries (SELECT then UPSERT)', async () => {
    const client = makeClient([])
    await upsertTemplate(client, 'ws-1', 'ch-1', baseTemplate)
    expect(client.query).toHaveBeenCalledTimes(2)
  })

  it('SELECT query scopes by workspace_id, channel_id, name, language', async () => {
    const client = makeClient([])
    await upsertTemplate(client, 'ws-abc', 'ch-xyz', baseTemplate)
    const firstCall = (client.query as ReturnType<typeof vi.fn>).mock.calls[0]
    const sql: string = firstCall[0]
    const params: unknown[] = firstCall[1]
    expect(sql).toMatch(/WHERE workspace_id.*channel_id.*template_name.*language/i)
    expect(params).toContain('ws-abc')
    expect(params).toContain('ch-xyz')
    expect(params).toContain(baseTemplate.name)
    expect(params).toContain(baseTemplate.language)
  })
})

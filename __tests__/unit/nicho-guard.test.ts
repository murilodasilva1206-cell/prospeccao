// ---------------------------------------------------------------------------
// Unit tests — nicho guard in /api/agente, /api/busca, /api/export
//
// Verifies that when a nicho cannot be resolved to a CNAE code, all three
// routes reject the request rather than executing a sector-less DB scan.
// All external dependencies are mocked — no DB or network required.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@/lib/database', () => ({
  default: { connect: vi.fn().mockResolvedValue({ release: vi.fn() }) },
}))

vi.mock('@/lib/rate-limit', () => ({
  agenteLimiter: { check: vi.fn().mockResolvedValue({ success: true, resetAt: 0 }) },
  buscaLimiter:  { check: vi.fn().mockResolvedValue({ success: true, resetAt: 0 }) },
  exportLimiter: { check: vi.fn().mockResolvedValue({ success: true, resetAt: 0 }) },
}))

vi.mock('@/lib/whatsapp/auth-middleware', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/whatsapp/auth-middleware')>()
  return {
    ...original,
    requireWorkspaceAuth: vi.fn().mockResolvedValue({
      workspace_id:   'ws-test',
      actor:          'api_key:test-bot',
      key_id:         'key-test',
      dedup_actor_id: 'api_key:key-test',
    }),
  }
})

vi.mock('@/lib/llm-profile-repo', () => ({
  getDefaultProfile: vi.fn().mockResolvedValue({
    apiKey: 'sk-or-test', model: 'test-model', provider: 'openrouter',
  }),
}))

// AI agent returns a search intent that carries nicho but no cnae_principal
vi.mock('@/lib/ai-client', () => ({
  callAiAgent: vi.fn().mockResolvedValue({
    intent:      { action: 'search', filters: { nicho: 'zumba-xyz', uf: 'SP' }, confidence: 0.9 },
    latencyMs:   10,
    parseSuccess: true,
  }),
  _resetBreakerForTest: vi.fn(),
}))

// Resolver always fails for the unknown nicho
vi.mock('@/lib/cnae-resolver-service', () => ({
  getCnaeResolverService: vi.fn(() => ({ resolve: vi.fn().mockResolvedValue(null) })),
}))

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { POST as agentePost } from '@/app/api/agente/route'
import { GET  as buscaGet   } from '@/app/api/busca/route'
import { GET  as exportGet  } from '@/app/api/export/route'

// ---------------------------------------------------------------------------
// /api/agente
// ---------------------------------------------------------------------------

describe('/api/agente — nicho guard', () => {
  it('returns action:clarify with a non-empty message when nicho cannot be resolved', async () => {
    const req = new NextRequest('http://localhost/api/agente', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Professores de zumba-xyz em SP' }),
    })

    const res = await agentePost(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.action).toBe('clarify')
    expect(typeof body.message).toBe('string')
    expect(body.message.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// /api/busca
// ---------------------------------------------------------------------------

describe('/api/busca — nicho guard', () => {
  it('returns 400 with an error message when nicho cannot be resolved', async () => {
    const req = new NextRequest('http://localhost/api/busca?nicho=zumba-xyz', {
      method: 'GET',
    })

    const res = await buscaGet(req)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(typeof body.error).toBe('string')
    expect(body.error.toLowerCase()).toContain('nicho')
  })
})

// ---------------------------------------------------------------------------
// /api/export
// ---------------------------------------------------------------------------

describe('/api/export — nicho guard', () => {
  it('returns 400 with an error message when nicho cannot be resolved', async () => {
    const req = new NextRequest('http://localhost/api/export?nicho=zumba-xyz', {
      method: 'GET',
    })

    const res = await exportGet(req)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(typeof body.error).toBe('string')
    expect(body.error.toLowerCase()).toContain('nicho')
  })
})

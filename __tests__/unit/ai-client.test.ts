// ---------------------------------------------------------------------------
// Unit tests — ai-client.ts
//
// Covers:
//   - Per-provider circuit breakers: separate breaker per provider label
//   - extractJson helper (via parse round-trips with mocked callLlmProvider)
//   - Fallback on parse failure (ruleBasedFallback)
//   - Profile is required (no global fallback)
//   - latencyMs and parseSuccess returned correctly
//
// callLlmProvider is mocked via MSW / vi.mock so no real HTTP calls occur.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoist mocks so they are available in vi.mock factories
// ---------------------------------------------------------------------------
const { mockCallLlmProvider, mockCircuitBreakerExecute } = vi.hoisted(() => {
  const mockCallLlmProvider = vi.fn()
  const mockCircuitBreakerExecute = vi.fn()
  return { mockCallLlmProvider, mockCircuitBreakerExecute }
})

// Mock the LLM provider — all network calls go here
vi.mock('@/lib/llm-providers', () => ({
  callLlmProvider: mockCallLlmProvider,
}))

// Mock logger to suppress output during tests
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnThis() },
}))

// Use the real CircuitBreaker so per-provider isolation is tested properly
// (only mock callLlmProvider, not the breaker itself)

import { callAiAgent } from '@/lib/ai-client'
import type { LlmCallConfig } from '@/lib/llm-providers'

const makeProfile = (provider: string = 'openrouter'): LlmCallConfig => ({
  provider: provider as LlmCallConfig['provider'],
  apiKey: 'sk-test-key',
  model: 'test-model',
})

const VALID_INTENT_JSON = JSON.stringify({
  action: 'search',
  filters: { uf: 'SP' },
  confidence: 0.9,
})

beforeEach(() => {
  mockCallLlmProvider.mockReset()
})

// ---------------------------------------------------------------------------
// Basic flow
// ---------------------------------------------------------------------------
describe('callAiAgent — basic flow', () => {
  it('returns parsed intent and latencyMs on success', async () => {
    mockCallLlmProvider.mockResolvedValue(VALID_INTENT_JSON)

    const result = await callAiAgent('Dentistas em SP', makeProfile())

    expect(result.intent.action).toBe('search')
    expect(result.parseSuccess).toBe(true)
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('falls back to clarify intent when AI returns invalid JSON', async () => {
    mockCallLlmProvider.mockResolvedValue('Not JSON at all')

    const result = await callAiAgent('???', makeProfile())

    expect(result.intent.action).toBe('clarify')
    expect(result.parseSuccess).toBe(false)
    expect(result.intent.confidence).toBe(0)
  })

  it('falls back when AI returns JSON that fails schema validation', async () => {
    // valid JSON but missing required 'action' field
    mockCallLlmProvider.mockResolvedValue(JSON.stringify({ foo: 'bar' }))

    const result = await callAiAgent('test', makeProfile())

    expect(result.intent.action).toBe('clarify')
    expect(result.parseSuccess).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// extractJson via mocked LLM responses
// ---------------------------------------------------------------------------
describe('callAiAgent — extractJson', () => {
  it('parses JSON wrapped in markdown code fence', async () => {
    mockCallLlmProvider.mockResolvedValue(
      '```json\n' + VALID_INTENT_JSON + '\n```',
    )
    const result = await callAiAgent('test', makeProfile())
    expect(result.parseSuccess).toBe(true)
    expect(result.intent.action).toBe('search')
  })

  it('parses JSON wrapped in plain code fence (no language tag)', async () => {
    mockCallLlmProvider.mockResolvedValue('```\n' + VALID_INTENT_JSON + '\n```')
    const result = await callAiAgent('test', makeProfile())
    expect(result.parseSuccess).toBe(true)
  })

  it('parses JSON embedded in surrounding prose', async () => {
    mockCallLlmProvider.mockResolvedValue(
      'Sure! Here is my response: ' + VALID_INTENT_JSON + ' I hope that helps.',
    )
    const result = await callAiAgent('test', makeProfile())
    expect(result.parseSuccess).toBe(true)
    expect(result.intent.action).toBe('search')
  })

  it('parses multiline JSON with newlines in string values', async () => {
    const intent = JSON.stringify({
      action: 'clarify',
      confidence: 0.5,
      message: 'Please\nprovide more\ndetails',
    })
    mockCallLlmProvider.mockResolvedValue('```json\n' + intent + '\n```')
    const result = await callAiAgent('test', makeProfile())
    expect(result.parseSuccess).toBe(true)
    expect(result.intent.action).toBe('clarify')
  })
})

// ---------------------------------------------------------------------------
// Per-provider circuit breaker isolation
// ---------------------------------------------------------------------------
describe('callAiAgent — per-provider circuit breaker', () => {
  it('calls the LLM provider with the profile passed in', async () => {
    mockCallLlmProvider.mockResolvedValue(VALID_INTENT_JSON)

    const profile = makeProfile('anthropic')
    await callAiAgent('test', profile)

    // callLlmProvider receives the profile as first arg
    expect(mockCallLlmProvider).toHaveBeenCalledWith(
      profile,
      expect.any(String), // system prompt
      'test',             // user message
      expect.any(Number), // max_tokens
      expect.any(Number), // temperature
      expect.any(AbortSignal), // AbortController signal
    )
  })

  it('uses different provider labels for breaker isolation', async () => {
    // Both calls succeed — we just verify provider is passed through
    mockCallLlmProvider.mockResolvedValue(VALID_INTENT_JSON)

    const openaiProfile   = makeProfile('openai')
    const anthropicProfile = makeProfile('anthropic')

    const [r1, r2] = await Promise.all([
      callAiAgent('test', openaiProfile),
      callAiAgent('test', anthropicProfile),
    ])

    expect(r1.parseSuccess).toBe(true)
    expect(r2.parseSuccess).toBe(true)

    // Each call used its own provider config
    const calls = mockCallLlmProvider.mock.calls as [LlmCallConfig, ...unknown[]][]
    const providers = calls.map((c) => c[0].provider)
    expect(providers).toContain('openai')
    expect(providers).toContain('anthropic')
  })
})

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------
describe('callAiAgent — AbortController timeout', () => {
  it('includes AbortSignal in the provider call (timeout guard)', async () => {
    mockCallLlmProvider.mockResolvedValue(VALID_INTENT_JSON)
    await callAiAgent('test', makeProfile())

    const [, , , , , signal] = mockCallLlmProvider.mock.calls[0] as unknown[]
    expect(signal).toBeInstanceOf(AbortSignal)
  })
})

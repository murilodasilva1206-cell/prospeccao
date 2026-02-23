import { logger } from './logger'
import { CircuitBreaker } from './circuit-breaker'
import { SYSTEM_PROMPT } from './agent-prompts'
import { AgentIntentSchema, type AgentIntent } from './schemas'
import { callLlmProvider, type LlmCallConfig } from './llm-providers'

const AI_TIMEOUT_MS = 15_000 // 15-second hard timeout for AI response

export interface AiCallResult {
  intent: AgentIntent
  latencyMs: number
  parseSuccess: boolean
}

// ---------------------------------------------------------------------------
// Per-provider circuit breakers
//
// One breaker per provider isolates failures: a degraded OpenAI instance does
// not trip the breaker for Google or Anthropic calls from other workspaces.
// ---------------------------------------------------------------------------
const _breakerMap = new Map<string, CircuitBreaker>()

function getBreakerFor(provider: string): CircuitBreaker {
  let b = _breakerMap.get(provider)
  if (!b) {
    b = new CircuitBreaker(`llm:${provider}`, {
      failureThreshold: 5,  // open after 5 consecutive failures
      successThreshold: 2,  // close after 2 successes in HALF_OPEN
      timeout: 30_000,      // wait 30 s before probing
    })
    _breakerMap.set(provider, b)
  }
  return b
}

// ---------------------------------------------------------------------------
// JSON extraction helper
//
// LLMs sometimes wrap their response in markdown fences or add explanatory
// prose. This extracts the JSON object before passing it to JSON.parse so
// that "Sure! ```json\n{...}\n```" still parses correctly.
// ---------------------------------------------------------------------------
function extractJson(raw: string): string {
  // 1. Markdown code fence: ```json ... ``` or ``` ... ```
  const fenceMatch = raw.match(/```(?:json)?[\s\S]*?```/)
  if (fenceMatch) {
    const inner = fenceMatch[0].replace(/^```(?:json)?/, '').replace(/```$/, '').trim()
    if (inner) return inner
  }
  // 2. Raw JSON object — may have surrounding prose
  const objMatch = raw.match(/{[\s\S]*}/)
  if (objMatch) return objMatch[0]

  return raw.trim()
}

/**
 * Calls an LLM provider using the supplied workspace profile config.
 *
 * The caller (route layer) is responsible for supplying a valid LlmCallConfig.
 * There is NO global API key fallback here — that decision belongs at the route
 * level where the 409 "configure your LLM" response can be returned cleanly.
 *
 * Security properties:
 * - System and user are ALWAYS separate message objects (never concatenated).
 * - Response is validated with AgentIntentSchema before any field is used.
 * - Falls back to a safe deterministic result if AI response is invalid/unparseable.
 * - Per-provider circuit breaker isolates failures across workspaces and providers.
 * - AbortController enforces a 15-second hard timeout.
 */
export async function callAiAgent(
  userMessage: string,
  profile: LlmCallConfig,
): Promise<AiCallResult> {
  const startTime = Date.now()
  const breaker = getBreakerFor(profile.provider)

  const rawContent = await breaker.execute(async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS)

    try {
      // CRITICAL: system and user are SEPARATE message objects inside callLlmProvider.
      // Never concatenate: `${SYSTEM_PROMPT}\n${userMessage}`
      return await callLlmProvider(
        profile,
        SYSTEM_PROMPT,
        userMessage,
        300,  // max_tokens: keep responses short and structured
        0.1,  // temperature: low for deterministic structured output
        controller.signal,
      )
    } finally {
      clearTimeout(timer)
    }
  })

  const latencyMs = Date.now() - startTime

  // Validate AI response structure before using any field
  let intent: AgentIntent
  let parseSuccess: boolean

  try {
    const jsonStr = extractJson(rawContent)
    const parsed = JSON.parse(jsonStr)
    intent = AgentIntentSchema.parse(parsed)
    parseSuccess = true
  } catch (err) {
    // AI returned invalid JSON or schema mismatch — fall back to safe default
    logger.warn(
      { rawContent: rawContent.slice(0, 200), err, latencyMs, provider: profile.provider },
      'AI response parse failed — using deterministic fallback',
    )
    intent = ruleBasedFallback()
    parseSuccess = false
  }

  logger.info(
    { action: intent.action, confidence: intent.confidence, latencyMs, parseSuccess, provider: profile.provider },
    'AI agent call complete',
  )

  return { intent, latencyMs, parseSuccess }
}

/**
 * Resets the circuit breaker for a specific provider.
 * @internal Exposed for test isolation only — do not use in production code.
 */
export function _resetBreakerForTest(provider: string): void {
  const b = _breakerMap.get(provider)
  if (b) b._reset()
}

/**
 * Rule-based fallback used when AI response cannot be parsed.
 * Returns a safe `clarify` action that asks the user to rephrase.
 */
function ruleBasedFallback(): AgentIntent {
  return {
    action: 'clarify',
    confidence: 0,
    message:
      'Não consegui entender o pedido. Por favor, descreva quem você procura (ex: "CTOs em fintechs de São Paulo").',
  }
}

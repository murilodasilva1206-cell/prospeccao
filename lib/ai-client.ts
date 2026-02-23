import { env } from './env'
import { logger } from './logger'
import { openRouterBreaker } from './circuit-breaker'
import { SYSTEM_PROMPT } from './agent-prompts'
import { AgentIntentSchema, type AgentIntent } from './schemas'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const AI_TIMEOUT_MS = 15_000 // 15-second hard timeout for AI response

export interface AiCallResult {
  intent: AgentIntent
  latencyMs: number
  parseSuccess: boolean
}

/**
 * Calls OpenRouter with the user's message, validates the response,
 * and returns a structured intent object.
 *
 * Security properties:
 * - System and user are ALWAYS separate message objects (never concatenated).
 * - Response is validated with AgentIntentSchema before any field is used.
 * - Falls back to a safe deterministic result if AI response is invalid.
 * - Circuit breaker prevents cascade failures when OpenRouter is degraded.
 * - AbortController enforces a 15-second hard timeout.
 */
export async function callAiAgent(userMessage: string): Promise<AiCallResult> {
  const startTime = Date.now()

  const rawContent = await openRouterBreaker.execute(async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS)

    try {
      const res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          // OPENROUTER_API_KEY is in pino's redact list — never appears in logs
          Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          'HTTP-Referer': 'https://prospeccao.app',
          'X-Title': 'Prospeccao Contact Search',
        },
        body: JSON.stringify({
          model: env.OPENROUTER_MODEL,
          messages: [
            // CRITICAL: system and user are SEPARATE objects.
            // Never concatenate: `${SYSTEM_PROMPT}\n${userMessage}`
            // Concatenation allows injection — user text can end the "instruction" section.
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userMessage },
          ],
          max_tokens: 300, // keep responses short and structured
          temperature: 0.1, // low temperature for deterministic structured output
          response_format: { type: 'json_object' }, // JSON mode enforced
        }),
      })

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`OpenRouter HTTP ${res.status}: ${res.statusText}. ${body}`)
      }

      const json = await res.json()
      return (json.choices?.[0]?.message?.content as string) ?? ''
    } finally {
      clearTimeout(timer)
    }
  })

  const latencyMs = Date.now() - startTime

  // Validate AI response structure before using any field
  let intent: AgentIntent
  let parseSuccess: boolean

  try {
    const parsed = JSON.parse(rawContent)
    intent = AgentIntentSchema.parse(parsed)
    parseSuccess = true
  } catch (err) {
    // AI returned invalid JSON or schema mismatch — fall back to safe default
    logger.warn(
      { rawContent: rawContent.slice(0, 200), err, latencyMs },
      'AI response parse failed — using deterministic fallback',
    )
    intent = ruleBasedFallback()
    parseSuccess = false
  }

  logger.info(
    {
      action: intent.action,
      confidence: intent.confidence,
      latencyMs,
      parseSuccess,
    },
    'AI agent call complete',
  )

  return { intent, latencyMs, parseSuccess }
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

// ---------------------------------------------------------------------------
// AI Narrator — second LLM pipeline that converts search results into a
// natural PT-BR headline + subtitle for the chat panel.
//
// Pipeline:
//   1. Build a compact user message with result statistics.
//   2. Call callLlmProvider with a hardcoded PT-BR narrator system prompt.
//   3. Validate the JSON response ({"headline":"...","subtitle":"..."}).
//   4. On any failure, fall back to deterministic humanizeSearchResult.
//
// The narrator runs AFTER the Interpreter LLM (callAiAgent) and the DB query.
// Its timeout (8s) is separate from the Interpreter's (15s).
// It never uses the circuit breaker — a narrator failure is non-fatal.
// ---------------------------------------------------------------------------

import { z } from 'zod'
import { callLlmProvider, type LlmCallConfig } from './llm-providers'
import { humanizeSearchResult } from './agent-humanizer'
import { logger } from './logger'
import { env } from './env'
import type { AgentIntent } from './schemas'
import type { PublicEmpresa } from './mask-output'

const NARRATOR_TIMEOUT_MS = 8_000

const NARRATOR_SYSTEM_PROMPT = `Você é um assistente conciso de prospecção empresarial.
Dado um resultado de busca de empresas no cadastro CNPJ, gere:
- headline: frase curta (máx 80 chars) em PT-BR informal resumindo o resultado
- subtitle: frase complementar (máx 120 chars) com um detalhe útil ao usuário

Responda APENAS com JSON válido, sem markdown: {"headline":"...","subtitle":"..."}`

const NarratorResponseSchema = z.object({
  headline: z.string().min(1).max(200),
  subtitle: z.string().min(1).max(300),
})

export interface NarratorResult {
  headline: string
  subtitle: string
  hasCta: boolean
  source: 'llm' | 'fallback'
}

/**
 * Generates a natural PT-BR headline + subtitle for a search result.
 * Falls back to the deterministic humanizeSearchResult on any LLM error.
 */
export async function narrateSearchResult(
  originalQuery: string,
  intent: AgentIntent,
  results: PublicEmpresa[],
  total: number,
  profile?: LlmCallConfig,
): Promise<NarratorResult> {
  const filters = intent.filters ?? {}

  // Compute hasCta the same way as humanizeSearchResult
  const withPhone = results.filter((r) => r.telefone1 || r.telefone2).length
  const withEmail = results.filter((r) => r.email).length
  const hasCta = results.length > 0 && withPhone > 0

  // Build compact user message with result statistics
  const sector =
    filters.nicho ?? (filters.cnae_principal ? `CNAE ${filters.cnae_principal}` : 'empresas')
  const location = [filters.municipio, filters.uf].filter(Boolean).join(', ')
  const userMessage = [
    `Busca do usuário: "${originalQuery}"`,
    `Total no banco: ${total} empresas.`,
    `Mostrando: ${results.length}.`,
    `Com telefone: ${withPhone}. Com e-mail: ${withEmail}.`,
    location ? `Localização: ${location}.` : '',
    `Setor: ${sector}.`,
  ]
    .filter(Boolean)
    .join(' ')

  const config: LlmCallConfig = profile ?? {
    apiKey:   env.OPENROUTER_API_KEY,
    model:    env.OPENROUTER_MODEL,
    provider: 'openrouter',
  }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), NARRATOR_TIMEOUT_MS)

    let rawContent: string
    try {
      rawContent = await callLlmProvider(
        config,
        NARRATOR_SYSTEM_PROMPT,
        userMessage,
        150,  // max_tokens: short response
        0.4,  // slightly more creative than interpreter
        controller.signal,
      )
    } finally {
      clearTimeout(timer)
    }

    // Strip potential markdown code fences before parsing
    const cleaned = rawContent.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim()
    const parsed = NarratorResponseSchema.parse(JSON.parse(cleaned))

    logger.debug(
      { headline: parsed.headline, originalQuery },
      'Narrator LLM generated response',
    )

    return { headline: parsed.headline, subtitle: parsed.subtitle, hasCta, source: 'llm' }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, originalQuery },
      'Narrator LLM failed — using deterministic fallback',
    )

    // Deterministic fallback — always succeeds
    const fallback = humanizeSearchResult({
      total,
      count: results.length,
      filters,
      data: results,
    })

    return {
      headline: fallback.headline,
      subtitle: fallback.subtitle,
      hasCta: fallback.hasCta,
      source: 'fallback',
    }
  }
}

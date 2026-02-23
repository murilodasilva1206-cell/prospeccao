// ---------------------------------------------------------------------------
// Multi-provider LLM abstraction.
//
// Supported providers:
//   openrouter — OpenAI-compatible, proxies many models.
//   openai     — OpenAI-compatible.
//   google     — Gemini via OpenAI-compatible endpoint.
//   anthropic  — Anthropic Messages API (different wire format).
//
// All providers use JSON-mode where supported. For Anthropic, the system
// prompt enforces JSON-only output instead (see agent-prompts.ts).
// ---------------------------------------------------------------------------

export type LlmProvider = 'openrouter' | 'openai' | 'anthropic' | 'google'

export interface LlmCallConfig {
  apiKey: string
  model: string
  provider: LlmProvider
  baseUrl?: string // overrides the default base URL for this provider
}

const DEFAULT_BASE_URLS: Record<LlmProvider, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  openai:     'https://api.openai.com/v1',
  anthropic:  'https://api.anthropic.com/v1',
  google:     'https://generativelanguage.googleapis.com/v1beta/openai',
}

/**
 * Calls an LLM provider and returns the raw text of the first response message.
 * Routes to the appropriate wire format based on provider.
 */
export async function callLlmProvider(
  config: LlmCallConfig,
  systemPrompt: string,
  userMessage: string,
  maxTokens: number,
  temperature: number,
  signal?: AbortSignal,
): Promise<string> {
  const base = config.baseUrl ?? DEFAULT_BASE_URLS[config.provider]

  if (config.provider === 'anthropic') {
    return callAnthropicProvider(
      base, config.apiKey, config.model,
      systemPrompt, userMessage, maxTokens, temperature, signal,
    )
  }

  return callOpenAiCompatibleProvider(
    base, config.apiKey, config.model,
    systemPrompt, userMessage, maxTokens, temperature, signal,
  )
}

async function callOpenAiCompatibleProvider(
  base: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userMessage: string,
  maxTokens: number,
  temperature: number,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://prospeccao.app',
      'X-Title': 'Prospeccao',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      max_tokens: maxTokens,
      temperature,
      response_format: { type: 'json_object' },
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`LLM provider HTTP ${res.status}: ${body.slice(0, 200)}`)
  }

  const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
  const content = json.choices?.[0]?.message?.content
  if (!content) throw new Error('LLM provider returned empty content')
  return content
}

async function callAnthropicProvider(
  base: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userMessage: string,
  maxTokens: number,
  temperature: number,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(`${base}/messages`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      max_tokens: maxTokens,
      temperature,
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Anthropic HTTP ${res.status}: ${body.slice(0, 200)}`)
  }

  const json = await res.json() as { content?: Array<{ text?: string }> }
  const content = json.content?.[0]?.text
  if (!content) throw new Error('Anthropic returned empty content')
  return content
}

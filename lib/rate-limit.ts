import { LRUCache } from 'lru-cache'

// ---------------------------------------------------------------------------
// Rate limiting — two modes:
//
// 1. DISTRIBUTED (Upstash Redis REST): active when UPSTASH_REDIS_REST_URL and
//    UPSTASH_REDIS_REST_TOKEN are set. Required for multi-instance deployments
//    (Vercel, etc.) where in-memory state is not shared across lambda instances.
//
//    No extra packages needed — uses Upstash REST API via fetch().
//    Set env vars: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
//
// 2. IN-MEMORY (LRUCache): fallback for single-process dev/staging deployments
//    (Railway, Render, VPS). Safe locally; not safe on Vercel (each lambda
//    instance has isolated memory).
//
// The `check(ip)` interface is async for both modes.
// ---------------------------------------------------------------------------

export interface CheckResult {
  success: boolean
  remaining: number
  resetAt: number // Unix ms timestamp of window expiry
}

interface RateLimiterConfig {
  name: string           // used as key prefix in Redis (e.g. 'agente')
  uniqueTokenPerInterval: number
  interval: number       // window size in ms
  maxRequests: number
}

interface RateLimitEntry {
  tokens: number
  resetAt: number
}

// ---------------------------------------------------------------------------
// Upstash REST implementation — fixed window via INCR + EXPIREAT pipeline
// ---------------------------------------------------------------------------

async function upstashCheck(
  name: string,
  ip: string,
  maxRequests: number,
  windowMs: number,
): Promise<CheckResult> {
  const upstashUrl = process.env.UPSTASH_REDIS_REST_URL!
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN!

  // Fixed window: key changes every `windowMs` milliseconds
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs
  const windowEnd = windowStart + windowMs
  const key = `rl:${name}:${ip}:${windowStart}`
  const expireAtSec = Math.floor(windowEnd / 1000)

  // Pipeline: INCR key, then EXPIREAT key <unix-seconds>
  // EXPIREAT is idempotent — safe to call on every request (sets same value)
  const response = await fetch(`${upstashUrl}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${upstashToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([
      ['INCR', key],
      ['EXPIREAT', key, expireAtSec],
    ]),
  })

  if (!response.ok) {
    throw new Error(`Upstash rate-limit pipeline failed: HTTP ${response.status}`)
  }

  const results = (await response.json()) as Array<{ result: number }>
  const count = results[0].result

  return {
    success: count <= maxRequests,
    remaining: Math.max(0, maxRequests - count),
    resetAt: windowEnd,
  }
}

// ---------------------------------------------------------------------------
// In-memory fallback (LRUCache) — synchronous token-bucket per IP
// ---------------------------------------------------------------------------

function createInMemoryLimiter(config: RateLimiterConfig) {
  const cache = new LRUCache<string, RateLimitEntry>({
    max: config.uniqueTokenPerInterval,
    ttl: config.interval,
  })

  return {
    check(ip: string): CheckResult {
      const now = Date.now()
      const entry = cache.get(ip) ?? {
        tokens: config.maxRequests,
        resetAt: now + config.interval,
      }

      if (now > entry.resetAt) {
        entry.tokens = config.maxRequests
        entry.resetAt = now + config.interval
      }

      if (entry.tokens <= 0) {
        cache.set(ip, entry)
        return { success: false, remaining: 0, resetAt: entry.resetAt }
      }

      entry.tokens -= 1
      cache.set(ip, entry)
      return { success: true, remaining: entry.tokens, resetAt: entry.resetAt }
    },
  }
}

// ---------------------------------------------------------------------------
// createRateLimiter — exported so tests can create isolated limiters
// Returns an async check(ip) interface regardless of which backend is active.
// ---------------------------------------------------------------------------

export function createRateLimiter(config: RateLimiterConfig): {
  check(ip: string): Promise<CheckResult>
} {
  const inMemory = createInMemoryLimiter(config)

  const useUpstash = Boolean(
    process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN,
  )

  const isProduction = process.env.NODE_ENV === 'production'

  return {
    async check(ip: string): Promise<CheckResult> {
      if (useUpstash) {
        try {
          return await upstashCheck(config.name, ip, config.maxRequests, config.interval)
        } catch (err) {
          if (isProduction) {
            // Fail closed in production: Upstash down means we cannot enforce
            // distributed limits. Block the request temporarily (5s) rather
            // than bypassing the limiter on every lambda instance.
            console.error('[rate-limit] Upstash indisponivel em producao — bloqueando temporariamente:', err)
            return { success: false, remaining: 0, resetAt: Date.now() + 5_000 }
          }
          // In dev/test: fall back to in-memory so development is not blocked
          console.warn('[rate-limit] Upstash erro em dev — usando fallback em memoria:', err)
        }
      }
      return Promise.resolve(inMemory.check(ip))
    },
  }
}

// ---------------------------------------------------------------------------
// Pre-built limiters per endpoint with distinct thresholds
// ---------------------------------------------------------------------------

/** /api/agente — strict: AI calls cost money and resources */
export const agenteLimiter = createRateLimiter({
  name: 'agente',
  uniqueTokenPerInterval: 500,
  interval: 60_000, // 1-minute window
  maxRequests: 10,  // 10 AI calls / minute / IP
})

/** /api/busca — moderate: fast DB reads, but still guard against scraping */
export const buscaLimiter = createRateLimiter({
  name: 'busca',
  uniqueTokenPerInterval: 500,
  interval: 60_000,
  maxRequests: 60, // 60 search calls / minute / IP
})

/** /api/export — tight: CSV generation is expensive and data-exposure risk */
export const exportLimiter = createRateLimiter({
  name: 'export',
  uniqueTokenPerInterval: 200,
  interval: 60_000,
  maxRequests: 5, // 5 exports / minute / IP
})

// ---------------------------------------------------------------------------
// WhatsApp channel management limiters
// ---------------------------------------------------------------------------

/** /api/whatsapp/channels (CRUD) and connect/disconnect/status operations */
export const whatsappChannelLimiter = createRateLimiter({
  name: 'whatsapp-channel',
  uniqueTokenPerInterval: 500,
  interval: 60_000,
  maxRequests: 10, // 10 management ops / minute / IP
})

/** /api/whatsapp/channels/:id/send — message sending */
export const whatsappSendLimiter = createRateLimiter({
  name: 'whatsapp-send',
  uniqueTokenPerInterval: 500,
  interval: 60_000,
  maxRequests: 60, // 60 messages / minute / IP
})

/** /api/whatsapp/webhook/:provider/:channelId — inbound webhook from providers */
export const whatsappWebhookLimiter = createRateLimiter({
  name: 'whatsapp-webhook',
  uniqueTokenPerInterval: 1000,
  interval: 60_000,
  maxRequests: 500, // high limit — external provider traffic
})

/** /api/whatsapp/channels/:id/send-media — media file uploads and sends */
export const whatsappMediaLimiter = createRateLimiter({
  name: 'whatsapp-media',
  uniqueTokenPerInterval: 500,
  interval: 60_000,
  maxRequests: 20, // 20 media sends / minute / IP
})

/** /api/whatsapp/conversations — inbox conversation listing */
export const whatsappConversationLimiter = createRateLimiter({
  name: 'whatsapp-conversation',
  uniqueTokenPerInterval: 500,
  interval: 60_000,
  maxRequests: 60, // 60 conversation reads / minute / IP
})

/** /api/whatsapp/conversations/:id/messages — message thread reads */
export const whatsappInboxLimiter = createRateLimiter({
  name: 'whatsapp-inbox',
  uniqueTokenPerInterval: 500,
  interval: 60_000,
  maxRequests: 120, // 120 message fetches / minute / IP (frequent polling)
})

/** /api/whatsapp/keys — API key management (tight limit — bootstrap endpoint) */
export const whatsappKeysLimiter = createRateLimiter({
  name: 'whatsapp-keys',
  uniqueTokenPerInterval: 100,
  interval: 60_000,
  maxRequests: 5, // 5 key operations / minute / IP
})

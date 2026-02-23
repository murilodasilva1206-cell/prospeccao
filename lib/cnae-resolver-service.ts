// ---------------------------------------------------------------------------
// CnaeResolverService — 4-layer cascade for nicho → CNAE resolution.
//
// Resolution order (stops at first match):
//   1. LRU cache          — in-memory, 5-min TTL, zero latency
//   2. cnae_dictionary    — local DB table (resolveNichoCnaeDynamic)
//   3. IBGE CNAE API      — external search with timeout + circuit breaker
//   4. Persist discovery  — new mapping written back to cnae_dictionary
//
// The IBGE API is public and free; no API key required.
// Circuit breaker: 3 failures → OPEN for 60 seconds.
// ---------------------------------------------------------------------------

import { LRUCache } from 'lru-cache'
import type { Pool } from 'pg'
import { logger } from './logger'
import { CircuitBreaker } from './circuit-breaker'
import { resolveNichoCnaeDynamic, resolveNichoCnae } from './nicho-cnae'

const IBGE_CNAE_URL = 'https://servicodados.ibge.gov.br/api/v2/cnae/subclasses'
const IBGE_TIMEOUT_MS = 3_000 // 3-second hard timeout

interface IbgeSubclass {
  id: string         // e.g. "8630-5/04"
  descricao: string  // e.g. "Atividades Odontológicas"
}

const ibgeBreaker = new CircuitBreaker('ibge-cnae', {
  failureThreshold: 3,   // open after 3 consecutive failures
  successThreshold: 1,   // close after 1 success in HALF_OPEN
  timeout: 60_000,       // wait 60 seconds before probing
})

export class CnaeResolverService {
  private readonly cache: LRUCache<string, string>

  constructor(private readonly pool: Pool) {
    this.cache = new LRUCache<string, string>({
      max: 500,
      ttl: 5 * 60 * 1000, // 5 minutes
    })
  }

  /**
   * Resolves a nicho (free text) to a CNAE code through 4 layers.
   * Returns undefined only when all layers fail.
   */
  async resolve(nicho: string): Promise<string | undefined> {
    const normalized = nicho
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()

    if (!normalized) return undefined

    // Layer 1: LRU cache
    const cached = this.cache.get(normalized)
    if (cached !== undefined) return cached

    // Layer 2: cnae_dictionary (resolveNichoCnaeDynamic manages its own connection)
    const dynamic = await resolveNichoCnaeDynamic(normalized)
    if (dynamic) {
      this.cache.set(normalized, dynamic)
      return dynamic
    }

    // Layer 2b: static map fallback (resolveNichoCnae is synchronous)
    const staticResult = resolveNichoCnae(normalized)
    if (staticResult) {
      this.cache.set(normalized, staticResult)
      return staticResult
    }

    // Layer 3: IBGE CNAE API
    const ibgeResult = await this.queryIbge(normalized)
    if (!ibgeResult) return undefined

    // Layer 4: Persist new mapping to cnae_dictionary so it's available next time
    await this.persistToDictionary(normalized, ibgeResult.id, ibgeResult.descricao)

    this.cache.set(normalized, ibgeResult.id)
    return ibgeResult.id
  }

  private async queryIbge(query: string): Promise<IbgeSubclass | null> {
    try {
      const result = await ibgeBreaker.execute(async () => {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), IBGE_TIMEOUT_MS)

        try {
          const url = `${IBGE_CNAE_URL}?busca=${encodeURIComponent(query)}`
          const res = await fetch(url, {
            signal: controller.signal,
            headers: { Accept: 'application/json' },
          })

          if (!res.ok) {
            throw new Error(`IBGE CNAE API HTTP ${res.status}`)
          }

          const json = await res.json() as IbgeSubclass[]
          return Array.isArray(json) && json.length > 0 ? json[0] : null
        } finally {
          clearTimeout(timer)
        }
      })

      if (result) {
        logger.info({ query, cnae: result.id, descricao: result.descricao }, 'IBGE CNAE resolved')
      }
      return result
    } catch (err) {
      logger.warn({ query, err: err instanceof Error ? err.message : err }, 'IBGE CNAE lookup failed')
      return null
    }
  }

  private async persistToDictionary(
    nicho: string,
    codigo: string,
    descricao: string,
  ): Promise<void> {
    const client = await this.pool.connect()
    try {
      // Upsert: insert if not exists, otherwise append nicho to sinonimos array
      await client.query(
        `INSERT INTO cnae_dictionary (codigo, descricao, sinonimos)
         VALUES ($1, $2, ARRAY[$3]::TEXT[])
         ON CONFLICT (codigo) DO UPDATE
           SET sinonimos = CASE
             WHEN $3 = ANY(cnae_dictionary.sinonimos) THEN cnae_dictionary.sinonimos
             ELSE cnae_dictionary.sinonimos || ARRAY[$3]::TEXT[]
           END`,
        [codigo, descricao, nicho],
      )
      logger.info({ codigo, nicho }, 'CNAE dictionary updated from IBGE')
    } catch (err) {
      // Non-fatal: next request will re-query IBGE; the cached result still works
      logger.warn({ codigo, nicho, err }, 'Failed to persist CNAE to dictionary')
    } finally {
      client.release()
    }
  }
}

// Singleton — created lazily to avoid importing pool at module load time in tests
let _instance: CnaeResolverService | null = null

export function getCnaeResolverService(): CnaeResolverService {
  if (!_instance) {
    // Lazy import to avoid circular dependencies and allow test mocking
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pool = require('./database').default as Pool
    _instance = new CnaeResolverService(pool)
  }
  return _instance
}

/** @internal Reset singleton for test isolation */
export function _resetCnaeResolverService(): void {
  _instance = null
}

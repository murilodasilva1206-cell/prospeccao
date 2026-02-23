// ---------------------------------------------------------------------------
// Dynamic CNAE resolution — queries cnae_dictionary table (migration 011)
// with a short TTL in-memory cache to avoid per-request DB round-trips.
// ---------------------------------------------------------------------------

import { LRUCache } from 'lru-cache'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'

// Bounded LRU cache: at most 500 unique nicho strings, each entry lives 5 min.
// LRUCache handles both eviction (max) and expiry (ttl) automatically, so the
// Map never grows without limit.
const _dynamicCache = new LRUCache<string, string>({
  max: 500,
  ttl: 5 * 60 * 1000, // 5 minutes in ms
})

/**
 * Clears the in-memory CNAE cache.
 * @internal Exported only for test isolation — do not call in production code.
 */
export function _clearDynamicCacheForTesting(): void {
  _dynamicCache.clear()
}

/**
 * Resolves a nicho (free text) to a CNAE code by querying the `cnae_dictionary`
 * table.  Results are cached in memory for CACHE_TTL_MS to reduce DB load.
 *
 * Matching priority (deterministic — highest score wins):
 *   3 — Exact synonym match  : normalized nicho equals any element in `sinonimos`
 *   2 — Substring synonym    : nicho contains, or is contained by, a synonym
 *   1 — Description fuzzy   : normalized nicho appears inside `descricao` (ILIKE)
 *
 * Returns undefined if nothing matches or if the DB is unavailable (falls back
 * to the static NICHO_CNAE_MAP in the caller).
 */
export async function resolveNichoCnaeDynamic(nicho: string): Promise<string | undefined> {
  const normalized = nicho
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()

  if (!normalized) return undefined

  // Cache hit — LRUCache handles TTL expiry automatically
  const cached = _dynamicCache.get(normalized)
  if (cached !== undefined) return cached

  try {
    const client = await pool.connect()
    try {
      // Score each row by match quality so the result is deterministic for
      // ambiguous inputs: exact synonym (3) > substring synonym (2) > fuzzy
      // description (1).  Without ORDER BY, LIMIT 1 is non-deterministic.
      const { rows } = await client.query<{ codigo: string }>(
        `SELECT codigo,
                CASE
                  WHEN $1 = ANY(sinonimos) THEN 3
                  WHEN EXISTS (
                         SELECT 1 FROM unnest(sinonimos) AS s
                         WHERE $1 ILIKE ('%' || s || '%') OR s ILIKE ('%' || $1 || '%')
                       ) THEN 2
                  ELSE 1
                END AS score
         FROM cnae_dictionary
         WHERE $1 = ANY(sinonimos)
            OR EXISTS (
                 SELECT 1 FROM unnest(sinonimos) AS s
                 WHERE $1 ILIKE ('%' || s || '%') OR s ILIKE ('%' || $1 || '%')
               )
            OR descricao ILIKE $2
         ORDER BY score DESC, codigo ASC
         LIMIT 1`,
        [normalized, `%${normalized}%`],
      )
      if (rows.length > 0) {
        _dynamicCache.set(normalized, rows[0].codigo)
        return rows[0].codigo
      }
    } finally {
      client.release()
    }
  } catch (err) {
    // DB unavailable — warn so ops can diagnose, then let caller fall back to static map
    logger.warn(
      { nicho: normalized, err: err instanceof Error ? err.message : String(err) },
      'resolveNichoCnaeDynamic: DB lookup failed, falling back to static map',
    )
  }

  return undefined
}

// ---------------------------------------------------------------------------
// Mapeamento nicho de negócio → código CNAE principal
//
// Usado pelo agente: o AI pode retornar o campo `nicho` (texto livre) e a
// rota resolve para o código CNAE antes de executar a query no banco.
// ---------------------------------------------------------------------------

export const NICHO_CNAE_MAP: Record<string, string> = {
  // Saúde
  'clinicas odontologicas': '8630-5/04',
  'clinicas dentarias': '8630-5/04',
  'dentistas': '8630-5/04',
  'odontologia': '8630-5/04',
  'clinicas medicas': '8630-5/01',
  'medicos': '8630-5/01',
  'hospitais': '8610-1/01',
  'farmacias': '4771-7/01',
  'drogarias': '4771-7/01',
  'laboratorios': '8640-2/02',
  'fisioterapia': '8650-0/05',
  'psicologia': '8650-0/06',
  'nutricao': '8650-0/03',
  'veterinaria': '7500-1/00',
  'petshop': '4789-0/04',

  // Alimentação
  'restaurantes': '5611-2/01',
  'lanchonetes': '5611-2/03',
  'bares': '5611-2/04',
  'pizzarias': '5611-2/01',
  'padarias': '1091-1/02',
  'sorveterias': '5611-2/03',
  'cafeterias': '5611-2/03',
  'delivery': '5611-2/01',

  // Beleza e Estética
  'saloes de beleza': '9602-5/01',
  'cabeleireiros': '9602-5/01',
  'barbearias': '9602-5/02',
  'estetica': '9602-5/03',
  'manicure': '9602-5/01',
  'spa': '9609-2/08',

  // Fitness e Bem-Estar
  'academias': '9313-1/00',
  'pilates': '9313-1/00',
  'crossfit': '9313-1/00',
  'yoga': '9313-1/00',

  // Educação
  'escolas': '8511-2/00',
  'faculdades': '8532-5/00',
  'creches': '8511-2/00',
  'cursos': '8599-6/04',
  'cursinhos': '8599-6/04',
  'idiomas': '8599-6/04',

  // Tecnologia
  'software': '6201-5/01',
  'startups': '6201-5/01',
  'desenvolvimento web': '6201-5/01',
  'consultoria ti': '6204-0/00',
  'ecommerce': '4791-0/02',

  // Varejo
  'lojas de roupas': '4781-4/00',
  'moda': '4781-4/00',
  'calcados': '4782-2/01',
  'moveis': '4754-7/01',
  'eletronicos': '4752-1/00',

  // Construção e Imóveis
  'construtoras': '4120-4/00',
  'imobiliarias': '6821-8/02',
  'arquitetura': '7111-1/00',
  'engenharia': '7112-0/00',

  // Serviços
  'contabilidade': '6920-6/01',
  'advocacia': '6911-7/01',
  'marketing': '7319-0/02',
  'logistica': '4930-2/01',
  'transportes': '4921-3/02',
  'seguranca': '8011-1/01',
  'limpeza': '8121-4/00',

  // Automotivo
  'oficinas': '4520-0/01',
  'concessionarias': '4511-1/01',
  'auto pecas': '4530-7/03',
}

/**
 * Resolve a nicho (texto livre do usuário ou do AI) para um código CNAE.
 * Normaliza para minúsculas e remove acentos para maior tolerância.
 * Retorna undefined se não encontrar mapeamento.
 */
export function resolveNichoCnae(nicho: string): string | undefined {
  const normalized = nicho
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove diacritics
    .trim()

  // Exact match first — eslint-disable: normalized is a controlled internal string
  // eslint-disable-next-line security/detect-object-injection
  if (NICHO_CNAE_MAP[normalized]) return NICHO_CNAE_MAP[normalized]

  // Substring match (nicho contains or is contained by a key)
  for (const [key, cnae] of Object.entries(NICHO_CNAE_MAP)) {
    if (normalized.includes(key) || key.includes(normalized)) {
      return cnae
    }
  }

  return undefined
}

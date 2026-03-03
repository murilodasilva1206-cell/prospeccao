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
// Values are arrays because a single nicho may map to multiple CNAE subclasses.
const _dynamicCache = new LRUCache<string, string[]>({
  max: 500,
  ttl: 5 * 60 * 1000, // 5 minutes in ms
})

/**
 * Clears the in-memory CNAE dynamic-resolver cache.
 * @internal Exported only for test isolation — do not call in production code.
 */
export function _clearDynamicCacheForTesting(): void {
  _dynamicCache.clear()
}

/**
 * Resolves a nicho (free text) to one or more CNAE codes by querying the
 * `cnae_dictionary` table.  Results are cached in memory for 5 min.
 *
 * Returns up to 5 codes ordered by match quality, deduplicated by normalized
 * digits so '9602-5/01' and '9602501' count as the same entry.
 *
 * Matching priority (deterministic — highest score wins):
 *   3 — Exact synonym match  : normalized nicho equals any element in `sinonimos`
 *   2 — Substring synonym    : nicho contains, or is contained by, a synonym
 *   1 — Description fuzzy   : normalized nicho appears inside `descricao` (ILIKE)
 *
 * Returns undefined if nothing matches or if the DB is unavailable (falls back
 * to the static NICHO_CNAE_MAP in the caller).
 */
export async function resolveNichoCnaeDynamic(nicho: string): Promise<string[] | undefined> {
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
      // Score each row by match quality so ORDER BY is deterministic.
      // LIMIT 5: return the top N candidates so callers can use = ANY() with the
      // full set rather than betting on a single best-guess code.
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
         LIMIT 5`,
        [normalized, `%${normalized}%`],
      )
      if (rows.length > 0) {
        // Deduplicate by digit-normalized code so '9602-5/01' and '9602501' are
        // treated as the same entry.
        const seen = new Set<string>()
        const codes: string[] = []
        for (const row of rows) {
          const key = row.codigo.replace(/[^0-9]/g, '')
          if (key && !seen.has(key)) {
            seen.add(key)
            codes.push(row.codigo)
          }
        }
        _dynamicCache.set(normalized, codes)
        return codes
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

// Values are either a single CNAE code or an array when a niche maps to
// multiple subclasses (e.g. "estética" covers salão + barbearia + esteticista).
// The resolver wraps single strings into arrays before returning so callers
// always receive string[].
export const NICHO_CNAE_MAP: Record<string, string | string[]> = {
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

  // Beleza e Estética — múltiplos subclasses cobertos pela busca
  'saloes de beleza': ['9602-5/01', '9602-5/02', '9602-5/03'],
  'cabeleireiros': '9602-5/01',
  'barbearias': '9602-5/02',
  'estetica': ['9602-5/01', '9602-5/02', '9602-5/03'],
  'esteticistas': '9602-5/03',
  'manicure': '9602-5/01',
  'spa': '9609-2/08',

  // Fitness e Bem-Estar
  'academias': '9313-1/00',
  'pilates': '9313-1/00',
  'crossfit': '9313-1/00',
  'yoga': '9313-1/00',

  // Educação
  'escolas': ['8511-2/00', '8512-1/00', '8513-9/00'],
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
 * Resolve a nicho (texto livre do usuário ou do AI) para um ou mais códigos CNAE.
 * Normaliza para minúsculas e remove acentos para maior tolerância.
 * Retorna undefined se não encontrar mapeamento.
 * Retorna string[] — sempre array, mesmo para nichos de código único.
 */
export function resolveNichoCnae(nicho: string): string[] | undefined {
  const normalized = nicho
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove diacritics
    .trim()

  // Exact match first — eslint-disable: normalized is a controlled internal string
  // eslint-disable-next-line security/detect-object-injection
  const exactMatch = NICHO_CNAE_MAP[normalized]
  if (exactMatch) return Array.isArray(exactMatch) ? exactMatch : [exactMatch]

  // Substring match (nicho contains or is contained by a key)
  for (const [key, cnae] of Object.entries(NICHO_CNAE_MAP)) {
    if (normalized.includes(key) || key.includes(normalized)) {
      return Array.isArray(cnae) ? cnae : [cnae]
    }
  }

  return undefined
}

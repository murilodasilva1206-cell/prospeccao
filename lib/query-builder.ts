import type { BuscaQuery } from './schemas'

interface QueryResult {
  text: string
  values: unknown[]
}

// ---------------------------------------------------------------------------
// SECURITY CONTRACT: All user-supplied values use $N parameterized placeholders.
// The only fields interpolated directly into SQL text are `orderBy`, `orderDir`,
// and TABLE — all are either z.enum()-validated or a hardcoded constant.
// 'contato_priority' is a virtual sentinel handled as a CASE expression here,
// never passed as a raw column name into SQL.
// ---------------------------------------------------------------------------

// Single source of truth for the table name — change here if the DB schema evolves.
const TABLE = 'cnpj_completo'

// Table columns used here:
//   cnpj_completo, razao_social, nome_fantasia, uf, municipio,
//   cnae_principal (digits only in the DB, e.g. '8630504'),
//   situacao_cadastral (RF numeric code: '01'–'08'),
//   ddd1, ddd2 (aliased as telefone1/telefone2 — no separate telefoneN column),
//   correio_eletronico,
//   tem_telefone (boolean), tem_email (boolean)

// ---------------------------------------------------------------------------
// CountFilters — filters relevant for COUNT(*); no pagination / ordering needed.
// cnae_codes supports multi-code nicho resolution (e.g. "estética" → 3 codes).
// ---------------------------------------------------------------------------
export type CountFilters = Partial<
  Pick<
    BuscaQuery,
    'uf' | 'municipio' | 'cnae_principal' | 'nicho' | 'situacao_cadastral' | 'tem_telefone' | 'tem_email'
  >
> & { cnae_codes?: string[] }

// Extended type for the full search query — adds cnae_codes from multi-code resolution.
export type ExtendedBuscaQuery = BuscaQuery & { cnae_codes?: string[] }

const NUMERIC_RE = /^\d+$/

function buildConditions(
  filters: CountFilters,
): { conditions: string[]; values: unknown[] } {
  const conditions: string[] = []
  const values: unknown[] = []
  let paramIndex = 1

  if (filters.uf) {
    conditions.push(`uf = $${paramIndex}`) // exact 2-letter state code
    values.push(filters.uf)
    paramIndex++
  }

  if (filters.municipio) {
    if (NUMERIC_RE.test(filters.municipio)) {
      // Resolver already converted the name to a numeric codigo_rf → exact match.
      // This uses idx_cnpj_municipio (pending) or a seq scan filtered by uf.
      conditions.push(`municipio = $${paramIndex}`)
      values.push(filters.municipio)
    } else {
      // Text fallback (resolver not used or mapeamento_municipios not available).
      // Uses idx_cnpj_municipio_trgm GIN index (migration 018).
      conditions.push(`municipio ILIKE $${paramIndex}`)
      values.push(`%${filters.municipio}%`)
    }
    paramIndex++
  }

  if (filters.cnae_codes && filters.cnae_codes.length > 0) {
    // Multi-code nicho resolution (e.g. "estética" → ['9602-5/01','9602-5/02','9602-5/03']).
    // Strip non-digits from each code here so the SQL uses a pre-normalised array
    // on the right-hand side of the = ANY() expression.
    const normalized = filters.cnae_codes.map((c) => c.replace(/[^0-9]/g, ''))
    conditions.push(
      `regexp_replace(cnae_principal, '[^0-9]', '', 'g') = ANY($${paramIndex}::text[])`,
    )
    values.push(normalized)
    paramIndex++
  } else if (filters.cnae_principal) {
    // Single code (user input or single-result nicho resolution) — partial ILIKE.
    // Normalise both stored code and user input by stripping non-digits so that
    // '8630-5/04', '8630504', and '863050/4' all resolve to the same digits and
    // match the same records. The $N parameter holds the raw user value; the
    // regexp_replace is applied to both sides inside PostgreSQL.
    conditions.push(
      `regexp_replace(cnae_principal, '[^0-9]', '', 'g') ILIKE '%' || regexp_replace($${paramIndex}::text, '[^0-9]', '', 'g') || '%'`,
    )
    values.push(filters.cnae_principal)
    paramIndex++
  }

  if (filters.situacao_cadastral) {
    conditions.push(`situacao_cadastral = $${paramIndex}`) // exact RF numeric code ('02', etc.)
    values.push(filters.situacao_cadastral)
    paramIndex++
  }

  // tem_telefone and tem_email are dedicated boolean columns in the RF schema
  if (filters.tem_telefone === true) {
    conditions.push(`tem_telefone = true`)
  }
  if (filters.tem_telefone === false) {
    conditions.push(`tem_telefone = false`)
  }

  if (filters.tem_email === true) {
    conditions.push(`tem_email = true`)
  }
  if (filters.tem_email === false) {
    conditions.push(`tem_email = false`)
  }

  return { conditions, values }
}

export function buildContactsQuery(filters: ExtendedBuscaQuery): QueryResult {
  const { conditions, values } = buildConditions(filters)

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  // orderBy is z.enum() validated — safe to interpolate.
  // 'contato_priority' maps to boolean column sort (DESC) — index-friendly.
  // cnpj_completo (PK, unique) is appended as a stable tiebreaker on every ordering
  // so OFFSET-based pagination is deterministic even when primary sort keys tie.
  const orderExpression =
    filters.orderBy === 'contato_priority'
      ? `tem_telefone DESC, tem_email DESC, razao_social ${filters.orderDir}, cnpj_completo ASC`
      : `${filters.orderBy} ${filters.orderDir}, cnpj_completo ASC`
  const orderClause = `ORDER BY ${orderExpression}`

  const offset = (filters.page - 1) * filters.limit
  const paramIndex = values.length + 1

  // LIMIT and OFFSET are also parameterized.
  // ddd1/ddd2 aliased as telefone1/telefone2 — the RF schema has no separate
  // telefoneN column; the area code (DDD) and number are stored in separate fields.
  const text = `
    SELECT
      cnpj_completo,
      razao_social,
      nome_fantasia,
      uf,
      municipio,
      cnae_principal,
      situacao_cadastral,
      ddd1::text AS telefone1,
      ddd2::text AS telefone2,
      correio_eletronico
    FROM ${TABLE}
    ${where}
    ${orderClause}
    LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
  `

  values.push(filters.limit, offset)

  return { text, values }
}

export function buildCountQuery(filters: CountFilters): QueryResult {
  const { conditions, values } = buildConditions(filters)

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  return {
    text: `SELECT COUNT(*) AS total FROM ${TABLE} ${where}`,
    values,
  }
}

import type { BuscaQuery } from './schemas'

interface QueryResult {
  text: string
  values: unknown[]
}

// ---------------------------------------------------------------------------
// SECURITY CONTRACT: All user-supplied values use $N parameterized placeholders.
// The only fields interpolated directly into SQL text are `orderBy` and `orderDir`,
// which are validated against a z.enum() whitelist in the schema — they can
// never be arbitrary user strings. SQL identifiers cannot be parameterized.
// 'contato_priority' is a virtual sentinel handled as a CASE expression here,
// never passed as a raw column name into SQL.
// ---------------------------------------------------------------------------

// Table: cnpj_completo (Receita Federal public CNPJ registry)
// Relevant columns: cnpj_completo, razao_social, nome_fantasia, uf, municipio,
//   cnae_principal, situacao_cadastral, telefone1, telefone2, correio_eletronico

// CountFilters — all filter fields optional; pagination/ordering not needed for COUNT
export type CountFilters = Partial<
  Pick<
    BuscaQuery,
    'uf' | 'municipio' | 'cnae_principal' | 'nicho' | 'situacao_cadastral' | 'tem_telefone' | 'tem_email'
  >
>

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
    conditions.push(`municipio ILIKE $${paramIndex}`)
    values.push(`%${filters.municipio}%`) // wildcard added server-side
    paramIndex++
  }
  if (filters.cnae_principal) {
    conditions.push(`cnae_principal = $${paramIndex}`) // exact CNAE code
    values.push(filters.cnae_principal)
    paramIndex++
  }
  if (filters.situacao_cadastral) {
    conditions.push(`situacao_cadastral = $${paramIndex}`)
    values.push(filters.situacao_cadastral)
    paramIndex++
  }

  // telefone1 OR telefone2 — either field satisfies "has phone"
  if (filters.tem_telefone === true) {
    conditions.push(
      `(telefone1 IS NOT NULL AND telefone1 <> '') OR (telefone2 IS NOT NULL AND telefone2 <> '')`,
    )
  }
  if (filters.tem_telefone === false) {
    conditions.push(
      `(telefone1 IS NULL OR telefone1 = '') AND (telefone2 IS NULL OR telefone2 = '')`,
    )
  }

  if (filters.tem_email === true) {
    conditions.push(`correio_eletronico IS NOT NULL AND correio_eletronico <> ''`)
  }
  if (filters.tem_email === false) {
    conditions.push(`(correio_eletronico IS NULL OR correio_eletronico = '')`)
  }

  return { conditions, values }
}

export function buildContactsQuery(filters: BuscaQuery): QueryResult {
  const { conditions, values } = buildConditions(filters)

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  // orderBy is z.enum() validated — safe to interpolate.
  // 'contato_priority' uses a CASE expression (not a column name) so it never
  // reaches the database as an arbitrary identifier.
  // cnpj_completo (PK, unique) is appended as a stable tiebreaker on every ordering
  // so OFFSET-based pagination is deterministic even when primary sort keys tie.
  const orderExpression =
    filters.orderBy === 'contato_priority'
      ? `(CASE WHEN (telefone1 IS NOT NULL AND telefone1 <> '') OR (telefone2 IS NOT NULL AND telefone2 <> '') THEN 0 ELSE 1 END) ASC, (CASE WHEN correio_eletronico IS NOT NULL AND correio_eletronico <> '' THEN 0 ELSE 1 END) ASC, razao_social ${filters.orderDir}, cnpj_completo ASC`
      : `${filters.orderBy} ${filters.orderDir}, cnpj_completo ASC`
  const orderClause = `ORDER BY ${orderExpression}`

  const offset = (filters.page - 1) * filters.limit
  const paramIndex = values.length + 1

  // LIMIT and OFFSET are also parameterized
  const text = `
    SELECT
      cnpj_completo,
      razao_social,
      nome_fantasia,
      uf,
      municipio,
      cnae_principal,
      situacao_cadastral,
      telefone1,
      telefone2,
      correio_eletronico
    FROM cnpj_completo
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
    text: `SELECT COUNT(*) AS total FROM cnpj_completo ${where}`,
    values,
  }
}

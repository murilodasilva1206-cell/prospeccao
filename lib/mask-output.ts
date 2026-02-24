// ---------------------------------------------------------------------------
// Output masking — explicit allow-list of fields returned to API consumers.
//
// If the database table gains new columns they are NOT exposed automatically.
// The caller must add them here explicitly after a deliberate review of
// privacy and exposure implications.
//
// Note: telefone1, telefone2, correio_eletronico are included because this
// product's purpose is B2B prospecting using the PUBLIC Receita Federal CNPJ
// registry — these fields are public data, not PII in this context.
// ---------------------------------------------------------------------------

/** Raw row from cnpj_completo table as returned by pg */
export interface EmpresaRow {
  cnpj_completo: string
  razao_social: string
  nome_fantasia: string | null
  uf: string
  municipio: string
  cnae_principal: string
  situacao_cadastral: string
  telefone1: string | null
  telefone2: string | null
  correio_eletronico: string | null
}

/** Shape returned to API consumers */
export interface PublicEmpresa {
  cnpj: string
  razaoSocial: string
  nomeFantasia: string
  uf: string
  municipio: string
  cnaePrincipal: string
  situacao: string
  telefone1: string
  telefone2: string
  email: string
}

/**
 * Maps a database row to the public-safe shape.
 * Only exposes fields in the explicit allow-list above.
 */
export function maskContact(row: EmpresaRow): PublicEmpresa {
  return {
    cnpj: row.cnpj_completo,
    razaoSocial: row.razao_social,
    nomeFantasia: row.nome_fantasia ?? '',
    uf: row.uf,
    municipio: row.municipio,
    cnaePrincipal: row.cnae_principal,
    situacao: row.situacao_cadastral,
    telefone1: row.telefone1 ?? '',
    telefone2: row.telefone2 ?? '',
    email: row.correio_eletronico ?? '',
  }
}

// Keep backwards-compatible alias so export route stays clean
export type { PublicEmpresa as PublicContact }

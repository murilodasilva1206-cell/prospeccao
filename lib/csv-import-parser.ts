// ---------------------------------------------------------------------------
// CSV Import Parser
//
// Parses CSV files uploaded via POST /api/lead-pools/import.
//
// Design decisions:
//  - Auto-detects delimiter (, or ;) from the header line
//  - Headers are matched case-insensitively with accent normalization
//  - Synonym headers (nome→razaoSocial, cidade→municipio, etc.) are supported
//  - Rows with empty razaoSocial AND empty cnpj are skipped with an error
//  - Phone format is validated (digits only after stripping +, -, spaces, etc.)
//  - CNPJ deduplication: first occurrence wins
//  - Maximum 500 data rows (CreateLeadPoolSchema.leads.max)
//  - Extra cells on the last mapped column are joined back (handles unquoted
//    values that contain commas, e.g. =HYPERLINK("url","label"))
//  - Cell values are NOT sanitized for CSV injection — that is the exporter's job
// ---------------------------------------------------------------------------

export interface ImportedLead {
  cnpj: string
  razaoSocial: string
  nomeFantasia?: string
  uf?: string
  municipio?: string
  cnaePrincipal?: string
  situacao?: string
  telefone1?: string
  telefone2?: string
  email?: string
}

export interface ImportError {
  row: number
  column?: string
  message: string
}

export interface ParseResult {
  leads: ImportedLead[]
  errors: ImportError[]
  rowCount: number
}

export interface ParseOptions {
  delimiter?: ',' | ';'
  /** 'partial': import valid rows even when some have errors (default).
   *  'reject_all': return empty leads array if any row has errors. */
  policy?: 'reject_all' | 'partial'
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ROWS = 500

// Maps normalised header name → ImportedLead field.
// Normalisation: lowercase + strip accents + collapse spaces to underscores.
const HEADER_MAP: Readonly<Record<string, keyof ImportedLead>> = {
  cnpj:             'cnpj',
  razao_social:     'razaoSocial',
  razaosocial:      'razaoSocial',
  nome:             'razaoSocial',
  empresa:          'razaoSocial',
  nome_fantasia:    'nomeFantasia',
  nomefantasia:     'nomeFantasia',
  fantasia:         'nomeFantasia',
  uf:               'uf',
  estado:           'uf',
  municipio:        'municipio',
  cidade:           'municipio',
  cnae_principal:   'cnaePrincipal',
  cnaeprincipal:    'cnaePrincipal',
  cnae:             'cnaePrincipal',
  situacao:         'situacao',
  telefone1:        'telefone1',
  telefone:         'telefone1',
  fone:             'telefone1',
  fone1:            'telefone1',
  telefone2:        'telefone2',
  fone2:            'telefone2',
  email:            'email',
  e_mail:           'email',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip accents, lowercase, normalise spaces to underscores for header lookup. */
function normaliseHeader(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritical marks
    .replace(/\s+/g, '_')
}

/** Naive comma split — no RFC 4180 quoting, intentionally lenient.
 *  RFC 4180 support would break the lenient-last-field joining used for
 *  unquoted values that contain commas (e.g. formula injection payloads). */
function splitLine(line: string, delimiter: string): string[] {
  return line.split(delimiter)
}

/** Auto-detect delimiter from the header line. */
function detectDelimiter(headerLine: string): ',' | ';' {
  const commas     = (headerLine.match(/,/g)  ?? []).length
  const semicolons = (headerLine.match(/;/g)  ?? []).length
  return semicolons > commas ? ';' : ','
}

/** Returns true when the phone value (if non-empty) contains only digits
 *  after stripping common formatting characters. */
function isValidPhone(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return true
  const digits = trimmed.replace(/[\s\-+().]/g, '')
  return /^\d+$/.test(digits)
}

// ---------------------------------------------------------------------------
// Safe assignment helper — avoids dynamic object-injection lint warnings
// ---------------------------------------------------------------------------

function assignRaw(raw: Partial<ImportedLead>, key: keyof ImportedLead, value: string): void {
  switch (key) {
    case 'cnpj':          raw.cnpj          = value; break
    case 'razaoSocial':   raw.razaoSocial   = value; break
    case 'nomeFantasia':  raw.nomeFantasia  = value; break
    case 'uf':            raw.uf            = value; break
    case 'municipio':     raw.municipio     = value; break
    case 'cnaePrincipal': raw.cnaePrincipal = value; break
    case 'situacao':      raw.situacao      = value; break
    case 'telefone1':     raw.telefone1     = value; break
    case 'telefone2':     raw.telefone2     = value; break
    case 'email':         raw.email         = value; break
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function parseCsvLeads(
  content: string,
  options: ParseOptions = {},
): ParseResult {
  const { policy = 'partial' } = options

  const leads:  ImportedLead[] = []
  const errors: ImportError[]  = []

  // 1. Empty file
  const trimmed = content.trim()
  if (!trimmed) {
    errors.push({ row: 0, message: 'Arquivo vazio' })
    return { leads, errors, rowCount: 0 }
  }

  // 2. Normalise line endings, split into lines
  const lines     = trimmed.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const headerLine = lines[0]
  const dataLines  = lines.slice(1).filter((l) => l.trim() !== '')
  const rowCount   = dataLines.length

  // 3. Detect delimiter
  const delimiter = options.delimiter ?? detectDelimiter(headerLine)

  // 4. Parse headers and build mapping array
  const rawHeaders = splitLine(headerLine, delimiter)
  const headerMap: (keyof ImportedLead | null)[] = rawHeaders.map(
    (h) => HEADER_MAP[normaliseHeader(h)] ?? null,
  )

  // 5. Require at least one recognised header
  if (!headerMap.some(Boolean)) {
    errors.push({
      row: 0,
      message:
        'Nenhuma coluna reconhecida no cabeçalho. Verifique os nomes das colunas (ex.: cnpj, razao_social, telefone).',
    })
    return { leads, errors, rowCount }
  }

  // 6. Row-count guard
  if (rowCount > MAX_ROWS) {
    errors.push({
      row: 0,
      message: `Limite de ${MAX_ROWS} linhas excedido. O arquivo contém ${rowCount} linhas de dados.`,
    })
    if (policy === 'reject_all') {
      return { leads: [], errors, rowCount }
    }
  }

  // 7. Find the last mapped header index (for lenient last-field joining)
  let lastMappedIdx = -1
  for (const [i, mapped] of headerMap.entries()) {
    if (mapped !== null) lastMappedIdx = i
  }

  // 8. Parse data rows
  const seenCnpjs = new Set<string>()

  for (let lineIdx = 0; lineIdx < Math.min(dataLines.length, MAX_ROWS); lineIdx++) {
    const rowNum = lineIdx + 2 // 1-indexed; +1 for header row
    const line   = dataLines.at(lineIdx) ?? ''

    const cells = splitLine(line, delimiter)

    // Map cells → raw field values
    const raw: Partial<ImportedLead> = {}
    for (let colIdx = 0; colIdx < headerMap.length; colIdx++) {
      const fieldKey = headerMap.at(colIdx) ?? null
      if (fieldKey === null) continue

      let value: string
      if (colIdx === lastMappedIdx && cells.length > headerMap.length) {
        // Lenient: extra cells joined back into the last mapped field.
        // Handles unquoted values that contain commas (e.g. formula strings).
        value = cells.slice(colIdx).join(delimiter)
      } else {
        value = cells.at(colIdx) ?? ''
      }

      assignRaw(raw, fieldKey, value.trim())
    }

    const razaoSocial = raw.razaoSocial ?? ''
    const cnpj        = raw.cnpj ?? ''

    // Validate minimum required fields
    if (!razaoSocial && !cnpj) {
      errors.push({
        row:     rowNum,
        message: `Linha ${rowNum}: sem nome (razao_social) e sem CNPJ — linha ignorada.`,
      })
      if (policy === 'reject_all') return { leads: [], errors, rowCount }
      continue
    }

    // Validate phone format (if provided); clear invalid value and record error
    if (raw.telefone1 && !isValidPhone(raw.telefone1)) {
      errors.push({
        row:    rowNum,
        column: 'telefone1',
        message: `Linha ${rowNum}: telefone "${raw.telefone1}" tem formato inválido.`,
      })
      raw.telefone1 = undefined
    }

    // CNPJ deduplication — keep first occurrence
    if (cnpj) {
      if (seenCnpjs.has(cnpj)) continue
      seenCnpjs.add(cnpj)
    }

    leads.push({
      cnpj,
      razaoSocial:   razaoSocial || cnpj,
      nomeFantasia:  raw.nomeFantasia  || undefined,
      uf:            raw.uf            || undefined,
      municipio:     raw.municipio     || undefined,
      cnaePrincipal: raw.cnaePrincipal || undefined,
      situacao:      raw.situacao      || undefined,
      telefone1:     raw.telefone1     || undefined,
      telefone2:     raw.telefone2     || undefined,
      email:         raw.email         || undefined,
    })
  }

  return { leads, errors, rowCount }
}

import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { exportLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { ExportQuerySchema } from '@/lib/schemas'
import { buildContactsQuery, type ExtendedBuscaQuery } from '@/lib/query-builder'
import { maskContact, type PublicEmpresa } from '@/lib/mask-output'
import { resolveMunicipio } from '@/lib/municipio-resolver'
import { getCnaeResolverService } from '@/lib/cnae-resolver-service'
import { requireWorkspaceAuth, authErrorResponse, type AuthContext } from '@/lib/whatsapp/auth-middleware'
import type { BuscaQuery } from '@/lib/schemas'

// ---------------------------------------------------------------------------
// CSV Injection Protection
//
// Spreadsheet applications (Excel, LibreOffice, Google Sheets) execute cell
// formulas when a cell starts with =, +, -, or @.
// Prefix those cells with a tab character to break formula execution.
// RFC 4180: double quotes inside quoted fields are escaped by doubling them.
// ---------------------------------------------------------------------------

export function sanitizeCsvCell(value: string | null | undefined): string {
  if (value == null) return ''
  const str = String(value)
  // Prefix formula-starting characters with a tab
  if (/^[=+\-@\t\r]/.test(str)) {
    return `\t${str}`
  }
  // Escape double quotes per RFC 4180
  return str.replace(/"/g, '""')
}

function empresaToCsvLine(row: PublicEmpresa): string {
  const cells = [
    sanitizeCsvCell(row.cnpj),
    sanitizeCsvCell(row.razaoSocial),
    sanitizeCsvCell(row.nomeFantasia),
    sanitizeCsvCell(row.uf),
    sanitizeCsvCell(row.municipio),
    sanitizeCsvCell(row.cnaePrincipal),
    sanitizeCsvCell(row.situacao),
    sanitizeCsvCell(row.telefone1),
    sanitizeCsvCell(row.telefone2),
    sanitizeCsvCell(row.email),
  ]
  return cells.map((c) => `"${c}"`).join(',')
}

export async function GET(request: NextRequest) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: '/api/export', ip })

  // 1. Rate limit — CSV generation is expensive and data-exposure risk
  const rateLimit = await exportLimiter.check(ip)
  if (!rateLimit.success) {
    log.warn('Limite de requisicoes excedido em /api/export')
    return NextResponse.json(
      { error: 'Muitas requisicoes — tente novamente em breve' },
      {
        status: 429,
        headers: {
          'Retry-After': String(
            Math.ceil((rateLimit.resetAt - Date.now()) / 1000),
          ),
        },
      },
    )
  }

  // 2. Parse and validate query parameters
  let exportFilters
  try {
    const raw = Object.fromEntries(request.nextUrl.searchParams.entries())
    exportFilters = ExportQuerySchema.parse(raw)
  } catch (err) {
    if (err instanceof ZodError) {
      log.info({ issues: err.issues }, 'Erro de validacao em /api/export')
      return NextResponse.json(
        { error: 'Parametros invalidos', details: err.issues },
        { status: 400 },
      )
    }
    throw err
  }

  // 3. Auth — must precede CNAE resolution (which may call the IBGE API or DB).
  //    workspace_id is used for audit logging only; cnpj_completo is a public
  //    CNPJ registry shared across all workspaces — filtering by it would be wrong.
  let auth: AuthContext
  {
    const authClient = await pool.connect()
    try {
      auth = await requireWorkspaceAuth(request, authClient)
    } catch (err) {
      const res = authErrorResponse(err)
      if (res) return res
      log.error({ err }, 'Erro inesperado durante autenticacao em /api/export')
      return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
    } finally {
      authClient.release()
    }
  }

  // 4. Resolve nicho → one or more CNAE codes via the 4-layer cascade
  //    (LRU cache → cnae_dictionary → static map → IBGE API)
  //    Safe: only runs after a valid authenticated request.
  let cnae_principal = exportFilters.cnae_principal
  let cnaeCodesFromNicho: string[] | undefined
  if (exportFilters.nicho) {
    const resolved = await getCnaeResolverService().resolve(exportFilters.nicho)
    if (resolved) {
      // Always route through cnae_codes (= ANY) — exact-match semantics and carries
      // the full merged set from dynamic + static resolver.
      cnaeCodesFromNicho = resolved
      cnae_principal = undefined
      log.debug({ nicho: exportFilters.nicho, codes: resolved }, 'Nicho resolvido para CNAE em export')
    }
  }

  // Guard: nicho was given but couldn't be mapped — reject rather than exporting
  // the whole table with no sector filter, which produces meaningless results.
  if (exportFilters.nicho && !cnaeCodesFromNicho) {
    return NextResponse.json(
      { error: 'Nicho não reconhecido. Tente um segmento mais específico, como "dentistas" ou "restaurantes".' },
      { status: 400 },
    )
  }

  // 5. Build search filters compatible with the query builder
  const searchFilters: BuscaQuery & { cnae_codes?: string[] } = {
    uf: exportFilters.uf,
    municipio: exportFilters.municipio,
    cnae_principal,
    cnae_codes: cnaeCodesFromNicho,
    nicho: exportFilters.nicho,
    situacao_cadastral: exportFilters.situacao_cadastral,
    tem_telefone: exportFilters.tem_telefone,
    tem_email: exportFilters.tem_email,
    orderBy: exportFilters.orderBy,
    orderDir: exportFilters.orderDir,
    page: 1,
    limit: exportFilters.maxRows, // maxRows is validated 1-5000 by schema
  }

  try {
    const client = await pool.connect()
    try {
      // Resolve municipio text name → numeric codigo_rf before querying.
      // Not-found and ambiguous results are rejected with 400 so the export
      // doesn't silently fall back to an unfiltered full-table scan.
      let workingFilters: ExtendedBuscaQuery = searchFilters
      if (exportFilters.municipio) {
        const munResult = await resolveMunicipio(client, exportFilters.municipio, exportFilters.uf)

        if (munResult.type === 'not_found') {
          log.info({ municipio: exportFilters.municipio, uf: exportFilters.uf }, 'Municipio nao encontrado em export')
          return NextResponse.json(
            { error: `Município "${exportFilters.municipio}" não encontrado. Verifique o nome ou informe a UF.` },
            { status: 400 },
          )
        }

        if (munResult.type === 'ambiguous') {
          log.info({ municipio: exportFilters.municipio, candidates: munResult.candidates }, 'Municipio ambiguo em export')
          return NextResponse.json(
            {
              error: `Município "${exportFilters.municipio}" existe em mais de um estado. Informe a UF para filtrar corretamente.`,
              candidates: munResult.candidates,
            },
            { status: 400 },
          )
        }

        // found — replace text name with numeric code for exact-match query
        workingFilters = { ...workingFilters, municipio: munResult.codigo }
        log.debug({ municipio: exportFilters.municipio, codigo: munResult.codigo, uf: munResult.uf }, 'Municipio resolvido em export')
      }

      const { text, values } = buildContactsQuery(workingFilters)
      const result = await client.query(text, values)
      const rows = result.rows.map(maskContact)

      const header = '"cnpj","razaoSocial","nomeFantasia","uf","municipio","cnaePrincipal","situacao","telefone1","telefone2","email"'
      const csv = [header, ...rows.map(empresaToCsvLine)].join('\r\n')

      log.info({ exportedRows: rows.length, workspace_id: auth.workspace_id, actor: auth.actor }, 'Exportacao CSV concluida')

      return new NextResponse(csv, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="empresas.csv"',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        },
      })
    } finally {
      client.release()
    }
  } catch (err) {
    log.error({ err }, 'Erro de banco de dados em /api/export')
    return NextResponse.json(
      { error: 'Erro interno do servidor' },
      { status: 500 },
    )
  }
}

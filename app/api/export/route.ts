import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { exportLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { ExportQuerySchema } from '@/lib/schemas'
import { buildContactsQuery } from '@/lib/query-builder'
import { maskContact, type PublicEmpresa } from '@/lib/mask-output'
import { resolveNichoCnae } from '@/lib/nicho-cnae'
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

  // 3. Resolve nicho -> cnae_principal if not explicitly provided
  let cnae_principal = exportFilters.cnae_principal
  if (exportFilters.nicho && !cnae_principal) {
    const resolved = resolveNichoCnae(exportFilters.nicho)
    if (resolved) {
      cnae_principal = resolved
      log.debug({ nicho: exportFilters.nicho, cnae: resolved }, 'Nicho resolvido para CNAE em export')
    }
  }

  // 4. Build search filters compatible with the query builder
  const searchFilters: BuscaQuery = {
    uf: exportFilters.uf,
    municipio: exportFilters.municipio,
    cnae_principal,
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
      const { text, values } = buildContactsQuery(searchFilters)
      const result = await client.query(text, values)
      const rows = result.rows.map(maskContact)

      const header = '"cnpj","razaoSocial","nomeFantasia","uf","municipio","cnaePrincipal","situacao","telefone1","telefone2","email"'
      const csv = [header, ...rows.map(empresaToCsvLine)].join('\r\n')

      log.info({ exportedRows: rows.length }, 'Exportacao CSV concluida')

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

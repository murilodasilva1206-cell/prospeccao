// GET /api/lead-pools/:id/export
//
// Exports a lead pool as a CSV file.
//
// Returns 200 with text/csv body and Content-Disposition: attachment.

import { NextRequest, NextResponse } from 'next/server'
import { z }                         from 'zod'
import pool                          from '@/lib/database'
import { logger }                    from '@/lib/logger'
import { exportLimiter }             from '@/lib/rate-limit'
import { getClientIp }               from '@/lib/get-ip'
import { requireWorkspaceAuth, authErrorResponse } from '@/lib/whatsapp/auth-middleware'
import { checkWorkspaceFeature, auditBlockedFeature } from '@/lib/entitlement'
import { findLeadPoolById }          from '@/lib/lead-pool-repo'
import type { PublicEmpresa }        from '@/lib/mask-output'

// Strict UUID schema (only hex chars, no uppercase)
const UUIDSchema = z.string().uuid()

// ---------------------------------------------------------------------------
// CSV injection protection (inline — matches app/api/export/route.ts)
// ---------------------------------------------------------------------------

function sanitizeCsvCell(value: string | null | undefined): string {
  if (value == null) return ''
  const str = String(value)
  if (/^[=+\-@\t\r]/.test(str)) return `\t${str}`
  // Wrap in double-quotes if value contains comma, newline, or double-quote
  if (str.includes(',') || str.includes('\n') || str.includes('"')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

const CSV_HEADER = 'cnpj,razaoSocial,nomeFantasia,uf,municipio,cnaePrincipal,situacao,telefone1,telefone2,email'

function rowToCsvLine(lead: PublicEmpresa): string {
  return [
    sanitizeCsvCell(lead.cnpj),
    sanitizeCsvCell(lead.razaoSocial),
    sanitizeCsvCell(lead.nomeFantasia),
    sanitizeCsvCell(lead.uf),
    sanitizeCsvCell(lead.municipio),
    sanitizeCsvCell(lead.cnaePrincipal),
    sanitizeCsvCell(lead.situacao),
    sanitizeCsvCell(lead.telefone1),
    sanitizeCsvCell(lead.telefone2),
    sanitizeCsvCell(lead.email),
  ].join(',')
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = crypto.randomUUID()
  const ip        = getClientIp(request)
  const log       = logger.child({ requestId, route: 'GET /api/lead-pools/[id]/export', ip })

  // 1. Rate limit
  const rateLimit = await exportLimiter.check(ip)
  if (!rateLimit.success) {
    log.warn('Limite de requisições excedido em /api/lead-pools/[id]/export')
    return NextResponse.json(
      { error: 'Muitas requisições — tente novamente em breve' },
      {
        status: 429,
        headers: {
          'Retry-After': String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)),
        },
      },
    )
  }

  const client = await pool.connect()
  try {
    // 2. Auth
    const auth = await requireWorkspaceAuth(request, client)

    // 3. Feature gate — csv_export
    const hasFeature = await checkWorkspaceFeature(client, auth.workspace_id, 'csv_export')
    if (!hasFeature) {
      await auditBlockedFeature(client, auth.workspace_id, 'csv_export', auth.actor)
      log.info({ workspace_id: auth.workspace_id }, 'csv_export feature bloqueada')
      return NextResponse.json(
        { error: 'Seu plano não inclui exportação de CSV. Contate o suporte para habilitar.' },
        { status: 403 },
      )
    }

    // 4. Validate pool id (strict UUID)
    const { id } = await params
    const parsed = UUIDSchema.safeParse(id)
    if (!parsed.success) {
      return NextResponse.json({ error: 'ID de pool inválido' }, { status: 400 })
    }

    // 5. Load pool — workspace-scoped (repo returns null for cross-workspace IDs)
    const leadPool = await findLeadPoolById(client, parsed.data, auth.workspace_id)
    if (!leadPool) {
      return NextResponse.json({ error: 'Pool não encontrado' }, { status: 404 })
    }

    // 6. Generate CSV
    const lines = [CSV_HEADER, ...leadPool.leads_json.map(rowToCsvLine)]
    const csv   = lines.join('\n')

    const safeName = leadPool.name.replace(/[^a-zA-Z0-9_\-\s]/g, '').trim().replace(/\s+/g, '_') || 'pool'
    const filename = `${safeName}.csv`

    log.info(
      { workspace_id: auth.workspace_id, pool_id: leadPool.id, rows: leadPool.leads_json.length },
      'CSV export concluído',
    )

    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type':        'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control':       'no-store',
      },
    })
  } catch (err) {
    const res = authErrorResponse(err)
    if (res) return res
    log.error({ err }, 'Erro durante export CSV')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  } finally {
    client.release()
  }
}

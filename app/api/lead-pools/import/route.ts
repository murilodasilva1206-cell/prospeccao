// POST /api/lead-pools/import
//
// Accepts a multipart/form-data upload with:
//   file  — CSV file (text/csv or application/octet-stream)
//   name  — pool name (string, required)
//
// Returns 201 with the created LeadPool and import statistics.

import { NextRequest, NextResponse } from 'next/server'
import pool                                           from '@/lib/database'
import { logger }                                     from '@/lib/logger'
import { csvImportLimiter }                           from '@/lib/rate-limit'
import { getClientIp }                                from '@/lib/get-ip'
import { requireWorkspaceAuth, authErrorResponse }    from '@/lib/whatsapp/auth-middleware'
import { checkWorkspaceFeature, auditBlockedFeature } from '@/lib/entitlement'
import { parseCsvLeads }                              from '@/lib/csv-import-parser'
import { createLeadPool }                             from '@/lib/lead-pool-repo'

// MIME types accepted as CSV uploads
const ACCEPTED_MIME_TYPES = new Set([
  'text/csv',
  'application/csv',
  'application/vnd.ms-excel',
  'text/plain',
  'application/octet-stream',
  '',  // browsers sometimes omit content-type
])

export async function POST(request: NextRequest) {
  const requestId = crypto.randomUUID()
  const ip        = getClientIp(request)
  const log       = logger.child({ requestId, route: 'POST /api/lead-pools/import', ip })

  // 1. Rate limit
  const rateLimit = await csvImportLimiter.check(ip)
  if (!rateLimit.success) {
    log.warn('Limite de requisições excedido em /api/lead-pools/import')
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

    // 3. Feature gate — csv_import
    const hasFeature = await checkWorkspaceFeature(client, auth.workspace_id, 'csv_import')
    if (!hasFeature) {
      await auditBlockedFeature(client, auth.workspace_id, 'csv_import', auth.actor)
      log.info({ workspace_id: auth.workspace_id }, 'csv_import feature bloqueada')
      return NextResponse.json(
        { error: 'Seu plano não inclui importação de CSV. Contate o suporte para habilitar.' },
        { status: 403 },
      )
    }

    // 4. Parse multipart form
    let form: FormData
    try {
      form = await request.formData()
    } catch {
      return NextResponse.json({ error: 'Formato de requisição inválido — esperado multipart/form-data' }, { status: 400 })
    }

    const fileField = form.get('file')
    if (!fileField || !(fileField instanceof Blob)) {
      return NextResponse.json({ error: 'Campo "file" ausente ou inválido' }, { status: 400 })
    }

    // 5. Validate MIME type
    const mimeType = (fileField as File).type ?? ''
    const baseMime = mimeType.split(';')[0].trim().toLowerCase()
    if (!ACCEPTED_MIME_TYPES.has(baseMime)) {
      return NextResponse.json(
        { error: `Tipo de arquivo inválido: "${mimeType}". Envie um arquivo CSV (text/csv).` },
        { status: 400 },
      )
    }

    // 6. Read file content
    const csvContent = await fileField.text()

    // 7. Parse CSV
    const parseResult = parseCsvLeads(csvContent)

    // 8. Reject if no valid leads were parsed
    if (parseResult.leads.length === 0) {
      return NextResponse.json(
        {
          error:   parseResult.errors[0]?.message ?? 'Nenhum lead válido encontrado no arquivo.',
          details: parseResult.errors,
        },
        { status: 400 },
      )
    }

    // 9. Resolve pool name
    const nameField = form.get('name')
    const poolName  = typeof nameField === 'string' && nameField.trim()
      ? nameField.trim()
      : `Importação ${new Date().toLocaleDateString('pt-BR')}`

    // 10. Persist lead pool
    const leadPool = await createLeadPool(client, {
      workspace_id: auth.workspace_id,
      name:         poolName,
      leads:        parseResult.leads as Parameters<typeof createLeadPool>[1]['leads'],
    })

    log.info(
      {
        workspace_id: auth.workspace_id,
        pool_id:      leadPool.id,
        imported:     parseResult.leads.length,
        errors:       parseResult.errors.length,
      },
      'CSV import concluído',
    )

    return NextResponse.json(
      {
        data: leadPool,
        meta: {
          imported:      parseResult.leads.length,
          errors:        parseResult.errors.length,
          error_details: parseResult.errors.length > 0 ? parseResult.errors : undefined,
          rowCount:      parseResult.rowCount,
        },
      },
      { status: 201 },
    )
  } catch (err) {
    const res = authErrorResponse(err)
    if (res) return res
    log.error({ err }, 'Erro durante importação CSV')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  } finally {
    client.release()
  }
}

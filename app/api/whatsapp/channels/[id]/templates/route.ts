// GET /api/whatsapp/channels/:id/templates
//
// Lists active templates for a META_CLOUD channel.
// Supports filtering by status, language, and name search; paginated.
//
// Returns { data: WhatsAppTemplate[], pagination }

import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { whatsappChannelLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { ListTemplatesQuerySchema } from '@/lib/schemas'
import { requireWorkspaceAuth, authErrorResponse } from '@/lib/whatsapp/auth-middleware'
import { findChannelById } from '@/lib/whatsapp/channel-repo'
import { listTemplates } from '@/lib/whatsapp/template-repo'
import { ChannelIdSchema } from '@/lib/whatsapp/route-params'

type Params = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, { params }: Params) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'GET /api/whatsapp/channels/:id/templates', ip })

  const rateLimit = await whatsappChannelLimiter.check(ip)
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: 'Muitas requisições' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)) } },
    )
  }

  const idParsed = ChannelIdSchema.safeParse((await params).id)
  if (!idParsed.success) return NextResponse.json({ error: 'id inválido' }, { status: 400 })
  const channelId = idParsed.data

  let query
  try {
    const searchParams = Object.fromEntries(request.nextUrl.searchParams.entries())
    query = ListTemplatesQuerySchema.parse(searchParams)
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json({ error: 'Parâmetros inválidos', details: err.issues }, { status: 400 })
    }
    return NextResponse.json({ error: 'Parâmetros inválidos' }, { status: 400 })
  }

  try {
    const client = await pool.connect()
    try {
      const auth = await requireWorkspaceAuth(request, client)

      const channel = await findChannelById(client, channelId)
      if (!channel) return NextResponse.json({ error: 'Canal nao encontrado' }, { status: 404 })
      if (channel.workspace_id !== auth.workspace_id) {
        return NextResponse.json({ error: 'Acesso negado' }, { status: 403 })
      }
      if (channel.provider !== 'META_CLOUD') {
        return NextResponse.json(
          { error: 'Templates disponiveis apenas para canais META_CLOUD' },
          { status: 409 },
        )
      }

      const result = await listTemplates(client, auth.workspace_id, channelId, {
        page: query.page,
        limit: query.limit,
        status: query.status,
        language: query.language,
        search: query.search,
      })

      log.info({ channelId, total: result.pagination.total }, 'Templates listados')
      return NextResponse.json(result, { status: 200 })
    } finally {
      client.release()
    }
  } catch (err) {
    const res = authErrorResponse(err)
    if (res) return res
    log.error({ err }, 'Erro ao listar templates')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

// GET /api/whatsapp/channels/:id/templates/:templateId/variables
//
// Returns the list of {{N}} placeholder variables detected in the template's
// BODY and HEADER components, with their component type.
//
// Returns { variables: Array<{ index: number, component: 'BODY' | 'HEADER' }> }

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { whatsappChannelLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { requireWorkspaceAuth, authErrorResponse } from '@/lib/whatsapp/auth-middleware'
import { findChannelById } from '@/lib/whatsapp/channel-repo'
import { getTemplateVariables } from '@/lib/whatsapp/template-repo'
import { ChannelIdSchema } from '@/lib/whatsapp/route-params'

const TemplateIdSchema = z.string().uuid('templateId invalido')

type Params = { params: Promise<{ id: string; templateId: string }> }

export async function GET(request: NextRequest, { params }: Params) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'GET /api/whatsapp/channels/:id/templates/:templateId/variables', ip })

  const rateLimit = await whatsappChannelLimiter.check(ip)
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: 'Muitas requisicoes' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)) } },
    )
  }

  const resolvedParams = await params
  const idParsed = ChannelIdSchema.safeParse(resolvedParams.id)
  if (!idParsed.success) return NextResponse.json({ error: 'id invalido' }, { status: 400 })
  const channelId = idParsed.data

  const tplIdParsed = TemplateIdSchema.safeParse(resolvedParams.templateId)
  if (!tplIdParsed.success) return NextResponse.json({ error: 'templateId invalido' }, { status: 400 })
  const templateId = tplIdParsed.data

  try {
    const client = await pool.connect()
    try {
      const auth = await requireWorkspaceAuth(request, client)

      const channel = await findChannelById(client, channelId)
      if (!channel) return NextResponse.json({ error: 'Canal nao encontrado' }, { status: 404 })
      if (channel.workspace_id !== auth.workspace_id) {
        return NextResponse.json({ error: 'Acesso negado' }, { status: 403 })
      }

      const result = await getTemplateVariables(client, templateId, auth.workspace_id, channelId)
      if (!result) return NextResponse.json({ error: 'Template nao encontrado' }, { status: 404 })

      log.info({ channelId, templateId, variableCount: result.variables.length }, 'Variaveis do template retornadas')
      return NextResponse.json({ variables: result.variables }, { status: 200 })
    } finally {
      client.release()
    }
  } catch (err) {
    const res = authErrorResponse(err)
    if (res) return res
    log.error({ err }, 'Erro ao buscar variaveis do template')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

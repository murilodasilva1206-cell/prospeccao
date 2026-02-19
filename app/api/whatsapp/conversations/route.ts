// GET /api/whatsapp/conversations — list conversations for authenticated workspace
//
// Query params: limit?, offset?, status?
// Auth: Bearer wk_... workspace API key

import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { whatsappConversationLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { requireWorkspaceAuth, authErrorResponse } from '@/lib/whatsapp/auth-middleware'
import { findConversationsByWorkspace } from '@/lib/whatsapp/conversation-repo'

export async function GET(request: NextRequest) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'GET /api/whatsapp/conversations', ip })

  const rateLimit = await whatsappConversationLimiter.check(ip)
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: 'Muitas requisicoes' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)) } },
    )
  }

  try {
    const client = await pool.connect()
    try {
      const auth = await requireWorkspaceAuth(request, client)

      const params = request.nextUrl.searchParams
      const limit = Math.min(parseInt(params.get('limit') ?? '50', 10) || 50, 100)
      const offset = parseInt(params.get('offset') ?? '0', 10) || 0
      const status = params.get('status') ?? undefined

      const conversations = await findConversationsByWorkspace(client, auth.workspace_id, {
        limit,
        offset,
        status: status as 'open' | 'resolved' | 'ai_handled' | undefined,
      })

      log.info({ workspace_id: auth.workspace_id, count: conversations.length }, 'Conversas listadas')
      return NextResponse.json({ data: conversations })
    } finally {
      client.release()
    }
  } catch (err) {
    const res = authErrorResponse(err)
    if (res) return res
    log.error({ err }, 'Erro ao listar conversas')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

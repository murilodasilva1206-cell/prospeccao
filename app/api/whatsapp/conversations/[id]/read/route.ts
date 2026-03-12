// POST /api/whatsapp/conversations/:id/read
//
// Marks all messages in a conversation as read (sets unread_count = 0).
// Called by the frontend whenever the user opens/selects a conversation.
//
// Auth: session cookie or Bearer wk_...

import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { whatsappConversationLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { requireWorkspaceAuth, authErrorResponse } from '@/lib/whatsapp/auth-middleware'
import { findConversationById, markAllRead } from '@/lib/whatsapp/conversation-repo'

type Params = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, { params }: Params) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'POST /api/whatsapp/conversations/:id/read', ip })

  const rateLimit = await whatsappConversationLimiter.check(ip)
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: 'Muitas requisições' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)) } },
    )
  }

  const { id } = await params

  try {
    const client = await pool.connect()
    try {
      const auth = await requireWorkspaceAuth(request, client)

      const conversation = await findConversationById(client, id)
      if (!conversation) {
        return NextResponse.json({ error: 'Conversa nao encontrada' }, { status: 404 })
      }
      if (conversation.workspace_id !== auth.workspace_id) {
        return NextResponse.json({ error: 'Acesso negado' }, { status: 403 })
      }

      await markAllRead(client, id)
      log.info({ conversationId: id }, 'Conversa marcada como lida')
      return NextResponse.json({ ok: true }, { status: 200 })
    } finally {
      client.release()
    }
  } catch (err) {
    const res = authErrorResponse(err)
    if (res) return res
    log.error({ err }, 'Erro ao marcar conversa como lida')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

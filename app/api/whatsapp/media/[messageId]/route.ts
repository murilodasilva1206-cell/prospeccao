// GET /api/whatsapp/media/:messageId — generate short-lived signed S3 URL for a media message
//
// Auth: Bearer wk_... workspace API key
// Returns: { url: string, expires_in: 300 }

import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { whatsappInboxLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { requireWorkspaceAuth, authErrorResponse } from '@/lib/whatsapp/auth-middleware'
import { findMessageById } from '@/lib/whatsapp/message-repo'
import { findConversationById } from '@/lib/whatsapp/conversation-repo'
import { getSignedUrl } from '@/lib/whatsapp/media'

type Params = { params: Promise<{ messageId: string }> }

export async function GET(request: NextRequest, { params }: Params) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'GET /api/whatsapp/media/:messageId', ip })

  const rateLimit = await whatsappInboxLimiter.check(ip)
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: 'Muitas requisicoes' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)) } },
    )
  }

  const { messageId } = await params

  try {
    const client = await pool.connect()
    try {
      const auth = await requireWorkspaceAuth(request, client)

      const message = await findMessageById(client, messageId)
      if (!message) {
        return NextResponse.json({ error: 'Mensagem nao encontrada' }, { status: 404 })
      }
      if (!message.media_s3_key) {
        return NextResponse.json({ error: 'Mensagem nao possui midia' }, { status: 400 })
      }

      // Verify workspace ownership via the conversation
      const conversation = await findConversationById(client, message.conversation_id)
      if (!conversation || conversation.workspace_id !== auth.workspace_id) {
        return NextResponse.json({ error: 'Acesso negado' }, { status: 403 })
      }

      const expiresIn = 300 // 5 minutes
      const url = await getSignedUrl(message.media_s3_key, expiresIn)

      log.info({ messageId, workspace_id: auth.workspace_id }, 'Signed URL gerada')
      return NextResponse.json({ url, expires_in: expiresIn })
    } finally {
      client.release()
    }
  } catch (err) {
    const res = authErrorResponse(err)
    if (res) return res
    log.error({ err }, 'Erro ao gerar signed URL')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

// GET   /api/whatsapp/conversations/:id — get conversation detail
// PATCH /api/whatsapp/conversations/:id — update status or ai_enabled
//
// Auth: Bearer wk_... workspace API key

import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { whatsappConversationLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { ConversationPatchSchema } from '@/lib/schemas'
import { requireWorkspaceAuth, authErrorResponse } from '@/lib/whatsapp/auth-middleware'
import {
  findConversationById,
  updateConversationStatus,
  updateConversationAiEnabled,
  markAllRead,
} from '@/lib/whatsapp/conversation-repo'

type Params = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, { params }: Params) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'GET /api/whatsapp/conversations/:id', ip })

  const rateLimit = await whatsappConversationLimiter.check(ip)
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: 'Muitas requisicoes' },
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

      log.info({ conversationId: id }, 'Conversa consultada')
      return NextResponse.json({ data: conversation })
    } finally {
      client.release()
    }
  } catch (err) {
    const res = authErrorResponse(err)
    if (res) return res
    log.error({ err }, 'Erro ao buscar conversa')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'PATCH /api/whatsapp/conversations/:id', ip })

  const rateLimit = await whatsappConversationLimiter.check(ip)
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: 'Muitas requisicoes' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)) } },
    )
  }

  const { id } = await params

  let body
  try {
    const raw = await request.json()
    body = ConversationPatchSchema.parse(raw)
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json({ error: 'Parametros invalidos', details: err.issues }, { status: 400 })
    }
    return NextResponse.json({ error: 'JSON invalido' }, { status: 400 })
  }

  if (!body.status && body.ai_enabled === undefined) {
    return NextResponse.json({ error: 'Nada para atualizar' }, { status: 400 })
  }

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

      if (body.status) {
        await updateConversationStatus(client, id, body.status)
        // Mark all messages read when resolving
        if (body.status === 'resolved') {
          await markAllRead(client, id)
        }
      }
      if (body.ai_enabled !== undefined) {
        await updateConversationAiEnabled(client, id, body.ai_enabled)
      }

      const updated = await findConversationById(client, id)
      log.info({ conversationId: id }, 'Conversa atualizada')
      return NextResponse.json({ data: updated })
    } finally {
      client.release()
    }
  } catch (err) {
    const res = authErrorResponse(err)
    if (res) return res
    log.error({ err }, 'Erro ao atualizar conversa')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

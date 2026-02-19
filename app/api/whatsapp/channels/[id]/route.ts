// GET /api/whatsapp/channels/:id — get single channel (no credentials)

import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { whatsappChannelLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { findChannelById } from '@/lib/whatsapp/channel-repo'

type Params = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, { params }: Params) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'GET /api/whatsapp/channels/:id', ip })

  const rateLimit = await whatsappChannelLimiter.check(ip)
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: 'Muitas requisicoes — tente novamente em breve' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)) } },
    )
  }

  const { id } = await params
  if (!id) return NextResponse.json({ error: 'ID e obrigatorio' }, { status: 400 })

  try {
    const client = await pool.connect()
    try {
      const channel = await findChannelById(client, id)
      if (!channel) {
        return NextResponse.json({ error: 'Canal nao encontrado' }, { status: 404 })
      }
      // Never expose credentials or webhook_secret in a GET
      const { credentials_encrypted: _c, webhook_secret: _w, ...safe } = channel
      log.info({ channelId: id }, 'Canal consultado')
      return NextResponse.json({ data: safe })
    } finally {
      client.release()
    }
  } catch (err) {
    log.error({ err }, 'Erro ao buscar canal')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

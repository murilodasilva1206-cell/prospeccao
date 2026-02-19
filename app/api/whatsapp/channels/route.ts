// GET  /api/whatsapp/channels?workspace_id=<id>  — list channels
// POST /api/whatsapp/channels                     — create channel

import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { randomBytes } from 'crypto'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { whatsappChannelLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { ChannelCreateSchema } from '@/lib/schemas'
import { encryptCredentials } from '@/lib/whatsapp/crypto'
import { createChannel, findChannelsByWorkspace } from '@/lib/whatsapp/channel-repo'
import { getAdapter } from '@/lib/whatsapp/adapters/factory'
import { updateChannelStatus } from '@/lib/whatsapp/channel-repo'

export async function GET(request: NextRequest) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'GET /api/whatsapp/channels', ip })

  const rateLimit = await whatsappChannelLimiter.check(ip)
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: 'Muitas requisicoes — tente novamente em breve' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)) } },
    )
  }

  const workspace_id = request.nextUrl.searchParams.get('workspace_id')
  if (!workspace_id || workspace_id.trim().length === 0) {
    return NextResponse.json({ error: 'workspace_id e obrigatorio' }, { status: 400 })
  }

  try {
    const client = await pool.connect()
    try {
      const channels = await findChannelsByWorkspace(client, workspace_id)
      // Strip credentials_encrypted and webhook_secret from list response
      const safe = channels.map(({ credentials_encrypted: _c, webhook_secret: _w, ...rest }) => rest)
      log.info({ workspace_id, count: safe.length }, 'Canais listados')
      return NextResponse.json({ data: safe })
    } finally {
      client.release()
    }
  } catch (err) {
    log.error({ err }, 'Erro ao listar canais')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'POST /api/whatsapp/channels', ip })

  const rateLimit = await whatsappChannelLimiter.check(ip)
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: 'Muitas requisicoes — tente novamente em breve' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)) } },
    )
  }

  let body
  try {
    const raw = await request.json()
    body = ChannelCreateSchema.parse(raw)
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json({ error: 'Parametros invalidos', details: err.issues }, { status: 400 })
    }
    return NextResponse.json({ error: 'JSON invalido no corpo da requisicao' }, { status: 400 })
  }

  // Encrypt credentials before touching the DB
  const credentials_encrypted = encryptCredentials(body.credentials)

  // Generate a server-side HMAC signing secret (never user-provided)
  const webhook_secret = randomBytes(32).toString('hex')

  try {
    const client = await pool.connect()
    try {
      // Create channel row (status=DISCONNECTED)
      const channel = await createChannel(client, {
        workspace_id: body.workspace_id,
        name: body.name,
        provider: body.provider,
        credentials_encrypted,
        webhook_secret,
        phone_number: body.phone_number,
      })

      // Validate credentials with the provider
      try {
        const adapter = getAdapter(body.provider)
        const { external_instance_id } = await adapter.createChannel(channel, body.credentials)
        await updateChannelStatus(client, channel.id, 'DISCONNECTED', {
          external_instance_id,
        })
        channel.external_instance_id = external_instance_id
      } catch (adapterErr) {
        // Credential validation failed — delete the row and surface the error
        const { deleteChannel } = await import('@/lib/whatsapp/channel-repo')
        await deleteChannel(client, channel.id)
        log.warn({ err: adapterErr }, 'Validacao de credenciais falhou — canal removido')
        return NextResponse.json(
          { error: 'Credenciais invalidas ou provider inacessivel', detail: String(adapterErr) },
          { status: 422 },
        )
      }

      log.info({ channelId: channel.id, provider: body.provider }, 'Canal criado')

      // Return webhook_secret once — caller must configure it on the provider
      return NextResponse.json(
        {
          data: { ...channel, credentials_encrypted: undefined, webhook_secret: undefined },
          webhook_secret, // returned once at creation; not stored in subsequent GETs
        },
        { status: 201 },
      )
    } finally {
      client.release()
    }
  } catch (err) {
    log.error({ err }, 'Erro ao criar canal')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

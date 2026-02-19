// POST /api/whatsapp/webhook/:provider/:channelId — receive incoming webhooks from WhatsApp providers
//
// Security pipeline (in order):
//   1. Rate limit (500/min per IP)
//   2. Validate path params (provider enum + channelId UUID)
//   3. Read raw body as text (HMAC verification needs un-parsed bytes)
//   4. processWebhook(): channel lookup → HMAC verify → idempotency → normalize → side-effects
//
// Domain errors from processWebhook are translated to appropriate HTTP codes.
// Any unhandled error returns 500 — no provider info leaked.

import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { whatsappWebhookLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { WebhookPathSchema } from '@/lib/schemas'
import {
  processWebhook,
  ChannelNotFoundError,
  ProviderMismatchError,
  SignatureInvalidError,
} from '@/lib/whatsapp/webhook-handler'
import { findChannelById } from '@/lib/whatsapp/channel-repo'
import { safeCompare } from '@/lib/whatsapp/crypto'

type Params = { params: Promise<{ provider: string; channelId: string }> }

// GET /api/whatsapp/webhook/meta/:channelId — Meta webhook verification handshake
export async function GET(request: NextRequest, { params }: Params) {
  const { provider, channelId } = await params

  if (provider !== 'META_CLOUD') {
    return NextResponse.json({ error: 'GET apenas suportado para provider META_CLOUD' }, { status: 405 })
  }

  const url = request.nextUrl
  const mode = url.searchParams.get('hub.mode')
  const verifyToken = url.searchParams.get('hub.verify_token')
  const challenge = url.searchParams.get('hub.challenge')

  if (mode !== 'subscribe' || !verifyToken || !challenge) {
    return NextResponse.json({ error: 'Parametros de verificacao ausentes' }, { status: 400 })
  }

  try {
    const client = await pool.connect()
    try {
      const channel = await findChannelById(client, channelId)
      if (!channel || channel.provider !== 'META_CLOUD') {
        return NextResponse.json({ error: 'Canal nao encontrado' }, { status: 404 })
      }
      if (!safeCompare(verifyToken, channel.webhook_secret)) {
        return NextResponse.json({ error: 'Token de verificacao invalido' }, { status: 403 })
      }
      return new NextResponse(challenge, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    } finally {
      client.release()
    }
  } catch (err) {
    logger.error({ err }, 'Erro no handshake Meta webhook')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

export async function POST(request: NextRequest, { params }: Params) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({
    requestId,
    route: 'POST /api/whatsapp/webhook/:provider/:channelId',
    ip,
  })

  const rateLimit = await whatsappWebhookLimiter.check(ip)
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: 'Muitas requisicoes' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)) } },
    )
  }

  // Validate path params before touching the DB
  const pathParsed = WebhookPathSchema.safeParse(await params)
  if (!pathParsed.success) {
    return NextResponse.json({ error: 'Parametros de rota invalidos' }, { status: 400 })
  }

  const { provider, channelId } = pathParsed.data

  // Read raw body BEFORE any JSON parsing — HMAC must sign the exact bytes received
  const rawBody = await request.text()

  try {
    const client = await pool.connect()
    try {
      const result = await processWebhook(
        client,
        provider,
        channelId,
        request.headers,
        rawBody,
      )

      if (!result.processed) {
        log.debug({ provider, channelId }, 'Webhook duplicado — ignorado')
        return NextResponse.json({ ok: true, duplicate: true })
      }

      log.info({ provider, channelId, eventType: result.event?.type }, 'Webhook processado')
      return NextResponse.json({ ok: true, event_type: result.event?.type ?? null })
    } finally {
      client.release()
    }
  } catch (err) {
    if (err instanceof ChannelNotFoundError) {
      return NextResponse.json({ error: 'Canal nao encontrado' }, { status: 404 })
    }
    if (err instanceof ProviderMismatchError) {
      return NextResponse.json({ error: 'Provider nao corresponde ao canal' }, { status: 400 })
    }
    if (err instanceof SignatureInvalidError) {
      log.warn({ provider, channelId }, 'Assinatura de webhook invalida')
      return NextResponse.json({ error: 'Assinatura invalida' }, { status: 401 })
    }
    log.error({ err }, 'Erro interno ao processar webhook')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

// GET    /api/whatsapp/keys         — list API keys for the authenticated workspace
// POST   /api/whatsapp/keys         — create new API key (raw key returned once)
// DELETE /api/whatsapp/keys?id=<x>  — revoke API key (only if owned by the caller's workspace)
//
// Auth: Bearer wk_... is REQUIRED on every verb.
// workspace_id is always sourced from the validated token — never from query string or body.

import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { whatsappKeysLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { ApiKeyCreateSchema } from '@/lib/schemas'
import { createApiKey, listApiKeys, revokeApiKey } from '@/lib/whatsapp/auth'
import { requireWorkspaceAuth, authErrorResponse } from '@/lib/whatsapp/auth-middleware'

// ---------------------------------------------------------------------------
// GET — list active keys for the authenticated workspace
// ---------------------------------------------------------------------------
export async function GET(request: NextRequest) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'GET /api/whatsapp/keys', ip })

  const rateLimit = await whatsappKeysLimiter.check(ip)
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: 'Muitas requisicoes' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)) } },
    )
  }

  try {
    const client = await pool.connect()
    try {
      // workspace_id comes from the token — never from the query string
      const auth = await requireWorkspaceAuth(request, client)

      const keys = await listApiKeys(client, auth.workspace_id)
      log.info({ workspace_id: auth.workspace_id, count: keys.length }, 'API keys listadas')
      return NextResponse.json({ data: keys })
    } finally {
      client.release()
    }
  } catch (err) {
    const res = authErrorResponse(err)
    if (res) return res
    log.error({ err }, 'Erro ao listar API keys')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// POST — create a new API key for the authenticated workspace
// ---------------------------------------------------------------------------
export async function POST(request: NextRequest) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'POST /api/whatsapp/keys', ip })

  const rateLimit = await whatsappKeysLimiter.check(ip)
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: 'Muitas requisicoes' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)) } },
    )
  }

  let body
  try {
    const raw = await request.json()
    body = ApiKeyCreateSchema.parse(raw)
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json({ error: 'Parametros invalidos', details: err.issues }, { status: 400 })
    }
    return NextResponse.json({ error: 'JSON invalido no corpo da requisicao' }, { status: 400 })
  }

  try {
    const client = await pool.connect()
    try {
      // Auth first — workspace_id from the token is authoritative; body.workspace_id is ignored
      const auth = await requireWorkspaceAuth(request, client)

      const { key, record } = await createApiKey(client, {
        workspace_id: auth.workspace_id,
        label: body.label,
        created_by: body.created_by,
      })

      log.info({ workspace_id: auth.workspace_id, keyId: record.id }, 'API key criada')

      // Return raw key ONCE — never stored in plaintext, cannot be recovered
      return NextResponse.json(
        {
          data: {
            id: record.id,
            workspace_id: record.workspace_id,
            label: record.label,
            created_by: record.created_by,
            created_at: record.created_at,
          },
          key, // Bearer wk_... — save this, it cannot be shown again
        },
        { status: 201 },
      )
    } finally {
      client.release()
    }
  } catch (err) {
    const res = authErrorResponse(err)
    if (res) return res
    log.error({ err }, 'Erro ao criar API key')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// DELETE — revoke a key (only if it belongs to the caller's workspace)
// ---------------------------------------------------------------------------
export async function DELETE(request: NextRequest) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'DELETE /api/whatsapp/keys', ip })

  const rateLimit = await whatsappKeysLimiter.check(ip)
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: 'Muitas requisicoes' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)) } },
    )
  }

  const id = request.nextUrl.searchParams.get('id')
  if (!id?.trim()) {
    return NextResponse.json({ error: 'id e obrigatorio' }, { status: 400 })
  }

  try {
    const client = await pool.connect()
    try {
      const auth = await requireWorkspaceAuth(request, client)

      // workspace_id guard lives inside revokeApiKey SQL (WHERE id=$1 AND workspace_id=$2)
      // so a caller cannot revoke keys that belong to another workspace
      const revoked = await revokeApiKey(client, id, auth.workspace_id)
      if (!revoked) {
        return NextResponse.json({ error: 'API key nao encontrada ou ja revogada' }, { status: 404 })
      }

      log.info({ keyId: id, workspace_id: auth.workspace_id }, 'API key revogada')
      return NextResponse.json({ ok: true })
    } finally {
      client.release()
    }
  } catch (err) {
    const res = authErrorResponse(err)
    if (res) return res
    log.error({ err }, 'Erro ao revogar API key')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

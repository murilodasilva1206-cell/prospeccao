// GET   /api/whatsapp/channels/:id — get single channel (no credentials)
// PATCH /api/whatsapp/channels/:id — update name, phone_number, and/or credentials
//
// Auth: session cookie or Bearer wk_... workspace API key required.
// workspace_id is always taken from the token — never from the request body.

import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { whatsappChannelLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { ChannelUpdateSchema, getFullCredsSchema } from '@/lib/schemas'
import { encryptCredentials, decryptCredentials } from '@/lib/whatsapp/crypto'
import { findChannelById, updateChannelConfig } from '@/lib/whatsapp/channel-repo'
import { getAdapter } from '@/lib/whatsapp/adapters/factory'
import { CredentialValidationError } from '@/lib/whatsapp/errors'
import { requireWorkspaceAuth, authErrorResponse } from '@/lib/whatsapp/auth-middleware'
import { ChannelIdSchema } from '@/lib/whatsapp/route-params'
import type { ChannelCredentials } from '@/lib/whatsapp/types'

type Params = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, { params }: Params) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'GET /api/whatsapp/channels/:id', ip })

  const rateLimit = await whatsappChannelLimiter.check(ip)
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: 'Muitas requisições — tente novamente em breve' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)) } },
    )
  }

  const idParsed = ChannelIdSchema.safeParse((await params).id)
  if (!idParsed.success) return NextResponse.json({ error: 'id inválido' }, { status: 400 })
  const id = idParsed.data

  try {
    const client = await pool.connect()
    try {
      const auth = await requireWorkspaceAuth(request, client)

      const channel = await findChannelById(client, id)
      if (!channel) {
        return NextResponse.json({ error: 'Canal nao encontrado' }, { status: 404 })
      }
      if (channel.workspace_id !== auth.workspace_id) {
        return NextResponse.json({ error: 'Acesso negado' }, { status: 403 })
      }

      // Never expose credentials or webhook_secret in a GET
      const { credentials_encrypted: _c, webhook_secret: _w, ...safe } = channel
      log.info({ channelId: id }, 'Canal consultado')
      return NextResponse.json({ data: safe })
    } finally {
      client.release()
    }
  } catch (err) {
    const res = authErrorResponse(err)
    if (res) return res
    log.error({ err }, 'Erro ao buscar canal')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'PATCH /api/whatsapp/channels/:id', ip })

  const rateLimit = await whatsappChannelLimiter.check(ip)
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: 'Muitas requisições — tente novamente em breve' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)) } },
    )
  }

  const idParsed = ChannelIdSchema.safeParse((await params).id)
  if (!idParsed.success) return NextResponse.json({ error: 'id inválido' }, { status: 400 })
  const id = idParsed.data

  try {
    const client = await pool.connect()
    try {
      const auth = await requireWorkspaceAuth(request, client)

      const channel = await findChannelById(client, id)
      if (!channel) {
        return NextResponse.json({ error: 'Canal nao encontrado' }, { status: 404 })
      }
      if (channel.workspace_id !== auth.workspace_id) {
        return NextResponse.json({ error: 'Acesso negado' }, { status: 403 })
      }

      // Parse and validate the request body
      let body
      try {
        const raw = await request.json()
        body = ChannelUpdateSchema.parse(raw)
      } catch (err) {
        if (err instanceof ZodError) {
          return NextResponse.json({ error: 'Parâmetros inválidos', details: err.issues }, { status: 400 })
        }
        return NextResponse.json({ error: 'JSON inválido no corpo da requisição' }, { status: 400 })
      }

      // Provider is immutable — the body must declare the same provider as the channel
      if (body.provider !== channel.provider) {
        return NextResponse.json(
          { error: `Provider do canal e '${channel.provider}' e nao pode ser alterado` },
          { status: 409 },
        )
      }

      // Prepare updates object — accumulate only the fields that change
      const updates: Parameters<typeof updateChannelConfig>[2] = {}

      if (body.name !== undefined) {
        updates.name = body.name
      }
      if ('phone_number' in body) {
        updates.phone_number = body.phone_number ?? null
      }

      // Credential update: merge incoming (partial) with existing, validate merged result
      let validatedCreds: ChannelCredentials | undefined
      if (body.credentials && Object.keys(body.credentials).length > 0) {
        const existingCreds = decryptCredentials(channel.credentials_encrypted)
        // Merge: incoming fields win over existing; empty strings are discarded (UX: blank = keep existing)
        const merged: Record<string, unknown> = { ...existingCreds }
        for (const [k, v] of Object.entries(body.credentials)) {
          if (v !== '' && v !== undefined) {
            // eslint-disable-next-line security/detect-object-injection
            merged[k] = v
          }
        }

        // Validate the merged object against the full provider schema (all required fields)
        const fullSchema = getFullCredsSchema(channel.provider)
        let parseResult
        try {
          parseResult = fullSchema.parse(merged)
        } catch (err) {
          if (err instanceof ZodError) {
            return NextResponse.json(
              { error: 'Credenciais incompletas apos merge', details: err.issues },
              { status: 400 },
            )
          }
          throw err
        }
        validatedCreds = parseResult as ChannelCredentials
        updates.credentials_encrypted = encryptCredentials(validatedCreds)
      }

      // Revalidate credentials at the provider (default: true when credentials present)
      // Uses validateCredentials (read-only) — never createChannel, which has side effects.
      // external_instance_id is NOT updated here; it is only set during initial POST or connect flow.
      const shouldRevalidate = validatedCreds !== undefined && body.revalidate !== false
      if (shouldRevalidate && validatedCreds) {
        try {
          const adapter = getAdapter(channel.provider)
          if (adapter.validateCredentials) {
            await adapter.validateCredentials(channel, validatedCreds)
          }
        } catch (adapterErr) {
          // Validation failed — do NOT persist the new credentials
          const errMsg = adapterErr instanceof Error ? adapterErr.message : String(adapterErr)
          const httpStatus = adapterErr instanceof CredentialValidationError ? adapterErr.httpStatus : null
          const userMessage = adapterErr instanceof CredentialValidationError
            ? adapterErr.userMessage
            : 'Credenciais inválidas ou provider inacessivel'
          log.warn(
            { provider: channel.provider, channelId: id, httpStatus, errMsg },
            'Revalidacao de credenciais falhou — alteracoes descartadas',
          )
          return NextResponse.json({ error: userMessage }, { status: 422 })
        }
      }

      // Persist changes and return the updated channel (without secrets)
      const updated = await updateChannelConfig(client, id, updates)
      if (!updated) {
        return NextResponse.json({ error: 'Canal nao encontrado' }, { status: 404 })
      }

      log.info(
        { channelId: id, updatedFields: Object.keys(updates) },
        'Canal atualizado',
      )

      const { credentials_encrypted: _c, webhook_secret: _w, ...safe } = updated
      return NextResponse.json({ data: safe })
    } finally {
      client.release()
    }
  } catch (err) {
    const res = authErrorResponse(err)
    if (res) return res
    log.error({ err }, 'Erro ao atualizar canal')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

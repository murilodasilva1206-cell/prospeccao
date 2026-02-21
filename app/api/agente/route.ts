import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { agenteLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { AgenteBodySchema } from '@/lib/schemas'
import { detectInjectionAttempt } from '@/lib/agent-prompts'
import { callAiAgent } from '@/lib/ai-client'
import { buildContactsQuery, buildCountQuery } from '@/lib/query-builder'
import { maskContact } from '@/lib/mask-output'
import { resolveNichoCnae, resolveNichoCnaeDynamic } from '@/lib/nicho-cnae'
import { requireWorkspaceAuth, authErrorResponse } from '@/lib/whatsapp/auth-middleware'
import type { BuscaQuery } from '@/lib/schemas'

export async function POST(request: NextRequest) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: '/api/agente', ip })

  // 1. Rate limit — strict: AI calls cost money and can be abused for DoS
  const rateLimit = await agenteLimiter.check(ip)
  if (!rateLimit.success) {
    log.warn('Rate limit exceeded on /api/agente')
    return NextResponse.json(
      { error: 'Muitas requisicoes — tente novamente em breve' },
      {
        status: 429,
        headers: {
          'Retry-After': String(
            Math.ceil((rateLimit.resetAt - Date.now()) / 1000),
          ),
          'X-RateLimit-Remaining': '0',
        },
      },
    )
  }

  // 2. Parse and validate request body — before any DB hit so invalid payloads
  //    are rejected cheaply without consuming a connection.
  let body
  try {
    const raw = await request.json()
    body = AgenteBodySchema.parse(raw)
  } catch (err) {
    if (err instanceof ZodError) {
      log.info({ issues: err.issues }, 'Validation error on /api/agente')
      return NextResponse.json(
        { error: 'Requisicao invalida', details: err.issues },
        { status: 400 },
      )
    }
    log.info({ err }, 'Invalid JSON body on /api/agente')
    return NextResponse.json({ error: 'JSON invalido no corpo da requisicao' }, { status: 400 })
  }

  // 3. Authentication — session cookie (web UI) or Bearer wk_... token (API)
  // Runs after parse (no DB cost for bad payloads) but before injection check so
  // unauthenticated callers always receive 401/403, never a rejection message.
  // Note: workspace_id is captured for audit logging only.
  // `estabelecimentos` is a public CNPJ registry shared across all workspaces —
  // filtering by workspace_id would be incorrect here.
  let authCtx: { workspace_id: string; actor: string }
  {
    const authClient = await pool.connect()
    try {
      authCtx = await requireWorkspaceAuth(request, authClient)
    } catch (err) {
      const res = authErrorResponse(err)
      if (res) return res
      log.error({ err }, 'Unexpected error during auth on /api/agente')
      return NextResponse.json({ error: 'Erro interno' }, { status: 500 })
    } finally {
      authClient.release()
    }
  }

  // 4. Pre-screen for prompt injection — fast regex check, no API cost
  if (detectInjectionAttempt(body.message)) {
    log.warn(
      { messagePreview: body.message.slice(0, 100) },
      'Prompt injection attempt detected — blocked before AI call',
    )
    return NextResponse.json({
      action: 'reject',
      message: 'Posso apenas ajudar com buscas de empresas no cadastro CNPJ.',
      metadata: { blocked: true },
    })
  }

  // 5. Call AI with circuit breaker, guardrails, and structured output validation
  let intent, latencyMs, parseSuccess
  try {
    ;({ intent, latencyMs, parseSuccess } = await callAiAgent(body.message))
  } catch (err) {
    log.error({ err }, 'AI agent call failed')
    return NextResponse.json(
      { error: 'Servico temporariamente indisponivel — tente novamente em breve' },
      { status: 503 },
    )
  }

  // clarify or reject — return message to user immediately (no DB needed)
  if (intent.action === 'clarify' || intent.action === 'reject') {
    return NextResponse.json({
      action: intent.action,
      message: intent.message,
      metadata: { latencyMs, parseSuccess, confidence: intent.confidence },
    })
  }

  // 6. Resolve nicho → cnae_principal before building query
  // Dynamic lookup (cnae_dictionary table) first; fall back to static map.
  const rawFilters = intent.filters ?? {}
  if (rawFilters.nicho && !rawFilters.cnae_principal) {
    const resolved =
      (await resolveNichoCnaeDynamic(rawFilters.nicho)) ??
      resolveNichoCnae(rawFilters.nicho)
    if (resolved) {
      rawFilters.cnae_principal = resolved
      log.debug({ nicho: rawFilters.nicho, cnae: resolved }, 'Nicho resolved to CNAE')
    }
  }

  // Build complete BuscaQuery with defaults
  const filters: BuscaQuery = {
    uf: rawFilters.uf,
    municipio: rawFilters.municipio,
    cnae_principal: rawFilters.cnae_principal,
    nicho: rawFilters.nicho,
    situacao_cadastral: rawFilters.situacao_cadastral ?? 'ATIVA',
    tem_telefone: rawFilters.tem_telefone,
    tem_email: rawFilters.tem_email,
    orderBy: rawFilters.orderBy ?? 'razao_social',
    orderDir: rawFilters.orderDir ?? 'asc',
    page: rawFilters.page ?? 1,
    limit: rawFilters.limit ?? 20,
  }

  if (intent.action === 'export') {
    // For export intent, return filters for the client to call /api/export
    const params = new URLSearchParams()
    if (filters.uf) params.set('uf', filters.uf)
    if (filters.municipio) params.set('municipio', filters.municipio)
    if (filters.cnae_principal) params.set('cnae_principal', filters.cnae_principal)
    if (filters.situacao_cadastral) params.set('situacao_cadastral', filters.situacao_cadastral)
    if (filters.tem_telefone != null) params.set('tem_telefone', String(filters.tem_telefone))
    if (filters.tem_email != null) params.set('tem_email', String(filters.tem_email))

    log.info({ filters, latencyMs }, 'Agent produced export intent')
    return NextResponse.json({
      action: 'export',
      filters,
      queryString: params.toString(),
      metadata: { latencyMs, parseSuccess, confidence: intent.confidence },
    })
  }

  // 7. Execute DB search and return real data
  try {
    const client = await pool.connect()
    try {
      const { text, values } = buildContactsQuery(filters)
      const { text: countText, values: countValues } = buildCountQuery(filters)

      log.debug({ filters, workspace_id: authCtx.workspace_id, actor: authCtx.actor }, 'Agent executing search query')

      const [rows, countResult] = await Promise.all([
        client.query(text, values),
        client.query(countText, countValues),
      ])

      const data = rows.rows.map(maskContact)
      const total = Number(countResult.rows[0]?.total ?? 0)

      log.info({ resultCount: data.length, total, latencyMs, workspace_id: authCtx.workspace_id, actor: authCtx.actor }, 'Agent search success')

      return NextResponse.json({
        action: 'search',
        filters,
        data,
        meta: {
          total,
          page: filters.page,
          limit: filters.limit,
          pages: Math.ceil(total / filters.limit),
        },
        metadata: { latencyMs, parseSuccess, confidence: intent.confidence },
      })
    } finally {
      client.release()
    }
  } catch (err) {
    log.error({ err }, 'Erro de banco de dados em /api/agente')
    return NextResponse.json(
      { error: 'Erro ao consultar banco de dados' },
      { status: 500 },
    )
  }
}

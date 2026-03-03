import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { agenteLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { AgenteBodySchema } from '@/lib/schemas'
import { detectInjectionAttempt } from '@/lib/agent-prompts'
import { callAiAgent } from '@/lib/ai-client'
import { buildContactsQuery, buildCountQuery, type ExtendedBuscaQuery } from '@/lib/query-builder'
import { maskContact } from '@/lib/mask-output'
import { narrateSearchResult } from '@/lib/ai-narrator'
import { getCnaeResolverService } from '@/lib/cnae-resolver-service'
import { resolveMunicipio } from '@/lib/municipio-resolver'
import { requireWorkspaceAuth, authErrorResponse, type AuthContext } from '@/lib/whatsapp/auth-middleware'
import { getDefaultProfile } from '@/lib/llm-profile-repo'
import { buildQueryFingerprint, getServedCnpjs, markAsServed } from '@/lib/served-leads-repo'
import { env } from '@/lib/env'
import type { BuscaQuery } from '@/lib/schemas'
import type { LlmCallConfig } from '@/lib/llm-providers'

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

  // 3. Authentication + LLM profile resolution
  //
  // Auth: session cookie (web UI) or Bearer wk_... token (API).
  // Unauthenticated callers always receive 401/403, never a rejection message.
  //
  // LLM profile: every workspace must configure its own LLM profile.
  //   - Production: no profile → 409 "configure sua LLM" (no global fallback).
  //   - Development: global OPENROUTER_API_KEY is used as a convenience fallback
  //     with an explicit warning log so the absence of a profile is visible.
  let authCtx: AuthContext
  let llmProfile: LlmCallConfig
  {
    const authClient = await pool.connect()
    try {
      authCtx = await requireWorkspaceAuth(request, authClient)

      let profileOrNull: LlmCallConfig | null = null
      try {
        profileOrNull = await getDefaultProfile(authClient, authCtx.workspace_id)
      } catch (err) {
        log.warn({ err, workspace_id: authCtx.workspace_id }, 'Erro ao carregar perfil LLM (migration pendente?)')
      }

      if (profileOrNull === null) {
        if (env.NODE_ENV !== 'development') {
          return NextResponse.json(
            {
              action: 'reject',
              error: 'Configure sua chave de LLM em Configurações > Integrações de IA antes de usar o agente.',
              code: 'LLM_PROFILE_REQUIRED',
            },
            { status: 409 },
          )
        }
        // Dev-only fallback: use the global OpenRouter env key with a visible warning.
        // If that key is also absent, return 409 now rather than letting an empty
        // string propagate to a confusing generic 503 after the LLM call fails.
        if (!env.OPENROUTER_API_KEY) {
          return NextResponse.json(
            {
              action: 'reject',
              error: 'Configure sua chave de LLM em Configurações > Integrações de IA antes de usar o agente.',
              code: 'LLM_PROFILE_REQUIRED',
            },
            { status: 409 },
          )
        }
        log.warn('[DEV ONLY] Nenhum perfil LLM configurado — usando OPENROUTER_API_KEY global. Configure um perfil em /whatsapp/llm.')
        llmProfile = {
          apiKey: env.OPENROUTER_API_KEY,
          model: env.OPENROUTER_MODEL,
          provider: 'openrouter',
        }
      } else {
        llmProfile = profileOrNull
      }
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

  // 5. Call AI with circuit breaker, guardrails, and structured output validation.
  //    Uses the workspace LLM profile resolved above (guaranteed non-null at this point).
  let intent, latencyMs, parseSuccess
  try {
    ;({ intent, latencyMs, parseSuccess } = await callAiAgent(body.message, llmProfile))
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

  // 6. Resolve nicho → one or more CNAE codes through 4-layer cascade:
  //    LRU cache → cnae_dictionary → IBGE API → persist discovery.
  //
  //    The resolver always takes priority over any cnae_principal the AI may have
  //    inferred, because it has authoritative CNAE mapping and supports multi-code
  //    niches.  cnae_principal is kept as-is only when no nicho was provided or
  //    when the resolver fails to find a mapping.
  const rawFilters = intent.filters ?? {}
  let cnaeCodesFromNicho: string[] | undefined
  if (rawFilters.nicho) {
    const resolved = await getCnaeResolverService().resolve(rawFilters.nicho)
    if (resolved) {
      // Always route through cnae_codes (= ANY) even for a single code.
      // This is exact-match semantics (no ILIKE wildcards) and carries the full
      // set returned by the merged dynamic+static resolver.
      cnaeCodesFromNicho = resolved
      rawFilters.cnae_principal = undefined
      log.debug({ nicho: rawFilters.nicho, codes: resolved }, 'Nicho resolved to CNAE')
    }
  }

  // Guard: if a nicho was given but couldn't be mapped to a CNAE, a DB scan
  // with no sector filter would return meaningless results. Ask the user to
  // rephrase rather than executing an expensive full-table query.
  if (rawFilters.nicho && !rawFilters.cnae_principal && !cnaeCodesFromNicho) {
    log.info({ nicho: rawFilters.nicho }, 'Nicho nao resolvido para CNAE — solicitando esclarecimento')
    return NextResponse.json({
      action: 'clarify',
      message: 'Não consegui identificar o setor cadastral para esse nicho. Tente ser mais específico — por exemplo: "dentistas", "restaurantes", "academias de ginástica".',
      metadata: { latencyMs, parseSuccess, confidence: intent.confidence },
    })
  }

  // Regex fallback: extract a requested quantity from the user message when the
  // AI did not populate `filters.limit`.  Matches patterns like:
  //   "100 clínicas", "me traga 50 leads", "preciso de 30 empresas", "buscar 200"
  // The extracted value is clamped to [1, 100] to match the schema hard cap.
  let resolvedLimit = rawFilters.limit
  if (!resolvedLimit) {
    const m = body.message.match(/\b(\d{1,3})\b/)
    if (m) {
      const parsed = parseInt(m[1], 10)
      if (parsed >= 1) resolvedLimit = Math.min(parsed, 100)
    }
  }

  // Build complete BuscaQuery with defaults
  const filters: BuscaQuery = {
    uf: rawFilters.uf,
    municipio: rawFilters.municipio,
    cnae_principal: rawFilters.cnae_principal,
    nicho: rawFilters.nicho,
    situacao_cadastral: rawFilters.situacao_cadastral ?? '02',
    tem_telefone: rawFilters.tem_telefone,
    tem_email: rawFilters.tem_email,
    orderBy: rawFilters.orderBy ?? 'contato_priority',
    orderDir: rawFilters.orderDir ?? 'asc',
    page: rawFilters.page ?? 1,
    limit: resolvedLimit ?? 20,
  }

  if (intent.action === 'export') {
    // For export intent, return filters for the client to call /api/export
    const params = new URLSearchParams()
    if (filters.uf) params.set('uf', filters.uf)
    if (filters.municipio) params.set('municipio', filters.municipio)
    if (filters.nicho) params.set('nicho', filters.nicho)
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
      const requestedLimit = filters.limit

      // 7a. Resolve municipio name → numeric codigo_f.
      //     On ambiguity: return clarify. On not_found: return clarify.
      let workingFilters: ExtendedBuscaQuery = { ...filters, cnae_codes: cnaeCodesFromNicho }

      if (filters.municipio) {
        const munResult = await resolveMunicipio(client, filters.municipio, filters.uf)

        if (munResult.type === 'not_found') {
          log.info({ municipio: filters.municipio, uf: filters.uf }, 'Municipio nao encontrado')
          return NextResponse.json({
            action: 'clarify',
            message: `Não encontrei o município "${filters.municipio}" no cadastro. Verifique o nome ou informe a UF.`,
            metadata: { latencyMs, parseSuccess, confidence: intent.confidence },
          })
        }

        if (munResult.type === 'ambiguous') {
          const stateList = munResult.candidates.map((c) => c.uf).join(', ')
          log.info({ municipio: filters.municipio, candidates: munResult.candidates }, 'Municipio ambiguo')
          return NextResponse.json({
            action: 'clarify',
            message: `"${filters.municipio}" existe em mais de um estado (${stateList}). Qual deles você quer buscar?`,
            metadata: { latencyMs, parseSuccess, confidence: intent.confidence },
          })
        }

        // found — replace text name with numeric code for exact-match query
        workingFilters = { ...workingFilters, municipio: munResult.codigo }
        log.debug({ municipio: filters.municipio, codigo: munResult.codigo, uf: munResult.uf }, 'Municipio resolvido')
      }

      log.debug({ filters: workingFilters, workspace_id: authCtx.workspace_id, actor: authCtx.actor }, 'Agent executing search query')

      // Fingerprint uses resolved cnae_principal (not raw nicho) so different phrasings
      // of the same sector share one dedup pool. Accent-normalized in buildQueryFingerprint.
      const fingerprint = buildQueryFingerprint({
        uf:                 workingFilters.uf,
        municipio:          workingFilters.municipio,
        cnae_principal:     workingFilters.cnae_principal,
        nicho:              workingFilters.cnae_principal ? null : rawFilters.nicho,
        situacao_cadastral: workingFilters.situacao_cadastral,
      })

      // Run count (optional) + served-leads lookup before the pagination loop.
      // getServedCnpjs failure (table not yet migrated) falls back to empty set.
      // COUNT(*) can be skipped via DB_SKIP_COUNT=true on large tables without indexes.
      const countPromise = env.DB_SKIP_COUNT
        ? Promise.resolve(null)
        : (() => {
            const { text: countText, values: countValues } = buildCountQuery(workingFilters)
            return client.query(countText, countValues)
          })()

      const [countResult, servedSet] = await Promise.all([
        countPromise,
        getServedCnpjs(client, authCtx.workspace_id, authCtx.dedup_actor_id)
          .catch(() => new Set<string>()),
      ])
      const total: number | null = countResult !== null
        ? Number(countResult.rows[0]?.total ?? 0)
        : null

      // Incremental pagination: fetch one page at a time until we collect
      // requestedLimit fresh (never-served) results or the DB is exhausted.
      //
      // MAX_PAGES scales with requestedLimit so large requests can still fill
      // their quota when dedup history is dense, but is capped at 20 to bound
      // the number of DB round-trips per API call. Beyond 20 pages the tradeoff
      // between freshness and latency/DB pressure tips negative — operators should
      // reset the lead pool or reduce the retention window instead.
      // We log a warning whenever the cap is hit so the condition is visible.
      const accumulated: ReturnType<typeof maskContact>[] = []
      const seenInBatch = new Set<string>()  // prevents cross-page duplicates (unstable ordering)
      let page = workingFilters.page ?? 1
      const MAX_PAGES = Math.min(Math.max(5, requestedLimit), 20)
      let cappedEarly = false

      for (let i = 0; i < MAX_PAGES && accumulated.length < requestedLimit; i++) {
        const { text, values } = buildContactsQuery({ ...workingFilters, page, limit: requestedLimit })
        const rows = await client.query(text, values)
        if (rows.rows.length === 0) break

        const fresh = rows.rows
          .map(maskContact)
          .filter((r) => !servedSet.has(r.cnpj) && !seenInBatch.has(r.cnpj))
        fresh.forEach((r) => seenInBatch.add(r.cnpj))
        accumulated.push(...fresh)

        if (rows.rows.length < requestedLimit) break  // DB returned fewer than batch — exhausted
        if (i === MAX_PAGES - 1 && accumulated.length < requestedLimit) cappedEarly = true
        page++
      }

      if (cappedEarly) {
        log.warn(
          { requestedLimit, filled: accumulated.length, pagesSearched: MAX_PAGES, workspace_id: authCtx.workspace_id },
          'Pagination cap reached — fewer fresh leads than requested; consider resetting the lead pool or reducing the retention window',
        )
      }

      const data = accumulated.slice(0, requestedLimit)

      // Mark results as served (best-effort; table-missing failure must not block response)
      await markAsServed(client, authCtx.workspace_id, authCtx.dedup_actor_id, fingerprint, data.map((r) => r.cnpj))
        .catch(() => {})

      // Narrator: generate natural PT-BR headline + subtitle (always returns a value)
      const narration = await narrateSearchResult(body.message, intent, data, total, llmProfile)

      log.info(
        { resultCount: data.length, total, latencyMs, narratorSource: narration.source, workspace_id: authCtx.workspace_id, actor: authCtx.actor },
        'Agent search success',
      )

      return NextResponse.json({
        action: 'search',
        filters: workingFilters,
        data,
        headline: narration.headline,
        subtitle: narration.subtitle,
        hasCta: narration.hasCta,
        meta: {
          total,
          page: workingFilters.page,
          limit: workingFilters.limit,
          pages: total !== null ? Math.ceil(total / workingFilters.limit) : null,
        },
        metadata: { latencyMs, parseSuccess, confidence: intent.confidence, narratorSource: narration.source },
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

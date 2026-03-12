import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { buscaLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { BuscaQuerySchema } from '@/lib/schemas'
import { buildContactsQuery, buildCountQuery, type ExtendedBuscaQuery } from '@/lib/query-builder'
import { maskContact } from '@/lib/mask-output'
import { getCnaeResolverService } from '@/lib/cnae-resolver-service'
import { requireWorkspaceAuth, authErrorResponse, type AuthContext } from '@/lib/whatsapp/auth-middleware'
import { resolveMunicipio } from '@/lib/municipio-resolver'
import { env } from '@/lib/env'

export async function GET(request: NextRequest) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: '/api/busca', ip })

  // 1. Rate limit — check before any DB work
  const rateLimit = await buscaLimiter.check(ip)
  if (!rateLimit.success) {
    log.warn('Limite de requisições excedido em /api/busca')
    return NextResponse.json(
      { error: 'Muitas requisições — tente novamente em breve' },
      {
        status: 429,
        headers: {
          'Retry-After': String(
            Math.ceil((rateLimit.resetAt - Date.now()) / 1000),
          ),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(rateLimit.resetAt),
        },
      },
    )
  }

  // 2. Parse and validate query parameters (Zod whitelist)
  let parsedFilters
  try {
    const raw = Object.fromEntries(request.nextUrl.searchParams.entries())
    parsedFilters = BuscaQuerySchema.parse(raw)
  } catch (err) {
    if (err instanceof ZodError) {
      log.info({ issues: err.issues }, 'Erro de validacao em /api/busca')
      return NextResponse.json(
        { error: 'Parâmetros inválidos', details: err.issues },
        { status: 400 },
      )
    }
    throw err
  }

  // 3. Auth — must precede CNAE resolution (which may call the IBGE API or DB).
  //    workspace_id is used for audit logging only; cnpj_completo is a public
  //    CNPJ registry shared across all workspaces — filtering by it would be wrong.
  let auth: AuthContext
  {
    const authClient = await pool.connect()
    try {
      auth = await requireWorkspaceAuth(request, authClient)
    } catch (err) {
      const res = authErrorResponse(err)
      if (res) return res
      log.error({ err }, 'Erro inesperado durante autenticação em /api/busca')
      return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
    } finally {
      authClient.release()
    }
  }

  // 4. Resolve nicho → one or more CNAE codes via the 4-layer cascade
  //    (LRU cache → cnae_dictionary → static map → IBGE API)
  //    Safe: only runs after a valid authenticated request.
  let cnaeCodesFromNicho: string[] | undefined
  if (parsedFilters.nicho) {
    const resolved = await getCnaeResolverService().resolve(parsedFilters.nicho)
    if (resolved) {
      // Always route through cnae_codes (= ANY) — exact-match semantics and carries
      // the full merged set from dynamic + static resolver.
      cnaeCodesFromNicho = resolved
      parsedFilters = { ...parsedFilters, cnae_principal: undefined }
      log.debug({ nicho: parsedFilters.nicho, codes: resolved }, 'Nicho resolvido para CNAE')
    }
  }

  // Guard: nicho was given but couldn't be mapped — reject rather than scanning
  // the whole table with no sector filter, which returns meaningless results.
  if (parsedFilters.nicho && !cnaeCodesFromNicho) {
    return NextResponse.json(
      { error: 'Nicho não reconhecido. Tente um segmento mais específico, como "dentistas" ou "restaurantes".' },
      { status: 400 },
    )
  }

  // 5. Execute parameterized queries (single DB connection)
  try {
    const client = await pool.connect()
    try {
      // 5a. Resolve municipio name → numeric codigo_rf (requires mapeamento_municipios).
      //     On ambiguity or not-found, return 400 with a helpful message.
      let workingFilters: ExtendedBuscaQuery = { ...parsedFilters, cnae_codes: cnaeCodesFromNicho }

      if (parsedFilters.municipio) {
        const munResult = await resolveMunicipio(client, parsedFilters.municipio, parsedFilters.uf)

        if (munResult.type === 'not_found') {
          log.info({ municipio: parsedFilters.municipio, uf: parsedFilters.uf }, 'Municipio nao encontrado em mapeamento_municipios')
          return NextResponse.json(
            { error: `Município "${parsedFilters.municipio}" não encontrado. Verifique o nome ou informe a UF.` },
            { status: 400 },
          )
        }

        if (munResult.type === 'ambiguous') {
          log.info({ municipio: parsedFilters.municipio, candidates: munResult.candidates }, 'Municipio ambiguo — solicitar UF')
          return NextResponse.json(
            {
              error: `Município "${parsedFilters.municipio}" existe em mais de um estado. Informe a UF para disambiguar.`,
              candidates: munResult.candidates,
            },
            { status: 400 },
          )
        }

        // found — replace text name with numeric code for exact-match query
        workingFilters = { ...workingFilters, municipio: munResult.codigo }
        log.debug({ municipio: parsedFilters.municipio, codigo: munResult.codigo, uf: munResult.uf }, 'Municipio resolvido')
      }

      log.debug({ filters: workingFilters, workspace_id: auth.workspace_id, actor: auth.actor }, 'Executando busca')

      let data: ReturnType<typeof maskContact>[]
      let total: number | null = null

      if (env.DB_SKIP_COUNT) {
        // Skip COUNT(*) — returns total: null in pagination metadata.
        // Use when the table is large and indexes are not yet in place.
        const { text, values } = buildContactsQuery(workingFilters)
        const rows = await client.query(text, values)
        data = rows.rows.map(maskContact)
      } else {
        const { text, values } = buildContactsQuery(workingFilters)
        const { text: countText, values: countValues } = buildCountQuery(workingFilters)
        const [rows, countResult] = await Promise.all([
          client.query(text, values),
          client.query(countText, countValues),
        ])
        data = rows.rows.map(maskContact)
        total = Number(countResult.rows[0]?.total ?? 0)
      }

      log.info({ resultCount: data.length, total, workspace_id: auth.workspace_id, actor: auth.actor }, 'Busca concluida')

      return NextResponse.json({
        data,
        meta: {
          total,
          page: parsedFilters.page,
          limit: parsedFilters.limit,
          pages: total !== null ? Math.ceil(total / parsedFilters.limit) : null,
        },
      })
    } finally {
      client.release()
    }
  } catch (err) {
    // Log full error server-side; return generic message to client (no stack/SQL leak)
    log.error({ err }, 'Erro de banco de dados em /api/busca')
    return NextResponse.json(
      { error: 'Erro interno do servidor' },
      { status: 500 },
    )
  }
}

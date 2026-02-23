import { describe, it, expect, beforeAll } from 'vitest'
import { z } from 'zod'
import { GET } from '@/app/api/busca/route'
import { NextRequest } from 'next/server'
import pool from '@/lib/database'

// ---------------------------------------------------------------------------
// Contract tests: validate that actual API responses match the versioned
// Zod schemas. If a schema changes in a breaking way, this test breaks —
// forcing a deliberate versioning decision.
// Tests that need DB use ctx.skip() when PostgreSQL is unavailable.
// ---------------------------------------------------------------------------

let dbAvailable = false

beforeAll(async () => {
  try {
    const client = await pool.connect()
    await client.query('SELECT 1')
    client.release()
    dbAvailable = true
  } catch {
    dbAvailable = false
    console.warn('[contracts] PostgreSQL indisponivel — testes de contrato com DB serao ignorados')
  }
})

// PublicEmpresa contract (matches lib/mask-output.ts PublicEmpresa)
const PublicEmpresaSchema = z.object({
  cnpj: z.string(),
  razaoSocial: z.string(),
  nomeFantasia: z.string(),
  uf: z.string(),
  municipio: z.string(),
  cnaePrincipal: z.string(),
  situacao: z.string(),
  telefone1: z.string(),
  telefone2: z.string(),
  email: z.string(),
})

const MetaSchema = z.object({
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  pages: z.number().int().nonnegative(),
})

const BuscaResponseSchema = z.object({
  data: z.array(PublicEmpresaSchema),
  meta: MetaSchema,
})

const ErrorResponseSchema = z.object({
  error: z.string(),
})

describe('API Contract: GET /api/busca', () => {
  it('success response matches BuscaResponseSchema', async (ctx) => {
    if (!dbAvailable) ctx.skip()
    const req = new NextRequest('http://localhost/api/busca', {
      headers: { 'x-forwarded-for': '10.0.2.1' },
    })
    const res = await GET(req)
    if (res.status === 200) {
      const body = await res.json()
      // This will throw with a descriptive error if the contract is violated
      expect(() => BuscaResponseSchema.parse(body)).not.toThrow()
    }
  })

  it('error response matches ErrorResponseSchema for invalid input', async () => {
    const url = new URL('http://localhost/api/busca')
    url.searchParams.set('orderBy', 'invalid_column')
    const req = new NextRequest(url.toString(), {
      headers: { 'x-forwarded-for': '10.0.2.2' },
    })
    const res = await GET(req)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(() => ErrorResponseSchema.parse(body)).not.toThrow()
  })

  it('empresa fields are all strings (no raw DB types leaked)', async (ctx) => {
    if (!dbAvailable) ctx.skip()
    const req = new NextRequest('http://localhost/api/busca', {
      headers: { 'x-forwarded-for': '10.0.2.3' },
    })
    const res = await GET(req)
    if (res.status === 200) {
      const body = await res.json()
      for (const empresa of body.data) {
        expect(typeof empresa.cnpj).toBe('string')
        expect(typeof empresa.razaoSocial).toBe('string')
        expect(typeof empresa.telefone1).toBe('string')
        expect(typeof empresa.email).toBe('string')
      }
    }
  })
})

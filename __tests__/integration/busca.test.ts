import { describe, it, expect, beforeAll } from 'vitest'
import { GET } from '@/app/api/busca/route'
import { NextRequest } from 'next/server'
import pool from '@/lib/database'

// ---------------------------------------------------------------------------
// Integration tests — require a running PostgreSQL test database with the
// estabelecimentos table seeded.
//
// In CI, a PostgreSQL service container is used (see .github/workflows/ci.yml).
// Locally: docker run -e POSTGRES_DB=prospeccao_test -e POSTGRES_USER=prospeccao_app
//          -e POSTGRES_PASSWORD=testpassword_ci -p 5432:5432 postgres:16
//
// Tests that need DB use ctx.skip() when DB is unavailable (shown as SKIP, not PASS).
// Validation tests (400/429) run regardless of DB availability.
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
    console.warn('[integration/busca] PostgreSQL indisponivel — testes de DB serao ignorados')
  }
})

function makeRequest(params: Record<string, string> = {}, ip = '10.0.1.1'): NextRequest {
  const url = new URL('http://localhost/api/busca')
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  return new NextRequest(url.toString(), {
    headers: { 'x-forwarded-for': ip },
  })
}

describe('GET /api/busca', () => {
  it('returns 200 with data and meta fields', async (ctx) => {
    if (!dbAvailable) ctx.skip()
    const req = makeRequest()
    const res = await GET(req)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toHaveProperty('data')
    expect(body).toHaveProperty('meta')
    expect(Array.isArray(body.data)).toBe(true)
  })

  it('returns paginated results with correct meta', async (ctx) => {
    if (!dbAvailable) ctx.skip()
    const req = makeRequest({ limit: '5', page: '1' })
    const res = await GET(req)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.meta.limit).toBe(5)
    expect(body.meta.page).toBe(1)
    expect(typeof body.meta.total).toBe('number')
    expect(typeof body.meta.pages).toBe('number')
    expect(body.data.length).toBeLessThanOrEqual(5)
  })

  // Validation tests — do NOT require DB
  it('returns 400 for invalid orderBy', async () => {
    const req = makeRequest({ orderBy: 'email' })
    const res = await GET(req)
    expect(res.status).toBe(400)
  })

  it('returns 400 for limit over 100', async () => {
    const req = makeRequest({ limit: '200' })
    const res = await GET(req)
    expect(res.status).toBe(400)
  })

  it('returns 400 for invalid uf (not 2 chars)', async () => {
    const req = makeRequest({ uf: 'Sao Paulo' })
    const res = await GET(req)
    expect(res.status).toBe(400)
  })

  it('returns 400 for invalid situacao_cadastral', async () => {
    const req = makeRequest({ situacao_cadastral: 'INVALIDA' })
    const res = await GET(req)
    expect(res.status).toBe(400)
  })

  it('returns correct CNPJ fields in each empresa', async (ctx) => {
    if (!dbAvailable) ctx.skip()
    const req = makeRequest({ limit: '1' })
    const res = await GET(req)
    const body = await res.json()
    if (body.data.length > 0) {
      const empresa = body.data[0]
      expect(empresa).toHaveProperty('cnpj')
      expect(empresa).toHaveProperty('razaoSocial')
      expect(empresa).toHaveProperty('uf')
      expect(empresa).toHaveProperty('municipio')
      expect(empresa).toHaveProperty('cnaePrincipal')
      expect(empresa).toHaveProperty('situacao')
      expect(empresa).toHaveProperty('telefone1')
      expect(empresa).toHaveProperty('email')
    }
  })

  it('does not expose raw DB column names', async (ctx) => {
    if (!dbAvailable) ctx.skip()
    const req = makeRequest()
    const res = await GET(req)
    const body = await res.json()
    for (const empresa of body.data) {
      expect('cnpj_completo' in empresa).toBe(false)
      expect('razao_social' in empresa).toBe(false)
      expect('correio_eletronico' in empresa).toBe(false)
    }
  })

  it('returns 429 when rate limit is exceeded', async (ctx) => {
    // Skip when DB is unavailable: 65 concurrent requests without DB generates
    // a storm of ECONNREFUSED errors that obscure real failures.
    // Rate-limit enforcement is also covered in __tests__/security/dos.test.ts.
    if (!dbAvailable) ctx.skip()
    const ip = '88.0.0.1'
    const requests = Array.from({ length: 65 }, () => GET(makeRequest({}, ip)))
    const responses = await Promise.all(requests)
    const statuses = responses.map((r) => r.status)
    expect(statuses).toContain(429)
  })
})

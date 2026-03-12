import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Unit tests — csv-actions.ts (exportPoolCsv, importPoolCsv, buildExportFilename)
//
// Pure logic tests: fetch is stubbed per-test so no network / MSW needed.
// DOM side-effects (triggerDownload) are swallowed by happy-dom stubs.
// ---------------------------------------------------------------------------

import {
  exportPoolCsv,
  importPoolCsv,
  buildExportFilename,
} from '@/app/whatsapp/listas/csv-actions'

// ---------------------------------------------------------------------------
// DOM stubs (happy-dom lacks URL.createObjectURL)
// ---------------------------------------------------------------------------

beforeAll(() => {
  if (!URL.createObjectURL) {
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:mock'), writable: true })
  }
  if (!URL.revokeObjectURL) {
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), writable: true })
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetch(status: number, body: unknown = {}, contentType = 'application/json'): void {
  const isBlob = contentType.startsWith('text/csv')
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
    blob: () => Promise.resolve(new Blob([isBlob ? 'csv,data' : ''], { type: contentType })),
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// buildExportFilename
// ---------------------------------------------------------------------------

describe('buildExportFilename', () => {
  it('converts pool name to safe filename', () => {
    expect(buildExportFilename('Dentistas SP 2026')).toBe('Dentistas_SP_2026.csv')
  })

  it('falls back to "lista" when name has only special chars', () => {
    expect(buildExportFilename('!!!###')).toBe('lista.csv')
  })

  it('appends .csv extension', () => {
    expect(buildExportFilename('minha lista')).toMatch(/\.csv$/)
  })

  it('trims leading and trailing spaces', () => {
    expect(buildExportFilename('  pool  ')).toBe('pool.csv')
  })
})

// ---------------------------------------------------------------------------
// exportPoolCsv — HTTP status handling
// ---------------------------------------------------------------------------

describe('exportPoolCsv — success', () => {
  it('returns ok:true when API responds 200 with text/csv', async () => {
    mockFetch(200, 'cnpj,razao_social\n12345,Empresa', 'text/csv')
    const result = await exportPoolCsv('pool-1', 'Minha Lista')
    expect(result.ok).toBe(true)
  })

  it('calls /api/lead-pools/:id/export with the correct pool id', async () => {
    mockFetch(200, '', 'text/csv')
    await exportPoolCsv('abc-123', 'Lista Teste')
    const fetchMock = vi.mocked(fetch)
    expect(fetchMock).toHaveBeenCalledOnce()
    const calledUrl = String((fetchMock.mock.calls[0] as unknown[])[0])
    expect(calledUrl).toBe('/api/lead-pools/abc-123/export')
  })
})

describe('exportPoolCsv — feature gate (403)', () => {
  it('returns ok:false with code "forbidden" on 403', async () => {
    mockFetch(403, { error: 'plano não inclui exportação' })
    const result = await exportPoolCsv('pool-1', 'Lista')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('forbidden')
      expect(result.message).toMatch(/plano|contate/i)
    }
  })
})

describe('exportPoolCsv — not found (404)', () => {
  it('returns ok:false with code "not_found" on 404', async () => {
    mockFetch(404, { error: 'pool not found' })
    const result = await exportPoolCsv('missing-id', 'Lista')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('not_found')
  })
})

describe('exportPoolCsv — rate limit (429)', () => {
  it('returns ok:false with code "rate_limited" on 429', async () => {
    mockFetch(429, { error: 'too many requests' })
    const result = await exportPoolCsv('pool-1', 'Lista')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('rate_limited')
  })
})

describe('exportPoolCsv — server error (500)', () => {
  it('returns ok:false with code "error" on 500', async () => {
    mockFetch(500, { error: 'internal server error' })
    const result = await exportPoolCsv('pool-1', 'Lista')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('error')
  })
})

describe('exportPoolCsv — network failure', () => {
  it('returns ok:false with code "error" when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')))
    const result = await exportPoolCsv('pool-1', 'Lista')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('error')
  })
})

// ---------------------------------------------------------------------------
// importPoolCsv — HTTP status handling
// ---------------------------------------------------------------------------

function makeFile(content = 'cnpj,razao_social\n12345,Empresa', name = 'leads.csv'): File {
  return new File([content], name, { type: 'text/csv' })
}

describe('importPoolCsv — success (201)', () => {
  it('returns ok:true with imported / errors counts', async () => {
    mockFetch(201, {
      data: { id: 'pool-new' },
      meta: { imported: 5, errors: 1, error_details: [{ row: 3, message: 'bad' }], rowCount: 6 },
    })
    const result = await importPoolCsv(makeFile(), 'Minha Lista')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.imported).toBe(5)
      expect(result.errors).toBe(1)
      expect(result.errorDetails).toHaveLength(1)
    }
  })

  it('calls /api/lead-pools/import via POST', async () => {
    mockFetch(201, { data: {}, meta: { imported: 1, errors: 0 } })
    await importPoolCsv(makeFile(), '')
    const fetchMock = vi.mocked(fetch)
    expect(fetchMock).toHaveBeenCalledOnce()
    const call = fetchMock.mock.calls[0] as unknown[]
    expect(String(call[0])).toBe('/api/lead-pools/import')
    expect((call[1] as RequestInit).method).toBe('POST')
  })

  it('attaches name to FormData when provided', async () => {
    mockFetch(201, { data: {}, meta: { imported: 1, errors: 0 } })
    await importPoolCsv(makeFile(), 'Lista Médicos')
    const call = (vi.mocked(fetch).mock.calls[0] as unknown[])
    const body = (call[1] as RequestInit).body as FormData
    expect(body.get('name')).toBe('Lista Médicos')
  })

  it('does not attach name when empty', async () => {
    mockFetch(201, { data: {}, meta: { imported: 2, errors: 0 } })
    await importPoolCsv(makeFile(), '   ')
    const call = (vi.mocked(fetch).mock.calls[0] as unknown[])
    const body = (call[1] as RequestInit).body as FormData
    expect(body.get('name')).toBeNull()
  })
})

describe('importPoolCsv — feature gate (403)', () => {
  it('returns ok:false with code "forbidden" on 403', async () => {
    mockFetch(403, { error: 'plano não inclui importação' })
    const result = await importPoolCsv(makeFile(), '')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('forbidden')
      expect(result.message).toMatch(/plano|contate/i)
    }
  })
})

describe('importPoolCsv — validation error (400)', () => {
  it('returns ok:false with code "invalid" and server message on 400', async () => {
    mockFetch(400, { error: 'Nenhum lead válido encontrado no arquivo.' })
    const result = await importPoolCsv(makeFile('', 'empty.csv'), '')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('invalid')
      expect(result.message).toContain('Nenhum lead válido')
    }
  })
})

describe('importPoolCsv — rate limit (429)', () => {
  it('returns ok:false with code "rate_limited" on 429', async () => {
    mockFetch(429, { error: 'too many requests' })
    const result = await importPoolCsv(makeFile(), '')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('rate_limited')
  })
})

describe('importPoolCsv — server error (500)', () => {
  it('returns ok:false with code "error" on 500', async () => {
    mockFetch(500, { error: 'internal server error' })
    const result = await importPoolCsv(makeFile(), '')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('error')
  })
})

describe('importPoolCsv — network failure', () => {
  it('returns ok:false with code "error" when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const result = await importPoolCsv(makeFile(), '')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('error')
  })
})

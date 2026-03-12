// ---------------------------------------------------------------------------
// CSV import / export actions for the /whatsapp/listas page.
//
// These are plain async functions (no React) so they can be unit-tested
// without rendering the component.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExportOutcome =
  | { ok: true }
  | { ok: false; code: 'forbidden' | 'not_found' | 'rate_limited' | 'error'; message: string }

export interface ImportSuccess {
  ok: true
  imported: number
  errors: number
  errorDetails: unknown[]
}

export interface ImportFailure {
  ok: false
  code: 'forbidden' | 'rate_limited' | 'invalid' | 'error'
  message: string
}

export type ImportOutcome = ImportSuccess | ImportFailure

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Derives a safe ASCII filename from a pool name. */
export function buildExportFilename(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_\-\s]/g, '').trim().replace(/\s+/g, '_') || 'lista'
  return `${safe}.csv`
}

/** Sample CSV the user can download to see the expected format. */
export const SAMPLE_CSV_CONTENT =
  'cnpj,razao_social,telefone,email,municipio,uf\n' +
  '12345678000195,Empresa Exemplo Ltda,11999999999,contato@exemplo.com,SAO PAULO,SP\n' +
  '98765432000100,Outra Empresa SA,21888888888,oi@outra.com,RIO DE JANEIRO,RJ\n'

export function downloadSampleCsv(): void {
  const blob = new Blob([SAMPLE_CSV_CONTENT], { type: 'text/csv;charset=utf-8' })
  triggerDownload(blob, 'exemplo_importacao.csv')
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ---------------------------------------------------------------------------
// Export pool as CSV
// ---------------------------------------------------------------------------

export async function exportPoolCsv(poolId: string, poolName: string): Promise<ExportOutcome> {
  let res: Response
  try {
    res = await fetch(`/api/lead-pools/${poolId}/export`)
  } catch {
    return { ok: false, code: 'error', message: 'Erro de conexão ao exportar lista.' }
  }

  if (res.status === 403) {
    return {
      ok: false,
      code: 'forbidden',
      message: 'Seu plano não inclui exportação de CSV. Contate o suporte para habilitar.',
    }
  }
  if (res.status === 429) {
    return { ok: false, code: 'rate_limited', message: 'Muitas tentativas — aguarde um momento.' }
  }
  if (res.status === 404) {
    return { ok: false, code: 'not_found', message: 'Lista não encontrada.' }
  }
  if (!res.ok) {
    return { ok: false, code: 'error', message: `Erro ao exportar lista (${res.status}).` }
  }

  try {
    const blob = await res.blob()
    triggerDownload(blob, buildExportFilename(poolName))
    return { ok: true }
  } catch {
    return { ok: false, code: 'error', message: 'Erro ao processar arquivo exportado.' }
  }
}

// ---------------------------------------------------------------------------
// Import CSV → new pool
// ---------------------------------------------------------------------------

export async function importPoolCsv(file: File, name: string): Promise<ImportOutcome> {
  const form = new FormData()
  form.append('file', file)
  if (name.trim()) form.append('name', name.trim())

  let res: Response
  try {
    res = await fetch('/api/lead-pools/import', { method: 'POST', body: form })
  } catch {
    return { ok: false, code: 'error', message: 'Erro de conexão ao importar CSV.' }
  }

  if (res.status === 403) {
    return {
      ok: false,
      code: 'forbidden',
      message: 'Seu plano não inclui importação de CSV. Contate o suporte para habilitar.',
    }
  }
  if (res.status === 429) {
    return { ok: false, code: 'rate_limited', message: 'Muitas tentativas — aguarde um momento e tente novamente.' }
  }

  let body: Record<string, unknown>
  try {
    body = (await res.json()) as Record<string, unknown>
  } catch {
    return { ok: false, code: 'error', message: `Erro ao processar resposta (${res.status}).` }
  }

  if (!res.ok) {
    const msg = typeof body.error === 'string' ? body.error : `Erro ${res.status}`
    const code = res.status >= 500 ? 'error' : 'invalid'
    return { ok: false, code, message: msg }
  }

  const meta = (body.meta ?? {}) as Record<string, unknown>
  return {
    ok:          true,
    imported:    Number(meta.imported ?? 0),
    errors:      Number(meta.errors ?? 0),
    errorDetails: Array.isArray(meta.error_details) ? meta.error_details : [],
  }
}

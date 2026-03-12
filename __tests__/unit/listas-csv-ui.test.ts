import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// ---------------------------------------------------------------------------
// Static source analysis — /whatsapp/listas page: CSV import/export UI
//
// Verifies that the import/export buttons, modal, loading states, and
// feature-gate (403) handling are present in the source.
//
// Strategy: readFileSync + pattern matching, same approach used in
// templates-page-ui.test.ts and useConversations-filters.test.ts.
// No React rendering required.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, '../..')

function readSrc(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf-8')
}

const PAGE_SRC   = readSrc('app/whatsapp/listas/page.tsx')
const ACTION_SRC = readSrc('app/whatsapp/listas/csv-actions.ts')

// ---------------------------------------------------------------------------
// Import button
// ---------------------------------------------------------------------------

describe('Listas page — Import CSV button', () => {
  it('renders an "Importar CSV" button in the page header', () => {
    expect(PAGE_SRC).toMatch(/Importar CSV/)
  })

  it('button has data-testid="btn-import-csv"', () => {
    expect(PAGE_SRC).toMatch(/data-testid="btn-import-csv"/)
  })

  it('button triggers openImport handler', () => {
    expect(PAGE_SRC).toMatch(/openImport/)
  })

  it('uses Upload icon', () => {
    expect(PAGE_SRC).toMatch(/Upload/)
  })
})

// ---------------------------------------------------------------------------
// Export CSV button per row
// ---------------------------------------------------------------------------

describe('Listas page — Export CSV button per row', () => {
  it('renders a CSV/export button inside the table row actions', () => {
    // Should reference handleExport or exportPoolCsv in the row
    expect(PAGE_SRC).toMatch(/handleExport/)
  })

  it('button has data-testid pattern btn-export-{pool.id}', () => {
    expect(PAGE_SRC).toMatch(/data-testid=\{`btn-export-\$\{pool\.id\}`\}/)
  })

  it('uses Download icon', () => {
    expect(PAGE_SRC).toMatch(/Download/)
  })

  it('shows Loader2 spinner while exporting', () => {
    // exportingId === pool.id → spinner
    expect(PAGE_SRC).toMatch(/exportingId\s*===\s*pool\.id/)
  })

  it('disables export button while any export is in progress', () => {
    expect(PAGE_SRC).toMatch(/exportingId\s*!==\s*null/)
  })
})

// ---------------------------------------------------------------------------
// Import modal
// ---------------------------------------------------------------------------

describe('Listas page — Import CSV modal', () => {
  it('modal is conditionally rendered based on importOpen state', () => {
    expect(PAGE_SRC).toMatch(/importOpen/)
  })

  it('modal contains a file input restricted to .csv files', () => {
    expect(PAGE_SRC).toMatch(/accept=["'].*\.csv.*["']/)
  })

  it('modal has a pool name text input', () => {
    expect(PAGE_SRC).toMatch(/Nome da lista/)
  })

  it('submit button is disabled when no file is selected', () => {
    expect(PAGE_SRC).toMatch(/!\s*importFile/)
  })

  it('submit button shows loading state while importing', () => {
    expect(PAGE_SRC).toMatch(/Importando\.\.\./)
  })

  it('has a confirm import button with data-testid', () => {
    expect(PAGE_SRC).toMatch(/data-testid="btn-confirm-import"/)
  })

  it('shows success summary after 201 response', () => {
    expect(PAGE_SRC).toMatch(/Importação concluída/)
  })

  it('shows error message in modal for failed imports', () => {
    // importResult.ok === false → error shown inline
    expect(PAGE_SRC).toMatch(/importResult\.message/)
  })

  it('includes a "Baixar exemplo de CSV" link', () => {
    expect(PAGE_SRC).toMatch(/Baixar exemplo de CSV/)
    expect(PAGE_SRC).toMatch(/downloadSampleCsv/)
  })
})

// ---------------------------------------------------------------------------
// Feature gate handling
// ---------------------------------------------------------------------------

describe('Listas page — feature gate (403) handling', () => {
  it('handleExport checks for forbidden outcome code', () => {
    expect(PAGE_SRC).toMatch(/code.*===.*'forbidden'|'forbidden'.*===.*code/)
  })

  it('shows toast.error for forbidden export', () => {
    expect(PAGE_SRC).toMatch(/toast\.error/)
  })

  it('import modal shows Lock icon on forbidden result', () => {
    expect(PAGE_SRC).toMatch(/Lock/)
  })

  it('import modal distinguishes forbidden from other errors', () => {
    expect(PAGE_SRC).toMatch(/importResult\.code.*===.*'forbidden'|'forbidden'.*===.*importResult\.code/)
  })
})

// ---------------------------------------------------------------------------
// Loading states
// ---------------------------------------------------------------------------

describe('Listas page — loading states', () => {
  it('tracks exportingId state for per-row loading', () => {
    expect(PAGE_SRC).toMatch(/exportingId.*useState|useState.*exportingId/)
  })

  it('tracks importing boolean state for import submission', () => {
    expect(PAGE_SRC).toMatch(/importing.*useState|useState.*importing/)
  })

  it('disables import close button while importing', () => {
    expect(PAGE_SRC).toMatch(/disabled=\{importing\}/)
  })
})

// ---------------------------------------------------------------------------
// csv-actions module
// ---------------------------------------------------------------------------

describe('csv-actions — exports', () => {
  it('exports exportPoolCsv function', () => {
    expect(ACTION_SRC).toMatch(/export\s+async\s+function\s+exportPoolCsv/)
  })

  it('exports importPoolCsv function', () => {
    expect(ACTION_SRC).toMatch(/export\s+async\s+function\s+importPoolCsv/)
  })

  it('exports buildExportFilename function', () => {
    expect(ACTION_SRC).toMatch(/export\s+function\s+buildExportFilename/)
  })

  it('exports SAMPLE_CSV_CONTENT constant', () => {
    expect(ACTION_SRC).toMatch(/export\s+const\s+SAMPLE_CSV_CONTENT/)
  })

  it('exports downloadSampleCsv function', () => {
    expect(ACTION_SRC).toMatch(/export\s+function\s+downloadSampleCsv/)
  })

  it('sample CSV includes expected headers', () => {
    expect(ACTION_SRC).toMatch(/cnpj.*razao_social.*telefone/)
  })

  it('handles 403 with forbidden code in exportPoolCsv', () => {
    expect(ACTION_SRC).toMatch(/status.*===.*403|403.*===.*status/)
  })

  it('handles 403 with forbidden code in importPoolCsv', () => {
    const importSection = ACTION_SRC.slice(ACTION_SRC.indexOf('importPoolCsv'))
    expect(importSection).toMatch(/status.*===.*403|403.*===.*status/)
  })
})

'use client'

// ---------------------------------------------------------------------------
// /whatsapp/listas — full-page management for saved lead pools.
//
// Data is loaded from the server on mount (and on manual refresh) so the
// state survives a hard refresh (F5). The floating AgentChat remains the
// entry-point for creating new pools; this page handles the operational
// side: browse, paginate, inspect leads, delete, launch campaigns,
// import CSV, and export CSV.
//
// Partial selection: opening the detail modal pre-selects all leads.
// The user can then deselect individual leads or use "Selecionar todos" /
// "Limpar seleção" before clicking "Criar Campanha".
// ---------------------------------------------------------------------------

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  List, Trash2, Users, ChevronLeft, ChevronRight, X, Loader2,
  Building2, RefreshCw, Upload, Download, Lock, AlertCircle,
} from 'lucide-react'
import { toast, Toaster } from 'sonner'
import CampaignWizard from '@/app/components/CampaignWizard'
import type { PublicEmpresa } from '@/lib/mask-output'
import {
  exportPoolCsv,
  importPoolCsv,
  downloadSampleCsv,
  type ImportOutcome,
} from '@/app/whatsapp/listas/csv-actions'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LeadPool {
  id: string
  name: string
  lead_count: number
  created_at: string
  query_fingerprint: string | null
}

interface LeadPoolDetail extends LeadPool {
  leads_json: PublicEmpresa[]
}

interface PendingCampaign {
  campaignId: string
  confirmationToken: string
  recipients: PublicEmpresa[]
}

// ---------------------------------------------------------------------------
// Pure helper — exported for unit testing only.
//
// Filters the leads array down to the user-selected subset and maps each
// entry to the shape expected by POST /api/campaigns `recipients`.
// Throws (instead of silently sending zero recipients) when nothing is
// selected, so the caller can surface a clear error to the user.
// ---------------------------------------------------------------------------

export interface CampaignRecipient {
  cnpj: string
  razao_social: string
  nome_fantasia?: string
  telefone?: string
  email?: string
  municipio?: string
  uf?: string
}

export function buildRecipients(
  leads: PublicEmpresa[],
  selectedIds: ReadonlySet<string>,
): CampaignRecipient[] {
  const selected = leads.filter((l) => selectedIds.has(l.cnpj))
  if (selected.length === 0) throw new Error('Selecione ao menos 1 lead.')
  return selected.map((r) => ({
    cnpj:          r.cnpj,
    razao_social:  r.razaoSocial,
    nome_fantasia: r.nomeFantasia || undefined,
    telefone:      r.telefone1 || r.telefone2 || undefined,
    email:         r.email || undefined,
    municipio:     r.municipio || undefined,
    uf:            r.uf || undefined,
  }))
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGE_SIZE = 20

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ListasPage() {
  // List state
  const [pools, setPools]     = useState<LeadPool[]>([])
  const [total, setTotal]     = useState(0)
  const [offset, setOffset]   = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState<string | null>(null)

  // Detail modal
  const [detail, setDetail]               = useState<LeadPoolDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError]     = useState<string | null>(null)

  // Partial selection: set of selected CNPJs
  const [selectedLeadIds, setSelectedLeadIds] = useState<Set<string>>(new Set())

  // Delete
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // Campaign launch
  const [pendingCampaign, setPendingCampaign] = useState<PendingCampaign | null>(null)
  const [campaignLoading, setCampaignLoading] = useState(false)
  const [campaignError, setCampaignError]     = useState<string | null>(null)

  // Export: track which pool is being exported
  const [exportingId, setExportingId] = useState<string | null>(null)

  // Import modal
  const [importOpen, setImportOpen]       = useState(false)
  const [importFile, setImportFile]       = useState<File | null>(null)
  const [importName, setImportName]       = useState('')
  const [importing, setImporting]         = useState(false)
  const [importResult, setImportResult]   = useState<ImportOutcome | null>(null)
  const fileInputRef                      = useRef<HTMLInputElement>(null)

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  const fetchPools = useCallback(async (newOffset: number) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/lead-pools?limit=${PAGE_SIZE}&offset=${newOffset}`)
      if (res.status === 401) { window.location.href = '/login'; return }
      if (!res.ok) throw new Error(`Erro ${res.status}`)
      const data = await res.json() as { data: LeadPool[]; meta: { total: number } }
      setPools(data.data)
      setTotal(data.meta.total)
      setOffset(newOffset)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar listas')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchPools(0)
  }, [fetchPools])

  // ---------------------------------------------------------------------------
  // Detail
  // ---------------------------------------------------------------------------

  const openDetail = useCallback(async (poolId: string) => {
    setDetailLoading(true)
    setDetailError(null)
    setDetail(null)
    setCampaignError(null)
    try {
      const res = await fetch(`/api/lead-pools/${poolId}`)
      if (!res.ok) throw new Error(`Erro ${res.status}`)
      const data = await res.json() as { data: LeadPoolDetail }
      // Pre-select all leads on open
      setSelectedLeadIds(new Set((data.data.leads_json ?? []).map((l) => l.cnpj)))
      setDetail(data.data)
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : 'Erro ao carregar detalhes')
    } finally {
      setDetailLoading(false)
    }
  }, [])

  const closeDetail = useCallback(() => {
    setDetail(null)
    setDetailError(null)
    setSelectedLeadIds(new Set())
    setCampaignError(null)
  }, [])

  // ---------------------------------------------------------------------------
  // Delete
  // ---------------------------------------------------------------------------

  const deletePool = useCallback(async (poolId: string, poolName: string) => {
    if (!confirm(`Excluir "${poolName}"? Esta ação não pode ser desfeita.`)) return
    setDeletingId(poolId)
    try {
      const res = await fetch(`/api/lead-pools/${poolId}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`Erro ${res.status}`)
      if (detail?.id === poolId) closeDetail()
      await fetchPools(offset)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao excluir lista')
    } finally {
      setDeletingId(null)
    }
  }, [detail, fetchPools, offset, closeDetail])

  // ---------------------------------------------------------------------------
  // Export CSV
  // ---------------------------------------------------------------------------

  const handleExport = useCallback(async (poolId: string, poolName: string) => {
    setExportingId(poolId)
    const outcome = await exportPoolCsv(poolId, poolName)
    setExportingId(null)
    if (outcome.ok) {
      toast.success('CSV exportado com sucesso.')
    } else if (outcome.code === 'forbidden') {
      toast.error(outcome.message, { duration: 6000 })
    } else {
      toast.error(outcome.message)
    }
  }, [])

  // ---------------------------------------------------------------------------
  // Import CSV modal
  // ---------------------------------------------------------------------------

  const openImport = useCallback(() => {
    setImportOpen(true)
    setImportFile(null)
    setImportName('')
    setImportResult(null)
  }, [])

  const closeImport = useCallback(() => {
    setImportOpen(false)
    setImportFile(null)
    setImportName('')
    setImportResult(null)
  }, [])

  const handleImport = useCallback(async () => {
    if (!importFile) return
    setImporting(true)
    setImportResult(null)
    const outcome = await importPoolCsv(importFile, importName)
    setImporting(false)
    setImportResult(outcome)
    if (outcome.ok) {
      toast.success(`${outcome.imported} empresa(s) importadas com sucesso.`)
      await fetchPools(0)
      // Keep modal open so user can see the summary; they close manually
    }
  }, [importFile, importName, fetchPools])

  // ---------------------------------------------------------------------------
  // Campaign launch (from detail modal with partial selection)
  // ---------------------------------------------------------------------------

  const startCampaignFromDetail = useCallback(async () => {
    if (!detail) return
    setCampaignLoading(true)
    setCampaignError(null)
    try {
      const recipients = buildRecipients(detail.leads_json ?? [], selectedLeadIds)

      const campaignRes = await fetch('/api/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:       `Campanha: ${detail.name.slice(0, 100)}`,
          recipients,
        }),
      })
      if (!campaignRes.ok) {
        const err = await campaignRes.json().catch(() => ({})) as { error?: string }
        throw new Error(err.error ?? `Erro ${campaignRes.status}`)
      }
      const campaignData = await campaignRes.json() as {
        data: { id: string }
        confirmation_token: string
      }
      setPendingCampaign({
        campaignId:        campaignData.data.id,
        confirmationToken: campaignData.confirmation_token,
        recipients:        (detail.leads_json ?? []).filter((l) => selectedLeadIds.has(l.cnpj)),
      })
      closeDetail()
    } catch (err) {
      setCampaignError(err instanceof Error ? err.message : 'Erro ao iniciar campanha')
    } finally {
      setCampaignLoading(false)
    }
  }, [detail, selectedLeadIds, closeDetail])

  // ---------------------------------------------------------------------------
  // Selection helpers
  // ---------------------------------------------------------------------------

  const selectAll = useCallback(() => {
    if (!detail) return
    setSelectedLeadIds(new Set((detail.leads_json ?? []).map((l) => l.cnpj)))
  }, [detail])

  const clearSelection = useCallback(() => {
    setSelectedLeadIds(new Set())
  }, [])

  const toggleLead = useCallback((cnpj: string) => {
    setSelectedLeadIds((prev) => {
      const next = new Set(prev)
      if (next.has(cnpj)) next.delete(cnpj)
      else next.add(cnpj)
      return next
    })
  }, [])

  // ---------------------------------------------------------------------------
  // Pagination
  // ---------------------------------------------------------------------------

  const totalPages  = Math.ceil(total / PAGE_SIZE)
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const leads         = detail?.leads_json ?? []
  const selectedCount = leads.filter((l) => selectedLeadIds.has(l.cnpj)).length

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <Toaster richColors position="top-right" />

      {/* Page header */}
      <div className="mb-6 flex items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-800">
            <List className="size-5 text-emerald-600" />
            Listas Salvas
          </h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Buscas com resultados são salvas automaticamente pelo agente de prospecção.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Import CSV button */}
          <button
            data-testid="btn-import-csv"
            onClick={openImport}
            className="flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-700 hover:bg-emerald-100"
          >
            <Upload className="size-4" />
            Importar CSV
          </button>

          <button
            onClick={() => void fetchPools(offset)}
            disabled={loading}
            title="Atualizar"
            className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-40"
          >
            <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
            Atualizar
          </button>
        </div>
      </div>

      {/* Error banners */}
      {error && (
        <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>
      )}

      {/* Table */}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        {loading && pools.length === 0 ? (
          <div className="flex justify-center py-16">
            <Loader2 className="size-6 animate-spin text-slate-400" />
          </div>
        ) : pools.length === 0 ? (
          <div className="py-16 text-center text-sm text-slate-400">
            <List className="mx-auto mb-3 size-10 opacity-20" />
            <p>Nenhuma lista salva ainda.</p>
            <p className="mt-1 text-xs">Use o agente de prospecção para buscar empresas.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 bg-slate-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-slate-600">Nome</th>
                <th className="px-4 py-3 text-center font-medium text-slate-600">Empresas</th>
                <th className="px-4 py-3 text-left font-medium text-slate-600">Criada em</th>
                <th className="px-4 py-3 text-right font-medium text-slate-600">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pools.map((pool) => (
                <tr key={pool.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <button
                      onClick={() => void openDetail(pool.id)}
                      className="max-w-xs truncate text-left font-medium text-slate-800 hover:text-emerald-700"
                      title={pool.name}
                    >
                      {pool.name}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-center text-slate-600">{pool.lead_count}</td>
                  <td className="px-4 py-3 text-slate-500">
                    {new Date(pool.created_at).toLocaleString('pt-BR', {
                      day: '2-digit', month: '2-digit', year: 'numeric',
                      hour: '2-digit', minute: '2-digit',
                    })}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      {/* Export CSV button */}
                      <button
                        data-testid={`btn-export-${pool.id}`}
                        onClick={() => void handleExport(pool.id, pool.name)}
                        disabled={exportingId !== null || deletingId !== null}
                        title="Exportar lista como CSV"
                        className="flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 hover:border-emerald-200 hover:bg-emerald-50 hover:text-emerald-700 disabled:opacity-40"
                      >
                        {exportingId === pool.id ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Download className="size-3.5" />
                        )}
                        CSV
                      </button>

                      <button
                        onClick={() => void openDetail(pool.id)}
                        disabled={deletingId !== null}
                        title="Selecionar leads e iniciar campanha"
                        className="flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
                      >
                        <Users className="size-3.5" />
                        Campanha
                      </button>
                      <button
                        onClick={() => void deletePool(pool.id, pool.name)}
                        disabled={deletingId !== null}
                        title="Excluir lista"
                        className="rounded-lg border border-slate-200 p-1.5 text-slate-400 hover:border-red-200 hover:bg-red-50 hover:text-red-500 disabled:opacity-40"
                      >
                        {deletingId === pool.id ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="size-3.5" />
                        )}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm text-slate-500">
          <span>
            Página {currentPage} de {totalPages} · {total} lista{total !== 1 ? 's' : ''}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => void fetchPools(offset - PAGE_SIZE)}
              disabled={offset === 0 || loading}
              className="flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 hover:bg-slate-50 disabled:opacity-40"
            >
              <ChevronLeft className="size-4" />
              Anterior
            </button>
            <button
              onClick={() => void fetchPools(offset + PAGE_SIZE)}
              disabled={offset + PAGE_SIZE >= total || loading}
              className="flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 hover:bg-slate-50 disabled:opacity-40"
            >
              Próxima
              <ChevronRight className="size-4" />
            </button>
          </div>
        </div>
      )}

      {/* Detail modal */}
      {(detailLoading || detailError !== null || detail !== null) && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) closeDetail() }}
        >
          <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl bg-white shadow-2xl">
            {/* Modal header */}
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
              <h2 className="font-semibold text-slate-800">
                {detail ? detail.name : 'Carregando...'}
              </h2>
              <button
                onClick={closeDetail}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100"
              >
                <X className="size-5" />
              </button>
            </div>

            {/* Selection action bar (only when leads are loaded) */}
            {detail && (
              <div className="flex items-center gap-3 border-b border-slate-100 bg-slate-50 px-5 py-2.5">
                <button
                  onClick={selectAll}
                  className="text-xs text-emerald-700 hover:underline"
                >
                  Selecionar todos
                </button>
                <span className="text-slate-300">·</span>
                <button
                  onClick={clearSelection}
                  className="text-xs text-slate-500 hover:underline"
                >
                  Limpar seleção
                </button>
                <span className="ml-auto text-xs text-slate-500">
                  Selecionados: <span className="font-medium text-slate-700">{selectedCount}</span> de {leads.length}
                </span>
              </div>
            )}

            {/* Modal body */}
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {detailLoading && (
                <div className="flex justify-center py-8">
                  <Loader2 className="size-5 animate-spin text-slate-400" />
                </div>
              )}
              {detailError && (
                <p className="text-sm text-red-600">{detailError}</p>
              )}
              {detail && (
                <>
                  <p className="mb-3 text-xs text-slate-500">
                    {detail.lead_count} empresa{detail.lead_count !== 1 ? 's' : ''} ·{' '}
                    criada em{' '}
                    {new Date(detail.created_at).toLocaleDateString('pt-BR', {
                      day: '2-digit', month: '2-digit', year: 'numeric',
                    })}
                  </p>
                  <div className="space-y-1">
                    {leads.map((lead) => (
                      <label
                        key={lead.cnpj}
                        className="flex cursor-pointer items-center gap-3 rounded-lg border border-slate-100 px-3 py-2 hover:bg-slate-50"
                      >
                        <input
                          type="checkbox"
                          checked={selectedLeadIds.has(lead.cnpj)}
                          onChange={() => toggleLead(lead.cnpj)}
                          className="size-4 shrink-0 rounded accent-emerald-600"
                        />
                        <Building2 className="size-4 shrink-0 text-slate-400" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-slate-800">
                            {lead.nomeFantasia || lead.razaoSocial}
                          </p>
                          <p className="truncate text-xs text-slate-500">
                            {lead.cnpj}
                            {lead.municipio ? ` · ${lead.municipio}/${lead.uf}` : ''}
                            {lead.telefone1 ? ` · ${lead.telefone1}` : ''}
                            {lead.email ? ` · ${lead.email}` : ''}
                          </p>
                        </div>
                      </label>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* Modal footer — campaign launch */}
            {detail && (
              <div className="border-t border-slate-200 px-5 py-4">
                {campaignError && (
                  <p className="mb-2 text-xs text-red-600">{campaignError}</p>
                )}
                <button
                  onClick={() => void startCampaignFromDetail()}
                  disabled={campaignLoading || selectedCount === 0}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
                >
                  {campaignLoading ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Users className="size-4" />
                  )}
                  {campaignLoading
                    ? 'Criando campanha...'
                    : `Criar Campanha com ${selectedCount} lead${selectedCount !== 1 ? 's' : ''}`}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Import CSV modal */}
      {importOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => { if (e.target === e.currentTarget && !importing) closeImport() }}
        >
          <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
              <h2 className="flex items-center gap-2 font-semibold text-slate-800">
                <Upload className="size-4 text-emerald-600" />
                Importar CSV
              </h2>
              <button
                onClick={closeImport}
                disabled={importing}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 disabled:opacity-40"
              >
                <X className="size-5" />
              </button>
            </div>

            <div className="px-5 py-4 space-y-4">
              {/* Import result summary */}
              {importResult && (
                <div
                  className={`rounded-lg p-3 text-sm ${
                    importResult.ok
                      ? 'bg-emerald-50 text-emerald-700'
                      : 'bg-red-50 text-red-700'
                  }`}
                >
                  {importResult.ok ? (
                    <>
                      <p className="font-medium">Importação concluída</p>
                      <p className="mt-0.5">
                        {importResult.imported} empresa{importResult.imported !== 1 ? 's' : ''} importada{importResult.imported !== 1 ? 's' : ''}.
                        {importResult.errors > 0 && (
                          <span className="ml-1 text-amber-600">
                            {importResult.errors} linha{importResult.errors !== 1 ? 's' : ''} com erro.
                          </span>
                        )}
                      </p>
                    </>
                  ) : (
                    <div className="flex gap-2">
                      {importResult.code === 'forbidden' ? (
                        <Lock className="mt-0.5 size-4 shrink-0" />
                      ) : (
                        <AlertCircle className="mt-0.5 size-4 shrink-0" />
                      )}
                      <p>{importResult.message}</p>
                    </div>
                  )}
                </div>
              )}

              {/* File input */}
              {(!importResult || !importResult.ok) && (
                <>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-slate-700">
                      Arquivo CSV <span className="text-red-500">*</span>
                    </label>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".csv,text/csv,application/vnd.ms-excel"
                      disabled={importing}
                      onChange={(e) => {
                        const f = e.target.files?.[0] ?? null
                        setImportFile(f)
                        setImportResult(null)
                      }}
                      className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-emerald-50 file:px-3 file:py-1 file:text-xs file:font-medium file:text-emerald-700 hover:file:bg-emerald-100 disabled:opacity-40"
                    />
                    <p className="mt-1 text-xs text-slate-400">
                      Apenas arquivos .csv · máximo 500 linhas · deduplicado por CNPJ
                    </p>
                  </div>

                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-slate-700">
                      Nome da lista <span className="text-slate-400">(opcional)</span>
                    </label>
                    <input
                      type="text"
                      placeholder="ex.: Dentistas SP — Maio 2026"
                      value={importName}
                      disabled={importing}
                      maxLength={120}
                      onChange={(e) => setImportName(e.target.value)}
                      className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm placeholder:text-slate-400 focus:border-emerald-400 focus:outline-none focus:ring-1 focus:ring-emerald-400 disabled:opacity-40"
                    />
                  </div>

                  {/* Sample CSV download */}
                  <p className="text-xs text-slate-500">
                    Cabeçalhos aceitos: cnpj, razao_social, telefone, email, municipio, uf, etc.{' '}
                    <button
                      type="button"
                      onClick={downloadSampleCsv}
                      className="text-emerald-600 underline hover:text-emerald-800"
                    >
                      Baixar exemplo de CSV
                    </button>
                  </p>
                </>
              )}
            </div>

            {/* Footer */}
            <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-4">
              {importResult?.ok ? (
                <button
                  onClick={closeImport}
                  className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
                >
                  Fechar
                </button>
              ) : (
                <>
                  <button
                    onClick={closeImport}
                    disabled={importing}
                    className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                  >
                    Cancelar
                  </button>
                  <button
                    data-testid="btn-confirm-import"
                    onClick={() => void handleImport()}
                    disabled={!importFile || importing}
                    className="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
                  >
                    {importing ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Upload className="size-4" />
                    )}
                    {importing ? 'Importando...' : 'Importar'}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Campaign wizard */}
      {pendingCampaign && (
        <CampaignWizard
          campaignId={pendingCampaign.campaignId}
          confirmationToken={pendingCampaign.confirmationToken}
          recipients={pendingCampaign.recipients}
          onClose={() => setPendingCampaign(null)}
          onComplete={() => setPendingCampaign(null)}
        />
      )}
    </div>
  )
}

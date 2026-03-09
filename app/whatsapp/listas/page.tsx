'use client'

// ---------------------------------------------------------------------------
// /whatsapp/listas — full-page management for saved lead pools.
//
// Data is loaded from the server on mount (and on manual refresh) so the
// state survives a hard refresh (F5). The floating AgentChat remains the
// entry-point for creating new pools; this page handles the operational
// side: browse, paginate, inspect leads, delete, and launch campaigns.
//
// Partial selection: opening the detail modal pre-selects all leads.
// The user can then deselect individual leads or use "Selecionar todos" /
// "Limpar seleção" before clicking "Criar Campanha".
// ---------------------------------------------------------------------------

import { useState, useEffect, useCallback } from 'react'
import { List, Trash2, Users, ChevronLeft, ChevronRight, X, Loader2, Building2, RefreshCw } from 'lucide-react'
import CampaignWizard from '@/app/components/CampaignWizard'
import type { PublicEmpresa } from '@/lib/mask-output'

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
  selectedIds: Record<string, boolean>,
): CampaignRecipient[] {
  const selected = leads.filter((l) => selectedIds[l.cnpj])
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

  // Partial selection: cnpj → selected (true/false)
  const [selectedLeadIds, setSelectedLeadIds] = useState<Record<string, boolean>>({})

  // Delete
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // Campaign launch
  const [pendingCampaign, setPendingCampaign]     = useState<PendingCampaign | null>(null)
  const [campaignLoading, setCampaignLoading]     = useState(false)
  const [campaignError, setCampaignError]         = useState<string | null>(null)

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
      const allSelected: Record<string, boolean> = {}
      ;(data.data.leads_json ?? []).forEach((l) => { allSelected[l.cnpj] = true })
      setSelectedLeadIds(allSelected)
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
    setSelectedLeadIds({})
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
        recipients:        (detail.leads_json ?? []).filter((l) => selectedLeadIds[l.cnpj]),
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
    const all: Record<string, boolean> = {}
    ;(detail.leads_json ?? []).forEach((l) => { all[l.cnpj] = true })
    setSelectedLeadIds(all)
  }, [detail])

  const clearSelection = useCallback(() => {
    setSelectedLeadIds({})
  }, [])

  const toggleLead = useCallback((cnpj: string) => {
    setSelectedLeadIds((prev) => ({ ...prev, [cnpj]: !prev[cnpj] }))
  }, [])

  // ---------------------------------------------------------------------------
  // Pagination
  // ---------------------------------------------------------------------------

  const totalPages  = Math.ceil(total / PAGE_SIZE)
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const leads        = detail?.leads_json ?? []
  const selectedCount = leads.filter((l) => selectedLeadIds[l.cnpj]).length

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">

      {/* Page header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-800">
            <List className="size-5 text-emerald-600" />
            Listas Salvas
          </h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Buscas com resultados são salvas automaticamente pelo agente de prospecção.
          </p>
        </div>
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
                          checked={!!selectedLeadIds[lead.cnpj]}
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

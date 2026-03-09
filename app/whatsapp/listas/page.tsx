'use client'

// ---------------------------------------------------------------------------
// /whatsapp/listas — full-page management for saved lead pools.
//
// Data is loaded from the server on mount (and on manual refresh) so the
// state survives a hard refresh (F5). The floating AgentChat remains the
// entry-point for creating new pools; this page handles the operational
// side: browse, paginate, inspect leads, delete, and launch campaigns.
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

  // Delete
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // Campaign launch
  const [pendingCampaign, setPendingCampaign]       = useState<PendingCampaign | null>(null)
  const [campaignLoadingId, setCampaignLoadingId]   = useState<string | null>(null)
  const [campaignError, setCampaignError]           = useState<string | null>(null)

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
    try {
      const res = await fetch(`/api/lead-pools/${poolId}`)
      if (!res.ok) throw new Error(`Erro ${res.status}`)
      const data = await res.json() as { data: LeadPoolDetail }
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
  // Campaign launch
  // ---------------------------------------------------------------------------

  const startCampaign = useCallback(async (pool: LeadPool) => {
    setCampaignLoadingId(pool.id)
    setCampaignError(null)
    try {
      const detailRes = await fetch(`/api/lead-pools/${pool.id}`)
      if (!detailRes.ok) throw new Error(`Erro ${detailRes.status}`)
      const detailData = await detailRes.json() as { data: LeadPoolDetail }
      const leads = detailData.data.leads_json ?? []
      if (leads.length === 0) throw new Error('Esta lista não tem leads.')

      const campaignRes = await fetch('/api/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `Campanha: ${pool.name.slice(0, 100)}`,
          recipients: leads.map((r) => ({
            cnpj:          r.cnpj,
            razao_social:  r.razaoSocial,
            nome_fantasia: r.nomeFantasia || undefined,
            telefone:      r.telefone1 || r.telefone2 || undefined,
            email:         r.email || undefined,
            municipio:     r.municipio || undefined,
            uf:            r.uf || undefined,
          })),
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
        recipients:        leads,
      })
    } catch (err) {
      setCampaignError(err instanceof Error ? err.message : 'Erro ao iniciar campanha')
    } finally {
      setCampaignLoadingId(null)
    }
  }, [])

  // ---------------------------------------------------------------------------
  // Pagination
  // ---------------------------------------------------------------------------

  const totalPages  = Math.ceil(total / PAGE_SIZE)
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

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
      {campaignError && (
        <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">{campaignError}</div>
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
                        onClick={() => void startCampaign(pool)}
                        disabled={campaignLoadingId !== null || deletingId !== null}
                        title="Iniciar campanha com esta lista"
                        className="flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
                      >
                        {campaignLoadingId === pool.id ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Users className="size-3.5" />
                        )}
                        Campanha
                      </button>
                      <button
                        onClick={() => void deletePool(pool.id, pool.name)}
                        disabled={deletingId !== null || campaignLoadingId !== null}
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
          <div className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-2xl bg-white shadow-2xl">
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
                    {detail.leads_json.map((lead) => (
                      <div
                        key={lead.cnpj}
                        className="flex items-center gap-3 rounded-lg border border-slate-100 px-3 py-2"
                      >
                        <Building2 className="size-4 shrink-0 text-slate-400" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-slate-800">
                            {lead.nomeFantasia || lead.razaoSocial}
                          </p>
                          <p className="truncate text-xs text-slate-500">
                            {lead.municipio}/{lead.uf}
                            {lead.telefone1 ? ` · ${lead.telefone1}` : ''}
                            {lead.email ? ` · ${lead.email}` : ''}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
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

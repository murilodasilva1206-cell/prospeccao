"use client"

// ---------------------------------------------------------------------------
// /whatsapp/templates
//
// Lista e sincroniza templates Meta Cloud API por canal.
// Suporta filtros por status, idioma e busca por nome.
// Apenas canais META_CLOUD aparecem no seletor.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react"
import { toast, Toaster } from "sonner"
import {
  FileText,
  Loader2,
  RefreshCw,
  Search,
  AlertCircle,
  CheckCircle2,
  Clock,
  XCircle,
  PauseCircle,
} from "lucide-react"

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

type Channel = {
  id: string
  name: string
  provider: string
  status: string
}

type Template = {
  id: string
  template_name: string
  language: string
  status: "APPROVED" | "PENDING" | "REJECTED" | "PAUSED" | "DISABLED"
  category: string
  variables_count: number
  synced_at: string
}

type Pagination = {
  total: number
  page: number
  limit: number
  pages: number
}

type SyncResult = {
  created: number
  updated: number
  deactivated: number
}

const TEMPLATE_STATUSES = ["APPROVED", "PENDING", "REJECTED", "PAUSED", "DISABLED"] as const

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusBadge(status: Template["status"]) {
  switch (status) {
    case "APPROVED":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
          <CheckCircle2 className="size-3" /> Aprovado
        </span>
      )
    case "PENDING":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
          <Clock className="size-3" /> Pendente
        </span>
      )
    case "REJECTED":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">
          <XCircle className="size-3" /> Rejeitado
        </span>
      )
    case "PAUSED":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
          <PauseCircle className="size-3" /> Pausado
        </span>
      )
    case "DISABLED":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
          <AlertCircle className="size-3" /> Inativo
        </span>
      )
  }
}

// ---------------------------------------------------------------------------
// Componente principal
// ---------------------------------------------------------------------------

export default function TemplatesPage() {
  // Canais disponiveis (somente META_CLOUD)
  const [channels, setChannels] = useState<Channel[]>([])
  const [channelsLoading, setChannelsLoading] = useState(true)

  // Canal selecionado
  const [selectedChannelId, setSelectedChannelId] = useState<string>("")

  // Templates
  const [templates, setTemplates] = useState<Template[]>([])
  const [pagination, setPagination] = useState<Pagination>({ total: 0, page: 1, limit: 20, pages: 0 })
  const [templatesLoading, setTemplatesLoading] = useState(false)

  // Filtros
  const [filterStatus, setFilterStatus] = useState<string>("")
  const [filterSearch, setFilterSearch] = useState<string>("")
  const [currentPage, setCurrentPage] = useState(1)

  // Sync
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)

  // ---------------------------------------------------------------------------
  // Carregar canais META_CLOUD na montagem
  // ---------------------------------------------------------------------------

  useEffect(() => {
    setChannelsLoading(true)
    fetch("/api/whatsapp/channels?limit=100")
      .then((r) => {
        if (r.status === 401) throw new Error("Sessao expirada. Faca login novamente.")
        if (!r.ok) throw new Error(`Erro ao carregar canais (${r.status})`)
        return r.json()
      })
      .then((d: { data?: Channel[] }) => {
        const meta = (d.data ?? []).filter(
          (c) => c.provider === "META_CLOUD" && c.status === "CONNECTED",
        )
        setChannels(meta)
        if (meta.length > 0) setSelectedChannelId(meta[0].id)
      })
      .catch((err: unknown) => {
        toast.error(err instanceof Error ? err.message : "Nao foi possivel carregar os canais.")
      })
      .finally(() => setChannelsLoading(false))
  }, [])

  // ---------------------------------------------------------------------------
  // Carregar templates ao mudar canal/filtros/pagina
  // ---------------------------------------------------------------------------

  const loadTemplates = useCallback(() => {
    if (!selectedChannelId) return

    setTemplatesLoading(true)
    const params = new URLSearchParams({ page: String(currentPage), limit: "20" })
    if (filterStatus) params.set("status", filterStatus)
    if (filterSearch) params.set("search", filterSearch)

    fetch(`/api/whatsapp/channels/${selectedChannelId}/templates?${params.toString()}`)
      .then((r) => {
        if (r.status === 401) throw new Error("Sessao expirada.")
        if (r.status === 403) throw new Error("Acesso negado.")
        if (r.status === 404) throw new Error("Canal nao encontrado.")
        if (r.status === 409) throw new Error("Canal nao e META_CLOUD.")
        if (!r.ok) throw new Error(`Erro ao carregar templates (${r.status})`)
        return r.json()
      })
      .then((d: { data: Template[]; pagination: Pagination }) => {
        setTemplates(d.data)
        setPagination(d.pagination)
      })
      .catch((err: unknown) => {
        toast.error(err instanceof Error ? err.message : "Erro ao carregar templates.")
      })
      .finally(() => setTemplatesLoading(false))
  }, [selectedChannelId, filterStatus, filterSearch, currentPage])

  useEffect(() => {
    loadTemplates()
  }, [loadTemplates])

  // ---------------------------------------------------------------------------
  // Sincronizar templates
  // ---------------------------------------------------------------------------

  const handleSync = async () => {
    if (!selectedChannelId || syncing) return
    setSyncing(true)
    setSyncError(null)

    try {
      const r = await fetch(
        `/api/whatsapp/channels/${selectedChannelId}/templates/sync`,
        { method: "POST" },
      )

      if (r.status === 401) throw new Error("Sessao expirada. Faca login novamente.")
      if (r.status === 403) throw new Error("Acesso negado.")
      if (r.status === 404) throw new Error("Canal nao encontrado.")
      if (r.status === 409) throw new Error("Sincronizacao disponivel apenas para canais META_CLOUD.")
      if (r.status === 422) throw new Error("Canal sem WABA ID ou credenciais incompletas. Atualize as credenciais do canal.")
      if (r.status === 429) {
        const retryAfter = r.headers.get("Retry-After") ?? "60"
        throw new Error(`Limite de sincronizacoes atingido. Aguarde ${retryAfter}s e tente novamente.`)
      }
      if (r.status === 503) throw new Error("Meta indisponivel no momento. Tente novamente em alguns minutos.")
      if (r.status === 500) throw new Error("Erro interno ao sincronizar. Verifique as credenciais e tente novamente.")
      if (!r.ok) throw new Error(`Erro ao sincronizar (${r.status}). Tente novamente.`)

      const result = await r.json() as SyncResult
      const msg = [
        result.created > 0 && `${result.created} criado(s)`,
        result.updated > 0 && `${result.updated} atualizado(s)`,
        result.deactivated > 0 && `${result.deactivated} desativado(s)`,
      ].filter(Boolean).join(", ")

      toast.success(msg ? `Templates sincronizados: ${msg}` : "Templates ja estao atualizados.")
      loadTemplates()
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro ao sincronizar templates."
      setSyncError(msg)
      toast.error(msg)
    } finally {
      setSyncing(false)
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8">
      <Toaster richColors />

      {/* Cabecalho */}
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileText className="size-5 text-violet-600" />
          <h1 className="text-xl font-semibold text-zinc-900">Templates</h1>
        </div>
      </div>

      {/* Estado: carregando canais */}
      {channelsLoading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="size-6 animate-spin text-zinc-400" />
        </div>
      )}

      {/* Estado: nenhum canal Meta */}
      {!channelsLoading && channels.length === 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-6 py-8 text-center">
          <AlertCircle className="mx-auto mb-3 size-8 text-amber-500" />
          <p className="text-sm font-medium text-amber-900">Nenhum canal oficial conectado</p>
          <p className="mt-1 text-xs text-amber-700">
            Templates estao disponiveis apenas para canais Meta Cloud API.
          </p>
          <a
            href="/whatsapp/canais"
            className="mt-4 inline-block rounded-lg bg-amber-600 px-4 py-2 text-xs font-medium text-white hover:bg-amber-700"
          >
            Configurar canal Meta
          </a>
        </div>
      )}

      {/* Canais disponiveis + controles */}
      {!channelsLoading && channels.length > 0 && (
        <div className="space-y-4">
          {/* Barra de selecao e acoes */}
          <div className="flex flex-wrap items-center gap-3">
            {/* Seletor de canal */}
            <select
              value={selectedChannelId}
              onChange={(e) => { setSelectedChannelId(e.target.value); setCurrentPage(1) }}
              className="rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-violet-400"
              aria-label="Selecionar canal"
            >
              {channels.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>

            {/* Filtro por status */}
            <select
              value={filterStatus}
              onChange={(e) => { setFilterStatus(e.target.value); setCurrentPage(1) }}
              className="rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-violet-400"
              aria-label="Filtrar por status"
            >
              <option value="">Todos os status</option>
              {TEMPLATE_STATUSES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>

            {/* Busca por nome */}
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-zinc-400" />
              <input
                type="text"
                placeholder="Buscar template..."
                value={filterSearch}
                onChange={(e) => { setFilterSearch(e.target.value); setCurrentPage(1) }}
                className="rounded-lg border border-zinc-200 py-2 pl-8 pr-3 text-sm outline-none focus:border-violet-400"
                aria-label="Buscar template"
              />
            </div>

            <div className="flex-1" />

            {/* Botao sincronizar */}
            <button
              onClick={() => void handleSync()}
              disabled={syncing || !selectedChannelId}
              className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {syncing
                ? <><Loader2 className="size-3.5 animate-spin" /> Sincronizando...</>
                : <><RefreshCw className="size-3.5" /> Sincronizar templates</>
              }
            </button>
          </div>

          {/* Erro de sync */}
          {syncError && (
            <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              <AlertCircle className="size-4 shrink-0" />
              <span>{syncError}</span>
              <button
                onClick={() => void handleSync()}
                className="ml-auto text-xs underline"
              >
                Tentar novamente
              </button>
            </div>
          )}

          {/* Tabela / loading / vazio */}
          {templatesLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="size-5 animate-spin text-zinc-400" />
            </div>
          ) : templates.length === 0 ? (
            <div className="rounded-xl border border-zinc-200 bg-zinc-50 py-12 text-center text-sm text-zinc-500">
              Nenhum template encontrado.{" "}
              <button onClick={() => void handleSync()} className="underline">
                Sincronize os templates
              </button>{" "}
              para importar da Meta.
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
              <table className="w-full text-sm">
                <thead className="border-b border-zinc-100 bg-zinc-50 text-left text-xs font-medium text-zinc-500">
                  <tr>
                    <th className="px-4 py-3">Nome</th>
                    <th className="px-4 py-3">Idioma</th>
                    <th className="px-4 py-3">Categoria</th>
                    <th className="px-4 py-3">Variaveis</th>
                    <th className="px-4 py-3">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {templates.map((t) => (
                    <tr key={t.id} className="hover:bg-zinc-50">
                      <td className="px-4 py-3 font-mono text-xs text-zinc-800">{t.template_name}</td>
                      <td className="px-4 py-3 text-zinc-600">{t.language}</td>
                      <td className="px-4 py-3 text-zinc-600">{t.category}</td>
                      <td className="px-4 py-3 text-zinc-600">{t.variables_count}</td>
                      <td className="px-4 py-3">{statusBadge(t.status)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Paginacao */}
              {pagination.pages > 1 && (
                <div className="flex items-center justify-between border-t border-zinc-100 px-4 py-3 text-xs text-zinc-500">
                  <span>{pagination.total} templates no total</span>
                  <div className="flex items-center gap-2">
                    <button
                      disabled={currentPage <= 1}
                      onClick={() => setCurrentPage((p) => p - 1)}
                      className="rounded border border-zinc-200 px-2 py-1 disabled:opacity-40"
                    >
                      Anterior
                    </button>
                    <span>{currentPage} / {pagination.pages}</span>
                    <button
                      disabled={currentPage >= pagination.pages}
                      onClick={() => setCurrentPage((p) => p + 1)}
                      className="rounded border border-zinc-200 px-2 py-1 disabled:opacity-40"
                    >
                      Proxima
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </main>
  )
}

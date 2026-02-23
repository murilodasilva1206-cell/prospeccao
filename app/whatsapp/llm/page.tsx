'use client'

// ---------------------------------------------------------------------------
// /whatsapp/llm — LLM profile management
//
// Allows operators to configure LLM providers (OpenRouter, OpenAI, Anthropic,
// Google) for the prospecting agent. One profile can be marked as default;
// that profile is used by /api/agente.
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import {
  Bot,
  CheckCircle2,
  Loader2,
  Pencil,
  Plus,
  RefreshCcw,
  ShieldCheck,
  Star,
  Trash2,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react'
import { toast, Toaster } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LlmProvider = 'openrouter' | 'openai' | 'anthropic' | 'google'

interface LlmProfile {
  id: string
  name: string
  provider: LlmProvider
  key_hint: string
  model: string
  base_url: string | null
  is_default: boolean
  created_at: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROVIDERS: Array<{ value: LlmProvider; label: string; keyPlaceholder: string }> = [
  { value: 'openrouter', label: 'OpenRouter',  keyPlaceholder: 'sk-or-...' },
  { value: 'openai',     label: 'OpenAI',      keyPlaceholder: 'sk-...' },
  { value: 'anthropic',  label: 'Anthropic',   keyPlaceholder: 'sk-ant-...' },
  { value: 'google',     label: 'Google',       keyPlaceholder: 'AIzaSy...' },
]

const MODEL_SUGGESTIONS: Record<LlmProvider, string[]> = {
  openrouter: [
    'google/gemini-flash-1.5',
    'meta-llama/llama-3.1-70b-instruct',
    'openai/gpt-4o-mini',
  ],
  openai:     ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
  anthropic:  ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
  google:     ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
}

const PROVIDER_COLORS: Record<LlmProvider, string> = {
  openrouter: 'bg-violet-100 text-violet-800',
  openai:     'bg-emerald-100 text-emerald-800',
  anthropic:  'bg-amber-100 text-amber-800',
  google:     'bg-blue-100 text-blue-800',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function providerLabel(p: LlmProvider): string {
  return PROVIDERS.find((x) => x.value === p)?.label ?? p
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(
    new Date(iso),
  )
}

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  const payload = (await res.json().catch(() => ({}))) as { error?: string } & T
  if (!res.ok) throw new Error(payload.error ?? `HTTP ${res.status}`)
  return payload
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-16 text-center">
      <div className="flex size-16 items-center justify-center rounded-2xl border-2 border-dashed border-zinc-300 bg-zinc-50">
        <Bot className="size-7 text-zinc-400" />
      </div>
      <div>
        <p className="font-semibold text-zinc-700">Nenhum perfil configurado</p>
        <p className="mt-1 text-sm text-zinc-500">
          Configure um provedor de LLM para habilitar o agente de prospecção.
        </p>
      </div>
      <Button onClick={onAdd}>
        <Plus className="mr-2 size-4" />
        Adicionar perfil
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Form state
// ---------------------------------------------------------------------------

type FormMode = 'create' | 'edit'

interface FormData {
  name: string
  provider: LlmProvider
  api_key: string
  model: string
  base_url: string
  is_default: boolean
}

const EMPTY_FORM: FormData = {
  name: '',
  provider: 'openrouter',
  api_key: '',
  model: '',
  base_url: '',
  is_default: false,
}

// ---------------------------------------------------------------------------
// Test result dialog
// ---------------------------------------------------------------------------

interface TestResult {
  ok: boolean
  latencyMs?: number
  error?: string
}

function TestResultDialog({
  open,
  result,
  onClose,
}: {
  open: boolean
  result: TestResult | null
  onClose: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Resultado do teste de conexão</DialogTitle>
        </DialogHeader>
        {result?.ok ? (
          <div className="flex items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4">
            <CheckCircle2 className="size-5 text-emerald-600" />
            <div>
              <p className="font-medium text-emerald-800">Conexão bem-sucedida</p>
              <p className="text-sm text-emerald-700">Latência: {result.latencyMs} ms</p>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-4">
            <WifiOff className="mt-0.5 size-5 text-red-600" />
            <div>
              <p className="font-medium text-red-800">Falha na conexão</p>
              <p className="mt-1 break-all text-xs text-red-700">{result?.error ?? 'Erro desconhecido'}</p>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Fechar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Delete confirm dialog
// ---------------------------------------------------------------------------

function DeleteDialog({
  profile,
  open,
  onClose,
  onConfirm,
  loading,
}: {
  profile: LlmProfile | null
  open: boolean
  onClose: () => void
  onConfirm: () => void
  loading: boolean
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Excluir perfil</DialogTitle>
          <DialogDescription>
            Tem certeza que deseja excluir <strong>{profile?.name}</strong>? Esta ação não pode ser desfeita.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>Cancelar</Button>
          <Button variant="destructive" onClick={onConfirm} disabled={loading}>
            {loading && <Loader2 className="mr-2 size-4 animate-spin" />}
            Excluir
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function LlmProfilesPage() {
  const [profiles, setProfiles]         = useState<LlmProfile[]>([])
  const [loading, setLoading]           = useState(false)
  const [formMode, setFormMode]         = useState<FormMode>('create')
  const [editId, setEditId]             = useState<string | null>(null)
  const [form, setForm]                 = useState<FormData>(EMPTY_FORM)
  const [saving, setSaving]             = useState(false)
  const [testingId, setTestingId]       = useState<string | null>(null)
  const [testResult, setTestResult]     = useState<TestResult | null>(null)
  const [testOpen, setTestOpen]         = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<LlmProfile | null>(null)
  const [deleting, setDeleting]         = useState(false)
  const [settingDefault, setSettingDefault] = useState<string | null>(null)

  // ---- Load ----------------------------------------------------------------

  async function loadProfiles() {
    setLoading(true)
    try {
      const res = await apiFetch<{ data: LlmProfile[] }>('/api/llm/profiles')
      setProfiles(res.data)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao carregar perfis')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void loadProfiles() }, [])

  // ---- Form helpers --------------------------------------------------------

  function resetForm() {
    setForm(EMPTY_FORM)
    setFormMode('create')
    setEditId(null)
  }

  function startEdit(profile: LlmProfile) {
    setFormMode('edit')
    setEditId(profile.id)
    setForm({
      name:       profile.name,
      provider:   profile.provider,
      api_key:    '', // never pre-filled; blank = keep unchanged
      model:      profile.model,
      base_url:   profile.base_url ?? '',
      is_default: profile.is_default,
    })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function setField<K extends keyof FormData>(key: K, value: FormData[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  // ---- Save (create or update) ---------------------------------------------

  async function handleSave() {
    if (!form.name.trim())  { toast.warning('Nome obrigatório'); return }
    if (!form.model.trim()) { toast.warning('Modelo obrigatório'); return }
    if (formMode === 'create' && !form.api_key.trim()) {
      toast.warning('Chave de API obrigatória'); return
    }

    setSaving(true)
    try {
      const body: Record<string, unknown> = {
        name:       form.name.trim(),
        provider:   form.provider,
        model:      form.model.trim(),
        base_url:   form.base_url.trim() || null,
        is_default: form.is_default,
      }
      if (form.api_key.trim()) body.api_key = form.api_key.trim()

      if (formMode === 'create') {
        const res = await apiFetch<{ data: LlmProfile }>('/api/llm/profiles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        setProfiles((prev) => {
          const updated = form.is_default ? prev.map((p) => ({ ...p, is_default: false })) : prev
          return [res.data, ...updated]
        })
        toast.success('Perfil criado')
      } else if (editId) {
        const res = await apiFetch<{ data: LlmProfile }>(`/api/llm/profiles/${editId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        setProfiles((prev) =>
          prev.map((p) => {
            if (form.is_default && p.id !== editId) return { ...p, is_default: false }
            return p.id === editId ? res.data : p
          }),
        )
        toast.success('Perfil atualizado')
      }

      resetForm()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao salvar perfil')
    } finally {
      setSaving(false)
    }
  }

  // ---- Test connection ------------------------------------------------------

  async function handleTest(profile: LlmProfile) {
    setTestingId(profile.id)
    try {
      const res = await apiFetch<{ ok: boolean; latencyMs?: number; error?: string }>(
        `/api/llm/profiles/${profile.id}/test`,
        { method: 'POST' },
      )
      setTestResult(res)
      setTestOpen(true)
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : 'Erro desconhecido' })
      setTestOpen(true)
    } finally {
      setTestingId(null)
    }
  }

  // ---- Set default ---------------------------------------------------------

  async function handleSetDefault(profile: LlmProfile) {
    if (profile.is_default) return
    setSettingDefault(profile.id)
    try {
      await apiFetch(`/api/llm/profiles/${profile.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_default: true }),
      })
      setProfiles((prev) =>
        prev.map((p) => ({ ...p, is_default: p.id === profile.id })),
      )
      toast.success(`"${profile.name}" definido como padrão`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao definir padrão')
    } finally {
      setSettingDefault(null)
    }
  }

  // ---- Delete --------------------------------------------------------------

  async function handleDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await apiFetch(`/api/llm/profiles/${deleteTarget.id}`, { method: 'DELETE' })
      setProfiles((prev) => prev.filter((p) => p.id !== deleteTarget.id))
      if (editId === deleteTarget.id) resetForm()
      toast.success('Perfil excluído')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao excluir perfil')
    } finally {
      setDeleting(false)
      setDeleteTarget(null)
    }
  }

  // ---- Render --------------------------------------------------------------

  const suggestions = MODEL_SUGGESTIONS[form.provider]
  const providerInfo = PROVIDERS.find((p) => p.value === form.provider)

  return (
    <main className="relative min-h-screen overflow-hidden bg-zinc-50 pb-16">
      <Toaster richColors position="top-right" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,_rgba(139,92,246,0.12),_transparent_40%),radial-gradient(circle_at_bottom_left,_rgba(16,185,129,0.10),_transparent_45%)]" />

      <div className="relative mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 pt-10 md:px-10">

        {/* Header */}
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
          className="rounded-2xl border border-zinc-200 bg-white/90 p-6 shadow-sm backdrop-blur"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-zinc-900 md:text-3xl">
                Integrações IA
              </h1>
              <p className="mt-1 text-sm text-zinc-600">
                Configure os provedores de LLM usados pelo agente de prospecção.
                O perfil padrão é usado por <code className="rounded bg-zinc-100 px-1 text-xs">/api/agente</code>.
              </p>
            </div>
            <div className="flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-800">
              <ShieldCheck className="size-3.5" />
              Chaves criptografadas no servidor
            </div>
          </div>
        </motion.section>

        <div className="grid gap-6 lg:grid-cols-[400px_1fr]">

          {/* Form panel */}
          <motion.section
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.05, duration: 0.3 }}
          >
            <Card className="border-zinc-200 bg-white/95 shadow-sm">
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <div>
                  <CardTitle>{formMode === 'create' ? 'Novo perfil' : 'Editar perfil'}</CardTitle>
                  <CardDescription>
                    {formMode === 'create'
                      ? 'Adicione um provedor de LLM ao workspace.'
                      : 'Altere os dados do perfil selecionado.'}
                  </CardDescription>
                </div>
                {formMode === 'edit' && (
                  <Button variant="ghost" size="sm" onClick={resetForm} title="Cancelar edição">
                    <X className="size-4" />
                  </Button>
                )}
              </CardHeader>

              <CardContent className="space-y-4">
                {/* Name */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-zinc-700">Nome</label>
                  <Input
                    value={form.name}
                    onChange={(e) => setField('name', e.target.value)}
                    placeholder="Agente Principal"
                  />
                </div>

                {/* Provider */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-zinc-700">Provedor</label>
                  <Select
                    value={form.provider}
                    onValueChange={(v) => {
                      setField('provider', v as LlmProvider)
                      setField('model', '')
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PROVIDERS.map((p) => (
                        <SelectItem key={p.value} value={p.value}>
                          {p.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <Separator />

                {/* API Key */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-zinc-700">
                    Chave de API
                    {formMode === 'edit' && (
                      <span className="ml-1 text-zinc-400">(deixe em branco para manter)</span>
                    )}
                  </label>
                  <Input
                    type="password"
                    value={form.api_key}
                    onChange={(e) => setField('api_key', e.target.value)}
                    placeholder={providerInfo?.keyPlaceholder ?? 'sk-...'}
                    autoComplete="off"
                  />
                </div>

                {/* Model */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-zinc-700">Modelo</label>
                  <Input
                    value={form.model}
                    onChange={(e) => setField('model', e.target.value)}
                    placeholder={suggestions[0] ?? 'nome-do-modelo'}
                    list={`model-suggestions-${form.provider}`}
                  />
                  <datalist id={`model-suggestions-${form.provider}`}>
                    {suggestions.map((s) => <option key={s} value={s} />)}
                  </datalist>
                  <div className="flex flex-wrap gap-1">
                    {suggestions.map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setField('model', s)}
                        className="rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[10px] text-zinc-600 hover:bg-zinc-100"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Base URL (optional) */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-zinc-700">
                    Base URL <span className="text-zinc-400">(opcional — para endpoints customizados)</span>
                  </label>
                  <Input
                    value={form.base_url}
                    onChange={(e) => setField('base_url', e.target.value)}
                    placeholder="https://seu-endpoint.com/v1"
                  />
                </div>

                {/* Default toggle */}
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={form.is_default}
                    onChange={(e) => setField('is_default', e.target.checked)}
                    className="size-4 rounded border-zinc-300 text-emerald-600 accent-emerald-600"
                  />
                  <span className="text-sm text-zinc-700">Definir como perfil padrão</span>
                </label>

                <Button onClick={() => void handleSave()} disabled={saving} className="w-full">
                  {saving
                    ? <Loader2 className="mr-2 size-4 animate-spin" />
                    : <Plus className="mr-2 size-4" />
                  }
                  {formMode === 'create' ? 'Criar perfil' : 'Salvar alterações'}
                </Button>
              </CardContent>
            </Card>
          </motion.section>

          {/* Profiles list */}
          <motion.section
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1, duration: 0.3 }}
          >
            <Card className="border-zinc-200 bg-white/95 shadow-sm">
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <div>
                  <CardTitle>Perfis configurados</CardTitle>
                  <CardDescription>
                    O perfil padrão (<Star className="mb-0.5 inline size-3 text-amber-500" />) é
                    usado automaticamente pelo agente.
                  </CardDescription>
                </div>
                <Button variant="outline" size="sm" onClick={() => void loadProfiles()} disabled={loading}>
                  {loading
                    ? <Loader2 className="mr-2 size-4 animate-spin" />
                    : <RefreshCcw className="mr-2 size-4" />
                  }
                  Atualizar
                </Button>
              </CardHeader>

              <CardContent>
                {!loading && profiles.length === 0 ? (
                  <EmptyState onAdd={() => window.scrollTo({ top: 0, behavior: 'smooth' })} />
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Nome</TableHead>
                        <TableHead>Provedor</TableHead>
                        <TableHead>Modelo</TableHead>
                        <TableHead>Chave</TableHead>
                        <TableHead>Criado</TableHead>
                        <TableHead className="text-right">Ações</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {loading && profiles.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={6} className="py-8 text-center">
                            <Loader2 className="mx-auto size-5 animate-spin text-zinc-400" />
                          </TableCell>
                        </TableRow>
                      )}
                      {profiles.map((profile) => (
                        <TableRow key={profile.id} className={editId === profile.id ? 'bg-violet-50/50' : ''}>
                          <TableCell>
                            <div className="flex items-center gap-1.5">
                              {profile.is_default && (
                                <Star className="size-3.5 fill-amber-400 text-amber-400" aria-label="Perfil padrão" />
                              )}
                              <span className="font-medium text-zinc-900">{profile.name}</span>
                            </div>
                            <div className="text-[10px] text-zinc-400">{profile.id.slice(0, 8)}</div>
                          </TableCell>

                          <TableCell>
                            <span
                              className={`rounded-full px-2 py-0.5 text-xs font-medium ${PROVIDER_COLORS[profile.provider]}`}
                            >
                              {providerLabel(profile.provider)}
                            </span>
                          </TableCell>

                          <TableCell className="max-w-[160px] truncate text-sm text-zinc-700" title={profile.model}>
                            {profile.model}
                          </TableCell>

                          <TableCell className="font-mono text-xs text-zinc-500">
                            {profile.key_hint}
                          </TableCell>

                          <TableCell className="text-xs text-zinc-500">
                            {formatDate(profile.created_at)}
                          </TableCell>

                          <TableCell>
                            <div className="flex justify-end gap-1">
                              {/* Test */}
                              <Button
                                size="sm"
                                variant="outline"
                                title="Testar conexão"
                                disabled={testingId === profile.id}
                                onClick={() => void handleTest(profile)}
                              >
                                {testingId === profile.id
                                  ? <Loader2 className="size-4 animate-spin" />
                                  : <Wifi className="size-4" />
                                }
                              </Button>

                              {/* Set default */}
                              <Button
                                size="sm"
                                variant="outline"
                                title={profile.is_default ? 'Já é padrão' : 'Definir como padrão'}
                                disabled={profile.is_default || settingDefault === profile.id}
                                onClick={() => void handleSetDefault(profile)}
                              >
                                {settingDefault === profile.id
                                  ? <Loader2 className="size-4 animate-spin" />
                                  : <Star className={`size-4 ${profile.is_default ? 'fill-amber-400 text-amber-400' : ''}`} />
                                }
                              </Button>

                              {/* Edit */}
                              <Button
                                size="sm"
                                variant="outline"
                                title="Editar"
                                onClick={() => startEdit(profile)}
                              >
                                <Pencil className="size-4" />
                              </Button>

                              {/* Delete */}
                              <Button
                                size="sm"
                                variant="outline"
                                title="Excluir"
                                onClick={() => setDeleteTarget(profile)}
                                className="text-red-600 hover:border-red-300 hover:bg-red-50"
                              >
                                <Trash2 className="size-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </motion.section>
        </div>
      </div>

      {/* Test result dialog */}
      <TestResultDialog
        open={testOpen}
        result={testResult}
        onClose={() => setTestOpen(false)}
      />

      {/* Delete confirm dialog */}
      <DeleteDialog
        profile={deleteTarget}
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void handleDelete()}
        loading={deleting}
      />
    </main>
  )
}

"use client"

import { useCallback, useEffect, useState } from "react"
import { Loader2, Plus, RefreshCcw, Trash2, Copy, Shield } from "lucide-react"
import { toast, Toaster } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"

type KeyItem = {
  id: string
  workspace_id: string
  label: string
  created_by: string | null
  created_at: string
  last_used_at: string | null
}

function readErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return "Erro inesperado"
}

function formatDate(value: string | null): string {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "-"
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date)
}

export default function WhatsAppKeysPage() {
  const [keys, setKeys] = useState<KeyItem[]>([])
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newLabel, setNewLabel] = useState("")
  const [newCreatedBy, setNewCreatedBy] = useState("")
  const [revealedRawKey, setRevealedRawKey] = useState<string | null>(null)

  const loadKeys = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/whatsapp/keys")
      const payload = (await res.json().catch(() => ({}))) as {
        data?: KeyItem[]
        error?: string
      }
      if (!res.ok) throw new Error(payload.error ?? `HTTP ${res.status}`)
      setKeys(payload.data ?? [])
    } catch (err) {
      toast.error(readErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [])

  // Auto-load on mount
  useEffect(() => {
    void loadKeys()
  }, [loadKeys])

  async function createKey() {
    if (!newLabel.trim()) {
      toast.warning("Informe um label para a chave")
      return
    }
    setCreating(true)
    try {
      const res = await fetch("/api/whatsapp/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: newLabel.trim(),
          created_by: newCreatedBy.trim() || undefined,
        }),
      })
      const payload = (await res.json().catch(() => ({}))) as {
        data?: KeyItem
        key?: string
        error?: string
      }
      if (!res.ok) throw new Error(payload.error ?? `HTTP ${res.status}`)
      setRevealedRawKey(payload.key ?? null)
      setNewLabel("")
      setNewCreatedBy("")
      toast.success("Chave criada")
      await loadKeys()
    } catch (err) {
      toast.error(readErrorMessage(err))
    } finally {
      setCreating(false)
    }
  }

  async function revokeKey(id: string) {
    try {
      const res = await fetch(`/api/whatsapp/keys?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      })
      const payload = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(payload.error ?? `HTTP ${res.status}`)
      setKeys((prev) => prev.filter((item) => item.id !== id))
      toast.success("Chave revogada")
    } catch (err) {
      toast.error(readErrorMessage(err))
    }
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-zinc-50 pb-16">
      <Toaster richColors position="top-right" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,_rgba(14,165,233,0.15),_transparent_40%),radial-gradient(circle_at_bottom_left,_rgba(16,185,129,0.14),_transparent_45%)]" />
      <div className="relative mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 pt-10 md:px-10">
        <Card className="border-zinc-200 bg-white/95 shadow-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="size-4 text-emerald-600" />
              Chaves API do Workspace
            </CardTitle>
            <CardDescription>
              Rotacione e revogue chaves `wk_...`. A chave raw e exibida apenas na criacao.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={() => void loadKeys()} disabled={loading}>
                {loading ? <Loader2 className="mr-2 size-4 animate-spin" /> : <RefreshCcw className="mr-2 size-4" />}
                Atualizar
              </Button>
            </div>
            <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
              <Input
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="Label da chave (ex: Frontend Canais)"
              />
              <Input
                value={newCreatedBy}
                onChange={(e) => setNewCreatedBy(e.target.value)}
                placeholder="Criada por (opcional)"
              />
              <Button onClick={() => void createKey()} disabled={creating}>
                {creating ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Plus className="mr-2 size-4" />}
                Criar chave
              </Button>
            </div>
            {revealedRawKey && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs">
                <p className="font-medium text-amber-900">Salve agora: essa chave nao sera mostrada novamente.</p>
                <div className="mt-2 flex items-center gap-2">
                  <code className="block flex-1 overflow-auto rounded bg-white px-2 py-1 text-amber-950">
                    {revealedRawKey}
                  </code>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      navigator.clipboard.writeText(revealedRawKey)
                      toast.success("Chave copiada")
                    }}
                  >
                    <Copy className="size-4" />
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-zinc-200 bg-white/95 shadow-sm">
          <CardHeader>
            <CardTitle>Chaves ativas</CardTitle>
            <CardDescription>Somente chaves nao revogadas do workspace autenticado.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Label</TableHead>
                  <TableHead>Criada por</TableHead>
                  <TableHead>Ultimo uso</TableHead>
                  <TableHead>Criada em</TableHead>
                  <TableHead className="text-right">Acao</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-8 text-center text-zinc-500">
                      Nenhuma chave carregada.
                    </TableCell>
                  </TableRow>
                ) : (
                  keys.map((key) => (
                    <TableRow key={key.id}>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <span className="font-medium text-zinc-900">{key.label}</span>
                          <code className="text-[11px] text-zinc-500">{key.id}</code>
                        </div>
                      </TableCell>
                      <TableCell>{key.created_by ?? "-"}</TableCell>
                      <TableCell>
                        {key.last_used_at ? <Badge variant="secondary">{formatDate(key.last_used_at)}</Badge> : "-"}
                      </TableCell>
                      <TableCell>{formatDate(key.created_at)}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void revokeKey(key.id)}
                        >
                          <Trash2 className="mr-1 size-4" />
                          Revogar
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </main>
  )
}

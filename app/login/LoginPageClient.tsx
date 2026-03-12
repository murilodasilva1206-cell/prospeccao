"use client"

import { useState, FormEvent } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useAuth } from "@/app/components/AuthProvider"
import { Loader2, LogIn, ShieldCheck } from "lucide-react"

function readErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return "Erro inesperado"
}

/**
 * Validates and returns a safe internal redirect path.
 * Blocks open-redirect attacks: rejects external URLs (http://, //),
 * protocol-relative paths, and javascript: URIs.
 * Only accepts paths that start with a single / followed by a non-/ character,
 * or exactly "/".
 */
export function safeRedirect(from: string | null): string {
  if (!from) return '/whatsapp'
  // Allow only internal paths: starts with / but not // or /\
  if (/^\/[^/\\]/.test(from) || from === '/') return from
  return '/whatsapp'
}

export default function LoginPageClient() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { refreshSession } = useAuth()
  const redirectTo = safeRedirect(searchParams.get("from"))

  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // First-user registration state
  const [showRegister, setShowRegister] = useState(false)
  const [regEmail, setRegEmail] = useState("")
  const [regPassword, setRegPassword] = useState("")
  const [regSetupSecret, setRegSetupSecret] = useState("")
  const [needsSetupSecret, setNeedsSetupSecret] = useState(false)
  const [regLoading, setRegLoading] = useState(false)
  const [regSuccess, setRegSuccess] = useState(false)
  const [regError, setRegError] = useState<string | null>(null)

  async function handleLogin(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      })
      const payload = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) {
        setError(payload.error ?? `Erro HTTP ${res.status}`)
        return
      }
      // Refresh auth context so user is set before navigating — prevents the
      // WhatsApp layout from seeing user=null and bouncing back to /login.
      await refreshSession()
      router.push(redirectTo)
    } catch (err) {
      setError(readErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  async function handleRegister(e: FormEvent) {
    e.preventDefault()
    setRegError(null)
    setRegLoading(true)
    try {
      const body: Record<string, string> = { email: regEmail.trim(), password: regPassword }
      if (regSetupSecret) body.setup_secret = regSetupSecret
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const payload = (await res.json().catch(() => ({}))) as { error?: string; email?: string }
      if (!res.ok) {
        const msg = payload.error ?? `Erro HTTP ${res.status}`
        // If the server requires a setup_secret, reveal the field so the user can supply it
        if (msg.toLowerCase().includes('setup_secret')) setNeedsSetupSecret(true)
        setRegError(msg)
        return
      }
      setRegSuccess(true)
      setShowRegister(false)
      setEmail(regEmail.trim())
    } catch (err) {
      setRegError(readErrorMessage(err))
    } finally {
      setRegLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 p-6">
      <div className="w-full max-w-sm">
        {/* Header */}
        <div className="mb-8 text-center">
          <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-emerald-100">
            <ShieldCheck className="size-6 text-emerald-700" />
          </div>
          <h1 className="text-xl font-semibold text-zinc-900">Prospeccao B2B</h1>
          <p className="mt-1 text-sm text-zinc-500">Entre com sua conta para continuar</p>
        </div>

        {regSuccess && (
          <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            Conta criada com sucesso! Faca o login abaixo.
          </div>
        )}

        {/* Login form */}
        {!showRegister && (
          <form onSubmit={(e) => void handleLogin(e)} className="space-y-4">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-zinc-700">
                E-mail
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="voce@empresa.com"
                required
                className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm placeholder-zinc-400 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-medium text-zinc-700">
                Senha
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm placeholder-zinc-400 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
              />
            </div>

            {error && (
              <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading || !email.trim() || !password}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <LogIn className="size-4" />
              )}
              Entrar
            </button>

            <p className="text-center text-xs text-zinc-500">
              Primeiro acesso?{" "}
              <button
                type="button"
                onClick={() => setShowRegister(true)}
                className="text-emerald-600 underline hover:text-emerald-700"
              >
                Criar conta inicial
              </button>
            </p>
          </form>
        )}

        {/* First-user registration */}
        {showRegister && (
          <form onSubmit={(e) => void handleRegister(e)} className="space-y-4">
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Disponivel apenas quando nenhum usuario existe. Apos o primeiro cadastro,
              esta opcao fica desabilitada.
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-medium text-zinc-700">
                E-mail
              </label>
              <input
                type="email"
                value={regEmail}
                onChange={(e) => setRegEmail(e.target.value)}
                placeholder="voce@empresa.com"
                required
                className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm placeholder-zinc-400 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-medium text-zinc-700">
                Senha (min. 8 caracteres)
              </label>
              <input
                type="password"
                value={regPassword}
                onChange={(e) => setRegPassword(e.target.value)}
                placeholder="••••••••"
                required
                minLength={8}
                className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm placeholder-zinc-400 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
              />
            </div>

            {needsSetupSecret && (
              <div>
                <label className="mb-1.5 block text-sm font-medium text-zinc-700">
                  Chave de configuração (SETUP_SECRET)
                </label>
                <input
                  type="password"
                  value={regSetupSecret}
                  onChange={(e) => setRegSetupSecret(e.target.value)}
                  placeholder="Chave definida na variavel de ambiente"
                  required
                  className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm placeholder-zinc-400 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                />
                <p className="mt-1 text-xs text-zinc-500">
                  O administrador configurou uma chave de protecao para o primeiro cadastro.
                </p>
              </div>
            )}

            {regError && (
              <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {regError}
              </p>
            )}

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShowRegister(false)}
                className="flex-1 rounded-lg border border-zinc-300 px-4 py-2.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={regLoading || !regEmail.trim() || regPassword.length < 8}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {regLoading && <Loader2 className="size-4 animate-spin" />}
                Criar conta
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

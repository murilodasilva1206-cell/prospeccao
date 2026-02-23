"use client"

import { createContext, useContext, useEffect, useState, useCallback } from "react"
import { useRouter } from "next/navigation"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AuthUser {
  workspace_id: string
  email: string
}

interface AuthContextValue {
  user: AuthUser | null
  loading: boolean
  logout: () => Promise<void>
  /** Re-fetches /api/auth/me and updates user state. Call after login to avoid
   * navigating to a protected page while the context still shows user=null. */
  refreshSession: () => Promise<void>
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error("useAuth must be used within AuthProvider")
  return ctx
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchSession = useCallback(async () => {
    try {
      const r = await fetch("/api/auth/me")
      setUser(r.ok ? await (r.json() as Promise<AuthUser>) : null)
    } catch {
      setUser(null)
    }
  }, [])

  // Load current session on mount
  useEffect(() => {
    fetchSession().finally(() => setLoading(false))
  }, [fetchSession])

  const refreshSession = useCallback(async () => {
    await fetchSession()
  }, [fetchSession])

  const logout = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" })
    } catch {
      // Best effort — proceed with redirect regardless
    }
    setUser(null)
    router.push("/login")
  }, [router])

  return (
    <AuthContext.Provider value={{ user, loading, logout, refreshSession }}>
      {children}
    </AuthContext.Provider>
  )
}

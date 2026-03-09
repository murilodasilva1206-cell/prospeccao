'use client'

// ---------------------------------------------------------------------------
// WhatsApp module layout
// Adds a sticky top bar with nav links and a logout button to every /whatsapp
// page. Each page still renders its own internal header for page-specific
// context below this global bar.
// ---------------------------------------------------------------------------

import { useEffect } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useAuth } from '@/app/components/AuthProvider'
import AgentChat from '@/app/components/AgentChat'
import { LogOut, MessageSquare, Plug, Key, Bot, List, Loader2 } from 'lucide-react'

const NAV_LINKS = [
  { href: '/whatsapp/inbox',  label: 'Inbox',          icon: MessageSquare },
  { href: '/whatsapp/canais', label: 'Canais',          icon: Plug },
  { href: '/whatsapp/chaves', label: 'Chaves',          icon: Key },
  { href: '/whatsapp/listas', label: 'Listas',          icon: List },
  { href: '/whatsapp/llm',    label: 'Integrações IA',  icon: Bot },
]

export default function WhatsAppLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const auth = useAuth()

  // The Edge middleware allows the page to load when the session cookie is
  // present (cookie-only check, no DB). This effect catches the case where
  // the session is revoked or expired in the DB: AuthProvider calls
  // /api/auth/me on mount and sets user=null on 401, triggering a redirect.
  useEffect(() => {
    if (!auth.loading && !auth.user) {
      const loginUrl = new URL('/login', window.location.href)
      loginUrl.searchParams.set('from', pathname)
      router.replace(loginUrl.pathname + loginUrl.search)
    }
  }, [auth.loading, auth.user, pathname, router])

  // Suppress children while auth state is being resolved to avoid a flash of
  // unauthenticated content and unnecessary child component API calls.
  if (auth.loading || !auth.user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <Loader2 className="size-6 animate-spin text-slate-400" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Global top bar */}
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white shadow-sm">
        <div className="mx-auto flex h-12 w-full max-w-6xl items-center gap-6 px-4">
          {/* Brand */}
          <span className="text-sm font-semibold text-slate-800">Prospecção</span>

          {/* Nav links */}
          <nav className="flex items-center gap-1">
            {NAV_LINKS.map(({ href, label, icon: Icon }) => {
              const active = pathname.startsWith(href)
              return (
                <Link
                  key={href}
                  href={href}
                  className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    active
                      ? 'bg-emerald-50 text-emerald-700'
                      : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                  }`}
                >
                  <Icon className="size-3.5" />
                  {label}
                </Link>
              )
            })}
          </nav>

          {/* Spacer */}
          <div className="flex-1" />

          {/* User info + logout */}
          <div className="flex items-center gap-3">
            <span className="hidden text-xs text-slate-500 sm:block">
              {auth.user.email}
            </span>
            <button
              onClick={() => void auth.logout()}
              className="flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 hover:border-slate-300 hover:bg-slate-50"
              title="Sair"
            >
              <LogOut className="size-3.5" />
              Sair
            </button>
          </div>
        </div>
      </header>

      {/* Page content */}
      {children}

      {/* Prospecting agent — only shown inside the whatsapp module */}
      <AgentChat />
    </div>
  )
}

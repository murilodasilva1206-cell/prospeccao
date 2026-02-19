'use client'

import { useState } from 'react'
import type { ConversationItem } from '../hooks/useConversations'

interface ConversationListProps {
  conversations: ConversationItem[]
  selectedId: string | null
  onSelect: (id: string) => void
  loading: boolean
}

function formatLastMessage(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  if (diffDays === 0) return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  if (diffDays === 1) return 'Ontem'
  if (diffDays < 7) return d.toLocaleDateString('pt-BR', { weekday: 'short' })
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    open: 'Aberta',
    resolved: 'Resolvida',
    ai_handled: 'Atendida pela IA',
  }
  return map[status] ?? status
}

export function ConversationList({ conversations, selectedId, onSelect, loading }: ConversationListProps) {
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('open')

  const filtered = conversations
    .filter((c) => (statusFilter === 'all' ? true : c.status === statusFilter))
    .filter((c) =>
      search.trim()
        ? (c.contact_name ?? c.contact_phone).toLowerCase().includes(search.toLowerCase())
        : true,
    )

  return (
    <div className="flex flex-col h-full border-r border-gray-200 bg-white">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-100">
        <h2 className="text-base font-semibold text-gray-900 mb-2">Conversas</h2>
        <input
          type="search"
          placeholder="Buscar contato..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-400"
        />
        <div className="flex gap-1 mt-2">
          {['open', 'resolved', 'ai_handled', 'all'].map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-2 py-0.5 text-xs rounded-full border transition-colors ${
                statusFilter === s
                  ? 'bg-green-500 text-white border-green-500'
                  : 'bg-white text-gray-600 border-gray-200 hover:border-green-300'
              }`}
            >
              {s === 'all' ? 'Todas' : statusLabel(s)}
            </button>
          ))}
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {loading && filtered.length === 0 && (
          <div className="flex items-center justify-center h-32 text-gray-400 text-sm">
            Carregando...
          </div>
        )}
        {!loading && filtered.length === 0 && (
          <div className="flex items-center justify-center h-32 text-gray-400 text-sm">
            Nenhuma conversa encontrada
          </div>
        )}
        {filtered.map((conv) => (
          <button
            key={conv.id}
            onClick={() => onSelect(conv.id)}
            className={`w-full text-left px-4 py-3 border-b border-gray-50 hover:bg-gray-50 transition-colors ${
              selectedId === conv.id ? 'bg-green-50 border-l-4 border-l-green-500' : ''
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1">
                  <span className="font-medium text-sm text-gray-900 truncate">
                    {conv.contact_name ?? conv.contact_phone}
                  </span>
                  {conv.ai_enabled && (
                    <span className="text-xs text-purple-500" title="IA ativada">🤖</span>
                  )}
                </div>
                <p className="text-xs text-gray-500 truncate mt-0.5">
                  {conv.contact_phone}
                </p>
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0">
                <span className="text-xs text-gray-400">
                  {formatLastMessage(conv.last_message_at)}
                </span>
                {conv.unread_count > 0 && (
                  <span className="inline-flex items-center justify-center w-5 h-5 bg-green-500 text-white text-xs rounded-full font-semibold">
                    {conv.unread_count > 99 ? '99+' : conv.unread_count}
                  </span>
                )}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

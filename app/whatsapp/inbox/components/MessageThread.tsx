'use client'

import { useEffect, useRef } from 'react'
import { MessageBubble } from './MessageBubble'
import type { MessageData } from './MessageBubble'

interface MessageThreadProps {
  messages: MessageData[]
  loading: boolean
  error: string | null
  hasMore: boolean
  onLoadMore: () => void
  apiKey: string
  contactName?: string | null
  contactPhone?: string | null
}

export function MessageThread({
  messages,
  loading,
  error,
  hasMore,
  onLoadMore,
  apiKey,
  contactName,
  contactPhone,
}: MessageThreadProps) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const prevCountRef = useRef(0)

  // Scroll to bottom when new outbound messages are added
  useEffect(() => {
    const newCount = messages.length
    const lastMsg = messages[messages.length - 1]
    if (newCount > prevCountRef.current && lastMsg?.direction === 'outbound') {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
    prevCountRef.current = newCount
  }, [messages])

  // Scroll to bottom on mount
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'instant' })
  }, [])

  // Load more when scrolled to top
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const handleScroll = () => {
      if (container.scrollTop < 60 && hasMore && !loading) {
        onLoadMore()
      }
    }
    container.addEventListener('scroll', handleScroll, { passive: true })
    return () => container.removeEventListener('scroll', handleScroll)
  }, [hasMore, loading, onLoadMore])

  if (!contactPhone) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm bg-gray-50">
        Selecione uma conversa para ver as mensagens
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-gray-50">
      {/* Thread header */}
      <div className="px-4 py-3 bg-white border-b border-gray-200 flex items-center gap-3">
        <div className="w-9 h-9 rounded-full bg-green-100 flex items-center justify-center text-green-700 font-semibold text-sm shrink-0">
          {(contactName ?? contactPhone).charAt(0).toUpperCase()}
        </div>
        <div>
          <div className="font-semibold text-sm text-gray-900">{contactName ?? contactPhone}</div>
          {contactName && <div className="text-xs text-gray-500">{contactPhone}</div>}
        </div>
      </div>

      {/* Messages */}
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto px-4 py-4 space-y-1"
      >
        {hasMore && (
          <div className="flex justify-center mb-4">
            <button
              onClick={onLoadMore}
              disabled={loading}
              className="text-xs text-blue-500 hover:text-blue-700 disabled:opacity-40"
            >
              {loading ? 'Carregando...' : 'Carregar mensagens anteriores'}
            </button>
          </div>
        )}

        {error && (
          <div className="px-3 py-2 bg-red-50 border border-red-200 rounded text-sm text-red-700 mb-2">
            {error}
          </div>
        )}

        {messages.length === 0 && !loading && (
          <div className="flex items-center justify-center h-32 text-gray-400 text-sm">
            Nenhuma mensagem ainda
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} apiKey={apiKey} />
        ))}

        <div ref={bottomRef} />
      </div>
    </div>
  )
}

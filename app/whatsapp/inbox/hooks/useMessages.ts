'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import type { MessageData } from '../components/MessageBubble'

interface UseMessagesOptions {
  conversationId: string | null
  pollInterval?: number
}

export function useMessages({ conversationId, pollInterval = 5000 }: UseMessagesOptions) {
  const [messages, setMessages] = useState<MessageData[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const oldestIdRef = useRef<string | null>(null)

  const fetchMessages = useCallback(
    async (before?: string) => {
      if (!conversationId) return
      setLoading(true)
      try {
        const params = new URLSearchParams({ limit: '50' })
        if (before) params.set('before', before)

        const res = await fetch(
          `/api/whatsapp/conversations/${conversationId}/messages?${params}`,
        )
        if (!res.ok) {
          const d = await res.json() as { error?: string }
          throw new Error(d.error ?? `HTTP ${res.status}`)
        }
        const data = await res.json() as { data: MessageData[] }
        const fetched = data.data

        if (before) {
          // Prepend older messages
          setMessages((prev) => [...fetched, ...prev])
          setHasMore(fetched.length === 50)
        } else {
          setMessages(fetched)
          setHasMore(fetched.length === 50)
          if (fetched.length > 0) {
            oldestIdRef.current = fetched[0].id
          }
        }
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Erro ao carregar mensagens')
      } finally {
        setLoading(false)
      }
    },
    [conversationId],
  )

  // Initial load + poll for new messages (poll by re-fetching latest page)
  useEffect(() => {
    setMessages([])
    oldestIdRef.current = null
    if (!conversationId) return
    fetchMessages()
    const interval = setInterval(() => fetchMessages(), pollInterval)
    return () => clearInterval(interval)
  }, [conversationId, fetchMessages, pollInterval])

  const loadMore = useCallback(() => {
    if (messages.length > 0) {
      fetchMessages(messages[0].id)
    }
  }, [messages, fetchMessages])

  const sendTextMessage = useCallback(
    async (text: string) => {
      if (!conversationId) return
      const res = await fetch(`/api/whatsapp/conversations/${conversationId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      if (!res.ok) {
        const d = await res.json() as { error?: string }
        throw new Error(d.error ?? `HTTP ${res.status}`)
      }
      // Re-fetch messages after send
      await fetchMessages()
    },
    [conversationId, fetchMessages],
  )

  return { messages, loading, error, hasMore, loadMore, sendTextMessage, refetch: fetchMessages }
}

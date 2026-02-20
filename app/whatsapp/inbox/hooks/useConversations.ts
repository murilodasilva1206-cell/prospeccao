'use client'

import { useState, useEffect, useCallback } from 'react'

export interface ConversationItem {
  id: string
  channel_id: string
  channel_name?: string
  channel_provider?: 'META_CLOUD' | 'EVOLUTION' | 'UAZAPI'
  workspace_id: string
  contact_phone: string
  contact_name: string | null
  status: 'open' | 'resolved' | 'ai_handled'
  last_message_at: string | null
  unread_count: number
  ai_enabled: boolean
  created_at: string
  updated_at: string
}

interface UseConversationsOptions {
  apiKey: string
  pollInterval?: number
  status?: string
}

export function useConversations({ apiKey, pollInterval = 5000, status }: UseConversationsOptions) {
  const [conversations, setConversations] = useState<ConversationItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchConversations = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: '50' })
      if (status) params.set('status', status)

      const res = await fetch(`/api/whatsapp/conversations?${params}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })

      if (!res.ok) {
        const data = await res.json() as { error?: string }
        throw new Error(data.error ?? `HTTP ${res.status}`)
      }

      const data = await res.json() as { data: ConversationItem[] }
      setConversations(data.data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar conversas')
    } finally {
      setLoading(false)
    }
  }, [apiKey, status])

  useEffect(() => {
    fetchConversations()
    const interval = setInterval(fetchConversations, pollInterval)
    return () => clearInterval(interval)
  }, [fetchConversations, pollInterval])

  const patchConversation = useCallback(
    async (id: string, patch: { status?: string; ai_enabled?: boolean }) => {
      const res = await fetch(`/api/whatsapp/conversations/${id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(patch),
      })
      if (!res.ok) {
        const d = await res.json() as { error?: string }
        throw new Error(d.error ?? `HTTP ${res.status}`)
      }
      await fetchConversations()
    },
    [apiKey, fetchConversations],
  )

  return { conversations, loading, error, refetch: fetchConversations, patchConversation }
}

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
  pollInterval?: number
  status?: string
  provider?: string
  channel_id?: string
  date_from?: string
  date_to?: string
  preset?: string
  offset?: number
}

export function useConversations({
  pollInterval = 5000,
  status,
  provider,
  channel_id,
  date_from,
  date_to,
  preset,
  offset,
}: UseConversationsOptions = {}) {
  const [conversations, setConversations] = useState<ConversationItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function doFetch() {
    try {
      const params = new URLSearchParams()
      params.set('limit', '50')
      if (status) params.set('status', status)
      if (provider) params.set('provider', provider)
      if (channel_id) params.set('channel_id', channel_id)
      if (offset !== undefined) params.set('offset', String(offset))
      if (preset) params.set('preset', preset)
      else {
        if (date_from) params.set('date_from', date_from)
        if (date_to) params.set('date_to', date_to)
      }

      const res = await fetch(`/api/whatsapp/conversations?${params}`)

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
  }

  const fetchConversations = useCallback(doFetch, [status, provider, channel_id, date_from, date_to, preset, offset])

  useEffect(() => {
    fetchConversations()
    const interval = setInterval(fetchConversations, pollInterval)
    return () => clearInterval(interval)
  }, [fetchConversations, pollInterval])

  const patchConversation = useCallback(
    async (id: string, patch: { status?: string; ai_enabled?: boolean }) => {
      const res = await fetch(`/api/whatsapp/conversations/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!res.ok) {
        const d = await res.json() as { error?: string }
        throw new Error(d.error ?? `HTTP ${res.status}`)
      }
      await fetchConversations()
    },
    [fetchConversations],
  )

  return { conversations, loading, error, refetch: fetchConversations, patchConversation }
}

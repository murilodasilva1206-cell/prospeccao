'use client'

import { useState } from 'react'
import { ConversationList } from './components/ConversationList'
import { MessageThread } from './components/MessageThread'
import { MessageComposer } from './components/MessageComposer'
import { useConversations } from './hooks/useConversations'
import { useMessages } from './hooks/useMessages'
import type { ConversationItem } from './hooks/useConversations'

interface ContextPanelProps {
  conversation: ConversationItem | null
  onPatch: (id: string, patch: { status?: string; ai_enabled?: boolean }) => Promise<void>
}

function ContextPanel({ conversation, onPatch }: ContextPanelProps) {
  if (!conversation) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm p-4">
        Sem conversa selecionada
      </div>
    )
  }

  function statusLabel(status: 'open' | 'resolved' | 'ai_handled'): string {
    switch (status) {
      case 'open':
        return 'Aberta'
      case 'resolved':
        return 'Resolvida'
      case 'ai_handled':
        return 'Atendida pela IA'
      default:
        return status
    }
  }

  return (
    <div className="p-4 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-gray-900 mb-1">Contato</h3>
        <p className="text-sm text-gray-700">{conversation.contact_name ?? '-'}</p>
        <p className="text-xs text-gray-500">{conversation.contact_phone}</p>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-gray-900 mb-1">Status</h3>
        <div className="flex flex-col gap-1">
          {(['open', 'resolved', 'ai_handled'] as const).map((s) => (
            <button
              key={s}
              onClick={() => onPatch(conversation.id, { status: s })}
              className={`px-2 py-1 text-xs rounded border text-left transition-colors ${
                conversation.status === s
                  ? 'bg-green-500 text-white border-green-500'
                  : 'bg-white text-gray-600 border-gray-200 hover:border-green-300'
              }`}
            >
              {statusLabel(s)}
            </button>
          ))}
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-gray-900 mb-1">Assistente IA</h3>
        <button
          onClick={() => onPatch(conversation.id, { ai_enabled: !conversation.ai_enabled })}
          className={`w-full px-3 py-1.5 text-xs rounded border transition-colors ${
            conversation.ai_enabled
              ? 'bg-purple-500 text-white border-purple-500'
              : 'bg-white text-gray-600 border-gray-200 hover:border-purple-300'
          }`}
        >
          {conversation.ai_enabled ? 'IA ativada' : 'Ativar IA'}
        </button>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-gray-900 mb-1">Mensagens nao lidas</h3>
        <span className="text-2xl font-bold text-gray-700">{conversation.unread_count}</span>
      </div>
    </div>
  )
}

export default function InboxPage() {
  const [apiKey, setApiKey] = useState<string>('')
  const [keyInput, setKeyInput] = useState<string>('')
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null)
  const [statusFilter] = useState<string>('open')

  const { conversations, loading: convLoading, patchConversation } = useConversations({
    apiKey,
    status: statusFilter,
  })

  const selectedConversation = conversations.find((c) => c.id === selectedConversationId) ?? null

  const {
    messages,
    loading: msgLoading,
    error: msgError,
    hasMore,
    loadMore,
    refetch,
  } = useMessages({
    conversationId: selectedConversationId,
    apiKey,
  })

  if (!apiKey) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-50">
        <div className="p-8 bg-white rounded-xl shadow border border-gray-100 w-full max-w-sm">
          <h2 className="text-lg font-semibold text-gray-900 mb-1">Chave de API do Workspace</h2>
          <p className="text-sm text-gray-500 mb-4">
            Insira a chave <code className="bg-gray-100 px-1 rounded">wk_...</code> gerada com{' '}
            <code className="bg-gray-100 px-1 rounded">bootstrap-api-key.mjs</code>.
            A chave e mantida apenas em memoria.
          </p>
          <input
            type="password"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && keyInput.trim().startsWith('wk_')) {
                setApiKey(keyInput.trim())
              }
            }}
            placeholder="wk_..."
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-400 mb-3"
          />
          <button
            onClick={() => {
              if (keyInput.trim().startsWith('wk_')) setApiKey(keyInput.trim())
            }}
            disabled={!keyInput.trim().startsWith('wk_')}
            className="w-full py-2 text-sm font-medium bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Entrar
          </button>
          <p className="mt-3 text-xs text-gray-400 text-center">
            <a href="/whatsapp" className="underline hover:text-gray-600">
              Voltar ao modulo WhatsApp
            </a>
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-screen bg-gray-100 overflow-hidden">
      <div className="w-72 shrink-0 flex flex-col bg-white border-r border-gray-200">
        <div className="px-4 py-3 border-b border-gray-100 bg-green-600">
          <h1 className="text-base font-semibold text-white">Inbox OmniCanal</h1>
          <div className="mt-1 flex gap-3 text-xs text-green-200">
            <a href="/whatsapp" className="hover:text-white">Modulo</a>
            <a href="/whatsapp/canais" className="hover:text-white">Canais</a>
            <a href="/whatsapp/chaves" className="hover:text-white">Chaves</a>
          </div>
        </div>
        <div className="flex-1 overflow-hidden">
          <ConversationList
            conversations={conversations}
            selectedId={selectedConversationId}
            onSelect={setSelectedConversationId}
            loading={convLoading}
          />
        </div>
      </div>

      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex-1 overflow-hidden">
          <MessageThread
            messages={messages}
            loading={msgLoading}
            error={msgError}
            hasMore={hasMore}
            onLoadMore={loadMore}
            apiKey={apiKey}
            contactName={selectedConversation?.contact_name}
            contactPhone={selectedConversation?.contact_phone}
          />
        </div>
        <MessageComposer
          conversationId={selectedConversationId}
          channelId={selectedConversation?.channel_id ?? null}
          contactPhone={selectedConversation?.contact_phone ?? null}
          apiKey={apiKey}
          onMessageSent={refetch}
        />
      </div>

      <div className="w-64 shrink-0 bg-white border-l border-gray-200 overflow-y-auto">
        <div className="px-4 py-3 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-700">Detalhes</h2>
        </div>
        <ContextPanel conversation={selectedConversation} onPatch={patchConversation} />
      </div>
    </div>
  )
}

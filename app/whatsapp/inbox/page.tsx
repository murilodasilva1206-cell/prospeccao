'use client'

import { useState } from 'react'
import {
  Bot,
  ChevronRight,
  Phone,
  UserRound,
} from 'lucide-react'
import { ConversationList } from './components/ConversationList'
import { MessageThread } from './components/MessageThread'
import { MessageComposer } from './components/MessageComposer'
import { useConversations } from './hooks/useConversations'
import { useMessages } from './hooks/useMessages'
import type { ConversationItem } from './hooks/useConversations'

function conversationStatusLabel(status: 'open' | 'resolved' | 'ai_handled') {
  switch (status) {
    case 'open': return 'Aberta'
    case 'resolved': return 'Resolvida'
    case 'ai_handled': return 'Atendida pela IA'
  }
}

function ContactCockpit({ conversation }: { conversation: ConversationItem | null }) {
  if (!conversation) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
        Selecione uma conversa para ver os detalhes do lead.
      </div>
    )
  }

  const displayName = conversation.contact_name ?? conversation.contact_phone
  const initial = displayName.charAt(0).toUpperCase()

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="flex size-14 items-center justify-center rounded-full bg-emerald-100 text-lg font-semibold text-emerald-800">
            {initial}
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-900">{displayName}</p>
            <p className="truncate text-xs text-slate-500">{conversation.contact_phone}</p>
            <p className="truncate text-xs text-slate-500">
              Canal: {conversation.channel_name ?? conversation.channel_id.slice(0, 8)}
            </p>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-sm font-semibold text-slate-800">Detalhes do contato</h3>
        <div className="space-y-2 text-xs text-slate-600">
          <p className="flex items-center gap-2"><Phone className="size-3.5" /> {conversation.contact_phone}</p>
          <p>E-mail: não informado</p>
          <p>Endereço: não informado</p>
          <p>Nome do canal: {conversation.channel_name ?? '-'}</p>
          <p>Provedor: {conversation.channel_provider ?? '-'}</p>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-sm font-semibold text-slate-800">Contexto de prospecção</h3>
        <div className="space-y-2 text-xs text-slate-700">
          <p>Mensagens não lidas: {conversation.unread_count}</p>
          <p>Status da conversa: {conversationStatusLabel(conversation.status)}</p>
          <p>IA no contato: {conversation.ai_enabled ? 'Ativada' : 'Desativada'}</p>
        </div>
      </section>
    </div>
  )
}

function InsightsPanel({
  conversation,
  onPatch,
}: {
  conversation: ConversationItem | null
  onPatch: (id: string, patch: { status?: string; ai_enabled?: boolean }) => Promise<void>
}) {
  if (!conversation) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
        Sem conversa selecionada.
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-800">Assistente IA</h3>
          <Bot className="size-4 text-violet-600" />
        </div>
        <button
          onClick={() => onPatch(conversation.id, { ai_enabled: !conversation.ai_enabled })}
          className={`w-full rounded-md border px-3 py-2 text-xs font-medium transition-colors ${
            conversation.ai_enabled
              ? 'border-violet-500 bg-violet-500 text-white'
              : 'border-slate-300 bg-white text-slate-700 hover:border-violet-300'
          }`}
        >
          {conversation.ai_enabled ? 'IA ativada' : 'Ativar IA'}
        </button>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-sm font-semibold text-slate-800">Próxima melhor ação</h3>
        <div className="space-y-2 text-xs text-slate-700">
          <button className="flex w-full items-center justify-between rounded-md border border-slate-200 px-3 py-2 hover:bg-slate-50">
            Enviar template de follow-up <ChevronRight className="size-3.5" />
          </button>
          <button className="flex w-full items-center justify-between rounded-md border border-slate-200 px-3 py-2 hover:bg-slate-50">
            Solicitar áudio de qualificação <ChevronRight className="size-3.5" />
          </button>
          <button className="flex w-full items-center justify-between rounded-md border border-slate-200 px-3 py-2 hover:bg-slate-50">
            Converter em oportunidade <ChevronRight className="size-3.5" />
          </button>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="mb-2 text-sm font-semibold text-slate-800">Resumo rápido</h3>
        <p className="text-xs text-slate-600">
          Conversa em andamento para prospecção outbound. Use mensagens curtas, CTA claro
          e registro de próximo passo.
        </p>
      </section>
    </div>
  )
}

export default function InboxPage() {
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null)
  const { conversations, loading: convLoading, patchConversation } = useConversations()

  const selectedConversation = conversations.find((c) => c.id === selectedConversationId) ?? null

  const { messages, loading: msgLoading, error: msgError, hasMore, loadMore, refetch } = useMessages({
    conversationId: selectedConversationId,
  })

  return (
    <main className="min-h-screen bg-slate-100 p-4 md:p-6">
      <div className="mb-3 flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
        <div>
          <p className="text-base font-semibold text-slate-900">Inbox OmniChannel</p>
          <p className="text-xs text-slate-500">Layout operacional de prospecção multicanal</p>
        </div>
        <div className="hidden items-center gap-2 text-xs text-slate-600 md:flex">
          <a href="/whatsapp" className="rounded border border-slate-200 px-2 py-1 hover:bg-slate-50">Módulo</a>
          <a href="/whatsapp/canais" className="rounded border border-slate-200 px-2 py-1 hover:bg-slate-50">Canais</a>
          <a href="/whatsapp/chaves" className="rounded border border-slate-200 px-2 py-1 hover:bg-slate-50">Chaves</a>
        </div>
      </div>

      <div className="grid gap-3 xl:grid-cols-[300px_320px_1fr_300px]">
        <aside className="hidden xl:block">
          <ContactCockpit conversation={selectedConversation} />
        </aside>

        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <ConversationList
            conversations={conversations}
            selectedId={selectedConversationId}
            onSelect={setSelectedConversationId}
            loading={convLoading}
          />
        </section>

        <section className="flex min-h-[70vh] min-w-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-4 py-3">
            <div className="flex items-center gap-2">
              <div className="flex size-9 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
                <UserRound className="size-4" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-slate-900">
                  {selectedConversation?.contact_name ?? 'Selecione um contato'}
                </p>
                <p className="truncate text-xs text-slate-500">
                  {selectedConversation?.contact_phone ?? 'Sem telefone selecionado'}
                </p>
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-hidden">
            <MessageThread
              messages={messages}
              loading={msgLoading}
              error={msgError}
              hasMore={hasMore}
              onLoadMore={loadMore}
              contactName={selectedConversation?.contact_name}
              contactPhone={selectedConversation?.contact_phone}
            />
          </div>

          <MessageComposer
            conversationId={selectedConversationId}
            channelId={selectedConversation?.channel_id ?? null}
            channelProvider={selectedConversation?.channel_provider}
            contactPhone={selectedConversation?.contact_phone ?? null}
            onMessageSent={refetch}
          />
        </section>

        <aside className="hidden xl:block">
          <InsightsPanel conversation={selectedConversation} onPatch={patchConversation} />
        </aside>
      </div>
    </main>
  )
}

'use client'

import { useState, useEffect } from 'react'
import { StatusTick } from './StatusTick'

export interface MessageData {
  id: string
  direction: 'inbound' | 'outbound'
  message_type: 'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker' | 'reaction'
  status: 'queued' | 'sent' | 'delivered' | 'read' | 'failed'
  body: string | null
  media_url?: string
  media_filename: string | null
  media_mime_type: string | null
  reaction_to_msg_id: string | null
  sent_by: string
  created_at: string
  conversation_id: string
}

interface MessageBubbleProps {
  message: MessageData
  onReact?: (messageId: string) => void
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

function MediaContent({ message }: { message: MessageData }) {
  const [signedUrl, setSignedUrl] = useState<string | null>(message.media_url ?? null)

  useEffect(() => {
    if (signedUrl || !message.id) return
    // Fetch signed URL if not pre-populated (session cookie sent automatically)
    fetch(`/api/whatsapp/media/${message.id}`)
      .then((r) => r.json())
      .then((d) => { if (d.url) setSignedUrl(d.url as string) })
      .catch(() => null)
  }, [message.id, signedUrl])

  if (message.message_type === 'image' || message.message_type === 'sticker') {
    if (!signedUrl) return <div className="w-48 h-32 bg-gray-200 animate-pulse rounded" />
    return (
      <img
        src={signedUrl}
        alt={message.media_filename ?? 'imagem'}
        className="max-w-xs max-h-64 rounded object-contain"
        loading="lazy"
      />
    )
  }

  if (message.message_type === 'audio') {
    if (!signedUrl) return <div className="w-48 h-10 bg-gray-200 animate-pulse rounded" />
    return (
      <audio controls className="max-w-xs w-full">
        <source src={signedUrl} type={message.media_mime_type ?? 'audio/ogg'} />
        Seu navegador nao suporta audio.
      </audio>
    )
  }

  if (message.message_type === 'video') {
    if (!signedUrl) return <div className="w-48 h-32 bg-gray-200 animate-pulse rounded" />
    return (
      <video controls className="max-w-xs max-h-48 rounded">
        <source src={signedUrl} type={message.media_mime_type ?? 'video/mp4'} />
        Seu navegador nao suporta video.
      </video>
    )
  }

  if (message.message_type === 'document') {
    return (
      <a
        href={signedUrl ?? '#'}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-2 px-3 py-2 bg-white bg-opacity-20 rounded hover:bg-opacity-30"
      >
        <span className="text-2xl">📄</span>
        <span className="text-sm underline truncate max-w-48">
          {message.media_filename ?? 'documento'}
        </span>
      </a>
    )
  }

  return null
}

export function MessageBubble({ message, onReact }: MessageBubbleProps) {
  const isOutbound = message.direction === 'outbound'

  if (message.message_type === 'reaction') {
    return (
      <div className={`flex ${isOutbound ? 'justify-end' : 'justify-start'} mb-1`}>
        <div className="text-2xl" title={`Reação: ${message.body}`}>
          {message.body}
        </div>
      </div>
    )
  }

  return (
    <div className={`flex ${isOutbound ? 'justify-end' : 'justify-start'} mb-2 group`}>
      <div
        className={`
          relative max-w-sm px-3 py-2 rounded-lg text-sm shadow-sm
          ${isOutbound
            ? 'bg-green-100 text-gray-900 rounded-br-none'
            : 'bg-white text-gray-900 rounded-bl-none border border-gray-100'
          }
        `}
      >
        {/* Media content */}
        {(['image', 'audio', 'video', 'document', 'sticker'] as const).includes(
          message.message_type as never,
        ) && <MediaContent message={message} />}

        {/* Text body */}
        {message.body && (
          <p className="whitespace-pre-wrap break-words mt-1">{message.body}</p>
        )}

        {/* Footer: time + status */}
        <div className={`flex items-center gap-1 mt-1 ${isOutbound ? 'justify-end' : 'justify-start'}`}>
          <span className="text-xs text-gray-400">{formatTime(message.created_at)}</span>
          {isOutbound && <StatusTick status={message.status} />}
        </div>

        {/* React button — shown on hover for inbound messages */}
        {!isOutbound && onReact && (
          <button
            onClick={() => onReact(message.id)}
            className="absolute -right-6 top-1 opacity-0 group-hover:opacity-100 transition-opacity text-lg"
            title="Reagir"
            aria-label="Reagir a mensagem"
          >
            😊
          </button>
        )}
      </div>
    </div>
  )
}

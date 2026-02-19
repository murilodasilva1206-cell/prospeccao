'use client'

import { useState, useRef, useCallback } from 'react'

interface MessageComposerProps {
  conversationId: string | null
  channelId: string | null
  contactPhone: string | null
  apiKey: string
  onMessageSent: () => void
}

export function MessageComposer({
  conversationId,
  channelId,
  contactPhone,
  apiKey,
  onMessageSent,
}: MessageComposerProps) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleSendText = useCallback(async () => {
    if (!text.trim() || !conversationId) return
    setSending(true)
    setUploadError(null)
    try {
      const res = await fetch(`/api/whatsapp/conversations/${conversationId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: text.trim() }),
      })
      if (!res.ok) {
        const d = await res.json() as { error?: string }
        throw new Error(d.error ?? `HTTP ${res.status}`)
      }
      setText('')
      onMessageSent()
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Erro ao enviar mensagem')
    } finally {
      setSending(false)
    }
  }, [text, conversationId, apiKey, onMessageSent])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSendText()
      }
    },
    [handleSendText],
  )

  const handleFileUpload = useCallback(
    async (file: File) => {
      if (!channelId || !contactPhone) return
      setUploadError(null)
      setSending(true)
      try {
        const form = new FormData()
        form.append('to', contactPhone)
        form.append('file', file)

        // Determine type from MIME
        const mime = file.type
        const type = mime.startsWith('image/') ? 'image'
          : mime.startsWith('audio/') ? 'audio'
          : mime.startsWith('video/') ? 'video'
          : mime === 'image/webp' && file.name.endsWith('.webp') ? 'sticker'
          : 'document'
        form.append('type', type)

        const res = await fetch(`/api/whatsapp/channels/${channelId}/send-media`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
        })
        if (!res.ok) {
          const d = await res.json() as { error?: string }
          throw new Error(d.error ?? `HTTP ${res.status}`)
        }
        onMessageSent()
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : 'Erro ao enviar arquivo')
      } finally {
        setSending(false)
        if (fileInputRef.current) fileInputRef.current.value = ''
      }
    },
    [channelId, contactPhone, apiKey, onMessageSent],
  )

  const disabled = !conversationId || sending

  return (
    <div className="border-t border-gray-200 bg-white px-4 py-3">
      {uploadError && (
        <div className="mb-2 px-3 py-1.5 bg-red-50 border border-red-200 rounded text-sm text-red-700">
          {uploadError}
        </div>
      )}

      <div className="flex items-end gap-2">
        {/* File attachment */}
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept="image/*,audio/*,video/*,application/pdf,.doc,.docx"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) handleFileUpload(file)
          }}
          disabled={disabled}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
          className="p-2 text-gray-400 hover:text-gray-600 disabled:opacity-40 transition-colors"
          title="Anexar arquivo"
          aria-label="Anexar arquivo"
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {/* Text input */}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={disabled ? 'Selecione uma conversa' : 'Digite uma mensagem... (Enter para enviar)'}
          disabled={disabled}
          rows={1}
          className="flex-1 resize-none px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-400 disabled:bg-gray-50 disabled:text-gray-400 max-h-32 overflow-y-auto"
          style={{ minHeight: '2.5rem' }}
        />

        {/* Send button */}
        <button
          onClick={handleSendText}
          disabled={disabled || !text.trim()}
          className="p-2 bg-green-500 text-white rounded-lg hover:bg-green-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          title="Enviar mensagem"
          aria-label="Enviar mensagem"
        >
          <svg className="w-5 h-5 rotate-90" viewBox="0 0 24 24" fill="currentColor">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
          </svg>
        </button>
      </div>
    </div>
  )
}

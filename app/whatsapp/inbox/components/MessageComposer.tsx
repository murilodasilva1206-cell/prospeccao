'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Mic, Paperclip, Send, FileText, Square } from 'lucide-react'

interface MessageComposerProps {
  conversationId: string | null
  channelId: string | null
  channelProvider?: 'META_CLOUD' | 'EVOLUTION' | 'UAZAPI'
  contactPhone: string | null
  onMessageSent: () => void
}

interface ApiTemplate {
  id: string
  template_name: string
  language: string
  status: string
}

export function MessageComposer({
  conversationId,
  channelId,
  channelProvider,
  contactPhone,
  onMessageSent,
}: MessageComposerProps) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)
  const [templateMenuOpen, setTemplateMenuOpen] = useState(false)
  const [apiTemplates, setApiTemplates] = useState<ApiTemplate[]>([])
  const [templatesLoading, setTemplatesLoading] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)

  // Load APPROVED templates whenever the META_CLOUD channel changes
  useEffect(() => {
    if (channelProvider !== 'META_CLOUD' || !channelId) {
      setApiTemplates([])
      return
    }
    setTemplatesLoading(true)
    fetch(`/api/whatsapp/channels/${channelId}/templates?status=APPROVED&limit=100`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d: { data?: ApiTemplate[] }) => setApiTemplates(d.data ?? []))
      .catch(() => setApiTemplates([]))
      .finally(() => setTemplatesLoading(false))
  }, [channelId, channelProvider])

  const sendMediaFile = useCallback(
    async (file: File) => {
      if (!channelId || !contactPhone) return
      setErrorMessage(null)
      setSending(true)
      try {
        const form = new FormData()
        form.append('to', contactPhone)
        form.append('file', file)

        const mime = file.type
        const type = mime.startsWith('image/')
          ? 'image'
          : mime.startsWith('audio/')
            ? 'audio'
            : mime.startsWith('video/')
              ? 'video'
              : mime === 'image/webp' && file.name.endsWith('.webp')
                ? 'sticker'
                : 'document'
        form.append('type', type)

        const res = await fetch(`/api/whatsapp/channels/${channelId}/send-media`, {
          method: 'POST',
          body: form,
        })
        if (!res.ok) {
          const d = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(d.error ?? `HTTP ${res.status}`)
        }
        onMessageSent()
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : 'Erro ao enviar arquivo')
      } finally {
        setSending(false)
        if (fileInputRef.current) fileInputRef.current.value = ''
      }
    },
    [channelId, contactPhone, onMessageSent],
  )

  const handleSendText = useCallback(async () => {
    if (!text.trim() || !conversationId) return
    setSending(true)
    setErrorMessage(null)
    try {
      const res = await fetch(`/api/whatsapp/conversations/${conversationId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.trim() }),
      })
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(d.error ?? `HTTP ${res.status}`)
      }
      setText('')
      onMessageSent()
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Erro ao enviar mensagem')
    } finally {
      setSending(false)
    }
  }, [text, conversationId, onMessageSent])

  const handleSendTemplate = useCallback(
    async (templateName: string, language: string) => {
      if (!channelId || !contactPhone) return
      setTemplateMenuOpen(false)
      setSending(true)
      setErrorMessage(null)
      try {
        const res = await fetch(`/api/whatsapp/channels/${channelId}/send-template`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: contactPhone.replace(/[^\d]/g, ''),
            name: templateName,
            language,
            body_params: [],
          }),
        })
        if (!res.ok) {
          const d = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(d.error ?? `HTTP ${res.status}`)
        }
        onMessageSent()
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : 'Erro ao enviar template')
      } finally {
        setSending(false)
      }
    },
    [channelId, contactPhone, onMessageSent],
  )

  const stopRecording = useCallback(async () => {
    const recorder = mediaRecorderRef.current
    if (recorder && recorder.state !== 'inactive') recorder.stop()

    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    setRecording(false)
  }, [])

  const startRecording = useCallback(async () => {
    if (!channelId || !contactPhone) return
    setErrorMessage(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      chunksRef.current = []

      const preferred = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : undefined

      const recorder = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined)
      mediaRecorderRef.current = recorder

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data)
      }

      recorder.onstop = async () => {
        const mimeType = recorder.mimeType || 'audio/webm'
        const extension = mimeType.includes('ogg') ? 'ogg' : 'webm'
        const blob = new Blob(chunksRef.current, { type: mimeType })
        const file = new File([blob], `gravacao.${extension}`, { type: mimeType })
        await sendMediaFile(file)
      }

      recorder.start()
      setRecording(true)
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Nao foi possivel acessar o microfone')
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      setRecording(false)
    }
  }, [channelId, contactPhone, sendMediaFile])

  const disabled = !conversationId || sending
  const templateEnabled = channelProvider === 'META_CLOUD'

  return (
    <div className="border-t border-gray-200 bg-white px-4 py-3">
      {errorMessage && (
        <div className="mb-2 rounded border border-red-200 bg-red-50 px-3 py-1.5 text-sm text-red-700">
          {errorMessage}
        </div>
      )}

      <div className="flex items-end gap-2">
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept="image/*,audio/*,video/*,application/pdf,.doc,.docx"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void sendMediaFile(file)
          }}
          disabled={disabled}
        />

        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
          className="rounded p-2 text-gray-500 transition-colors hover:text-gray-700 disabled:opacity-40"
          title="Anexar arquivo"
          aria-label="Anexar arquivo"
        >
          <Paperclip className="size-5" />
        </button>

        <button
          onClick={() => {
            if (recording) {
              void stopRecording()
            } else {
              void startRecording()
            }
          }}
          disabled={disabled}
          className={`rounded p-2 transition-colors disabled:opacity-40 ${
            recording ? 'text-red-600 hover:text-red-700' : 'text-gray-500 hover:text-gray-700'
          }`}
          title={recording ? 'Parar gravacao' : 'Gravar audio'}
          aria-label={recording ? 'Parar gravacao' : 'Gravar audio'}
        >
          {recording ? <Square className="size-5" /> : <Mic className="size-5" />}
        </button>

        <div className="relative">
          <button
            onClick={() => setTemplateMenuOpen((v) => !v)}
            disabled={disabled || !templateEnabled}
            className="rounded p-2 text-gray-500 transition-colors hover:text-gray-700 disabled:opacity-40"
            title={templateEnabled ? 'Enviar template' : 'Templates disponiveis apenas no canal Meta'}
            aria-label="Templates"
          >
            <FileText className="size-5" />
          </button>

          {templateMenuOpen && templateEnabled && (
            <div className="absolute bottom-11 left-0 z-20 w-64 rounded-lg border border-gray-200 bg-white p-2 shadow-lg">
              <p className="px-2 pb-1 text-xs font-medium text-gray-500">Templates aprovados</p>
              {templatesLoading ? (
                <div className="flex items-center justify-center py-3">
                  <Loader2 className="size-4 animate-spin text-gray-400" />
                </div>
              ) : apiTemplates.length === 0 ? (
                <div className="px-2 py-2 text-xs text-gray-500">
                  Nenhum template aprovado.{' '}
                  <a href="/whatsapp/canais" className="text-green-600 underline">
                    Sincronize templates
                  </a>
                </div>
              ) : (
                apiTemplates.map((tpl) => (
                  <button
                    key={tpl.id}
                    onClick={() => void handleSendTemplate(tpl.template_name, tpl.language)}
                    className="w-full rounded px-2 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
                  >
                    <span className="font-medium">{tpl.template_name}</span>
                    <span className="ml-1 text-xs text-gray-400">{tpl.language}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void handleSendText()
            }
          }}
          placeholder={disabled ? 'Selecione uma conversa' : 'Digite uma mensagem... (Enter para enviar)'}
          disabled={disabled}
          rows={1}
          className="max-h-32 min-h-[2.5rem] flex-1 resize-none overflow-y-auto rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-400 disabled:bg-gray-50 disabled:text-gray-400"
        />

        <button
          onClick={() => void handleSendText()}
          disabled={disabled || !text.trim()}
          className="rounded-lg bg-green-500 p-2 text-white transition-colors hover:bg-green-600 disabled:cursor-not-allowed disabled:opacity-40"
          title="Enviar mensagem"
          aria-label="Enviar mensagem"
        >
          <Send className="size-5" />
        </button>
      </div>
    </div>
  )
}

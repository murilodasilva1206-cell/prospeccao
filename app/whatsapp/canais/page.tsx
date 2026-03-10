"use client"

import { useEffect, useMemo, useState } from "react"
import { motion } from "motion/react"
import {
  Loader2,
  Link2,
  Pencil,
  PlugZap,
  QrCode,
  RefreshCcw,
  Send,
  ShieldCheck,
  Unplug,
} from "lucide-react"
import { toast, Toaster } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"

type Provider = "META_CLOUD" | "EVOLUTION" | "UAZAPI"
type ChannelStatus =
  | "DISCONNECTED"
  | "PENDING_QR"
  | "CONNECTING"
  | "CONNECTED"
  | "ERROR"

type Channel = {
  id: string
  workspace_id: string
  name: string
  provider: Provider
  status: ChannelStatus
  phone_number: string | null
  external_instance_id: string | null
  last_seen_at: string | null
  created_at: string
}

type CreateResponse = {
  data: Channel
  webhook_secret?: string
}

type ConnectResponse = {
  data: {
    channel_id: string
    status: ChannelStatus
    qr_code: string | null
    phone_number: string | null
  }
}

type StatusResponse = {
  data: {
    channel_id: string
    status: ChannelStatus
    provider: Provider
    phone_number: string | null
    last_seen_at: string | null
  }
}

const PROVIDERS: Array<{ value: Provider; label: string; hint: string }> = [
  {
    value: "META_CLOUD",
    label: "Meta Cloud API",
    hint: "Credenciais oficiais (sem QR code)",
  },
  {
    value: "EVOLUTION",
    label: "Evolution API",
    hint: "Conexao por QR code",
  },
  {
    value: "UAZAPI",
    label: "UAZAPI",
    hint: "Conexao por QR code",
  },
]

function statusBadgeVariant(
  status: ChannelStatus
): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "CONNECTED":
      return "default"
    case "CONNECTING":
    case "PENDING_QR":
      return "secondary"
    case "ERROR":
      return "destructive"
    default:
      return "outline"
  }
}

function statusLabel(status: ChannelStatus): string {
  switch (status) {
    case "DISCONNECTED":
      return "Desconectado"
    case "PENDING_QR":
      return "Aguardando QR"
    case "CONNECTING":
      return "Conectando"
    case "CONNECTED":
      return "Conectado"
    case "ERROR":
      return "Erro"
    default:
      return status
  }
}

function providerLabel(provider: Provider): string {
  const item = PROVIDERS.find((p) => p.value === provider)
  return item ? item.label : provider
}

function formatDate(value: string | null): string {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "-"
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date)
}

function readErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === "string") return err
  return "Erro inesperado"
}

async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init)
  const payload = (await res.json().catch(() => ({}))) as {
    error?: string
    detail?: string
  } & T
  if (!res.ok) {
    throw new Error(payload.detail ?? payload.error ?? `HTTP ${res.status}`)
  }
  return payload
}

export default function WhatsAppChannelsPage() {
  const [channels, setChannels] = useState<Channel[]>([])
  const [loadingChannels, setLoadingChannels] = useState(false)
  const [creating, setCreating] = useState(false)
  const [busyChannelId, setBusyChannelId] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<
    "connect" | "status" | "disconnect" | "send" | null
  >(null)

  const [provider, setProvider] = useState<Provider>("META_CLOUD")
  const [channelName, setChannelName] = useState("")
  const [phoneNumber, setPhoneNumber] = useState("")

  const [accessToken, setAccessToken] = useState("")
  const [phoneNumberId, setPhoneNumberId] = useState("")
  const [wabaId, setWabaId] = useState("")
  const [appSecret, setAppSecret] = useState("")
  const [instanceUrl, setInstanceUrl] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [adminToken, setAdminToken] = useState("")
  const [instanceToken, setInstanceToken] = useState("")

  const [createdWebhookSecret, setCreatedWebhookSecret] = useState("")
  const [webhookDialogOpen, setWebhookDialogOpen] = useState(false)

  const [qrDialogOpen, setQrDialogOpen] = useState(false)
  const [qrDialogChannelName, setQrDialogChannelName] = useState("")
  const [qrCodeBase64, setQrCodeBase64] = useState("")

  const [sendDialogOpen, setSendDialogOpen] = useState(false)
  const [sendChannelId, setSendChannelId] = useState("")
  const [sendTo, setSendTo] = useState("")
  const [sendMessage, setSendMessage] = useState("")

  // Edit channel modal
  const [editChannel, setEditChannel] = useState<Channel | null>(null)
  const [saving, setSaving] = useState(false)
  const [editName, setEditName] = useState("")
  const [editPhoneNumber, setEditPhoneNumber] = useState("")
  // Credential fields — all start blank; blank = keep existing on the server
  const [editInstanceUrl, setEditInstanceUrl] = useState("")
  const [editAccessToken, setEditAccessToken] = useState("")
  const [editPhoneNumberId, setEditPhoneNumberId] = useState("")
  const [editWabaId, setEditWabaId] = useState("")
  const [editAdminToken, setEditAdminToken] = useState("")
  const [editInstanceToken, setEditInstanceToken] = useState("")
  const [editApiKey, setEditApiKey] = useState("")
  const [editAppSecret, setEditAppSecret] = useState("")

  const selectedProvider = useMemo(
    () => PROVIDERS.find((item) => item.value === provider),
    [provider]
  )

  const qrImageSrc = useMemo(() => {
    if (!qrCodeBase64) return ""
    if (qrCodeBase64.startsWith("data:image")) return qrCodeBase64
    return `data:image/png;base64,${qrCodeBase64}`
  }, [qrCodeBase64])

  async function loadChannels() {
    setLoadingChannels(true)
    try {
      const data = await requestJson<{ data: Channel[] }>(
        `/api/whatsapp/channels`,
      )
      setChannels(data.data)
    } catch (err) {
      toast.error(readErrorMessage(err))
    } finally {
      setLoadingChannels(false)
    }
  }

  useEffect(() => {
    void loadChannels()
  }, [])

  function clearProviderFields() {
    setAccessToken("")
    setPhoneNumberId("")
    setWabaId("")
    setAppSecret("")
    setInstanceUrl("")
    setApiKey("")
    setAdminToken("")
    setInstanceToken("")
  }

  async function handleCreateChannel() {
    if (!channelName.trim()) {
      toast.warning("Nome do canal e obrigatorio")
      return
    }

    const credentials =
      provider === "META_CLOUD"
        ? {
            access_token: accessToken.trim(),
            phone_number_id: phoneNumberId.trim(),
            waba_id: wabaId.trim() || undefined,
            app_secret: appSecret.trim() || undefined,
          }
        : provider === "UAZAPI"
        ? {
            instance_url: instanceUrl.trim(),
            admin_token: adminToken.trim(),
            instance_token: instanceToken.trim(),
          }
        : {
            instance_url: instanceUrl.trim(),
            api_key: apiKey.trim(),
          }

    setCreating(true)
    try {
      const payload = {
        name: channelName.trim(),
        provider,
        credentials,
        phone_number: phoneNumber.trim() || undefined,
      }

      const created = await requestJson<CreateResponse>("/api/whatsapp/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })

      setChannels((prev) => [created.data, ...prev])
      setChannelName("")
      setPhoneNumber("")
      clearProviderFields()
      toast.success("Canal criado com sucesso")

      if (created.webhook_secret) {
        setCreatedWebhookSecret(created.webhook_secret)
        setWebhookDialogOpen(true)
      }
    } catch (err) {
      toast.error(readErrorMessage(err))
    } finally {
      setCreating(false)
    }
  }

  async function handleConnect(channel: Channel) {
    setBusyChannelId(channel.id)
    setBusyAction("connect")
    try {
      const result = await requestJson<ConnectResponse>(
        `/api/whatsapp/channels/${channel.id}/connect`,
        { method: "POST" },
      )

      setChannels((prev) =>
        prev.map((item) =>
          item.id === channel.id
            ? {
                ...item,
                status: result.data.status,
                phone_number: result.data.phone_number ?? item.phone_number,
              }
            : item
        )
      )

      if (result.data.qr_code) {
        setQrDialogChannelName(channel.name)
        setQrCodeBase64(result.data.qr_code)
        setQrDialogOpen(true)
        toast.success("QR code gerado")
      } else {
        toast.success("Conexao iniciada")
      }
    } catch (err) {
      toast.error(readErrorMessage(err))
    } finally {
      setBusyChannelId(null)
      setBusyAction(null)
    }
  }

  async function handleRefreshStatus(channel: Channel) {
    setBusyChannelId(channel.id)
    setBusyAction("status")
    try {
      const result = await requestJson<StatusResponse>(
        `/api/whatsapp/channels/${channel.id}/status`,
      )
      setChannels((prev) =>
        prev.map((item) =>
          item.id === channel.id
            ? {
                ...item,
                status: result.data.status,
                phone_number: result.data.phone_number ?? item.phone_number,
                last_seen_at: result.data.last_seen_at,
              }
            : item
        )
      )
      toast.success(`Status: ${statusLabel(result.data.status)}`)
    } catch (err) {
      toast.error(readErrorMessage(err))
    } finally {
      setBusyChannelId(null)
      setBusyAction(null)
    }
  }

  async function handleDisconnect(channel: Channel) {
    setBusyChannelId(channel.id)
    setBusyAction("disconnect")
    try {
      await requestJson<{ data: { status: ChannelStatus } }>(
        `/api/whatsapp/channels/${channel.id}/disconnect`,
        { method: "POST" },
      )
      setChannels((prev) =>
        prev.map((item) =>
          item.id === channel.id
            ? { ...item, status: "DISCONNECTED" }
            : item
        )
      )
      toast.success("Canal desconectado")
    } catch (err) {
      toast.error(readErrorMessage(err))
    } finally {
      setBusyChannelId(null)
      setBusyAction(null)
    }
  }

  function openEditDialog(channel: Channel) {
    setEditChannel(channel)
    setEditName(channel.name)
    setEditPhoneNumber(channel.phone_number ?? "")
    // Credential fields start blank — placeholder guides user
    setEditInstanceUrl("")
    setEditAccessToken("")
    setEditPhoneNumberId("")
    setEditWabaId("")
    setEditAdminToken("")
    setEditInstanceToken("")
    setEditApiKey("")
    setEditAppSecret("")
  }

  async function handleEditChannel() {
    if (!editChannel) return
    if (!editName.trim()) {
      toast.warning("Nome do canal e obrigatorio")
      return
    }

    // Build partial credentials — only include non-empty fields
    const rawCreds: Record<string, string> = {}
    if (editChannel.provider === "META_CLOUD") {
      if (editAccessToken.trim()) rawCreds.access_token = editAccessToken.trim()
      if (editPhoneNumberId.trim()) rawCreds.phone_number_id = editPhoneNumberId.trim()
      if (editWabaId.trim()) rawCreds.waba_id = editWabaId.trim()
      if (editAppSecret.trim()) rawCreds.app_secret = editAppSecret.trim()
    } else if (editChannel.provider === "UAZAPI") {
      if (editInstanceUrl.trim()) rawCreds.instance_url = editInstanceUrl.trim()
      if (editAdminToken.trim()) rawCreds.admin_token = editAdminToken.trim()
      if (editInstanceToken.trim()) rawCreds.instance_token = editInstanceToken.trim()
    } else {
      if (editInstanceUrl.trim()) rawCreds.instance_url = editInstanceUrl.trim()
      if (editApiKey.trim()) rawCreds.api_key = editApiKey.trim()
    }

    const payload: Record<string, unknown> = { provider: editChannel.provider }
    if (editName.trim() !== editChannel.name) payload.name = editName.trim()
    const newPhone = editPhoneNumber.trim() || null
    if (newPhone !== editChannel.phone_number) payload.phone_number = newPhone
    if (Object.keys(rawCreds).length > 0) payload.credentials = rawCreds

    setSaving(true)
    try {
      const res = await fetch(`/api/whatsapp/channels/${editChannel.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) {
        throw new Error(data.error ?? `HTTP ${res.status}`)
      }
      setEditChannel(null)
      await loadChannels()
      toast.success("Canal atualizado com sucesso")
    } catch (err) {
      toast.error(readErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  function openSendDialog(channel: Channel) {
    setSendChannelId(channel.id)
    setSendTo("")
    setSendMessage("")
    setSendDialogOpen(true)
  }

  async function handleSendTestMessage() {
    if (!sendChannelId) return
    setBusyChannelId(sendChannelId)
    setBusyAction("send")
    try {
      await requestJson<{ data: { message_id: string } }>(
        `/api/whatsapp/channels/${sendChannelId}/send`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: sendTo.replace(/[^\d]/g, ""),
            message: sendMessage,
          }),
        },
      )
      setSendDialogOpen(false)
      toast.success("Mensagem enviada")
    } catch (err) {
      toast.error(readErrorMessage(err))
    } finally {
      setBusyChannelId(null)
      setBusyAction(null)
    }
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-zinc-50 pb-16">
      <Toaster richColors position="top-right" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,_rgba(14,165,233,0.15),_transparent_40%),radial-gradient(circle_at_bottom_left,_rgba(16,185,129,0.14),_transparent_45%)]" />
      <div className="relative mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 pt-10 md:px-10">
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
          className="rounded-2xl border border-zinc-200 bg-white/90 p-6 shadow-sm backdrop-blur"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-zinc-900 md:text-3xl">
                Canais WhatsApp
              </h1>
              <p className="mt-1 text-sm text-zinc-600">
                Configure conexoes com Meta Cloud API, Evolution API e UAZAPI.
              </p>
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                <a className="rounded-full border border-zinc-300 bg-white px-3 py-1 text-zinc-700 hover:bg-zinc-100" href="/whatsapp">
                  Modulo
                </a>
                <a className="rounded-full border border-zinc-300 bg-white px-3 py-1 text-zinc-700 hover:bg-zinc-100" href="/whatsapp/inbox">
                  Inbox
                </a>
                <a className="rounded-full border border-zinc-300 bg-white px-3 py-1 text-zinc-700 hover:bg-zinc-100" href="/whatsapp/chaves">
                  Chaves API
                </a>
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-800">
              <ShieldCheck className="size-3.5" />
              Credenciais criptografadas no back-end
            </div>
          </div>
        </motion.section>

        <div className="grid gap-6 lg:grid-cols-[420px_1fr]">
          <motion.section
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.05, duration: 0.3 }}
          >
            <Card className="border-zinc-200 bg-white/95 shadow-sm">
              <CardHeader>
                <CardTitle>Novo Canal</CardTitle>
                <CardDescription>
                  Crie um canal e receba o webhook secret para configurar no provedor.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <label className="text-xs font-medium text-zinc-700">
                    Nome do canal
                  </label>
                  <Input
                    value={channelName}
                    onChange={(e) => setChannelName(e.target.value)}
                    placeholder="WhatsApp Vendas Brasil"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-medium text-zinc-700">
                    Provider
                  </label>
                  <Select
                    value={provider}
                    onValueChange={(nextValue: Provider) => setProvider(nextValue)}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PROVIDERS.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-zinc-500">{selectedProvider?.hint}</p>
                </div>
                <Separator />
                {provider === "META_CLOUD" ? (
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-zinc-700">
                        Access Token
                      </label>
                      <Input
                        value={accessToken}
                        onChange={(e) => setAccessToken(e.target.value)}
                        placeholder="EAAB..."
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-zinc-700">
                        Phone Number ID
                      </label>
                      <Input
                        value={phoneNumberId}
                        onChange={(e) => setPhoneNumberId(e.target.value)}
                        placeholder="123456789"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-zinc-700">
                        WABA ID{" "}
                        <span className="font-normal text-zinc-500">
                          (obrigatorio para sincronizar templates)
                        </span>
                      </label>
                      <Input
                        value={wabaId}
                        onChange={(e) => setWabaId(e.target.value)}
                        placeholder="WhatsApp Business Account ID"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-zinc-700">
                        App Secret
                      </label>
                      <Input
                        value={appSecret}
                        onChange={(e) => setAppSecret(e.target.value)}
                        placeholder="meta app secret"
                      />
                    </div>
                  </div>
                ) : provider === "UAZAPI" ? (
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-zinc-700">
                        Instance URL
                      </label>
                      <Input
                        value={instanceUrl}
                        onChange={(e) => setInstanceUrl(e.target.value)}
                        placeholder="https://api.uazapi.com"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-zinc-700">
                        Admin Token
                      </label>
                      <Input
                        value={adminToken}
                        onChange={(e) => setAdminToken(e.target.value)}
                        placeholder="admin token (criar instancia)"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-zinc-700">
                        Instance Token
                      </label>
                      <Input
                        value={instanceToken}
                        onChange={(e) => setInstanceToken(e.target.value)}
                        placeholder="instance token (conectar/enviar)"
                      />
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-zinc-700">
                        Instance URL
                      </label>
                      <Input
                        value={instanceUrl}
                        onChange={(e) => setInstanceUrl(e.target.value)}
                        placeholder="https://api.evolution.com"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-zinc-700">
                        API Key
                      </label>
                      <Input
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder="apikey..."
                      />
                    </div>
                  </div>
                )}
                <div className="space-y-2">
                  <label className="text-xs font-medium text-zinc-700">
                    Numero (opcional)
                  </label>
                  <Input
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value)}
                    placeholder="+5511999990000"
                  />
                </div>
                <Button
                  onClick={() => void handleCreateChannel()}
                  disabled={creating}
                  className="w-full"
                >
                  {creating ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : (
                    <Link2 className="mr-2 size-4" />
                  )}
                  Criar canal
                </Button>
              </CardContent>
            </Card>
          </motion.section>

          <motion.section
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1, duration: 0.3 }}
          >
            <Card className="border-zinc-200 bg-white/95 shadow-sm">
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <div>
                  <CardTitle>Canais criados</CardTitle>
                  <CardDescription>
                    Conecte, consulte status e envie mensagem de teste.
                  </CardDescription>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void loadChannels()}
                  disabled={loadingChannels}
                >
                  {loadingChannels ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : (
                    <RefreshCcw className="mr-2 size-4" />
                  )}
                  Atualizar
                </Button>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Canal</TableHead>
                      <TableHead>Provider</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Telefone</TableHead>
                      <TableHead>Ultimo evento</TableHead>
                      <TableHead className="text-right">Acoes</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {channels.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={6} className="py-8 text-center text-zinc-500">
                          Nenhum canal encontrado para o workspace atual.
                        </TableCell>
                      </TableRow>
                    )}
                    {channels.map((channel) => {
                      const active = busyChannelId === channel.id
                      return (
                        <TableRow key={channel.id}>
                          <TableCell>
                            <div className="font-medium text-zinc-900">{channel.name}</div>
                            <div className="text-xs text-zinc-500">{channel.id}</div>
                          </TableCell>
                          <TableCell className="text-zinc-700">
                            {providerLabel(channel.provider)}
                          </TableCell>
                          <TableCell>
                            <Badge variant={statusBadgeVariant(channel.status)}>
                              {statusLabel(channel.status)}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-zinc-700">
                            {channel.phone_number ?? "-"}
                          </TableCell>
                          <TableCell className="text-zinc-600">
                            {formatDate(channel.last_seen_at)}
                          </TableCell>
                          <TableCell>
                            <div className="flex justify-end gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={active}
                                onClick={() => void handleConnect(channel)}
                              >
                                {active && busyAction === "connect" ? (
                                  <Loader2 className="size-4 animate-spin" />
                                ) : (
                                  <PlugZap className="size-4" />
                                )}
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={active}
                                onClick={() => void handleRefreshStatus(channel)}
                              >
                                {active && busyAction === "status" ? (
                                  <Loader2 className="size-4 animate-spin" />
                                ) : (
                                  <RefreshCcw className="size-4" />
                                )}
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={active || channel.status !== "CONNECTED"}
                                onClick={() => openSendDialog(channel)}
                              >
                                {active && busyAction === "send" ? (
                                  <Loader2 className="size-4 animate-spin" />
                                ) : (
                                  <Send className="size-4" />
                                )}
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={active}
                                onClick={() => void handleDisconnect(channel)}
                              >
                                {active && busyAction === "disconnect" ? (
                                  <Loader2 className="size-4 animate-spin" />
                                ) : (
                                  <Unplug className="size-4" />
                                )}
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={active}
                                onClick={() => openEditDialog(channel)}
                                title="Editar canal"
                              >
                                <Pencil className="size-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </motion.section>
        </div>
      </div>

      <Dialog open={webhookDialogOpen} onOpenChange={setWebhookDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Webhook secret gerado</DialogTitle>
            <DialogDescription>
              Salve este valor agora. Ele e exibido apenas uma vez no momento da criacao.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border bg-zinc-50 p-3 text-xs font-mono break-all text-zinc-800">
            {createdWebhookSecret}
          </div>
          <DialogFooter>
            <Button onClick={() => navigator.clipboard.writeText(createdWebhookSecret)}>
              Copiar segredo
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={qrDialogOpen} onOpenChange={setQrDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>QR code do canal</DialogTitle>
            <DialogDescription>
              Escaneie com o WhatsApp para conectar: {qrDialogChannelName}
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-center rounded-xl border bg-zinc-50 p-4">
            {qrImageSrc ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={qrImageSrc}
                alt="QR code para conexao do canal"
                className="h-64 w-64 rounded-md border bg-white p-2"
              />
            ) : (
              <div className="flex h-64 w-64 items-center justify-center text-zinc-500">
                <QrCode className="mr-2 size-5" /> QR indisponivel
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={sendDialogOpen} onOpenChange={setSendDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enviar mensagem de teste</DialogTitle>
            <DialogDescription>
              Numero somente com digitos, com DDI e DDD.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              value={sendTo}
              onChange={(e) => setSendTo(e.target.value)}
              placeholder="5511999990000"
            />
            <Textarea
              value={sendMessage}
              onChange={(e) => setSendMessage(e.target.value)}
              placeholder="Mensagem de validacao do canal"
              rows={4}
            />
          </div>
          <DialogFooter>
            <Button
              disabled={!sendTo.trim() || !sendMessage.trim()}
              onClick={() => void handleSendTestMessage()}
            >
              Enviar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit channel dialog */}
      <Dialog open={!!editChannel} onOpenChange={(open) => { if (!open) setEditChannel(null) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Editar canal</DialogTitle>
            <DialogDescription>
              Deixe os campos de credencial em branco para manter os valores atuais.
            </DialogDescription>
          </DialogHeader>
          {editChannel && (
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-xs font-medium text-zinc-700">Nome do canal</label>
                <Input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder="Nome do canal"
                />
              </div>
              <div className="space-y-2">
                <label className="text-xs font-medium text-zinc-700">Numero (opcional)</label>
                <Input
                  value={editPhoneNumber}
                  onChange={(e) => setEditPhoneNumber(e.target.value)}
                  placeholder="+5511999990000"
                />
              </div>
              <Separator />
              <p className="text-xs text-zinc-500">
                Provider: <span className="font-medium text-zinc-800">{providerLabel(editChannel.provider)}</span>
              </p>
              {editChannel.provider === "META_CLOUD" ? (
                <div className="space-y-3">
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-zinc-700">Access Token</label>
                    <Input
                      value={editAccessToken}
                      onChange={(e) => setEditAccessToken(e.target.value)}
                      placeholder="preencha para alterar"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-zinc-700">Phone Number ID</label>
                    <Input
                      value={editPhoneNumberId}
                      onChange={(e) => setEditPhoneNumberId(e.target.value)}
                      placeholder="preencha para alterar"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-zinc-700">
                      WABA ID{" "}
                      <span className="font-normal text-zinc-500">(para sincronizar templates)</span>
                    </label>
                    <Input
                      value={editWabaId}
                      onChange={(e) => setEditWabaId(e.target.value)}
                      placeholder="preencha para alterar"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-zinc-700">App Secret</label>
                    <Input
                      value={editAppSecret}
                      onChange={(e) => setEditAppSecret(e.target.value)}
                      placeholder="preencha para alterar"
                    />
                  </div>
                </div>
              ) : editChannel.provider === "UAZAPI" ? (
                <div className="space-y-3">
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-zinc-700">Instance URL</label>
                    <Input
                      value={editInstanceUrl}
                      onChange={(e) => setEditInstanceUrl(e.target.value)}
                      placeholder="preencha para alterar"
                    />
                    <p className="text-xs text-zinc-500">
                      Use exatamente a URL do ambiente onde o token foi emitido (free vs api).
                    </p>
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-zinc-700">Admin Token</label>
                    <Input
                      value={editAdminToken}
                      onChange={(e) => setEditAdminToken(e.target.value)}
                      placeholder="preencha para alterar"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-zinc-700">Instance Token</label>
                    <Input
                      value={editInstanceToken}
                      onChange={(e) => setEditInstanceToken(e.target.value)}
                      placeholder="preencha para alterar"
                    />
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-zinc-700">Instance URL</label>
                    <Input
                      value={editInstanceUrl}
                      onChange={(e) => setEditInstanceUrl(e.target.value)}
                      placeholder="preencha para alterar"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-zinc-700">API Key</label>
                    <Input
                      value={editApiKey}
                      onChange={(e) => setEditApiKey(e.target.value)}
                      placeholder="preencha para alterar"
                    />
                  </div>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditChannel(null)}>
              Cancelar
            </Button>
            <Button onClick={() => void handleEditChannel()} disabled={saving}>
              {saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  )
}

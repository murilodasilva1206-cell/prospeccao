import { MessageCircle, KeyRound, Inbox, ArrowRight } from "lucide-react"

const links = [
  {
    href: "/whatsapp/canais",
    title: "Canais",
    description: "Conecte Meta Cloud API, Evolution e UAZAPI.",
    icon: MessageCircle,
    tone: "emerald",
  },
  {
    href: "/whatsapp/chaves",
    title: "Chaves API",
    description: "Gerencie chaves wk_ por workspace com rotacao segura.",
    icon: KeyRound,
    tone: "sky",
  },
  {
    href: "/whatsapp/inbox",
    title: "Inbox",
    description: "Atenda conversas, mensagens e midias em um painel unico.",
    icon: Inbox,
    tone: "amber",
  },
] as const

function toneStyles(tone: (typeof links)[number]["tone"]) {
  switch (tone) {
    case "emerald":
      return "border-emerald-200 bg-emerald-50 text-emerald-900"
    case "sky":
      return "border-sky-200 bg-sky-50 text-sky-900"
    case "amber":
      return "border-amber-200 bg-amber-50 text-amber-900"
    default:
      return "border-zinc-200 bg-white text-zinc-900"
  }
}

export default function WhatsAppModulePage() {
  return (
    <main className="relative min-h-screen overflow-hidden bg-zinc-50 pb-16">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,_rgba(14,165,233,0.15),_transparent_40%),radial-gradient(circle_at_bottom_left,_rgba(16,185,129,0.14),_transparent_45%)]" />
      <div className="relative mx-auto w-full max-w-6xl px-6 pt-12 md:px-10">
        <section className="rounded-2xl border border-zinc-200 bg-white/90 p-6 shadow-sm backdrop-blur">
          <h1 className="text-2xl font-bold tracking-tight text-zinc-900 md:text-3xl">
            Modulo WhatsApp
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-zinc-600">
            Ponto central do OmniChannel: conecte canais, gerencie chaves e opere o inbox.
          </p>
        </section>

        <section className="mt-6 grid gap-4 md:grid-cols-3">
          {links.map((item) => {
            const Icon = item.icon
            return (
              <a
                key={item.href}
                href={item.href}
                className={`group rounded-xl border p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md ${toneStyles(item.tone)}`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Icon className="size-4" />
                    <p className="text-sm font-semibold">{item.title}</p>
                  </div>
                  <ArrowRight className="size-4 opacity-70 transition group-hover:translate-x-0.5" />
                </div>
                <p className="mt-2 text-xs opacity-80">{item.description}</p>
              </a>
            )
          })}
        </section>
      </div>
    </main>
  )
}

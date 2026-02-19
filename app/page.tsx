export default function Home() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-zinc-50 font-sans">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,_rgba(14,165,233,0.15),_transparent_40%),radial-gradient(circle_at_bottom_left,_rgba(16,185,129,0.12),_transparent_45%)]" />
      <main className="relative mx-auto flex w-full max-w-4xl flex-col gap-8 px-8 py-20">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-zinc-900">
            Prospeccao B2B
          </h1>
          <p className="mt-2 text-zinc-500">
            Busca inteligente de empresas no cadastro publico CNPJ (Receita Federal)
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-4">
          <a
            href="/api/busca"
            className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
          >
            <p className="text-sm font-semibold text-zinc-900">Busca</p>
            <p className="mt-1 text-xs text-zinc-500">GET /api/busca</p>
            <p className="mt-2 text-xs text-zinc-400">
              Filtre por UF, municipio, CNAE, situacao cadastral, presenca de telefone ou e-mail.
            </p>
          </a>

          <a
            href="/api/export?formato=csv"
            className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
          >
            <p className="text-sm font-semibold text-zinc-900">Export CSV</p>
            <p className="mt-1 text-xs text-zinc-500">GET /api/export</p>
            <p className="mt-2 text-xs text-zinc-400">
              Exporta ate 5.000 empresas filtradas em formato CSV.
            </p>
          </a>

          <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
            <p className="text-sm font-semibold text-zinc-900">Agente IA</p>
            <p className="mt-1 text-xs text-zinc-500">POST /api/agente</p>
            <p className="mt-2 text-xs text-zinc-400">
              Descreva em linguagem natural: &quot;Dentistas em SP com telefone&quot;.
              O agente interpreta e executa a busca.
            </p>
          </div>

          <a
            href="/whatsapp"
            className="rounded-xl border border-emerald-200 bg-emerald-50 p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
          >
            <p className="text-sm font-semibold text-emerald-900">Modulo WhatsApp</p>
            <p className="mt-1 text-xs text-emerald-700">OmniChannel</p>
            <p className="mt-2 text-xs text-emerald-800/80">
              Canais, inbox e chaves API para operacao completa.
            </p>
          </a>
        </div>

        <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
            Exemplo de uso
          </p>
          <pre className="mt-3 overflow-x-auto text-xs text-zinc-700">
{`# Buscar clinicas odontologicas em SP com telefone
GET /api/busca?uf=SP&cnae_principal=8630-5%2F04&tem_telefone=true

# Chat com o agente
POST /api/agente
{ "message": "Restaurantes no Rio de Janeiro com e-mail" }

# Exportar para CSV
GET /api/export?uf=MG&situacao_cadastral=ATIVA&maxRows=1000

# Gerenciar modulo WhatsApp
GET /whatsapp`}
          </pre>
        </div>
      </main>
    </div>
  )
}

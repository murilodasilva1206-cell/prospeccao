export default function Home() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 font-sans dark:bg-zinc-950">
      <main className="flex w-full max-w-2xl flex-col gap-8 px-8 py-24">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
            Prospeccao B2B
          </h1>
          <p className="mt-2 text-zinc-500 dark:text-zinc-400">
            Busca inteligente de empresas no cadastro publico CNPJ (Receita Federal)
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <a
            href="/api/busca"
            className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm transition hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900"
          >
            <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Busca</p>
            <p className="mt-1 text-xs text-zinc-500">GET /api/busca</p>
            <p className="mt-2 text-xs text-zinc-400">
              Filtre por UF, municipio, CNAE, situacao cadastral, presenca de telefone ou e-mail.
            </p>
          </a>

          <a
            href="/api/export?formato=csv"
            className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm transition hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900"
          >
            <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Export CSV</p>
            <p className="mt-1 text-xs text-zinc-500">GET /api/export</p>
            <p className="mt-2 text-xs text-zinc-400">
              Exporta ate 5.000 empresas filtradas em formato CSV.
            </p>
          </a>

          <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Agente IA</p>
            <p className="mt-1 text-xs text-zinc-500">POST /api/agente</p>
            <p className="mt-2 text-xs text-zinc-400">
              Descreva em linguagem natural: &quot;Dentistas em SP com telefone&quot;.
              O agente interpreta e executa a busca.
            </p>
          </div>
        </div>

        <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
            Exemplo de uso
          </p>
          <pre className="mt-3 overflow-x-auto text-xs text-zinc-700 dark:text-zinc-300">
{`# Buscar clinicas odontologicas em SP com telefone
GET /api/busca?uf=SP&cnae_principal=8630-5%2F04&tem_telefone=true

# Chat com o agente
POST /api/agente
{ "message": "Restaurantes no Rio de Janeiro com e-mail" }

# Exportar para CSV
GET /api/export?uf=MG&situacao_cadastral=ATIVA&maxRows=1000`}
          </pre>
        </div>
      </main>
    </div>
  );
}

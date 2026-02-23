# Prospeccao B2B

API de busca inteligente de empresas no cadastro publico CNPJ (Receita Federal do Brasil).

## Stack

- **Next.js 16** (App Router) + **TypeScript 5**
- **PostgreSQL** via `pg` — tabela `estabelecimentos` (dados publicos CNPJ)
- **OpenRouter** (Claude) — agente de linguagem natural
- **Zod** para validacao de entrada/saida
- **Vitest** + **MSW** para testes

---

## Endpoints

### `GET /api/busca`

Busca empresas com filtros. Retorna JSON paginado.

**Query params:**

| Param               | Tipo    | Exemplo          | Descricao                                      |
|---------------------|---------|------------------|------------------------------------------------|
| `uf`                | string  | `SP`             | UF (2 letras)                                  |
| `municipio`         | string  | `São Paulo`      | Nome do municipio (busca parcial)              |
| `cnae_principal`    | string  | `8630-5/04`      | Codigo CNAE exato                              |
| `nicho`             | string  | `clinicas`       | Texto livre → mapeado para CNAE                |
| `situacao_cadastral`| enum    | `ATIVA`          | `ATIVA`, `BAIXADA`, `INAPTA`, `SUSPENSA`       |
| `tem_telefone`      | boolean | `true`           | Filtra por presenca de telefone                |
| `tem_email`         | boolean | `true`           | Filtra por presenca de e-mail                  |
| `orderBy`           | enum    | `razao_social`   | `razao_social`, `municipio`, `cnpj_completo`   |
| `orderDir`          | enum    | `asc`            | `asc` ou `desc`                                |
| `page`              | number  | `1`              | Pagina (minimo 1)                              |
| `limit`             | number  | `20`             | Resultados por pagina (max 100)                |

**Exemplo:**
```
GET /api/busca?uf=SP&cnae_principal=8630-5%2F04&tem_telefone=true&limit=10
```

**Resposta:**
```json
{
  "data": [
    {
      "cnpj": "11222333000181",
      "razaoSocial": "CLINICA ODONTO LTDA",
      "nomeFantasia": "Odonto SP",
      "uf": "SP",
      "municipio": "SAO PAULO",
      "cnaePrincipal": "8630-5/04",
      "situacao": "ATIVA",
      "telefone1": "11999990000",
      "telefone2": "",
      "email": "contato@odonto.com"
    }
  ],
  "meta": {
    "total": 1842,
    "page": 1,
    "limit": 10,
    "pages": 185
  }
}
```

**Rate limit:** 60 req/min por IP. Responde 429 com header `Retry-After`.

---

### `GET /api/export`

Exporta empresas em CSV. Mesmos filtros de `/api/busca` mais `maxRows`.

| Param     | Tipo   | Exemplo | Descricao                         |
|-----------|--------|---------|-----------------------------------|
| `maxRows` | number | `1000`  | Maximo de linhas (1 – 5000)       |
| `formato` | enum   | `csv`   | Apenas `csv` por enquanto         |
| (demais)  | —      | —       | Mesmos filtros do `/api/busca`    |

**Exemplo:**
```
GET /api/export?uf=MG&situacao_cadastral=ATIVA&maxRows=500
```

**Resposta:** arquivo `empresas.csv` com colunas:
```
cnpj, razaoSocial, nomeFantasia, uf, municipio, cnaePrincipal, situacao, telefone1, telefone2, email
```

**Protecao:** celulas iniciadas com `=+-@` recebem prefixo `\t` (anti-formula CSV injection).
**Rate limit:** 5 req/min por IP.

---

### `POST /api/agente`

Agente de linguagem natural. Interpreta uma mensagem e executa a busca.

**Body:**
```json
{ "message": "Clinicas odontologicas em SP com telefone" }
```

**Resposta (action = search):**
```json
{
  "action": "search",
  "filters": { "uf": "SP", "cnae_principal": "8630-5/04", "tem_telefone": true },
  "data": [...],
  "meta": { "total": 1842, "page": 1, "limit": 20, "pages": 93 },
  "metadata": { "latencyMs": 1240, "confidence": 0.95 }
}
```

**Acoes possiveis:** `search`, `export`, `clarify`, `reject`.
**Rate limit:** 10 req/min por IP.
**Protecao:** pre-screen de prompt injection (regex) + circuit breaker (5 falhas → OPEN, 30s).

---

## Variáveis de Ambiente

Crie um arquivo `.env.local` com:

```env
# PostgreSQL
DB_HOST=localhost
DB_PORT=5432
DB_NAME=prospeccao
DB_USER=prospeccao_app
DB_PASSWORD=<senha>

# OpenRouter
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_MODEL=anthropic/claude-3.5-sonnet

# Rate limiting distribuido
UPSTASH_REDIS_REST_URL=https://...
UPSTASH_REDIS_REST_TOKEN=...
```

> **Atencao em producao:** `UPSTASH_REDIS_REST_URL` e `UPSTASH_REDIS_REST_TOKEN` sao **obrigatorios** em
> qualquer ambiente multi-instancia (Vercel, containers horizontalmente escalados).
> Sem eles, cada instancia mantem contadores proprios — o rate limit nao e aplicado de forma distribuida.
> Em producao, se o Upstash ficar indisponivel, a API falha fechada (retorna 429) em vez de liberar sem limite.

---

## Banco de Dados

Tabela esperada: `estabelecimentos` (subset do cadastro publico CNPJ).

```sql
CREATE TABLE estabelecimentos (
  cnpj_completo       VARCHAR(14) PRIMARY KEY,
  razao_social        TEXT NOT NULL,
  nome_fantasia       TEXT,
  uf                  CHAR(2) NOT NULL,
  municipio           TEXT NOT NULL,
  cnae_principal      VARCHAR(20),
  situacao_cadastral  VARCHAR(20) NOT NULL DEFAULT 'ATIVA',
  telefone1           VARCHAR(30),
  telefone2           VARCHAR(30),
  correio_eletronico  VARCHAR(115)
);
```

Fonte dos dados: [dados.gov.br — CNPJ](https://dados.gov.br/dados/conjuntos-dados/cadastro-nacional-da-pessoa-juridica---cnpj)

---

## Desenvolvimento

```bash
npm install
npm run dev        # servidor em http://localhost:3000
npm run typecheck  # tsc --noEmit
npm run lint       # ESLint + eslint-plugin-security
npm test           # testes unitarios + seguranca (sem banco)
npm run test:coverage
```

## Testes de Integracao

Requerem PostgreSQL rodando com a tabela `estabelecimentos` populada.

```bash
# Com Docker
docker run \
  -e POSTGRES_DB=prospeccao_test \
  -e POSTGRES_USER=prospeccao_app \
  -e POSTGRES_PASSWORD=testpassword_ci \
  -p 5432:5432 postgres:16

# Depois:
npm run test:integration
```

---

## Segurança

| Camada               | Mecanismo                                                          |
|----------------------|--------------------------------------------------------------------|
| SQL injection        | Queries 100% parametrizadas (`$N`); `orderBy` via `z.enum()`      |
| Prompt injection     | Regex pre-screen + mensagens system/user separadas                 |
| CSV injection        | Prefixo `\t` em celulas com `=+-@`                                 |
| Rate limiting        | Upstash Redis (distribuido) ou LRU em memoria (fallback)           |
| Circuit breaker      | 5 falhas → OPEN, 30s timeout, 2 sucessos → CLOSE                   |
| Output masking       | Allow-list de 10 campos; emails e telefones so do cadastro publico |
| Headers HTTP         | CSP, HSTS, X-Frame-Options, X-Content-Type-Options                 |
| Validacao de entrada | Zod em todas as rotas; sem campos extras passando para o SQL       |

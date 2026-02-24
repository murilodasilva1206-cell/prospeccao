# Prospeccao B2B

API de busca inteligente de empresas no cadastro publico CNPJ (Receita Federal do Brasil).

## Stack

- **Next.js 16** (App Router) + **TypeScript 5**
- **PostgreSQL** via `pg` — tabela `estabelecimentos` (dados publicos CNPJ)
- **Perfis LLM por workspace** (OpenRouter, OpenAI, Anthropic, Google) — agente de linguagem natural
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
| `situacao_cadastral`| enum    | `02`             | `01` Nula, `02` Ativa, `03` Suspensa, `04` Inapta, `08` Baixada |
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
      "situacao": "02",
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
GET /api/export?uf=MG&situacao_cadastral=02&maxRows=500
```

**Resposta:** arquivo `empresas.csv` com colunas:
```
cnpj, razaoSocial, nomeFantasia, uf, municipio, cnaePrincipal, situacao, telefone1, telefone2, email
```

**Protecao:** celulas iniciadas com `=+-@` recebem prefixo `\t` (anti-formula CSV injection).
**Nicho guard:** se `nicho` for informado e nao puder ser resolvido para CNAE, retorna 400 em vez de exportar a tabela inteira sem filtro de setor.
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
- `clarify` e `reject` incluem obrigatoriamente um campo `message` com explicacao.
- Quando `nicho` nao pode ser mapeado para CNAE, retorna `action: clarify` em vez de fazer scan da tabela inteira.

**Rate limit:** 10 req/min por IP.
**Protecao:** pre-screen de prompt injection (regex) + circuit breaker (5 falhas → OPEN, 30s).
**LLM:** usa o perfil padrao do workspace (tabela `llm_profiles`); configure em `/whatsapp/llm`.

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

# SSL do PostgreSQL
# DB_SSL=true          → conexao encriptada (padrao; obrigatorio em producao)
# DB_SSL=false         → sem TLS (requer ALLOW_INSECURE_DB=true em producao)
DB_SSL=true

# Valida certificado do servidor contra CAs confiaveis.
# Mantenha true (padrao) em producao. Use false apenas em redes internas
# com cert auto-assinado (ex: Render internal network).
DB_SSL_REJECT_UNAUTHORIZED=true

# Tempo maximo (ms) para obter conexao do pool. Padrao 8000 ms —
# mais alto que o padrao pg (2000) para tolerar cold start em serverless.
# DB_CONNECT_TIMEOUT_MS=8000

# Override de emergencia: permite DB_SSL=false em producao.
# Deve ser definido EXPLICITAMENTE junto com DB_SSL=false.
# Nunca defina em producao sem entender os riscos.
# ALLOW_INSECURE_DB=false

# OpenRouter
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_MODEL=anthropic/claude-3.5-sonnet

# Rate limiting distribuido
UPSTASH_REDIS_REST_URL=https://...
UPSTASH_REDIS_REST_TOKEN=...

# Criptografia de credenciais WhatsApp em repouso (AES-256-GCM)
# Gere com: openssl rand -hex 32
CREDENTIALS_ENCRYPTION_KEY=<64 caracteres hex>

# Armazenamento de midia (S3 ou compativel — ex: Cloudflare R2)
# Deixe false para iniciar sem S3; rotas de midia retornam 503 controlado.
MEDIA_STORAGE_ENABLED=false

# Obrigatorio somente quando MEDIA_STORAGE_ENABLED=true:
S3_BUCKET=<nome-do-bucket>
S3_ACCESS_KEY_ID=<access-key-id>
S3_SECRET_ACCESS_KEY=<secret-access-key>
S3_REGION=<regiao>          # ex: us-east-1

# Opcional — endpoint customizado para R2 ou outro S3-compativel:
# S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
```

> **Atencao em producao:** `UPSTASH_REDIS_REST_URL` e `UPSTASH_REDIS_REST_TOKEN` sao **obrigatorios** em
> qualquer ambiente multi-instancia (Vercel, containers horizontalmente escalados).
> Sem eles, cada instancia mantem contadores proprios — o rate limit nao e aplicado de forma distribuida.
> Em producao, se o Upstash ficar indisponivel, a API falha fechada (retorna 429) em vez de liberar sem limite.

---

## Auth

O sistema suporta dois modelos de autenticacao:

### 1. Sessao web (operadores humanos)

```
POST /api/auth/login   { email, password } → cookie HttpOnly `session` (8h, SameSite=Strict)
POST /api/auth/logout  → apaga cookie
GET  /api/auth/me      → { user_id, email, workspace_id }
POST /api/auth/register → bootstrap (so funciona quando nenhum usuario existe OU quando SETUP_SECRET esta correto)
```

Rotas de pagina `/whatsapp/*` sao protegidas por `proxy.ts` (Next.js middleware):
redirecionam para `/login` se o cookie `session` estiver ausente.

Credenciais de desenvolvimento (inseridas por `seed_dev.sql`):
```
email:    dev@prospeccao.local
password: devpassword
```

### 2. API key de workspace (integracoes externas)

Todas as rotas `/api/whatsapp/*` aceitam tambem autenticacao via API key.

#### Bootstrap da primeira chave

```bash
node --env-file=.env.local scripts/bootstrap-api-key.mjs [workspace_id] [label]
```

**Exemplo:**
```bash
node --env-file=.env.local scripts/bootstrap-api-key.mjs meu-workspace "Producao"
```

A chave raw (`wk_...`) e exibida **uma unica vez** — salve-a imediatamente em um secret manager.
Apenas o hash SHA-256 e persistido no banco (`workspace_api_keys.key_hash`).

#### Uso

Envie o header em todas as chamadas autenticadas:

```
Authorization: Bearer wk_<64 chars hex>
```

#### Exemplo — listar canais

```bash
curl -H "Authorization: Bearer wk_abc123..." \
  http://localhost:3000/api/whatsapp/channels
```

### Respostas de autenticacao

| Situacao                        | Status |
|---------------------------------|--------|
| Header `Authorization` ausente  | 401    |
| Key invalida ou revogada        | 401    |
| Recurso de outro workspace      | 403    |

### Perfis LLM

Cada workspace pode ter varios perfis LLM (OpenRouter, OpenAI, Anthropic, Google).
O perfil com `is_default = true` e usado pelo agente `/api/agente`.

```
GET    /api/llm/profiles          → lista perfis do workspace
POST   /api/llm/profiles          → cria perfil
PATCH  /api/llm/profiles/:id      → atualiza nome/modelo/chave/default
DELETE /api/llm/profiles/:id      → remove perfil
POST   /api/llm/profiles/:id/test → testa conectividade (retorna latencyMs)
```

Configure pelo painel em `/whatsapp/llm`.

---

## Campanhas WhatsApp

Disparo em massa para listas de empresas encontradas pelo agente.

```
POST   /api/campaigns              → cria campanha (draft)
GET    /api/campaigns/:id/status   → status + contadores
POST   /api/campaigns/:id/start    → inicia (draft → awaiting_confirmation)
POST   /api/campaigns/:id/pause    → pausa envios
POST   /api/campaigns/:id/resume   → retoma envios
POST   /api/campaigns/:id/cancel   → cancela (irreversivel)
PATCH  /api/campaigns/:id/automation → atualiza delay/jitter/max_per_hour/max_retries/horario
POST   /api/campaigns/process      → processamento por cron (auth via CRON_SECRET)
```

**Maquina de estados:** `draft → awaiting_confirmation → awaiting_channel → awaiting_message → ready_to_send → sending ↔ paused → completed / completed_with_errors / cancelled`

### Agendamento de campanhas (Vercel Hobby)

No plano Hobby da Vercel, cron por minuto nao esta disponivel.
Use GitHub Actions (`.github/workflows/campaign-cron.yml`) para chamar a rota a cada minuto:

```
POST /api/campaigns/process
Authorization: Bearer <CRON_SECRET>
```

Secrets necessarios no repositorio GitHub (**Settings → Secrets → Actions**):

| Secret | Valor |
|--------|-------|
| `APP_URL` | `https://seu-projeto.vercel.app` (sem `/` no final) |
| `CRON_SECRET` | Mesmo valor configurado na Vercel |

**Automacao configuravel em tempo real** via `PATCH /automation` (campos opcionais, so altera o que for enviado):
- `delay_seconds` (≥ 10): intervalo entre envios
- `jitter_max` (≥ 0): variacao aleatoria adicional em segundos
- `max_per_hour` (≥ 1): limite de envios por hora
- `max_retries` (≥ 0): tentativas em caso de erro transitorio (429/5xx)
- `working_hours_start` / `working_hours_end`: janela de envio em UTC-3 (HH:MM)

---

## Banco de Dados

Tabela esperada: `estabelecimentos` (subset do cadastro publico CNPJ).

```sql
CREATE TABLE cnpj_completo (
  cnpj_completo       VARCHAR(14) PRIMARY KEY,
  razao_social        TEXT NOT NULL,
  nome_fantasia       TEXT,
  uf                  CHAR(2) NOT NULL,
  municipio           TEXT NOT NULL,
  cnae_principal      VARCHAR(20),
  situacao_cadastral  VARCHAR(2) NOT NULL DEFAULT '02', -- '01' Nula | '02' Ativa | '03' Suspensa | '04' Inapta | '08' Baixada
  ddd1                VARCHAR(2),
  ddd2                VARCHAR(2),
  correio_eletronico  VARCHAR(115),
  tem_telefone        BOOLEAN NOT NULL DEFAULT false,
  tem_email           BOOLEAN NOT NULL DEFAULT false
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
| Nicho guard          | `nicho` sem CNAE conhecido → 400 (busca/export) ou clarify (agente) em vez de scan total |
| Auth antes do CNAE   | Resolucao de nicho → IBGE API so ocorre apos autenticacao validada |
| Sessao web           | Cookie HttpOnly, SameSite=Strict, 8h TTL, hash SHA-256 no banco    |
| workspace_id         | Vem 100% do token/sessao (DB lookup); nunca do corpo da requisicao |

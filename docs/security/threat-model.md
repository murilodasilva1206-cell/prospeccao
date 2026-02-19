# Threat Model — Prospeccao

## Data Flow

```
Browser (user prompt)
  → POST /api/agente  (Next.js Route Handler)
      → OpenRouter HTTPS API  (external, claude-3.5-sonnet)
          → Internal call to /api/busca logic
              → PostgreSQL TCP (pg pool)
  → GET  /api/busca   (direct search, same DB)
  → GET  /api/export  (CSV download, same DB)
```

## STRIDE Analysis

| Threat | Component | Attack Example | Control Implemented |
|--------|-----------|----------------|---------------------|
| **Spoofing** | /api/agente caller | Forged IP to bypass rate limit | Rate limit per IP (X-Forwarded-For) |
| **Tampering** | User prompt | Prompt injection to override system rules | System/user message separation + injection regex pre-screen |
| **Tampering** | Query parameters | SQL injection via filter fields | Zod whitelist + parameterized queries ($N placeholders) |
| **Tampering** | CSV export | Formula injection in cell values | sanitizeCsvCell() with tab prefix |
| **Repudiation** | All API calls | No audit trail for searches | pino structured logs with requestId correlation |
| **Information Disclosure** | Error responses | Stack traces / SQL errors leaked | Generic 500 to client; full error logged server-side only |
| **Information Disclosure** | API response | email/phone exposed in contact list | maskContact() allow-list of 8 fields |
| **Information Disclosure** | DB connection | Unencrypted TCP | ssl: { rejectUnauthorized: true } in production |
| **Information Disclosure** | Logs | API key appears in log lines | pino redact: ['OPENROUTER_API_KEY', 'password', 'email', 'phone'] |
| **Denial of Service** | /api/agente | Unbounded OpenRouter calls (cost) | 10 req/min/IP rate limit + circuit breaker |
| **Denial of Service** | /api/busca | Full table scan with no limit | LIMIT cap (100 rows) + statement_timeout (5s) |
| **Denial of Service** | /api/export | Huge export consuming DB resources | maxRows cap (5000) + exportLimiter (5/min/IP) |
| **Denial of Service** | OpenRouter | Cascade failure when OpenRouter is down | Circuit breaker: opens after 5 failures, probes after 30s |
| **Elevation of Privilege** | DB user | DDL commands via injection | Least-privilege role (no SUPERUSER, no DROP) — see db-permissions.md |
| **Elevation of Privilege** | AI agent | User overrides system prompt to gain admin | INJECTION_PATTERNS pre-screen + hardcoded SYSTEM_PROMPT |

## Trust Boundaries

1. **Browser → /api/agente**: All user input is untrusted. Validated with AgenteBodySchema.
2. **Browser → /api/busca**: All query params are untrusted. Validated with BuscaQuerySchema.
3. **App → OpenRouter**: OpenRouter response is untrusted. Validated with AgentIntentSchema before use.
4. **App → PostgreSQL**: Connection is trusted after authentication. Queries use parameterized placeholders.

## Out of Scope (MVP)

- Multi-tenant authorization (single tenant for MVP)
- DDoS at network layer (use Cloudflare or WAF for this)
- Physical security
- Social engineering of team members

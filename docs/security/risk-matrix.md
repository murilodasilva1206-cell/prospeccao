# Risk Matrix — Prospeccao

## Risk Scoring

- **Likelihood**: High (likely to be attempted), Medium (possible), Low (unlikely)
- **Impact**: Critical (data breach / service loss), High (data exposure), Medium (degraded service), Low (minor)
- **Priority**: P0 (fix before launch), P1 (fix within sprint), P2 (fix within quarter)

## Risk Register

| ID | Risk | Likelihood | Impact | Priority | Control Implemented | Residual Risk |
|----|------|-----------|--------|----------|---------------------|---------------|
| R01 | SQL injection via /api/busca filters | High | Critical | **P0** | Zod schema whitelist + parameterized queries ($N) | Low |
| R02 | Prompt injection overrides AI guardrails | High | High | **P0** | INJECTION_PATTERNS pre-screen + system/user separation + AgentIntentSchema validation | Low |
| R03 | API key (OpenRouter) leaked in logs | Medium | Critical | **P0** | pino redact list | Low |
| R04 | DB credentials leaked in logs | Medium | Critical | **P0** | pino redact list + env from lib/env.ts only | Low |
| R05 | Missing env var causes silent misconfiguration | High | High | **P0** | Zod parse() at boot — process.exit(1) if invalid | Low |
| R06 | No TLS on DB connection | High | High | **P1** | ssl: { rejectUnauthorized: true } in production | Low (needs cert) |
| R07 | DoS via unbounded AI calls | High | High | **P1** | agenteLimiter (10/min/IP) + circuit breaker | Medium (single-instance limiter) |
| R08 | DoS via large DB query | Medium | Medium | **P1** | statement_timeout (5s) + LIMIT cap (100) | Low |
| R09 | Sensitive fields (email, phone) in API response | Medium | High | **P1** | maskContact() allow-list | Low |
| R10 | Stack trace / SQL error in HTTP response | Medium | Medium | **P1** | Generic error handler in all routes | Low |
| R11 | CSV injection in export | Medium | Medium | **P2** | sanitizeCsvCell() with tab prefix | Low |
| R12 | Rate limit bypass in distributed deployment | High | Medium | **P2** | Documented Upstash upgrade path in lib/rate-limit.ts | High (MVP gap) |
| R13 | No DB user least-privilege | High | Critical | **P1** | db-permissions.md SQL documented; needs manual application | Medium (docs only) |
| R14 | Secrets committed to git | Low | Critical | **P0** | .gitignore + TruffleHog CI scan | Low |
| R15 | No HSTS in development (HTTP downgrade) | Low | Low | P2 | HSTS only in NODE_ENV=production (by design) | Low |
| R16 | AI response used without validation | Medium | High | **P0** | AgentIntentSchema.parse() before any field access | Low |
| R17 | OpenRouter outage cascades to full downtime | Medium | High | **P1** | Circuit breaker (5 failures → OPEN, 30s timeout) | Low |

## Mitigations Required Before Go-live (P0)

- [x] R01: Parameterized queries implemented in lib/query-builder.ts
- [x] R02: INJECTION_PATTERNS + AgentIntentSchema in lib/agent-prompts.ts + lib/ai-client.ts
- [x] R03: pino redact in lib/logger.ts
- [x] R04: pino redact in lib/logger.ts
- [x] R05: Zod boot validation in lib/env.ts
- [ ] R14: Verify .gitignore includes .env.local and no secrets in git history

## Accepted Risks (MVP)

- R12: In-memory rate limiter is single-instance. Acceptable for MVP on single server. Upgrade to Upstash before scaling.
- R13: DB role permissions are documented but not automatically applied. Must be run manually by ops.

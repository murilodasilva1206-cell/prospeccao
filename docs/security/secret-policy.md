# Secret Management Policy — Prospeccao

## Rules

1. **Never commit secrets to git.**
   - `.env.local` is in `.gitignore` — verify with `git check-ignore .env.local`
   - CI scans every PR with TruffleHog (see `.github/workflows/ci.yml`)
   - If a secret is committed: see [runbooks/key-leak.md](../runbooks/key-leak.md)

2. **Secrets live in exactly one place per environment.**
   - Local development: `.env.local`
   - CI: GitHub Actions Secrets
   - Production: Hosting provider's secret manager (Vercel Env Vars, Railway, etc.)

3. **Minimum scope.**
   - OpenRouter API key: scoped to the minimum required models
   - DB user: `prospeccao_app` role only — no superuser, no DDL
   - No shared secrets between environments (prod key ≠ dev key)

4. **Validation at boot.**
   - `lib/env.ts` validates all required secrets with Zod on startup
   - Missing or malformed secrets → `process.exit(1)` before serving any request

## Secret Inventory

| Secret | Env Var | Rotation Cadence | Owner | Where Stored |
|--------|---------|-----------------|-------|--------------|
| PostgreSQL password | `DB_PASSWORD` | Every **90 days** | DevOps | `.env.local` + hosting platform |
| OpenRouter API key | `OPENROUTER_API_KEY` | Every **180 days** | Engineering | `.env.local` + hosting platform |

## Generating Strong Secrets

```bash
# Generate a 32-byte base64 password (for DB, etc.)
openssl rand -base64 32

# Or using node
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Rotation Procedure

See [secrets-rotation-checklist.md](./secrets-rotation-checklist.md).

## Emergency Revocation

If a secret is confirmed leaked:
1. Revoke the old secret **immediately** in the respective dashboard
2. Follow the rotation procedure for the affected secret
3. Check git history: `git log -S '<leaked_value>'`
4. Check CI logs for the leaked value
5. File an incident report within 24 hours
6. If personal data may have been accessed: assess LGPD notification obligation (72-hour window to notify ANPD for high-risk incidents)

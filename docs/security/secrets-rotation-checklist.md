# Secrets Rotation Checklist — Prospeccao

## DB_PASSWORD (rotate every 90 days)

**Next rotation due:** [fill in date]

```
[ ] 1. Generate a new strong password:
       openssl rand -base64 32

[ ] 2. Update PostgreSQL:
       ALTER ROLE prospeccao_app PASSWORD '<new-password>';

[ ] 3. Update the hosting platform's secret:
       - Vercel: Settings → Environment Variables → DB_PASSWORD
       - Railway: Variables → DB_PASSWORD
       - (Or whichever platform is in use)

[ ] 4. Update GitHub Actions secret:
       - Settings → Secrets → Actions → DB_PASSWORD (if used in CI)

[ ] 5. Deploy a new build (app picks up the new value on restart)

[ ] 6. Verify the app is healthy:
       curl https://prospeccao.app/api/busca
       # Expect: 200 OK (not 500 Internal Server Error)

[ ] 7. Revoke / delete the old password from any shared docs or notes

[ ] 8. Update "Next rotation due" date above (90 days from today)
```

---

## OPENROUTER_API_KEY (rotate every 180 days)

**Next rotation due:** [fill in date]

```
[ ] 1. Generate a new API key:
       OpenRouter Dashboard → API Keys → Create new key

[ ] 2. Update the hosting platform's secret:
       (See above for your platform)

[ ] 3. Update GitHub Actions secret (if used in integration tests):
       OPENROUTER_API_KEY_TEST

[ ] 4. Deploy a new build

[ ] 5. Verify the AI agent works:
       POST https://prospeccao.app/api/agente
       Body: {"message": "Find CTOs in fintech"}
       # Expect: 200 with action field

[ ] 6. Revoke the OLD key in OpenRouter dashboard (key list → Revoke)

[ ] 7. Update "Next rotation due" date above (180 days from today)
```

---

## Emergency Rotation (key confirmed leaked)

```
[ ] 1. IMMEDIATELY revoke the exposed secret in the respective dashboard
       (OpenRouter: revoke key; DB: ALTER ROLE ... PASSWORD 'DISABLED')

[ ] 2. Follow the standard rotation steps above for the affected secret

[ ] 3. Search git history for the leaked value:
       git log -S '<leaked_value_prefix>' --oneline

[ ] 4. Search CI/CD logs (GitHub Actions logs) for the leaked value

[ ] 5. Check application logs for unauthorized use after the suspected leak time:
       jq 'select(.time > "<leak_timestamp>")' app.log | grep -i error

[ ] 6. If personal data may have been accessed:
       - Notify affected data subjects (LGPD Art. 48)
       - Notify ANPD within 72 hours if high-risk incident

[ ] 7. File an incident report (include: timeline, impact, root cause, remediation)

[ ] 8. Post-mortem review within 7 days
```

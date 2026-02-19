# Runbook: API Key / Secret Leak

## Detection

A secret is considered leaked if:
- TruffleHog CI scan reports a verified finding
- The secret appears in a public git repository
- Unauthorized API calls are detected using the key
- A team member reports accidental exposure (Slack, email, PR description)

## Severity: **CRITICAL — Act within 15 minutes**

## Response Steps

### Step 1: Revoke the key immediately (< 5 min)

**OpenRouter API key leaked:**
1. Log into https://openrouter.ai/keys
2. Find the leaked key → click **Revoke**
3. Note the revocation timestamp

**DB password leaked:**
1. Connect as superuser: `psql -h $DB_HOST -U postgres`
2. Run: `ALTER ROLE prospeccao_app PASSWORD 'DISABLED_LOCKED';`
3. Note the lock timestamp

### Step 2: Assess the blast radius (15 min)

```bash
# 1. Find when the secret was committed
git log -S 'sk-or-' --oneline --all

# 2. Check if it was ever pushed to a public remote
git log --remotes --oneline | head -20

# 3. Check application logs for unauthorized calls
jq 'select(.statusCode == 401 or .msg | test("auth"))' app.log

# 4. Check OpenRouter usage dashboard for unexpected usage spikes
# (OpenRouter dashboard → Usage)
```

### Step 3: Rotate to a new secret (< 30 min)

Follow [secrets-rotation-checklist.md](../security/secrets-rotation-checklist.md)
**Emergency Rotation** section.

### Step 4: Deploy the new secret

1. Update all environments (hosting platform + GitHub Actions)
2. Trigger a new deployment
3. Verify the app is healthy after deploy:
   ```bash
   curl https://prospeccao.app/api/busca
   # Expect: 200 OK
   ```

### Step 5: Notify and document

1. Notify the engineering team (Slack #incidents or equivalent)
2. If personal data may have been exposed via the DB:
   - Notify data subjects affected
   - Notify ANPD within 72 hours (LGPD Art. 48)
3. Open an incident ticket with:
   - Timeline (detection → revocation → rotation → deploy)
   - Estimated blast radius
   - Root cause (how did it leak?)
   - Remediation applied

### Step 6: Post-mortem (within 7 days)

Review:
- How was the secret exposed?
- Why was it not caught earlier (pre-commit hook? CI scan missed?)
- What process changes prevent recurrence?

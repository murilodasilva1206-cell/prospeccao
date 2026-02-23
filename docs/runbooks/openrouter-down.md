# Runbook: OpenRouter Unavailable

## Detection

- Circuit breaker logs: `Circuit OPEN — too many failures` (circuit: openrouter)
- /api/agente returns HTTP 503 consistently
- OpenRouter status page shows incident: https://status.openrouter.ai

## Impact

- **AI-powered search** (/api/agente) is unavailable
- **Direct search** (/api/busca) continues to work normally (no AI dependency)
- **CSV export** (/api/export) continues to work normally

## Immediate Response

### Step 1: Confirm the outage

```bash
# Check circuit breaker state in logs
jq 'select(.circuit == "openrouter")' app.log | tail -5

# Test OpenRouter directly
curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  https://openrouter.ai/api/v1/models

# Check OpenRouter status
open https://status.openrouter.ai
```

### Step 2: User communication

Display a UI banner on the frontend (if implemented):

> "AI-powered search is temporarily unavailable. You can still use manual filters below."

### Step 3: Monitor recovery

The circuit breaker transitions to HALF_OPEN automatically after 30 seconds.
Monitor for recovery in logs:

```bash
# Watch for HALF_OPEN → CLOSED transition
jq 'select(.msg | test("HALF_OPEN|CLOSED"))' app.log
```

### Step 4: If outage > 30 minutes

1. Consider switching `OPENROUTER_MODEL` to an alternative model (if available)
2. Set `OPENROUTER_MODEL=anthropic/claude-3-haiku` for faster, cheaper fallback
3. Deploy with the new env var

### Step 5: Post-outage verification

After OpenRouter reports recovery:
```bash
# Verify /api/agente works
curl -X POST https://prospeccao.app/api/agente \
  -H "Content-Type: application/json" \
  -d '{"message":"Find CTOs in fintech"}'
# Expect: 200 with action field (not 503)
```

## Prevention

- Circuit breaker is configured: 5 failures → OPEN, 30s timeout, 2 successes to close
- Rate limit (10/min/IP) protects against thundering herd when circuit closes
- Monitor OpenRouter's status page and subscribe to incident alerts

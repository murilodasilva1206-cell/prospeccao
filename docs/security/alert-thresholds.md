# Alert Thresholds — Prospeccao

## HTTP Error Rate Alerts

| Metric | Warning | Critical | Action |
|--------|---------|---------|--------|
| HTTP 429 rate (% of requests) | > 5% | > 15% | Check for DDoS or scraping; review rate limit config |
| HTTP 5xx rate (% of requests) | > 1% | > 5% | PagerDuty; check structured logs for root cause |
| HTTP 4xx rate (unexpected) | > 20% | > 50% | May indicate broken client or fuzz testing |

## Latency Alerts

| Metric | Warning | Critical | Action |
|--------|---------|---------|--------|
| /api/agente p95 latency | > 5s | > 10s | Check OpenRouter status; circuit breaker state |
| /api/busca p95 latency | > 1s | > 3s | Check DB query plan; missing indexes |
| /api/export p95 latency | > 5s | > 15s | Reduce default maxRows; check DB load |

## Application-Level Alerts

| Metric | Threshold | Action |
|--------|----------|--------|
| AI agent parse failures | > 10% of calls | Review AI response format; check OPENROUTER_MODEL |
| Circuit breaker OPEN events | Any | Immediate: check OpenRouter dashboard |
| DB pool idle client errors | > 5/min | Check DB host connectivity; review pool config |
| DB query timeouts (statement_timeout) | > 10/min | Identify slow queries; check for table scans |

## Security-Specific Alerts

| Event | Threshold | Action |
|-------|----------|--------|
| Prompt injection attempts blocked | > 10/hour from same IP | Block IP at WAF; investigate |
| Rate limit 429 from same IP | > 100/hour | Likely attack; add to block list |
| TruffleHog finds secret in PR | Any | Fail CI; rotate secret immediately |
| npm audit critical vuln | Any | Block deploy; patch dependency |

## Log Query Examples (pino JSON logs)

```bash
# Count 5xx errors in last 1 hour
jq 'select(.statusCode >= 500) | .requestId' logs.ndjson | wc -l

# Find circuit breaker OPEN events
jq 'select(.msg == "Circuit OPEN — too many failures")' logs.ndjson

# Find injection attempts
jq 'select(.msg == "Prompt injection attempt detected")' logs.ndjson

# Find slow queries (> 3s)
jq 'select(.latencyMs > 3000)' logs.ndjson
```

## Recommended Monitoring Stack

For production: Datadog, New Relic, Grafana + Loki, or AWS CloudWatch.
pino emits newline-delimited JSON in production — compatible with all major aggregators.

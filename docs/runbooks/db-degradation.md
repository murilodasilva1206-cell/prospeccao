# Runbook: Database Degradation

## Detection

- Logs: `pg pool idle client error` events spike
- HTTP 500 rate on /api/busca or /api/export increases
- DB query p95 latency alert fires (> 1s warning, > 3s critical)
- Connection pool exhaustion: all 10 connections in use simultaneously

## Symptoms and Causes

| Symptom | Likely Cause | Action |
|---------|-------------|--------|
| Connection refused | DB host unreachable | Check network / DB host status |
| All 10 pool connections busy | Slow query blocking pool | Kill blocking query (Step 4) |
| statement_timeout errors | Query without index doing full table scan | Add missing index (Step 5) |
| SSL connection error in prod | Cert expired or TLS config mismatch | Renew cert; check pg_hba.conf |
| Authentication failed | Password rotated but app not updated | Rotate env var + redeploy |

## Response Steps

### Step 1: Confirm the issue

```bash
# Check application logs
jq 'select(.msg | test("pg pool|Database error|connection"))' app.log | tail -20

# Check if DB host is reachable
nc -zv $DB_HOST $DB_PORT
# or
pg_isready -h $DB_HOST -p $DB_PORT
```

### Step 2: Check active connections

```sql
-- Connect as superuser
SELECT pid, state, query_start, query, wait_event_type, wait_event
FROM pg_stat_activity
WHERE datname = 'murilo-postgress'
ORDER BY query_start;
```

### Step 3: Check for blocking queries

```sql
SELECT
  blocked_locks.pid AS blocked_pid,
  blocking_locks.pid AS blocking_pid,
  blocked_activity.query AS blocked_statement,
  blocking_activity.query AS current_statement_in_blocking_process
FROM pg_catalog.pg_locks blocked_locks
JOIN pg_catalog.pg_stat_activity blocked_activity ON blocked_activity.pid = blocked_locks.pid
JOIN pg_catalog.pg_locks blocking_locks
  ON blocking_locks.locktype = blocked_locks.locktype
  AND blocking_locks.pid != blocked_locks.pid
  AND blocking_locks.granted
JOIN pg_catalog.pg_stat_activity blocking_activity ON blocking_activity.pid = blocking_locks.pid
WHERE NOT blocked_locks.granted;
```

### Step 4: Terminate a blocking query (emergency)

```sql
-- Terminate a specific PID (from Step 3)
SELECT pg_terminate_backend(<blocking_pid>);
```

### Step 5: Identify missing indexes

```sql
-- Find sequential scans on the contacts table
SELECT relname, seq_scan, seq_tup_read, idx_scan
FROM pg_stat_user_tables
WHERE relname = 'contacts';

-- If seq_scan is high, consider indexes on filtered columns:
-- CREATE INDEX CONCURRENTLY idx_contacts_nome ON contacts USING gin(to_tsvector('portuguese', nome));
-- CREATE INDEX CONCURRENTLY idx_contacts_empresa ON contacts (empresa);
-- CREATE INDEX CONCURRENTLY idx_contacts_estado ON contacts (estado);
```

### Step 6: Emergency — increase statement_timeout temporarily

If a single slow query is holding all pool connections:
1. Update `statement_timeout` in `lib/database.ts` to a lower value
2. Redeploy — this forces the pool to use the new timeout for new connections

### Step 7: Post-incident

1. Identify root cause query
2. Add appropriate index (CONCURRENTLY to avoid locking)
3. Run `ANALYZE contacts` to update query planner statistics
4. Verify query plan: `EXPLAIN (ANALYZE, BUFFERS) SELECT ...`
5. Document in incident report

## Prevention

- `statement_timeout: 5000` (5s) is configured in pool
- `query_timeout: 6000` (6s) client-side timeout
- Max pool size: 10 connections
- Monitor `pg_stat_activity` and `pg_stat_user_tables` regularly

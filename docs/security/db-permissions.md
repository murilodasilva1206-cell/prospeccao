# Database Permissions — Least Privilege Setup

## Principle

The application database user (`prospeccao_app`) must have **only the permissions
needed to run the application** — no DDL, no SUPERUSER, no access to system tables.

## Setup Script

Run once as a PostgreSQL superuser (`postgres`):

```sql
-- 1. Create the application role (least privilege)
CREATE ROLE prospeccao_app LOGIN PASSWORD 'use-a-strong-generated-password';

-- 2. Grant connection to the database
GRANT CONNECT ON DATABASE "murilo-postgress" TO prospeccao_app;

-- 3. Grant schema usage
GRANT USAGE ON SCHEMA public TO prospeccao_app;

-- 4. Grant only required table permissions
-- Contacts: SELECT (search) + INSERT (import) + UPDATE (edit)
GRANT SELECT, INSERT, UPDATE ON TABLE contacts TO prospeccao_app;

-- Agent logs: SELECT + INSERT
GRANT SELECT, INSERT ON TABLE agent_logs TO prospeccao_app;

-- 5. Explicitly DENY dangerous operations
REVOKE DELETE ON TABLE contacts FROM prospeccao_app;
REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM prospeccao_app;

-- 6. For future tables: grant on sequences if using SERIAL/BIGSERIAL
-- GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO prospeccao_app;

-- 7. Verify: list privileges
\dp contacts
\dp agent_logs
```

## SSL Configuration

In `postgresql.conf`:
```
ssl = on
ssl_cert_file = 'server.crt'
ssl_key_file  = 'server.key'
ssl_ca_file   = 'root.crt'
```

In `pg_hba.conf` — require SSL and SCRAM auth:
```
# TYPE  DATABASE          USER             ADDRESS         METHOD
hostssl all               prospeccao_app   0.0.0.0/0       scram-sha-256
```

## IP Allowlist

The database should only accept connections from:
1. The application server IP(s)
2. The VPN/bastion host for operator access
3. CI/CD runners (add their egress IPs)

Configure in cloud provider (Supabase, RDS, Neon, etc.) or in `pg_hba.conf`.

## Rotation

See [secrets-rotation-checklist.md](./secrets-rotation-checklist.md) for the
DB password rotation procedure (every 90 days).

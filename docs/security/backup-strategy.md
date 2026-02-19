# Backup Strategy — Prospeccao

## Database Backups

| Item | Frequency | Retention | Method | Storage |
|------|-----------|-----------|--------|---------|
| PostgreSQL full dump | Daily (02:00 local time) | 30 days | `pg_dump \| gzip` | S3 / Backblaze B2 |
| PostgreSQL WAL (continuous) | Continuous | 7 days | `pg_basebackup` or Patroni | Separate region |
| Schema-only dump | On every migration | 90 days | `pg_dump --schema-only` | Git repo (no data) |

## Backup Script (cron example)

```bash
#!/bin/bash
# /etc/cron.daily/pg-backup
DATE=$(date +%Y-%m-%d)
BACKUP_FILE="contacts_${DATE}.sql.gz"

pg_dump \
  -h $DB_HOST \
  -U $DB_USER \
  -d $DB_NAME \
  --no-password \
  | gzip > /backups/${BACKUP_FILE}

# Upload to S3
aws s3 cp /backups/${BACKUP_FILE} s3://prospeccao-backups/daily/${BACKUP_FILE}

# Keep only last 30 days locally
find /backups -name "*.sql.gz" -mtime +30 -delete
```

## Restore Procedure

```bash
# 1. Download the backup
aws s3 cp s3://prospeccao-backups/daily/contacts_YYYY-MM-DD.sql.gz .

# 2. Decompress and restore
gunzip contacts_YYYY-MM-DD.sql.gz
psql -h $DB_HOST -U postgres -d $DB_NAME < contacts_YYYY-MM-DD.sql
```

## Restore Testing

Test restore procedure **monthly**:
1. Spin up a temporary PostgreSQL instance
2. Restore from the most recent backup
3. Run `SELECT COUNT(*) FROM contacts` and compare with production count
4. Run application integration tests against the restored DB
5. Document the restore time (RTO target: < 1 hour)

## RPO and RTO Targets

| Metric | Target | Notes |
|--------|--------|-------|
| RPO (Recovery Point Objective) | < 24 hours | Daily backups |
| RTO (Recovery Time Objective) | < 1 hour | Manual restore + test |

## Secrets Backup

Secrets are **not** backed up as files. They are:
- Stored in the hosting provider's secret manager
- Documented in [secrets-rotation-checklist.md](./secrets-rotation-checklist.md)
- Accessible only to authorized team members via platform IAM

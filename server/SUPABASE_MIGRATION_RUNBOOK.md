# Cloud SQL to Supabase Postgres Runbook (Host Swap Only)

This runbook migrates the existing PostgreSQL workload from Cloud SQL to Supabase while keeping:
- Backend code and SQL queries unchanged (`pg` + raw SQL)
- Firebase auth and tenant scoping unchanged
- PM2 runtime unchanged

## 1. Required Variables

Set these in your shell before running migration scripts:

```bash
export SOURCE_DATABASE_URL="postgres://<cloudsql-user>:<password>@<cloudsql-host>:5432/<db>?sslmode=require"
export TARGET_DATABASE_URL="postgresql://postgres.xfamwraegljpmvsdimrp:<password>@aws-1-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require"
```

Optionally set the Supabase direct URL alias used by scripts:

```bash
export SUPABASE_DIRECT_URL="$TARGET_DATABASE_URL"
```

## 2. Baseline Capture (Cloud SQL Source of Truth)

Capture schema + snapshot from Cloud SQL:

```bash
npm run --prefix server db:migration:capture-baseline
```

Artifacts are written to `server/migrations/baseline/<timestamp>/`.

If you need to overwrite the checked-in baseline from source:

```bash
WRITE_BASELINE=true npm run --prefix server db:migration:capture-baseline
```

Export source data dump (core tables only):

```bash
npm run --prefix server db:migration:export-data
```

## 3. Staging Dry Run

Apply baseline schema to staging Supabase and import data dump:

```bash
SCHEMA_FILE=server/migrations/0001_cloudsql_baseline.sql \
DATA_FILE=server/migrations/baseline/<timestamp>/cloudsql_data.dump \
npm run --prefix server db:migration:import-target
```

Run target integrity checks:

```bash
npm run --prefix server db:migration:validate-target
```

Compare source and target parity:

```bash
npm run --prefix server db:migration:compare-parity
```

Record migration duration and confirm it fits the planned write-freeze window.

## 4. Production Cutover (Brief Write Freeze)

1. Announce maintenance window.
2. Freeze writes:
```bash
export DB_WRITE_FREEZE=true
pm2 restart shields-outbound-server --update-env
pm2 restart shields-outbound-worker --update-env
```
3. Take final source backup:
```bash
npm run --prefix server db:migration:capture-baseline
npm run --prefix server db:migration:export-data
```
4. Import final schema/data to Supabase production:
```bash
SCHEMA_FILE=server/migrations/0001_cloudsql_baseline.sql \
DATA_FILE=server/migrations/baseline/<timestamp>/cloudsql_data.dump \
npm run --prefix server db:migration:import-target
```
5. Validate target:
```bash
npm run --prefix server db:migration:validate-target
npm run --prefix server db:migration:compare-parity
```
6. Switch runtime DB env vars to Supabase (`PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGSSLMODE=require`).
7. Restart API + worker:
```bash
pm2 restart shields-outbound-server --update-env
pm2 restart shields-outbound-worker --update-env
```
8. Smoke test connectivity:
```bash
npm run --prefix server db:ping
```
9. Unfreeze writes after smoke checks pass:
```bash
export DB_WRITE_FREEZE=false
pm2 restart shields-outbound-server --update-env
pm2 restart shields-outbound-worker --update-env
```

## 5. Rollback Procedure

Rollback triggers:
- Integrity/parity check failure
- Sustained DB errors on critical routes
- Pipeline write failures during smoke window

Rollback steps:
1. Re-freeze writes:
```bash
export DB_WRITE_FREEZE=true
pm2 restart shields-outbound-server --update-env
pm2 restart shields-outbound-worker --update-env
```
2. Restore Cloud SQL runtime DB env vars.
3. Restart API + worker:
```bash
pm2 restart shields-outbound-server --update-env
pm2 restart shields-outbound-worker --update-env
```
4. Confirm health:
```bash
npm run --prefix server db:ping
```
5. Unfreeze writes when healthy:
```bash
export DB_WRITE_FREEZE=false
pm2 restart shields-outbound-server --update-env
pm2 restart shields-outbound-worker --update-env
```

Keep Cloud SQL untouched through April 20, 2026 as the rollback fallback.

## 6. Post-Cutover Checks (24-48h)

- Monitor DB pool errors and query latency in server logs.
- Run queue throughput smoke jobs and compare to pre-cutover baseline.
- Re-run:
```bash
npm run --prefix server db:migration:validate-target
```
- Only after stability window, remove old Cloud SQL operational remnants.

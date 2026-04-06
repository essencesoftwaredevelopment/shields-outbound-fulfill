#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_SERVER_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
SNAPSHOT_SQL="$SCRIPT_DIR/sql/table_parity_snapshot.sql"
BASELINE_FILE="$REPO_SERVER_DIR/migrations/0001_cloudsql_baseline.sql"

SOURCE_DATABASE_URL="${SOURCE_DATABASE_URL:-${DATABASE_URL:-}}"
OUTPUT_ROOT="${OUTPUT_ROOT:-$REPO_SERVER_DIR/migrations/baseline}"
TIMESTAMP="${TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
RUN_DIR="$OUTPUT_ROOT/$TIMESTAMP"
SCHEMA_OUT="$RUN_DIR/cloudsql_schema.sql"
SNAPSHOT_OUT="$RUN_DIR/cloudsql_table_snapshot.tsv"

if [[ -z "${SOURCE_DATABASE_URL}" ]]; then
  echo "SOURCE_DATABASE_URL (or DATABASE_URL) is required."
  exit 1
fi

command -v pg_dump >/dev/null 2>&1 || { echo "pg_dump is required."; exit 1; }
command -v psql >/dev/null 2>&1 || { echo "psql is required."; exit 1; }

mkdir -p "$RUN_DIR"

echo "[capture-baseline] Exporting schema to: $SCHEMA_OUT"
pg_dump \
  --schema-only \
  --no-owner \
  --no-privileges \
  "$SOURCE_DATABASE_URL" > "$SCHEMA_OUT"

echo "[capture-baseline] Exporting table snapshot to: $SNAPSHOT_OUT"
psql "$SOURCE_DATABASE_URL" \
  -v ON_ERROR_STOP=1 \
  -AtF $'\t' \
  -f "$SNAPSHOT_SQL" > "$SNAPSHOT_OUT"

if [[ "${WRITE_BASELINE:-false}" == "true" ]]; then
  cp "$SCHEMA_OUT" "$BASELINE_FILE"
  echo "[capture-baseline] Updated checked-in baseline: $BASELINE_FILE"
fi

echo "[capture-baseline] Complete."
echo "  schema:   $SCHEMA_OUT"
echo "  snapshot: $SNAPSHOT_OUT"

#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_SERVER_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

SOURCE_DATABASE_URL="${SOURCE_DATABASE_URL:-${DATABASE_URL:-}}"
OUTPUT_ROOT="${OUTPUT_ROOT:-$REPO_SERVER_DIR/migrations/baseline}"
TIMESTAMP="${TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
RUN_DIR="$OUTPUT_ROOT/$TIMESTAMP"
DATA_OUT="$RUN_DIR/cloudsql_data.dump"

if [[ -z "${SOURCE_DATABASE_URL}" ]]; then
  echo "SOURCE_DATABASE_URL (or DATABASE_URL) is required."
  exit 1
fi

command -v pg_dump >/dev/null 2>&1 || { echo "pg_dump is required."; exit 1; }

mkdir -p "$RUN_DIR"

echo "[export-data] Exporting data dump to: $DATA_OUT"
pg_dump \
  --format=custom \
  --data-only \
  --no-owner \
  --no-privileges \
  --table=public.clients \
  --table=public.companies \
  --table=public.contacts \
  --table=public.instantly_campaigns \
  --table=public.contact_instantly_campaigns \
  --table=public.job_stage_checkpoints \
  --file="$DATA_OUT" \
  "$SOURCE_DATABASE_URL"

echo "[export-data] Complete: $DATA_OUT"

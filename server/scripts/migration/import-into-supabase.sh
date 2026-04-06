#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_SERVER_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

TARGET_DATABASE_URL="${TARGET_DATABASE_URL:-${SUPABASE_DIRECT_URL:-}}"
SCHEMA_FILE="${SCHEMA_FILE:-$REPO_SERVER_DIR/migrations/0001_cloudsql_baseline.sql}"
DATA_FILE="${DATA_FILE:-}"

if [[ -z "${TARGET_DATABASE_URL}" ]]; then
  echo "TARGET_DATABASE_URL (or SUPABASE_DIRECT_URL) is required."
  exit 1
fi

command -v psql >/dev/null 2>&1 || { echo "psql is required."; exit 1; }

if [[ -n "${SCHEMA_FILE}" ]]; then
  if [[ ! -f "${SCHEMA_FILE}" ]]; then
    echo "Schema file not found: ${SCHEMA_FILE}"
    exit 1
  fi
  echo "[import-target] Applying schema: ${SCHEMA_FILE}"
  psql "${TARGET_DATABASE_URL}" -v ON_ERROR_STOP=1 -f "${SCHEMA_FILE}"
fi

if [[ -z "${DATA_FILE}" ]]; then
  echo "[import-target] DATA_FILE not set. Schema import only."
  exit 0
fi

if [[ ! -f "${DATA_FILE}" ]]; then
  echo "Data file not found: ${DATA_FILE}"
  exit 1
fi

case "${DATA_FILE}" in
  *.dump|*.backup|*.bin)
    command -v pg_restore >/dev/null 2>&1 || { echo "pg_restore is required for binary dumps."; exit 1; }
    echo "[import-target] Restoring binary data dump: ${DATA_FILE}"
    pg_restore \
      --data-only \
      --no-owner \
      --no-privileges \
      --disable-triggers \
      --dbname="${TARGET_DATABASE_URL}" \
      "${DATA_FILE}"
    ;;
  *)
    echo "[import-target] Restoring SQL data file: ${DATA_FILE}"
    psql "${TARGET_DATABASE_URL}" -v ON_ERROR_STOP=1 -f "${DATA_FILE}"
    ;;
esac

echo "[import-target] Complete."

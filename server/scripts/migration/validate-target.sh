#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VALIDATION_SQL="$SCRIPT_DIR/sql/integrity_validation.sql"
TARGET_DATABASE_URL="${TARGET_DATABASE_URL:-${SUPABASE_DIRECT_URL:-}}"

if [[ -z "${TARGET_DATABASE_URL}" ]]; then
  echo "TARGET_DATABASE_URL (or SUPABASE_DIRECT_URL) is required."
  exit 1
fi

command -v psql >/dev/null 2>&1 || { echo "psql is required."; exit 1; }

RESULTS="$(psql "${TARGET_DATABASE_URL}" -v ON_ERROR_STOP=1 -AtF $'\t' -f "$VALIDATION_SQL")"

echo "[validate-target] Integrity checks:"
echo "$RESULTS" | awk -F $'\t' 'BEGIN { printf "%-42s %-6s %s\n", "check_name", "status", "details" } { printf "%-42s %-6s %s\n", $1, $2, $3 }'

if echo "$RESULTS" | grep -q $'\tfail\t'; then
  echo "[validate-target] FAIL: one or more integrity checks failed."
  exit 1
fi

echo "[validate-target] PASS: all integrity checks passed."

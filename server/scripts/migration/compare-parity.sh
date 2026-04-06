#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_SERVER_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
SNAPSHOT_SQL="$SCRIPT_DIR/sql/table_parity_snapshot.sql"

SOURCE_DATABASE_URL="${SOURCE_DATABASE_URL:-}"
TARGET_DATABASE_URL="${TARGET_DATABASE_URL:-${SUPABASE_DIRECT_URL:-}}"
OUTPUT_ROOT="${OUTPUT_ROOT:-$REPO_SERVER_DIR/migrations/parity}"
TIMESTAMP="${TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
RUN_DIR="$OUTPUT_ROOT/$TIMESTAMP"
SOURCE_OUT="$RUN_DIR/source.tsv"
TARGET_OUT="$RUN_DIR/target.tsv"

if [[ -z "${SOURCE_DATABASE_URL}" ]]; then
  echo "SOURCE_DATABASE_URL is required."
  exit 1
fi

if [[ -z "${TARGET_DATABASE_URL}" ]]; then
  echo "TARGET_DATABASE_URL (or SUPABASE_DIRECT_URL) is required."
  exit 1
fi

command -v psql >/dev/null 2>&1 || { echo "psql is required."; exit 1; }
command -v diff >/dev/null 2>&1 || { echo "diff is required."; exit 1; }

mkdir -p "$RUN_DIR"

echo "[compare-parity] Capturing source snapshot..."
psql "${SOURCE_DATABASE_URL}" \
  -v ON_ERROR_STOP=1 \
  -AtF $'\t' \
  -f "$SNAPSHOT_SQL" > "$SOURCE_OUT"

echo "[compare-parity] Capturing target snapshot..."
psql "${TARGET_DATABASE_URL}" \
  -v ON_ERROR_STOP=1 \
  -AtF $'\t' \
  -f "$SNAPSHOT_SQL" > "$TARGET_OUT"

echo "[compare-parity] Comparing snapshots..."
if diff -u "$SOURCE_OUT" "$TARGET_OUT" > "$RUN_DIR/diff.txt"; then
  echo "[compare-parity] PASS: source and target snapshots match."
  echo "  source: $SOURCE_OUT"
  echo "  target: $TARGET_OUT"
  exit 0
fi

echo "[compare-parity] FAIL: snapshot mismatch detected."
echo "  diff: $RUN_DIR/diff.txt"
exit 1

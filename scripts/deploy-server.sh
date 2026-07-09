#!/usr/bin/env bash
#
# One-command deploy of the Express/PM2 server to the droplet.
#
#   npm run deploy:server            # push prod, then pull + deps + restart + health-check on the droplet
#   npm run deploy:server -- --no-push       # deploy whatever origin/prod already has
#   npm run deploy:server -- --skip-health   # don't fail the deploy on a health-check timeout
#
# Everything remote runs in ONE ssh invocation, so password auth prompts once.
# To make it prompt-free, install your key on the droplet a single time:
#   ssh-copy-id -i ~/.ssh/id_ed25519.pub root@159.65.95.175
#
# Defaults below can be overridden via env vars or scripts/.deploy.env
# (key=value lines; git-ignored).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ -f "$SCRIPT_DIR/.deploy.env" ]]; then
    # shellcheck disable=SC1091
    source "$SCRIPT_DIR/.deploy.env"
fi

DEPLOY_HOST="${DEPLOY_HOST:-root@159.65.95.175}"
DEPLOY_PATH="${DEPLOY_PATH:-/root/shields-outbound}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-prod}"
HEALTH_URL="${HEALTH_URL:-http://localhost:4000/health}"

PUSH=1
HEALTH_REQUIRED=1
for arg in "$@"; do
    case "$arg" in
        --no-push) PUSH=0 ;;
        --skip-health) HEALTH_REQUIRED=0 ;;
        *) echo "Unknown flag: $arg" >&2; exit 2 ;;
    esac
done

log() { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[deploy]\033[0m %s\n' "$*"; }

cd "$REPO_ROOT"

# ── Local phase: make origin/<branch> hold what we intend to deploy ──────────
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"

if [[ -n "$(git status --porcelain -- server lib app 2>/dev/null)" ]]; then
    warn "You have uncommitted changes — they will NOT be deployed (deploy ships origin/$DEPLOY_BRANCH)."
fi

if [[ "$PUSH" -eq 1 ]]; then
    if [[ "$CURRENT_BRANCH" != "$DEPLOY_BRANCH" ]]; then
        warn "On branch '$CURRENT_BRANCH', not '$DEPLOY_BRANCH' — skipping push. origin/$DEPLOY_BRANCH deploys as-is."
    else
        log "Pushing $DEPLOY_BRANCH to origin…"
        git push origin "$DEPLOY_BRANCH"
    fi
fi

TARGET_SHA="$(git ls-remote origin "refs/heads/$DEPLOY_BRANCH" | cut -f1)"
if [[ -z "$TARGET_SHA" ]]; then
    echo "[deploy] origin/$DEPLOY_BRANCH not found — nothing to deploy." >&2
    exit 1
fi
log "Deploying origin/$DEPLOY_BRANCH @ ${TARGET_SHA:0:9} to $DEPLOY_HOST:$DEPLOY_PATH"

# ── Remote phase: one ssh call — pull, deps if needed, restart, health ───────
# Heredoc pipes straight into ssh (no $(...) wrapper — macOS bash 3.2 chokes on
# quotes inside command-substituted heredocs). Unescaped $VARS expand locally,
# \$VARS expand on the droplet.
ssh -o ConnectTimeout=10 "$DEPLOY_HOST" 'bash -s' <<EOF
set -euo pipefail
cd "$DEPLOY_PATH"

OLD=\$(git rev-parse HEAD)
echo "[droplet] currently at \${OLD:0:9} on \$(git rev-parse --abbrev-ref HEAD)"

git fetch origin "$DEPLOY_BRANCH"
if [[ "\$(git rev-parse --abbrev-ref HEAD)" != "$DEPLOY_BRANCH" ]]; then
    git checkout "$DEPLOY_BRANCH"
fi
# --ff-only: refuse to silently merge if someone edited files on the droplet.
git merge --ff-only "origin/$DEPLOY_BRANCH"
NEW=\$(git rev-parse HEAD)

if [[ "\$OLD" == "\$NEW" ]]; then
    echo "[droplet] no new commits — restarting anyway."
else
    echo "[droplet] updated \${OLD:0:9} -> \${NEW:0:9} (\$(git rev-list --count "\$OLD".."\$NEW") commits)"
fi

# Install deps only when the server manifest actually changed.
if [[ "\$OLD" != "\$NEW" ]] && ! git diff --quiet "\$OLD" "\$NEW" -- server/package.json server/package-lock.json; then
    echo "[droplet] server dependencies changed — npm ci…"
    (cd server && (npm ci --omit=dev || npm install --omit=dev))
fi

# New SQL migrations are NOT auto-applied — call them out loudly.
if [[ "\$OLD" != "\$NEW" ]]; then
    NEW_MIGRATIONS=\$(git diff --name-only --diff-filter=A "\$OLD" "\$NEW" -- server/migrations | cat)
    if [[ -n "\$NEW_MIGRATIONS" ]]; then
        echo ""
        echo "[droplet] ⚠️  NEW MIGRATIONS in this deploy (apply to Supabase if not already):"
        echo "\$NEW_MIGRATIONS" | sed 's/^/[droplet]     /'
        echo ""
    fi
fi

# startOrRestart via the ecosystem file: restarts exactly the project apps,
# starts any that are missing, and re-reads server/.env through the config.
pm2 startOrRestart server/ecosystem.config.cjs --update-env
pm2 save

echo "[droplet] waiting for health check…"
HEALTH_OK=0
for i in \$(seq 1 10); do
    sleep 2
    if curl -fsS -m 4 "$HEALTH_URL" > /dev/null 2>&1; then
        HEALTH_OK=1
        break
    fi
done

if [[ "\$HEALTH_OK" -eq 1 ]]; then
    echo "[droplet] ✅ healthy: $HEALTH_URL"
    pm2 ls
else
    echo "[droplet] ❌ health check failed after 20s: $HEALTH_URL"
    echo "[droplet] recent server logs:"
    pm2 logs shields-outbound-server --nostream --lines 30 || true
    # HEALTH_REQUIRED expands locally: 1 = fail the deploy, 0 = warn only.
    exit $HEALTH_REQUIRED
fi
EOF

log "✅ Deploy complete: $DEPLOY_BRANCH @ ${TARGET_SHA:0:9}"
log "Note: the Next.js app deploys separately (Vercel on push) — this script only handles the PM2 server."

# PM2 process management commands for production

# Required env vars (export these before starting PM2)
export PGHOST="aws-1-eu-central-1.pooler.supabase.com"
export PGPORT="5432"
export PGDATABASE="postgres"
export PGUSER="postgres.xfamwraegljpmvsdimrp"
export PGPASSWORD="<supabase-password>"
export PGSSLMODE="require"
export DB_WRITE_FREEZE="false"

# Start all processes from ecosystem config (loads env vars from current shell)
pm2 start ecosystem.config.cjs

# Start only API or only worker from ecosystem config
pm2 start ecosystem.config.cjs --only shields-outbound-server
pm2 start ecosystem.config.cjs --only shields-outbound-worker

# Start only follow-up worker (twice-daily automated reply sender)
pm2 start ecosystem.config.cjs --only shields-outbound-followup-worker

# Trigger a one-off follow-up run manually (without starting the scheduler)
node src/scripts/run-follow-ups-once.js
# Dry-run mode (renders and logs but does not send)
FOLLOWUP_DRY_RUN=true node src/scripts/run-follow-ups-once.js

# View logs
pm2 logs shields-outbound-server
pm2 logs shields-outbound-worker
pm2 logs shields-outbound-followup-worker

# List all processes
pm2 list

# Restart with env refresh
pm2 restart shields-outbound-server --update-env
pm2 restart shields-outbound-worker --update-env

# Enable write freeze for migration cutover (returns 503 on write methods)
export DB_WRITE_FREEZE="true"
pm2 restart shields-outbound-server --update-env
pm2 restart shields-outbound-worker --update-env

# Disable write freeze after cutover validation
export DB_WRITE_FREEZE="false"
pm2 restart shields-outbound-server --update-env
pm2 restart shields-outbound-worker --update-env

# Stop the server
pm2 stop shields-outbound-server
pm2 stop shields-outbound-worker

# Save process list for auto-restart on reboot
pm2 save

# Setup PM2 to launch on system startup
pm2 startup
# (Run the command output by pm2 startup as root)

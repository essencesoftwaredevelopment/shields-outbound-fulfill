# PM2 process management commands for production

# Start all processes from ecosystem config (ensures DB env vars are applied)
pm2 start ecosystem.config.cjs

# Start only API or only worker from ecosystem config
pm2 start ecosystem.config.cjs --only shields-outbound-server
pm2 start ecosystem.config.cjs --only shields-outbound-worker

# View logs
pm2 logs shields-outbound-server
pm2 logs shields-outbound-worker

# List all processes
pm2 list

# Restart with env refresh
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

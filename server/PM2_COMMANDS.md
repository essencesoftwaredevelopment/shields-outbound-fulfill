# PM2 process management commands for production

# Start the server
pm2 start src/index.js --name shields-outbound-server
pm2 start src/worker/queueWorker.js --name shields-outbound-worker -i 2

# View logs
pm2 logs shields-outbound-server
pm2 logs shields-outbound-worker

# List all processes
pm2 list

# Restart the server
pm2 restart shields-outbound-server
pm2 restart shields-outbound-worker

# Stop the server
pm2 stop shields-outbound-server
pm2 stop shields-outbound-worker

# Save process list for auto-restart on reboot
pm2 save

# Setup PM2 to launch on system startup
pm2 startup
# (Run the command output by pm2 startup as root)

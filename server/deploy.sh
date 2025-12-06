#!/bin/bash
# DigitalOcean Node.js + PM2 deployment script
# Usage: bash deploy.sh

# 1. Update and install Node.js
sudo apt update && sudo apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# 2. Install PM2 globally
sudo npm install -g pm2

# 3. Clone or update your project (edit this section as needed)
# git clone <your-repo-url> /root/shields-outbound || (cd /root/shields-outbound && git pull)

# 4. Install dependencies
cd /root/shields-outbound/server
npm install

# 5. Start the server with PM2
pm2 start src/index.js --name shields-outbound-server

# 6. Save PM2 process list and configure startup
pm2 save
pm2 startup
# The above command will output another command to run as root. Copy and run it.

echo "Deployment complete. Use 'pm2 logs shields-outbound-server' to view logs."

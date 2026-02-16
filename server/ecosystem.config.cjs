module.exports = {
  apps: [
    {
      name: 'cloud-sql-proxy',
      script: '/usr/local/bin/cloud-sql-proxy',
      args: 'shields-outbound-fulfill:europe-southwest1:shields-outbound-sql --port 5432 --address 127.0.0.1',
      env: {
        GOOGLE_APPLICATION_CREDENTIALS: '/root/.secrets/gcp-key.json'
      },
      autorestart: true,
      max_restarts: 5,
      restart_delay: 3000
    },
    {
      name: 'shields-outbound-server',
      script: 'src/index.js',
      cwd: '/root/shields-outbound/server',
      env: {
        NODE_ENV: 'production',
        PORT: 4000,
        PGHOST: '127.0.0.1',
        PGPORT: 5432,
        PGDATABASE: 'shields_outbound',
        PGUSER: 'postgres',
        PGPASSWORD: 'Rinn2015!',
        PGSSLMODE: 'disable'
      },
      autorestart: true
    },
    {
      name: 'shields-outbound-worker',
      script: 'src/worker/queueWorker.js',
      cwd: '/root/shields-outbound/server',
      instances: 2,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PGHOST: '127.0.0.1',
        PGPORT: 5432,
        PGDATABASE: 'shields_outbound',
        PGUSER: 'postgres',
        PGPASSWORD: 'Rinn2015!',
        PGSSLMODE: 'disable'
      },
      autorestart: true
    }
  ]
};

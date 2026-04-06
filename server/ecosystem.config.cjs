const baseEnv = {
  NODE_ENV: process.env.NODE_ENV || 'production',
  PORT: process.env.PORT || 4000,
  PGHOST: process.env.PGHOST || '',
  PGPORT: process.env.PGPORT || 5432,
  PGDATABASE: process.env.PGDATABASE || '',
  PGUSER: process.env.PGUSER || '',
  PGPASSWORD: process.env.PGPASSWORD || '',
  PGSSLMODE: process.env.PGSSLMODE || 'require',
  PGSSLROOTCERT: process.env.PGSSLROOTCERT || '',
  PGPOOL_MAX: process.env.PGPOOL_MAX || 5,
  DB_WRITE_FREEZE: process.env.DB_WRITE_FREEZE || 'false',
  JOB_EXECUTION_MODE: process.env.JOB_EXECUTION_MODE || 'queue',
  INSTANTLY_SYNC_INTERVAL_MS: process.env.INSTANTLY_SYNC_INTERVAL_MS || 900000,
  INSTANTLY_SYNC_CONCURRENCY: process.env.INSTANTLY_SYNC_CONCURRENCY || 2,
  INSTANTLY_REQUEST_TIMEOUT_MS: process.env.INSTANTLY_REQUEST_TIMEOUT_MS || 20000,
  INSTANTLY_RATE_LIMIT_PER_SECOND: process.env.INSTANTLY_RATE_LIMIT_PER_SECOND || 20,
  INSTANTLY_MAX_RETRIES: process.env.INSTANTLY_MAX_RETRIES || 4,
  INSTANTLY_RETRY_BASE_DELAY_MS: process.env.INSTANTLY_RETRY_BASE_DELAY_MS || 1000
};

module.exports = {
  apps: [
    {
      name: 'shields-outbound-server',
      script: 'src/index.js',
      cwd: '/root/shields-outbound/server',
      env: {
        ...baseEnv
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
        ...baseEnv
      },
      autorestart: true
    },
    {
      name: 'shields-outbound-instantly-sync',
      script: 'src/worker/instantlySyncWorker.js',
      cwd: '/root/shields-outbound/server',
      instances: 1,
      exec_mode: 'fork',
      env: {
        ...baseEnv
      },
      autorestart: true
    }
  ]
};

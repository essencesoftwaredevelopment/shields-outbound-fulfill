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
  DB_WRITE_FREEZE: process.env.DB_WRITE_FREEZE || 'false',
  JOB_EXECUTION_MODE: process.env.JOB_EXECUTION_MODE || 'queue'
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
    }
  ]
};

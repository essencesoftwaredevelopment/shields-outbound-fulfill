const path = require('path');
const fs = require('fs');

// Load server/.secrets/.env then server/.env so PM2 sees the same DB creds as `npm run db:ping`.
// Do not pass empty PG* into PM2 env — that blocks dotenv in the app from filling them in.
for (const rel of ['.secrets/.env', '.env']) {
  const envPath = path.join(__dirname, rel);
  if (fs.existsSync(envPath)) {
    require('dotenv').config({ path: envPath });
    break;
  }
}

function envOrUnset(key) {
  const v = process.env[key];
  return v !== undefined && v !== '' ? v : undefined;
}

const baseEnv = {
  NODE_ENV: process.env.NODE_ENV || 'production',
  PORT: process.env.PORT || 4000,
  ...(envOrUnset('DATABASE_URL') ? { DATABASE_URL: process.env.DATABASE_URL } : {}),
  ...(envOrUnset('PGHOST') ? { PGHOST: process.env.PGHOST } : {}),
  PGPORT: Number(process.env.PGPORT || 5432),
  ...(envOrUnset('PGDATABASE') ? { PGDATABASE: process.env.PGDATABASE } : {}),
  ...(envOrUnset('PGUSER') ? { PGUSER: process.env.PGUSER } : {}),
  ...(envOrUnset('PGPASSWORD') ? { PGPASSWORD: process.env.PGPASSWORD } : {}),
  PGSSLMODE: process.env.PGSSLMODE || 'require',
  ...(envOrUnset('PGSSLROOTCERT') ? { PGSSLROOTCERT: process.env.PGSSLROOTCERT } : {}),
  PGPOOL_MAX: process.env.PGPOOL_MAX || 5,
  DB_WRITE_FREEZE: process.env.DB_WRITE_FREEZE || 'false',
  ...(envOrUnset('SUPABASE_URL') ? { SUPABASE_URL: process.env.SUPABASE_URL } : {}),
  ...(envOrUnset('SUPABASE_SERVICE_ROLE_KEY') ? { SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY } : {}),
  ...(envOrUnset('SUPABASE_ANON_KEY') ? { SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY } : {}),
  // Default: one full Instantly sync pass per client per 24h (override via INSTANTLY_SYNC_INTERVAL_MS).
  INSTANTLY_SYNC_INTERVAL_MS: process.env.INSTANTLY_SYNC_INTERVAL_MS || 86400000,
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
      instances: 1,
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
    },
    {
      name: 'shields-outbound-followup-worker',
      script: 'src/worker/followUpWorker.js',
      cwd: '/root/shields-outbound/server',
      instances: 1,
      exec_mode: 'fork',
      env: {
        ...baseEnv,
        FOLLOWUP_SCHEDULE_TIMES: process.env.FOLLOWUP_SCHEDULE_TIMES || '09:00,14:00',
        FOLLOWUP_TIMEZONE: process.env.FOLLOWUP_TIMEZONE || 'UTC',
        FOLLOWUP_BATCH_SIZE: process.env.FOLLOWUP_BATCH_SIZE || 50,
        FOLLOWUP_CONCURRENCY: process.env.FOLLOWUP_CONCURRENCY || 2,
        FOLLOWUP_DRY_RUN: process.env.FOLLOWUP_DRY_RUN || 'false'
      },
      autorestart: true
    }
  ]
};

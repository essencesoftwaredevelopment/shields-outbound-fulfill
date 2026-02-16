import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Pool } from 'pg';
import { env } from './env.js';

const sslEnabled = env.PGSSLMODE && env.PGSSLMODE.toLowerCase() !== 'disable';

const sslConfig = sslEnabled
    ? {
          rejectUnauthorized: false,
          ca: env.PGSSLROOTCERT ? readFileSync(resolve(env.PGSSLROOTCERT)).toString() : undefined
      }
    : undefined;

if (!env.PGPASSWORD) {
    console.warn('⚠️ [DB] PGPASSWORD is empty; PostgreSQL password authentication may fail');
}

export const pool = new Pool({
    host: env.PGHOST,
    port: env.PGPORT,
    database: env.PGDATABASE,
    user: env.PGUSER,
    password: env.PGPASSWORD,
    ssl: sslConfig,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 30_000, // Increased from 10s to 30s
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000
});

// Handle pool errors to prevent crashes
pool.on('error', (err) => {
    console.error('❌ [DB POOL ERROR]', {
        code: err.code,
        message: err.message,
        stack: err.stack?.split('\n').slice(0, 3).join('\n')
    });
});

pool.on('connect', () => {
    // console.log('✅ [DB] New connection established');
});

pool.on('acquire', () => {
    // console.log('🔵 [DB] Client acquired from pool');
});

pool.on('remove', () => {
    // console.log('🔴 [DB] Client removed from pool');
});

export async function testConnection() {
    const client = await pool.connect();
    try {
        const { rows } = await client.query('select 1 as ok');
        return rows[0]?.ok === 1;
    } finally {
        client.release();
    }
}

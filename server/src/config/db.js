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
    max: env.PGPOOL_MAX,
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

/**
 * Ceiling for interactive (UI-facing) reads. The cluster-wide `statement_timeout`
 * is 120s, which is a crash barrier, not a budget: a browse query that needs two
 * minutes is a bug, and letting it run holds a pool slot the whole time. Anything
 * on this path that exceeds the budget should fail loudly instead.
 */
export const INTERACTIVE_STATEMENT_TIMEOUT_MS = Number(
    process.env.INTERACTIVE_STATEMENT_TIMEOUT_MS || 20_000
);

/**
 * Run a query under an explicit per-statement timeout.
 *
 * `SET LOCAL` needs a transaction, and a transaction is what makes the setting
 * safe on a pooled connection — it reverts on COMMIT/ROLLBACK rather than leaking
 * into whatever runs next on that client.
 *
 * Throws Postgres error code 57014 (`query_canceled`) on expiry.
 */
export async function queryWithStatementTimeout(
    text,
    params = [],
    timeoutMs = INTERACTIVE_STATEMENT_TIMEOUT_MS
) {
    const budget = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
        ? Math.floor(Number(timeoutMs))
        : INTERACTIVE_STATEMENT_TIMEOUT_MS;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL statement_timeout = ${budget}`);
        const result = await client.query(text, params);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

export async function testConnection() {
    const client = await pool.connect();
    try {
        const { rows } = await client.query('select 1 as ok');
        return rows[0]?.ok === 1;
    } finally {
        client.release();
    }
}

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

export const pool = new Pool({
    host: env.PGHOST,
    port: env.PGPORT,
    database: env.PGDATABASE,
    user: env.PGUSER,
    password: env.PGPASSWORD,
    ssl: sslConfig,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000
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

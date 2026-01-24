import { pool } from '../src/config/db.js';
import { env } from '../src/config/env.js';

async function main() {
    console.log('Attempting DB connection with host=%s port=%s db=%s user=%s ssl=%s', env.PGHOST, env.PGPORT, env.PGDATABASE, env.PGUSER, env.PGSSLMODE);
    try {
        const client = await pool.connect();
        const { rows } = await client.query('select version() as version');
        console.log('Connected. Postgres version:', rows[0]?.version);
        client.release();
        await pool.end();
        process.exit(0);
    } catch (err) {
        console.error('DB ping failed:', err.message);
        console.error(err);
        process.exit(1);
    }
}

main();

import dotenv from 'dotenv';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_ROOT = path.resolve(__dirname, '../..');
const ENV_PATHS = [
    path.join(SERVER_ROOT, '.secrets', '.env'),
    path.join(SERVER_ROOT, '.env')
];

// Load from server/.secrets/.env first, then fallback to server/.env.
for (const envPath of ENV_PATHS) {
    if (existsSync(envPath)) {
        dotenv.config({ path: envPath });
        break;
    }
}

const databaseUrl = process.env.DATABASE_URL || '';
let parsedDatabaseUrl = null;

if (databaseUrl) {
    try {
        parsedDatabaseUrl = new URL(databaseUrl);
    } catch (error) {
        console.warn(`[env] Invalid DATABASE_URL: ${error.message}`);
    }
}

const databaseNameFromUrl = parsedDatabaseUrl?.pathname?.replace(/^\//, '') || '';
const databasePortFromUrl = parsedDatabaseUrl?.port ? Number(parsedDatabaseUrl.port) : 5432;
const databaseUserFromUrl = parsedDatabaseUrl?.username ? decodeURIComponent(parsedDatabaseUrl.username) : '';
const databasePasswordFromUrl = parsedDatabaseUrl?.password ? decodeURIComponent(parsedDatabaseUrl.password) : '';
const databaseSslModeFromUrl = parsedDatabaseUrl?.searchParams.get('sslmode') || '';

export const env = {
    PORT: process.env.PORT || 4000,
    DATABASE_URL: databaseUrl,
    PGHOST: process.env.PGHOST || parsedDatabaseUrl?.hostname || '',
    PGPORT: Number(process.env.PGPORT || databasePortFromUrl),
    PGDATABASE: process.env.PGDATABASE || databaseNameFromUrl,
    PGUSER: process.env.PGUSER || databaseUserFromUrl,
    PGPASSWORD: process.env.PGPASSWORD || databasePasswordFromUrl,
    PGSSLMODE: process.env.PGSSLMODE || databaseSslModeFromUrl || 'disable',
    PGSSLROOTCERT: process.env.PGSSLROOTCERT || '',
    PGPOOL_MAX: Math.max(Number(process.env.PGPOOL_MAX || 5) || 5, 1),
    DB_WRITE_FREEZE: String(process.env.DB_WRITE_FREEZE || 'false').toLowerCase() === 'true',
    SUPABASE_URL: process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '',
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '',
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || '',
    STRIPE_PRICE_ID: process.env.STRIPE_PRICE_ID || '',
    STRIPE_SUCCESS_URL: process.env.STRIPE_SUCCESS_URL || 'http://localhost:3000/account?checkout=success',
    STRIPE_CANCEL_URL: process.env.STRIPE_CANCEL_URL || 'http://localhost:3000/account?checkout=cancelled',
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || '',
    PERSONALIZATION_FILTER_B2B: process.env.PERSONALIZATION_FILTER_B2B
};

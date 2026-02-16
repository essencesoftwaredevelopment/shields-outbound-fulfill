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

export const env = {
    PORT: process.env.PORT || 4000,
    PGHOST: process.env.PGHOST || '',
    PGPORT: Number(process.env.PGPORT || 5432),
    PGDATABASE: process.env.PGDATABASE || '',
    PGUSER: process.env.PGUSER || '',
    PGPASSWORD: process.env.PGPASSWORD || '',
    PGSSLMODE: process.env.PGSSLMODE || 'disable',
    PGSSLROOTCERT: process.env.PGSSLROOTCERT || '',
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || '',
    STRIPE_PRICE_ID: process.env.STRIPE_PRICE_ID || '',
    STRIPE_SUCCESS_URL: process.env.STRIPE_SUCCESS_URL || 'http://localhost:3000/account?checkout=success',
    STRIPE_CANCEL_URL: process.env.STRIPE_CANCEL_URL || 'http://localhost:3000/account?checkout=cancelled',
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || '',
    PERSONALIZATION_FILTER_B2B: process.env.PERSONALIZATION_FILTER_B2B
};

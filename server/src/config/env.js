import dotenv from 'dotenv';

dotenv.config();

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

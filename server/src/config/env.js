import dotenv from 'dotenv';

dotenv.config();

export const env = {
    PORT: process.env.PORT || 4000,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || '',
    STRIPE_PRICE_ID: process.env.STRIPE_PRICE_ID || '',
    STRIPE_SUCCESS_URL: process.env.STRIPE_SUCCESS_URL || 'http://localhost:3000/account?checkout=success',
    STRIPE_CANCEL_URL: process.env.STRIPE_CANCEL_URL || 'http://localhost:3000/account?checkout=cancelled',
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || '',
    PERSONALIZATION_FILTER_B2B: process.env.PERSONALIZATION_FILTER_B2B
};

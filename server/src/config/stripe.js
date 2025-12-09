import Stripe from 'stripe';
import { env } from './env.js';

const stripeClient = env.STRIPE_SECRET_KEY ? new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' }) : null;

export { stripeClient };
export const STRIPE_PRICE_ID = env.STRIPE_PRICE_ID;
export const STRIPE_SUCCESS_URL = env.STRIPE_SUCCESS_URL;
export const STRIPE_CANCEL_URL = env.STRIPE_CANCEL_URL;
export const STRIPE_WEBHOOK_SECRET = env.STRIPE_WEBHOOK_SECRET;

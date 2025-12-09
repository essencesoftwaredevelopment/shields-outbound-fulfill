import express from 'express';
import cors from 'cors';
import fs from 'fs';
import { env } from './config/env.js';
import { admin, firestore } from './config/firebase.js';
import { stripeClient, STRIPE_PRICE_ID, STRIPE_SUCCESS_URL, STRIPE_CANCEL_URL, STRIPE_WEBHOOK_SECRET } from './config/stripe.js';
import { TMP_ROOT } from './config/paths.js';
import jobsRouter from './routes/jobs.js';
import clientsRouter from './routes/clients.js';


const PORT = env.PORT || 4000;
fs.mkdirSync(TMP_ROOT, { recursive: true });

const app = express();
app.use(cors());
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use('/api', jobsRouter);
app.use('/api', clientsRouter);

app.post('/api/stripe/checkout', async (req, res) => {
    try {
        if (!stripeClient) {
            return res.status(500).json({ error: 'Stripe secret key is not configured.' });
        }
        const { idToken, priceId: bodyPriceId, successUrl, cancelUrl } = req.body || {};
        if (!idToken) {
            return res.status(400).json({ error: 'Missing idToken.' });
        }
        const decoded = await admin.auth().verifyIdToken(idToken);
        const uid = decoded.uid;

        const priceId = bodyPriceId || STRIPE_PRICE_ID;
        if (!priceId) {
            return res.status(400).json({ error: 'priceId is required.' });
        }

        const session = await stripeClient.checkout.sessions.create({
            mode: 'subscription',
            payment_method_types: ['card'],
            line_items: [
                {
                    price: priceId,
                    quantity: 1,
                },
            ],
            success_url: successUrl || STRIPE_SUCCESS_URL,
            cancel_url: cancelUrl || STRIPE_CANCEL_URL,
            metadata: {
                uid,
            },
        });
        return res.json({ url: session.url });
    } catch (error) {
        console.error('Stripe checkout error:', error);
        return res.status(500).json({ error: 'Failed to create checkout session.' });
    }
});

app.post('/api/stripe/webhook', async (req, res) => {
    if (!stripeClient || !STRIPE_WEBHOOK_SECRET) {
        return res.status(500).json({ error: 'Stripe webhook is not configured.' });
    }
    const signature = req.headers['stripe-signature'];
    if (!signature) {
        return res.status(400).json({ error: 'Missing Stripe signature.' });
    }

    let event;
    try {
        event = stripeClient.webhooks.constructEvent(req.body, signature, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error('Stripe webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
        if (event.type === 'checkout.session.completed') {
            const session = event.data.object;
            const uid = session?.metadata?.uid;
            const customerId = session?.customer || null;
            const subscriptionId = session?.subscription || null;

            let priceId = null;
            let status = session?.payment_status || null;
            let currentPeriodEnd = null;

            if (subscriptionId) {
                try {
                    const sub = await stripeClient.subscriptions.retrieve(subscriptionId);
                    priceId = sub?.items?.data?.[0]?.price?.id || null;
                    status = sub?.status || status;
                    currentPeriodEnd = sub?.current_period_end ? new Date(sub.current_period_end * 1000) : null;
                } catch (subError) {
                    console.warn('Failed to retrieve subscription details:', subError?.message || subError);
                }
            }

            if (uid) {
                try {
                    const userRef = firestore.collection('users').doc(uid);
                    await userRef.set({
                        stripe: {
                            customerId,
                            subscriptionId,
                            priceId,
                            status,
                            currentPeriodEnd: currentPeriodEnd ? admin.firestore.Timestamp.fromDate(currentPeriodEnd) : null,
                            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                        },
                    }, { merge: true });
                } catch (writeError) {
                    console.error('Failed to persist Stripe details to user doc:', writeError);
                }
            }
        }
    } catch (handlerError) {
        console.error('Stripe webhook handler error:', handlerError);
        return res.status(500).json({ error: 'Failed to handle webhook.' });
    }

    return res.json({ received: true });
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});

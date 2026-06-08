/**
 * Shields Outbound Express API Server
 *
 * CANONICAL AGENCY IDENTIFIER RULE:
 * The Firestore users/{uid} document ID is the canonical agency identifier.
 * This same Firebase Auth uid is used directly as agency_id in all PostgreSQL tables.
 * No reconciliation or mapping is required.
 *
 * All endpoints that access PostgreSQL are protected by verifyFirebaseToken middleware,
 * which derives agency_id from the verified Firebase ID token.
 * See server/AGENCY_IDENTITY.md for complete architecture documentation.
 */

import express from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import { testConnection, pool } from './config/db.js';
import jobsRouter from './routes/jobs.js';
import agencyRouter from './routes/agency.js';
import clientsRouter from './routes/clients.js';
import leadsRouter from './routes/leads.js';
import webhooksRouter from './routes/webhooks.js';
import domainsRouter from './routes/domains.js';
import microserviceRouter from './routes/microservice.js';
import interestedAutoResponderRouter from './routes/interestedAutoResponder.js';
import calendlyWebhookRouter from './routes/calendlyWebhook.js';
import { requestJobsShutdown, cancelActiveJobsOnShutdown } from './services/jobPipeline.js';
import { terminateAllRunningRunners, SHUTDOWN_RUNNER_OPTS } from './services/jobRunner.js';

const app = express();
const PORT = env.PORT || 4000;
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Prevent 304 Not Modified on API JSON (empty body breaks client parsers).
app.set('etag', false);

// Middleware
app.use(cors());
app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    next();
});
// Calendly webhooks require raw body for signature verification — mount before express.json().
app.use('/webhooks/calendly', express.raw({ type: 'application/json', limit: '1mb' }), calendlyWebhookRouter);
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use((req, res, next) => {
    const start = Date.now();
    console.log(`📥 [${new Date().toISOString()}] ${req.method} ${req.path}`);

    res.on('finish', () => {
        const duration = Date.now() - start;
        console.log(`📤 [${new Date().toISOString()}] ${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
    });

    res.on('close', () => {
        if (!res.writableEnded) {
            console.log(`⚠️  [${new Date().toISOString()}] ${req.method} ${req.path} - Connection closed before response finished`);
        }
    });

    next();
});

app.use((req, res, next) => {
    if (!env.DB_WRITE_FREEZE) {
        return next();
    }
    if (!WRITE_METHODS.has(req.method)) {
        return next();
    }
    return res.status(503).json({
        error: 'Write operations are temporarily disabled for database maintenance.'
    });
});

app.use((err, req, res, next) => {
    console.error(`❌ [${new Date().toISOString()}] Error on ${req.method} ${req.path}:`, {
        code: err.code,
        message: err.message,
        stack: err.stack?.split('\n').slice(0, 5).join('\n')
    });

    if (err.code === 'ECONNRESET') {
        console.error('🔥 ECONNRESET ERROR DETECTED - Connection was reset');
    }

    res.status(500).json({ error: err.message || 'Internal server error' });
});

app.use('/api', jobsRouter);
app.use('/api', agencyRouter);
app.use('/api', clientsRouter);
app.use('/api', leadsRouter);
app.use('/api', domainsRouter);
app.use('/api', microserviceRouter);
app.use('/api', interestedAutoResponderRouter);
app.use('/webhook', webhooksRouter);

app.get('/health', (req, res) => {
    res.json({ status: 'ok', pipelineExecution: 'queue' });
});

const server = app.listen(PORT, async () => {
    if (env.DB_WRITE_FREEZE) {
        console.warn('⚠️  DB_WRITE_FREEZE=true: write endpoints are currently blocked');
    }
    console.log('Pipeline execution: queue-only (run shields-outbound-worker / npm run worker)');
    try {
        const ok = await testConnection();
        console.log(`Server running on port ${PORT} (db:${ok ? 'ok' : 'error'})`);
    } catch (err) {
        console.error('Database connectivity check failed:', err.message);
    }
});

server.on('error', (err) => {
    console.error('Failed to start API server:', err?.message || err);
    process.exit(1);
});

let shuttingDown = false;

async function exitSoon(code = 0) {
    try {
        await pool.end();
    } catch {
        /* noop */
    }
    setTimeout(() => process.exit(code), 100).unref();
}

async function gracefulShutdown(signal) {
    if (shuttingDown) {
        console.warn(`\n${signal} again — forcing exit`);
        try {
            await terminateAllRunningRunners({ cooperativeMs: 0, killDelayMs: 0 });
        } catch {
            /* noop */
        }
        await exitSoon(1);
        return;
    }
    shuttingDown = true;
    console.log(`\n${signal} received — stopping server and cancelling in-flight jobs…`);

    const flagged = requestJobsShutdown('Interrupted (server shutdown)');
    if (flagged) {
        console.log(`Flagged ${flagged} in-memory job(s) to stop`);
    }

    server.close?.();

    try {
        const cancelled = await cancelActiveJobsOnShutdown('Interrupted (server shutdown)');
        if (cancelled) {
            console.log(`Persisted cancel for ${cancelled} in-memory job(s)`);
        }
        await terminateAllRunningRunners(SHUTDOWN_RUNNER_OPTS);
    } catch (err) {
        console.error('Shutdown cancel error:', err?.message || err);
    }

    await exitSoon(0);
}

process.on('SIGINT', () => {
    void gracefulShutdown('SIGINT');
});

process.on('SIGTERM', () => {
    void gracefulShutdown('SIGTERM');
});

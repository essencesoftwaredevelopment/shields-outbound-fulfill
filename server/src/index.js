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
import { testConnection } from './config/db.js';
import jobsRouter from './routes/jobs.js';
import clientsRouter from './routes/clients.js';
import leadsRouter from './routes/leads.js';
import webhooksRouter from './routes/webhooks.js';
import domainsRouter from './routes/domains.js';
import microserviceRouter from './routes/microservice.js';
import { startEmbeddedQueueWorker } from './worker/embeddedWorker.js';

const app = express();
const PORT = env.PORT || 4000;
const JOB_EXECUTION_MODE = String(process.env.JOB_EXECUTION_MODE || 'inline').toLowerCase();
const queueExecutionEnabled = JOB_EXECUTION_MODE === 'queue';
let embeddedWorker = null;
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Increased limit for domain check with large CSVs
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Request logging middleware
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

// Optional write freeze for controlled DB cutovers.
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

// Error handling middleware
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

// Routes
// Note: Each router applies its own authentication middleware as needed.
// Routes requiring Firebase auth use verifyFirebaseToken middleware.
app.use('/api', jobsRouter);
app.use('/api', clientsRouter);
app.use('/api', leadsRouter);
app.use('/api', domainsRouter);
app.use('/api', microserviceRouter);
app.use('/webhook', webhooksRouter);

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

// Start server
const server = app.listen(PORT, async () => {
    embeddedWorker = startEmbeddedQueueWorker({
        enabled: process.env.DISABLE_EMBEDDED_QUEUE_WORKER !== 'true' && queueExecutionEnabled && !env.DB_WRITE_FREEZE
    });
    if (env.DB_WRITE_FREEZE) {
        console.warn('⚠️  DB_WRITE_FREEZE=true: write endpoints are currently blocked');
    }
    try {
        const ok = await testConnection();
        console.log(`Server running on port ${PORT} (db:${ok ? 'ok' : 'error'})`);
    } catch (err) {
        console.error('Database connectivity check failed:', err.message);
    }
});

server.on('error', (err) => {
    console.error('Failed to start API server:', err?.message || err);
    embeddedWorker?.stop();
    process.exit(1);
});

process.on('SIGINT', () => {
    embeddedWorker?.stop();
    server.close?.();
});

process.on('SIGTERM', () => {
    embeddedWorker?.stop();
    server.close?.();
});

/**
 * Shields Outbound Express API Server
 *
 * CANONICAL AGENCY IDENTIFIER RULE:
 * The Firestore users/{uid} document ID is the canonical agency identifier.
 * This same Firebase Auth uid is used directly as agency_id in all Cloud SQL tables.
 * No reconciliation or mapping is required.
 *
 * All endpoints that access Cloud SQL are protected by verifyFirebaseToken middleware,
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

const app = express();
const PORT = env.PORT || 4000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
app.use('/webhook', webhooksRouter);

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

// Start server
app.listen(PORT, async () => {
    try {
        const ok = await testConnection();
        console.log(`Server running on port ${PORT} (db:${ok ? 'ok' : 'error'})`);
    } catch (err) {
        console.error('Database connectivity check failed:', err.message);
    }
});

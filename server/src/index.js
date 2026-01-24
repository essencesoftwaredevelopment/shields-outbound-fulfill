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

// Routes
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

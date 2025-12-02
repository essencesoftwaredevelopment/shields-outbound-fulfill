import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { runFounderFinder } from './services/founderFinder.js';
import { runEmailFinder } from './services/emailFinder.js';
import { runEmailVerifier } from './services/emailVerifier.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 4000;
const TMP_ROOT = path.join(__dirname, '..', '..', 'tmp', 'jobs');
fs.mkdirSync(TMP_ROOT, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

const jobs = new Map();

const initialStageState = () => ({
    status: 'pending',
    startedAt: null,
    completedAt: null,
    summary: null,
    error: null,
    progress: null
});

function broadcast(job, payload) {
    job.streams.forEach(stream => {
        try {
            stream.write(`data: ${JSON.stringify(payload)}\n\n`);
        } catch (err) {
            console.error('SSE stream error', err);
        }
    });
}

function pushState(job) {
    const state = {
        id: job.id,
        status: job.status,
        stages: job.stages,
        error: job.error,
        createdAt: job.createdAt,
        completedAt: job.completedAt
    };
    broadcast(job, { type: 'state', state });
}

function log(job, message = null, meta = {}) {
    if (message) {
        const entry = { message, meta, timestamp: new Date().toISOString() };
        job.logs.push(entry);
        if (job.logs.length > 500) {
            job.logs.shift();
        }
        console.log(`[${job.id}] ${message}`);
        broadcast(job, { type: 'log', log: entry });
    }

    const progress = meta?.progress;
    if (progress?.stage && job.stages[progress.stage]) {
        const { stage, ...rest } = progress;
        job.stages[stage] = {
            ...job.stages[stage],
            progress: {
                ...(job.stages[stage].progress || {}),
                ...rest
            }
        };
        pushState(job);
    }
}

function updateStage(job, stageKey, updates) {
    job.stages[stageKey] = {
        ...job.stages[stageKey],
        ...updates
    };
    pushState(job);
}

function createJobRecord(fileBuffer, originalName) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const dir = path.join(TMP_ROOT, id);
    fs.mkdirSync(dir, { recursive: true });

    const inputPath = path.join(dir, 'domains.csv');
    fs.writeFileSync(inputPath, fileBuffer);

    const job = {
        id,
        status: 'queued',
        createdAt: new Date().toISOString(),
        completedAt: null,
        error: null,
        fileName: originalName,
        stages: {
            founders: initialStageState(),
            emailDiscovery: initialStageState(),
            verification: initialStageState()
        },
        logs: [],
        streams: [],
        paths: {
            dir,
            domains: inputPath,
            founders: path.join(dir, 'founders.csv'),
            emails: path.join(dir, 'emails.csv'),
            final: path.join(dir, 'final.csv')
        }
    };

    jobs.set(id, job);
    return job;
}

async function runStage(job, stageKey, handler) {
    updateStage(job, stageKey, { status: 'running', startedAt: new Date().toISOString(), error: null });
    try {
        const summary = await handler();
        updateStage(job, stageKey, { status: 'completed', completedAt: new Date().toISOString(), summary });
        return summary;
    } catch (err) {
        const message = err?.message || 'Unknown error';
        updateStage(job, stageKey, { status: 'error', completedAt: new Date().toISOString(), error: message });
        throw err;
    }
}

async function processJob(job) {
    job.status = 'running';
    pushState(job);
    log(job, 'Job started.');

    try {
        await runStage(job, 'founders', () =>
            runFounderFinder({
                inputCsv: job.paths.domains,
                outputCsv: job.paths.founders,
                log: (message, meta) => log(job, message, meta)
            })
        );

        await runStage(job, 'emailDiscovery', () =>
            runEmailFinder({
                inputCsv: job.paths.founders,
                outputCsv: job.paths.emails,
                log: (message, meta) => log(job, message, meta)
            })
        );

        await runStage(job, 'verification', () =>
            runEmailVerifier({
                inputCsv: job.paths.emails,
                outputCsv: job.paths.final,
                log: (message, meta) => log(job, message, meta)
            })
        );

        job.status = 'completed';
        job.completedAt = new Date().toISOString();
        pushState(job);
        log(job, `Job completed. Final CSV ready at ${job.paths.final}`);
    } catch (err) {
        job.status = 'error';
        job.error = err?.message || 'Unexpected pipeline error';
        pushState(job);
        log(job, `Job failed: ${job.error}`);
    }
}

function serializeJob(job) {
    return {
        id: job.id,
        status: job.status,
        error: job.error,
        fileName: job.fileName,
        createdAt: job.createdAt,
        completedAt: job.completedAt,
        stages: job.stages
    };
}

app.post('/api/jobs', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Missing CSV file upload.' });
    }

    const job = createJobRecord(req.file.buffer, req.file.originalname);
    log(job, `Job queued with file ${job.fileName}`);
    processJob(job);
    res.status(201).json({ jobId: job.id, job: serializeJob(job) });
});

app.get('/api/jobs/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }
    res.json({ job: serializeJob(job) });
});

app.get('/api/jobs/:id/result', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }
    if (job.status !== 'completed') {
        return res.status(409).json({ error: 'Job not completed yet' });
    }
    if (!fs.existsSync(job.paths.final)) {
        return res.status(404).json({ error: 'Result file missing' });
    }
    res.download(job.paths.final, `results-${job.id}.csv`);
});

app.get('/api/jobs/:id/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const job = jobs.get(req.params.id);
    if (!job) {
        res.write(`data: ${JSON.stringify({ type: 'error', error: 'Job not found' })}\n\n`);
        return res.end();
    }

    job.logs.forEach(entry => {
        res.write(`data: ${JSON.stringify({ type: 'log', log: entry })}\n\n`);
    });
    res.write(`data: ${JSON.stringify({ type: 'state', state: serializeJob(job) })}\n\n`);

    job.streams.push(res);

    const keepAlive = setInterval(() => {
        res.write(': keep-alive\n\n');
    }, 25000);

    req.on('close', () => {
        clearInterval(keepAlive);
        job.streams = job.streams.filter(stream => stream !== res);
        res.end();
    });
});

app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});

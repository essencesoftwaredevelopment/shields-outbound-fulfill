import express from 'express';
import { runSmallTask } from '../scripts/runSmallTask.js';

const router = express.Router();

router.post('/micro/run-script', async (req, res) => {
    const startedAt = Date.now();

    try {
        const payload = req.body || {};
        const result = await runSmallTask(payload);

        return res.status(200).json({
            ok: true,
            source: 'api-local-script',
            latencyMs: Date.now() - startedAt,
            result
        });
    } catch (error) {
        return res.status(500).json({
            ok: false,
            source: 'api-local-script',
            latencyMs: Date.now() - startedAt,
            error: `Script execution failed: ${error.message}`
        });
    }
});

router.get('/micro/run-script', async (req, res) => {
    try {
        const result = await runSmallTask({ dryRun: true });
        return res.status(200).json({ ok: true, source: 'api-local-script', result });
    } catch (error) {
        return res.status(500).json({ ok: false, error: `Script execution failed: ${error.message}` });
    }
});

export default router;
import express from 'express';
import { pool } from '../config/db.js';
import { verifyFirebaseToken as requireAuth } from '../middleware/auth.js';
import {
    getInterestedAutoResponderDraftByToken,
    sendInterestedAutoResponderDraftByToken,
    updateInterestedAutoResponderDraftTextByToken
} from '../services/interestedAutoResponder.js';

const router = express.Router();

function setNoStoreHeaders(res) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
}

async function resolveClientRow(agencyId, clientSlug) {
    const result = await pool.query(
        `SELECT id, name
         FROM clients
         WHERE agency_id = $1
           AND name = $2
         LIMIT 1`,
        [agencyId, clientSlug]
    );
    return result.rows[0] || null;
}

async function resolveCampaignRow(clientId, campaignId) {
    const result = await pool.query(
        `SELECT id, name
         FROM instantly_campaigns
         WHERE id = $1
           AND client_id = $2
         LIMIT 1`,
        [campaignId, clientId]
    );
    return result.rows[0] || null;
}

router.get('/clients/:clientId/interested-autoresponder/prompts', requireAuth, async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const clientRow = await resolveClientRow(req.agencyId, req.params.clientId);
        if (!clientRow) return res.status(404).json({ error: 'Client not found.' });

        const result = await pool.query(
            `SELECT p.id, p.agency_id, p.client_id, p.campaign_id, p.version, p.system_prompt,
                    p.active, p.created_at, p.updated_at, ic.name AS campaign_name
             FROM interested_autoresponder_prompts p
             JOIN instantly_campaigns ic ON ic.id = p.campaign_id
             WHERE p.client_id = $1
             ORDER BY p.active DESC, ic.name ASC, p.created_at DESC`,
            [clientRow.id]
        );
        res.json({ prompts: result.rows });
    } catch (error) {
        console.error('GET interested autoresponder prompts error:', error);
        res.status(500).json({ error: 'Failed to fetch prompts.' });
    }
});

router.post('/clients/:clientId/interested-autoresponder/prompts', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
        setNoStoreHeaders(res);
        const clientRow = await resolveClientRow(req.agencyId, req.params.clientId);
        if (!clientRow) return res.status(404).json({ error: 'Client not found.' });

        const campaignId = Number.parseInt(String(req.body?.campaignId || ''), 10);
        const version = String(req.body?.version || '').trim();
        const systemPrompt = String(req.body?.systemPrompt || '').trim();
        const active = req.body?.active !== false;

        if (!Number.isInteger(campaignId) || campaignId <= 0) {
            return res.status(400).json({ error: 'Valid campaignId is required.' });
        }
        if (!version) {
            return res.status(400).json({ error: 'Version is required.' });
        }
        if (!systemPrompt) {
            return res.status(400).json({ error: 'System prompt is required.' });
        }

        const campaignRow = await resolveCampaignRow(clientRow.id, campaignId);
        if (!campaignRow) {
            return res.status(404).json({ error: 'Campaign not found for client.' });
        }

        await client.query('BEGIN');
        if (active) {
            await client.query(
                `UPDATE interested_autoresponder_prompts
                 SET active = FALSE,
                     updated_at = NOW()
                 WHERE campaign_id = $1
                   AND active = TRUE`,
                [campaignId]
            );
        }
        const result = await client.query(
            `INSERT INTO interested_autoresponder_prompts (
                agency_id, client_id, campaign_id, version, system_prompt, active
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *`,
            [req.agencyId, clientRow.id, campaignId, version, systemPrompt, active]
        );
        await client.query('COMMIT');
        res.status(201).json({
            prompt: {
                ...result.rows[0],
                campaign_name: campaignRow.name
            }
        });
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('POST interested autoresponder prompt error:', error);
        res.status(500).json({ error: 'Failed to create prompt.' });
    } finally {
        client.release();
    }
});

router.put('/clients/:clientId/interested-autoresponder/prompts/:promptId', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
        setNoStoreHeaders(res);
        const clientRow = await resolveClientRow(req.agencyId, req.params.clientId);
        if (!clientRow) return res.status(404).json({ error: 'Client not found.' });

        const promptId = Number.parseInt(req.params.promptId, 10);
        const campaignId = Number.parseInt(String(req.body?.campaignId || ''), 10);
        const version = String(req.body?.version || '').trim();
        const systemPrompt = String(req.body?.systemPrompt || '').trim();
        const active = req.body?.active !== false;

        if (!Number.isInteger(promptId) || promptId <= 0) {
            return res.status(400).json({ error: 'Valid prompt id is required.' });
        }
        if (!Number.isInteger(campaignId) || campaignId <= 0) {
            return res.status(400).json({ error: 'Valid campaignId is required.' });
        }
        if (!version) {
            return res.status(400).json({ error: 'Version is required.' });
        }
        if (!systemPrompt) {
            return res.status(400).json({ error: 'System prompt is required.' });
        }

        const campaignRow = await resolveCampaignRow(clientRow.id, campaignId);
        if (!campaignRow) {
            return res.status(404).json({ error: 'Campaign not found for client.' });
        }

        await client.query('BEGIN');
        if (active) {
            await client.query(
                `UPDATE interested_autoresponder_prompts
                 SET active = FALSE,
                     updated_at = NOW()
                 WHERE campaign_id = $1
                   AND id <> $2
                   AND active = TRUE`,
                [campaignId, promptId]
            );
        }
        const result = await client.query(
            `UPDATE interested_autoresponder_prompts
             SET campaign_id = $2,
                 version = $3,
                 system_prompt = $4,
                 active = $5,
                 updated_at = NOW()
             WHERE id = $1
               AND client_id = $6
             RETURNING *`,
            [promptId, campaignId, version, systemPrompt, active, clientRow.id]
        );
        if (!result.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Prompt not found.' });
        }
        await client.query('COMMIT');
        res.json({
            prompt: {
                ...result.rows[0],
                campaign_name: campaignRow.name
            }
        });
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('PUT interested autoresponder prompt error:', error);
        res.status(500).json({ error: 'Failed to update prompt.' });
    } finally {
        client.release();
    }
});

router.delete('/clients/:clientId/interested-autoresponder/prompts/:promptId', requireAuth, async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const clientRow = await resolveClientRow(req.agencyId, req.params.clientId);
        if (!clientRow) return res.status(404).json({ error: 'Client not found.' });

        const promptId = Number.parseInt(req.params.promptId, 10);
        if (!Number.isInteger(promptId) || promptId <= 0) {
            return res.status(400).json({ error: 'Valid prompt id is required.' });
        }

        const result = await pool.query(
            `DELETE FROM interested_autoresponder_prompts
             WHERE id = $1
               AND client_id = $2
             RETURNING id`,
            [promptId, clientRow.id]
        );
        if (!result.rows.length) {
            return res.status(404).json({ error: 'Prompt not found.' });
        }
        res.json({ deleted: true, id: result.rows[0].id });
    } catch (error) {
        console.error('DELETE interested autoresponder prompt error:', error);
        res.status(500).json({ error: 'Failed to delete prompt.' });
    }
});

router.get('/interested-autoresponder/review/:token', async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const draft = await getInterestedAutoResponderDraftByToken(String(req.params.token || ''));
        res.json({ draft });
    } catch (error) {
        const statusCode = Number(error?.statusCode || 500);
        res.status(statusCode).json({ error: error?.message || 'Failed to fetch review draft.' });
    }
});

router.patch('/interested-autoresponder/review/:token', async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const draft = await updateInterestedAutoResponderDraftTextByToken({
            token: String(req.params.token || ''),
            renderedText: req.body?.renderedText
        });
        res.json({ draft });
    } catch (error) {
        const statusCode = Number(error?.statusCode || 500);
        res.status(statusCode).json({ error: error?.message || 'Failed to update review draft.' });
    }
});

router.post('/interested-autoresponder/review/:token/send', async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const result = await sendInterestedAutoResponderDraftByToken({
            token: String(req.params.token || '')
        });
        res.json(result);
    } catch (error) {
        const statusCode = Number(error?.statusCode || 500);
        res.status(statusCode).json({ error: error?.message || 'Failed to send review draft.' });
    }
});

export default router;

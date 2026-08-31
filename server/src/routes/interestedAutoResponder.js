import crypto from 'crypto';
import express from 'express';
import { pool } from '../config/db.js';
import { verifyFirebaseToken as requireAuth } from '../middleware/auth.js';
import { resolveClientRow } from '../services/db/queries.js';
import {
    generateAuditPreviewUrl,
    fetchAgencyAndClientSettings,
    generateDraftReply,
    getInterestedAutoResponderDraftByToken,
    sendInterestedAutoResponderDraftByToken,
    updateInterestedAutoResponderDraftTextByToken,
    cancelInterestedAutoResponderDraftByToken,
    regenerateInterestedAutoResponderDraftByToken,
    cancelStalePendingReviewDraftsForClient,
    applyActiveFungiStoryUrlToTemplateVars,
    INTERESTED_PENDING_REVIEW_LAST_EVENT_TYPES,
    resolveReplyPreviewBehavior,
    withAuditUrlVars
} from '../services/interestedAutoResponder.js';
import { resolveTemplateVars, renderTemplate } from '../services/followUpSender.js';

const router = express.Router();

function setNoStoreHeaders(res) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
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

router.post('/clients/:clientId/interested-autoresponder/prompts/:promptId/test', requireAuth, async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const clientRow = await resolveClientRow(req.agencyId, req.params.clientId);
        if (!clientRow) return res.status(404).json({ error: 'Client not found.' });

        const promptId = Number.parseInt(req.params.promptId, 10);
        if (!Number.isInteger(promptId) || promptId <= 0) {
            return res.status(400).json({ error: 'Valid prompt id is required.' });
        }

        const contactId = Number.parseInt(String(req.body?.contactId || ''), 10);
        if (!Number.isInteger(contactId) || contactId <= 0) {
            return res.status(400).json({ error: 'Valid contactId is required.' });
        }

        const testMessage = String(req.body?.testMessage || '').trim() || null;

        const [promptResult, contactResult] = await Promise.all([
            pool.query(
                `SELECT p.id, p.campaign_id, p.system_prompt, p.version, ic.name AS campaign_name
                 FROM interested_autoresponder_prompts p
                 JOIN instantly_campaigns ic ON ic.id = p.campaign_id
                 WHERE p.id = $1 AND p.client_id = $2
                 LIMIT 1`,
                [promptId, clientRow.id]
            ),
            pool.query(
                `SELECT c.id, c.email, co.domain_normalized AS company_domain
                 FROM contacts c
                 LEFT JOIN companies co ON co.id = c.company_id
                 WHERE c.id = $1 AND c.client_id = $2
                 LIMIT 1`,
                [contactId, clientRow.id]
            )
        ]);
        const prompt = promptResult.rows[0];
        if (!prompt) return res.status(404).json({ error: 'Prompt not found.' });
        const contact = contactResult.rows[0];
        if (!contact) return res.status(404).json({ error: 'Contact not found.' });

        // Fetch thread context in parallel; template vars resolved after we know the eaccount
        const settingsPromise = fetchAgencyAndClientSettings(req.agencyId, req.params.clientId);
        const [settings, threadResult, auditPreviewUrl] = await Promise.all([
            settingsPromise,
            pool.query(
                `SELECT
                    COALESCE(
                        NULLIF(BTRIM(e.payload->>'subject'), ''),
                        NULLIF(BTRIM(e.payload->>'email_subject'), ''),
                        NULLIF(BTRIM(e.payload->>'thread_subject'), ''),
                        NULLIF(BTRIM(e.payload->>'reply_subject'), '')
                    ) AS thread_subject,
                    e.email_account,
                    e.message_text,
                    e.reply_text_snippet
                 FROM contact_instantly_events e
                 WHERE e.contact_id = $1
                   AND e.campaign_id = $2
                   AND (e.message_text IS NOT NULL OR e.reply_text_snippet IS NOT NULL)
                 ORDER BY e.event_timestamp DESC NULLS LAST, e.created_at DESC NULLS LAST
                 LIMIT 5`,
                [contactId, prompt.campaign_id]
            ),
            settingsPromise.then((loadedSettings) => {
                const preview = resolveReplyPreviewBehavior({
                    settings: loadedSettings,
                    campaignName: prompt.campaign_name,
                    systemPrompt: prompt.system_prompt
                });
                return generateAuditPreviewUrl(contact.email, {
                    domain: contact.company_domain || null,
                    useVulcanShoppingAudit: preview.useShoppingAuditReply,
                    skipPopupPreview: preview.skipPopupPreview
                });
            })
        ]);
        const { openaiKey, ntfyTopic, useActiveFungiStoryUrl } = settings;
        const preview = resolveReplyPreviewBehavior({
            settings,
            campaignName: prompt.campaign_name,
            systemPrompt: prompt.system_prompt
        });

        // Derive eaccount from most recent thread event that has one
        const previewEaccount = threadResult.rows.find(r => r.email_account)?.email_account || null;
        let templateVars = await resolveTemplateVars(pool, contactId, prompt.campaign_id, {
            clientId: clientRow.id,
            emailAccount: previewEaccount
        });
        if (useActiveFungiStoryUrl) {
            templateVars = applyActiveFungiStoryUrlToTemplateVars(templateVars, {
                domain: contact.company_domain || null
            });
        } else {
            templateVars = withAuditUrlVars(templateVars, auditPreviewUrl);
        }

        if (!openaiKey) {
            return res.status(400).json({ error: 'No OpenAI API key configured for this agency.' });
        }

        // Build full thread context from recent events (newest first → reverse for chronological)
        const threadEvents = threadResult.rows.slice().reverse();
        const threadSubject = threadEvents.find(r => r.thread_subject)?.thread_subject || null;
        const threadText = threadEvents
            .map(r => (r.message_text || r.reply_text_snippet || '').trim())
            .filter(Boolean)
            .join('\n\n---\n\n');
        const previousLeadMessage = testMessage || threadText || null;

        // Substitute template variables in the system prompt
        const renderedSystemPrompt = renderTemplate(prompt.system_prompt, templateVars);

        const { renderedText, model } = await generateDraftReply({
            openaiKey,
            systemPrompt: renderedSystemPrompt,
            campaignName: prompt.campaign_name,
            leadEmail: contact.email,
            threadSubject,
            previousLeadMessage,
            auditPreviewUrl: useActiveFungiStoryUrl ? null : auditPreviewUrl,
            systemPromptOwnsCta: preview.systemPromptOwnsCta
        });

        // Create a real pending_review draft so we can send a clickable review link
        const reviewToken = crypto.randomBytes(32).toString('hex');
        const reviewTokenExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        await pool.query(
            `INSERT INTO interested_autoresponder_drafts (
                agency_id, client_id, campaign_id, contact_id, instantly_lead_id, source_event_id,
                review_token, review_token_expires_at, status, blocked_reason,
                reply_to_uuid, eaccount, thread_subject, lead_email, previous_lead_message,
                system_prompt_version, model, rendered_text
            ) VALUES (
                $1, $2, $3, $4, NULL, NULL,
                $5, $6, 'pending_review', NULL,
                NULL, NULL, $7, $8, $9,
                $10, $11, $12
            )`,
            [
                req.agencyId, clientRow.id, prompt.campaign_id, contactId,
                reviewToken, reviewTokenExpiresAt,
                threadSubject, contact.email, previousLeadMessage,
                prompt.version, model, renderedText
            ]
        );

        const appBaseUrl = String(
            process.env.NEXT_PUBLIC_APP_URL || process.env.APP_BASE_URL || process.env.PUBLIC_APP_URL || 'https://shields-outbound-fulfill.vercel.app'
        ).trim().replace(/\/$/, '');
        const reviewUrl = `${appBaseUrl}/interested-autoresponder/${encodeURIComponent(reviewToken)}`;

        res.json({
            renderedText,
            model,
            promptVersion: prompt.version,
            reviewUrl,
            previewUrl: useActiveFungiStoryUrl
                ? (templateVars.story_url || null)
                : (auditPreviewUrl || null),
            debug: {
                lead: {
                    email: contact.email,
                    name: templateVars.full_name || null,
                    firstName: templateVars.first_name || null,
                    companyDomain: templateVars.company_domain || null,
                    roleType: templateVars.role_type || null,
                },
                sender: {
                    eaccount: previewEaccount || null,
                    firstName: templateVars.email_account_first_name || null,
                    lastName: templateVars.email_account_last_name || null,
                },
                threadSubject: threadSubject || null,
                storyUrl: templateVars.story_url || null,
                renderedSystemPrompt,
                contextSentToAI: {
                    campaignName: prompt.campaign_name,
                    leadEmail: contact.email,
                    threadSubject: threadSubject || null,
                    previousLeadMessage: previousLeadMessage || null,
                },
            }
        });

        // Fire ntfy notification (non-blocking)
        if (ntfyTopic) {
            console.log('[test] ntfy topic:', ntfyTopic, '→', `https://ntfy.sh/${ntfyTopic}`);
            fetch(`https://ntfy.sh/${ntfyTopic}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Title': `[TEST] Auto-responder draft: ${contact.email}`,
                    'Tags': 'test_tube,robot_face',
                    'Click': reviewUrl
                },
                body: [
                    `Lead: ${contact.email}`,
                    `Campaign: ${prompt.campaign_name || 'Unknown'}`,
                    `Model: ${model}`,
                    `Review: ${reviewUrl}`,
                    '',
                    renderedText
                ].join('\n')
            }).catch(err => console.error('[test] ntfy notification failed:', err));
        } else {
            console.warn('[test] No ntfyTopic configured — skipping notification');
        }
    } catch (error) {
        console.error('POST interested autoresponder prompt test error:', error);
        res.status(500).json({ error: 'Failed to generate test reply.' });
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

router.post('/interested-autoresponder/review/:token/regenerate', async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const result = await regenerateInterestedAutoResponderDraftByToken({
            token: String(req.params.token || ''),
            additionalInstructions: req.body?.additionalInstructions
        });
        res.json(result);
    } catch (error) {
        const statusCode = Number(error?.statusCode || 500);
        console.error('POST interested autoresponder regenerate error:', error);
        res.status(statusCode).json({ error: error?.message || 'Failed to regenerate review draft.' });
    }
});

router.delete('/interested-autoresponder/review/:token', async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const result = await cancelInterestedAutoResponderDraftByToken({
            token: String(req.params.token || '')
        });
        res.json(result);
    } catch (error) {
        const statusCode = Number(error?.statusCode || 500);
        res.status(statusCode).json({ error: error?.message || 'Failed to archive review draft.' });
    }
});

router.get('/clients/:clientId/interested-autoresponder/drafts/pending-review', requireAuth, async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const clientRow = await resolveClientRow(req.agencyId, req.params.clientId);
        if (!clientRow) return res.status(404).json({ error: 'Client not found.' });

        await cancelStalePendingReviewDraftsForClient(pool, clientRow.id);

        const result = await pool.query(
            `SELECT d.id, d.lead_email, d.eaccount, d.thread_subject, d.rendered_text,
                    d.review_token, d.created_at, d.updated_at,
                    ic.name AS campaign_name,
                    cic.interest_status,
                    cic.interest_status_label,
                    cic.last_event_type
             FROM interested_autoresponder_drafts d
             LEFT JOIN instantly_campaigns ic ON ic.id = d.campaign_id
             INNER JOIN contact_instantly_campaigns cic
                 ON cic.contact_id = d.contact_id
                 AND cic.campaign_id = d.campaign_id
                 AND cic.active = TRUE
             WHERE d.client_id = $1
               AND d.status = 'pending_review'
               AND cic.interest_status = 1
               AND (
                   COALESCE(cic.last_event_type, '') = ''
                   OR LOWER(cic.last_event_type) = ANY($2::text[])
               )
             ORDER BY d.created_at DESC
             LIMIT 50`,
            [clientRow.id, INTERESTED_PENDING_REVIEW_LAST_EVENT_TYPES]
        );
        res.json({ drafts: result.rows });
    } catch (error) {
        console.error('GET pending-review drafts error:', error);
        res.status(500).json({ error: 'Failed to fetch pending review drafts.' });
    }
});

export default router;

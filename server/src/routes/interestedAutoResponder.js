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
    createInterestedAutoResponderDraftFromEvent,
    fetchPromptConfig,
    retryFailedInterestedAutoResponderDraft,
    dismissFailedInterestedAutoResponderDraft,
    classifyDraftFailure,
    applyActiveFungiStoryUrlToTemplateVars,
    FAILED_DRAFT_STATUSES,
    INTERESTED_PENDING_REVIEW_LAST_EVENT_TYPES,
    resolveReplyPreviewBehavior,
    withAuditUrlVars
} from '../services/interestedAutoResponder.js';
import { resolveTemplateVars, renderTemplate } from '../services/followUpSender.js';
import { resolveLeadCampaignMembership, resolveLeadReplyThread } from '../services/leadManualReply.js';

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
                if (preview.skipPopupPreview) return null;
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

        const { renderedText, model, previewUrl: generatedPreviewUrl } = await generateDraftReply({
            openaiKey,
            systemPrompt: renderedSystemPrompt,
            campaignName: prompt.campaign_name,
            leadEmail: contact.email,
            threadSubject,
            previousLeadMessage,
            auditPreviewUrl: useActiveFungiStoryUrl ? null : auditPreviewUrl,
            systemPromptOwnsCta: preview.systemPromptOwnsCta,
            essenceStorePreviewTool: preview.canGenerateEssenceStorePreview,
            previewDomain: contact.company_domain || null
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
                : (generatedPreviewUrl || auditPreviewUrl || null),
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
                    d.review_token, d.status, d.research_step, d.created_at, d.updated_at,
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
               AND d.status IN ('pending_review', 'researching')
               AND cic.interest_status = 1
               AND (
                   COALESCE(cic.last_event_type, '') = ''
                   OR LOWER(cic.last_event_type) = ANY($2::text[])
               )
             ORDER BY d.created_at DESC
             LIMIT 50`,
            [clientRow.id, INTERESTED_PENDING_REVIEW_LAST_EVENT_TYPES]
        );

        // Failed drafts have no review link and nothing retries them — surface the
        // latest non-cancelled draft per thread while the lead is still interested.
        const failedResult = await pool.query(
            `SELECT d.id, d.lead_email, d.eaccount, d.thread_subject, d.status, d.blocked_reason,
                    d.created_at, d.updated_at,
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
               AND d.status = ANY($3::text[])
               AND d.created_at > NOW() - INTERVAL '14 days'
               AND cic.interest_status = 1
               AND (
                   COALESCE(cic.last_event_type, '') = ''
                   OR LOWER(cic.last_event_type) = ANY($2::text[])
               )
               AND NOT EXISTS (
                   SELECT 1
                   FROM interested_autoresponder_drafts later
                   WHERE later.contact_id = d.contact_id
                     AND later.campaign_id = d.campaign_id
                     AND later.id > d.id
                     AND later.status <> 'cancelled'
               )
             ORDER BY d.created_at DESC
             LIMIT 50`,
            [clientRow.id, INTERESTED_PENDING_REVIEW_LAST_EVENT_TYPES, FAILED_DRAFT_STATUSES]
        );

        const failedDrafts = failedResult.rows.map((row) => ({
            ...row,
            failure: classifyDraftFailure({ status: row.status, reason: row.blocked_reason })
        }));

        res.json({ drafts: result.rows, failedDrafts });
    } catch (error) {
        console.error('GET pending-review drafts error:', error);
        res.status(500).json({ error: 'Failed to fetch pending review drafts.' });
    }
});

router.post('/clients/:clientId/interested-autoresponder/drafts/:draftId/retry', requireAuth, async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const clientRow = await resolveClientRow(req.agencyId, req.params.clientId);
        if (!clientRow) return res.status(404).json({ error: 'Client not found.' });

        const draftId = Number(req.params.draftId);
        if (!Number.isInteger(draftId) || draftId <= 0) {
            return res.status(400).json({ error: 'Invalid draft id.' });
        }

        const result = await retryFailedInterestedAutoResponderDraft({
            agencyId: req.agencyId,
            clientRow,
            draftId,
            logger: (message) => console.log(message)
        });
        res.json(result);
    } catch (error) {
        const statusCode = Number(error?.statusCode) || 500;
        console.error('POST retry failed draft error:', error);
        res.status(statusCode).json({ error: error?.message || 'Failed to retry draft.' });
    }
});

router.post('/clients/:clientId/interested-autoresponder/drafts/:draftId/dismiss', requireAuth, async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const clientRow = await resolveClientRow(req.agencyId, req.params.clientId);
        if (!clientRow) return res.status(404).json({ error: 'Client not found.' });

        const draftId = Number(req.params.draftId);
        if (!Number.isInteger(draftId) || draftId <= 0) {
            return res.status(400).json({ error: 'Invalid draft id.' });
        }

        const result = await dismissFailedInterestedAutoResponderDraft({
            agencyId: req.agencyId,
            clientRow,
            draftId
        });
        res.json(result);
    } catch (error) {
        const statusCode = Number(error?.statusCode) || 500;
        console.error('POST dismiss failed draft error:', error);
        res.status(statusCode).json({ error: error?.message || 'Failed to dismiss draft.' });
    }
});

/**
 * Pick the thread message a forced draft should answer. Prefers the lead's own
 * inbound message (that is what the prompt replies to), then whatever carries
 * text, then recency. Rows we sent ourselves are excluded so a forced draft
 * never anchors on an earlier autoresponder/follow-up reply.
 */
async function pickThreadSourceEvent(contactId, campaignId) {
    const result = await pool.query(
        `SELECT id, lead_email, event_type, reply_to_uuid, email_account
         FROM contact_instantly_events
         WHERE contact_id = $1
           AND campaign_id = $2
           AND COALESCE(source, '') NOT IN ('server_follow_up', 'interested_autoresponder', 'manual')
           AND event_type NOT IN ('interested_reply_sent', 'manual_reply_sent')
         ORDER BY
            (event_type IN ('reply_received', 'lead_interested')) DESC,
            (message_text IS NOT NULL OR reply_text_snippet IS NOT NULL) DESC,
            event_timestamp DESC NULLS LAST,
            created_at DESC NULLS LAST
         LIMIT 1`,
        [contactId, campaignId]
    );
    return result.rows[0] || null;
}

/**
 * Why a create call came back without a draft, in words a user can act on.
 * 4xx where the fix is in our own config, 502 where an upstream call failed.
 */
const FORCE_DRAFT_FAILURES = {
    missing_required_context: [400, 'Not enough thread context to draft a reply.'],
    missing_active_prompt: [400, 'No active autoresponder prompt for this campaign.'],
    missing_openai_key: [400, 'No OpenAI API key configured for this agency.'],
    blocked_missing_thread: [502, 'Instantly has not synced the reply-to id / sending mailbox for this thread yet.'],
    generation_failed: [502, 'The model could not generate a reply — see the failed drafts list for details.']
};

/**
 * POST /clients/:clientId/interested-autoresponder/leads/:contactId/generate
 *
 * Force an autoresponder draft for a lead from the lead modal, built from the
 * lead's existing Instantly thread. The webhook path only drafts for leads
 * Instantly flagged interested; this one skips that gate so a draft can be
 * produced on demand (missed webhook, lead replied outside the interested
 * flow, prompt changed since the original draft). Any open draft on the same
 * thread is superseded by the create call, so pressing this twice does not
 * leave two drafts behind.
 *
 * Body: { campaignId? } — the Instantly campaign id, required when the lead
 * sits in more than one campaign.
 */
router.post('/clients/:clientId/interested-autoresponder/leads/:contactId/generate', requireAuth, async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const clientRow = await resolveClientRow(req.agencyId, req.params.clientId);
        if (!clientRow) return res.status(404).json({ error: 'Client not found.' });

        const contactId = Number.parseInt(req.params.contactId, 10);
        if (!Number.isInteger(contactId) || contactId <= 0) {
            return res.status(400).json({ error: 'Valid contactId is required.' });
        }
        const instantlyCampaignId = String(req.body?.campaignId || '').trim() || null;

        const membership = await resolveLeadCampaignMembership({
            agencyId: req.agencyId,
            clientId: clientRow.id,
            contactId,
            instantlyCampaignId
        });

        // Fail before drafting rather than writing a missing_active_prompt row.
        const promptConfig = await fetchPromptConfig(pool, clientRow.id, membership.campaign_id);
        if (!promptConfig) {
            return res.status(400).json({
                error: `No active autoresponder prompt for campaign “${membership.campaign_name}”.`,
                reason: 'missing_active_prompt'
            });
        }

        const sourceEvent = await pickThreadSourceEvent(contactId, membership.campaign_id);
        if (!sourceEvent) {
            return res.status(400).json({
                error: 'No Instantly thread activity stored for this lead yet — nothing to draft from.',
                reason: 'no_thread_events'
            });
        }

        // Our events may carry no usable reply anchor (webhook missed, lead
        // replied before the sync). Look it up live and write it back onto the
        // source event, otherwise the draft lands as blocked_missing_thread.
        const thread = await resolveLeadReplyThread({
            contactId,
            campaignId: membership.campaign_id,
            instantlyCampaignId: membership.instantly_campaign_id,
            leadEmail: membership.lead_email,
            apiKey: String(clientRow.instantly_key || '').trim()
        });
        if (!thread) {
            return res.status(400).json({
                error: 'No Instantly thread for this lead yet — nothing to reply to.',
                reason: 'no_thread'
            });
        }
        if (thread.anchor_source === 'instantly') {
            await pool.query(
                `UPDATE contact_instantly_events
                 SET reply_to_uuid = COALESCE(reply_to_uuid, $2),
                     email_account = COALESCE(email_account, $3)
                 WHERE id = $1`,
                [sourceEvent.id, thread.reply_to_uuid, thread.eaccount]
            );
        }

        const result = await createInterestedAutoResponderDraftFromEvent({
            agencyId: req.agencyId,
            clientSlug: clientRow.slug,
            clientId: clientRow.id,
            campaignId: membership.campaign_id,
            contactId,
            instantlyLeadId: membership.instantly_lead_id,
            sourceEventId: sourceEvent.id,
            leadEmail: membership.lead_email,
            logger: (message) => console.log(message)
        });

        if (!result.created) {
            const [status, message] = FORCE_DRAFT_FAILURES[result.reason] || [502, 'Failed to generate a draft.'];
            return res.status(status).json({
                error: message,
                reason: result.reason || 'unknown',
                draftId: result.draftId || null
            });
        }

        res.json({
            created: true,
            researching: Boolean(result.researching),
            draftId: result.draftId,
            reviewUrl: result.reviewUrl || null,
            campaignId: membership.instantly_campaign_id,
            campaignName: membership.campaign_name
        });
    } catch (error) {
        const statusCode = Number(error?.statusCode) || 500;
        console.error('POST force generate autoresponder draft error:', error);
        res.status(statusCode).json({
            error: error?.statusCode ? (error.message || 'Failed to generate a draft.') : 'Failed to generate a draft.'
        });
    }
});

export default router;

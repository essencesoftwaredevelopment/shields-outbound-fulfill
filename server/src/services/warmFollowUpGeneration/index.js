/**
 * Warm follow-up AI generation — step implementations for
 * `warmFollowUpWorkflow` (workflows/warm-follow-up.ts).
 *
 * Reuses an existing interested-reply research_brief when one exists.
 * Missing research never fails the run: generate-thin from prompt + step + thread.
 */
import OpenAI from 'openai';
import { pool } from '../../config/db.js';
import { fetchAgencyAndClientSettings } from '../interestedAutoResponder.js';
import {
    htmlToPlainText,
    renderTemplate,
    resolveTemplateVars,
    sanitizeHtml,
    sendRenderedFollowUp,
    fetchThreadReplyMetadata
} from '../followUpSender.js';
import {
    assembleFollowUpMessages,
    FOLLOW_UP_MAX_CHARS,
    formatFollowUpPlainText,
    formatOutboundThreadHistory,
    isFollowUpCopyTooLong,
    plainTextToFollowUpHtml,
    shouldUseAiFollowUpCopy
} from './prompt.js';
import { attachWorkflowRunId, stampGenerationStep } from './progress.js';

export { attachWorkflowRunId, stampGenerationStep, shouldUseAiFollowUpCopy };

const FOLLOW_UP_MODEL = String(process.env.FOLLOWUP_MODEL || 'gpt-5.6').trim() || 'gpt-5.6';
const FOLLOW_UP_REASONING_EFFORT = 'high';

export class WarmFollowUpRunCancelledError extends Error {
    constructor(message) {
        super(message);
        this.name = 'WarmFollowUpRunCancelledError';
        this.code = 'WARM_FOLLOW_UP_RUN_CANCELLED';
    }
}

export function isWarmFollowUpCancelledError(errorInfo) {
    if (errorInfo?.code === 'WARM_FOLLOW_UP_RUN_CANCELLED') return true;
    if (errorInfo?.name === 'WarmFollowUpRunCancelledError') return true;
    const msg = String(errorInfo?.message || '');
    return (
        msg.includes('— cancelled or no longer running')
        || /^Generation run \d+ not found for agency /.test(msg)
    );
}

async function requireRunningRun(runId, agencyId, db = pool) {
    const result = await db.query(
        `SELECT *
         FROM follow_up_generation_runs
         WHERE id = $1 AND agency_id = $2
         LIMIT 1`,
        [runId, agencyId]
    );
    const run = result.rows[0];
    if (!run) {
        throw new WarmFollowUpRunCancelledError(
            `Generation run ${runId} not found for agency ${agencyId}`
        );
    }
    if (run.status !== 'running') {
        throw new WarmFollowUpRunCancelledError(
            `Generation run ${runId} — cancelled or no longer running`
        );
    }
    return run;
}

export async function insertGenerationRun({
    agencyId,
    clientId,
    contactId,
    campaignId,
    scriptId,
    mode,
    sentForDate = null,
    db = pool
}) {
    const result = await db.query(
        `INSERT INTO follow_up_generation_runs (
            agency_id, client_id, contact_id, campaign_id, follow_up_script_id,
            mode, status, generation_step, sent_for_date
        ) VALUES (
            $1, $2, $3, $4, $5,
            $6, 'running', 'hydrate', $7::date
        )
        RETURNING *`,
        [agencyId, clientId, contactId, campaignId || null, scriptId || null, mode, sentForDate]
    );
    return result.rows[0];
}

export async function getGenerationRun(runId, agencyId, { clientId = null } = {}) {
    const params = [runId, agencyId];
    let clientClause = '';
    if (clientId) {
        params.push(clientId);
        clientClause = ` AND client_id = $${params.length}`;
    }
    const result = await pool.query(
        `SELECT *
         FROM follow_up_generation_runs
         WHERE id = $1 AND agency_id = $2${clientClause}
         LIMIT 1`,
        params
    );
    return result.rows[0] || null;
}

async function loadRunInputs(runId, agencyId) {
    const run = await requireRunningRun(runId, agencyId);

    const [contactRow, scriptRow, clientRow, campaignRow] = await Promise.all([
        pool.query(
            `SELECT c.id, c.email, c.full_name, c.company_id,
                    cic.instantly_lead_id, ic.instantly_campaign_id, ic.name AS campaign_name
             FROM contacts c
             LEFT JOIN contact_instantly_campaigns cic
               ON cic.contact_id = c.id AND cic.campaign_id = $2
             LEFT JOIN instantly_campaigns ic ON ic.id = $2
             WHERE c.id = $1
             LIMIT 1`,
            [run.contact_id, run.campaign_id]
        ),
        run.follow_up_script_id
            ? pool.query(
                `SELECT id, script_order, html_template, text_template, step_instruction, active
                 FROM follow_up_scripts
                 WHERE id = $1 AND client_id = $2
                 LIMIT 1`,
                [run.follow_up_script_id, run.client_id]
            )
            : Promise.resolve({ rows: [] }),
        pool.query(
            `SELECT id, follow_up_system_prompt, instantly_key
             FROM clients
             WHERE id = $1
             LIMIT 1`,
            [run.client_id]
        ),
        run.campaign_id
            ? pool.query(
                `SELECT id, name, instantly_campaign_id FROM instantly_campaigns WHERE id = $1`,
                [run.campaign_id]
            )
            : Promise.resolve({ rows: [] })
    ]);

    const contact = contactRow.rows[0] || {};
    const script = scriptRow.rows[0] || null;
    const client = clientRow.rows[0] || {};
    const campaign = campaignRow.rows[0] || {};

    return {
        runId: run.id,
        agencyId,
        clientId: run.client_id,
        contactId: run.contact_id,
        campaignId: run.campaign_id,
        mode: run.mode,
        sentForDate: run.sent_for_date,
        email: contact.email || null,
        companyId: contact.company_id || null,
        instantlyLeadId: contact.instantly_lead_id || null,
        instantlyCampaignId: contact.instantly_campaign_id || campaign.instantly_campaign_id || null,
        campaignName: campaign.name || contact.campaign_name || '',
        systemPrompt: client.follow_up_system_prompt || '',
        instantlyKey: client.instantly_key || null,
        script
    };
}

export async function hydrateGenerationContext({ runId, agencyId }) {
    const ctx = await loadRunInputs(runId, agencyId);
    await stampGenerationStep(runId, agencyId, 'hydrate');
    return ctx;
}

export async function loadResearchBriefForRun({ runId, agencyId }) {
    const run = await requireRunningRun(runId, agencyId);
    await stampGenerationStep(runId, agencyId, 'brief');

    const result = await pool.query(
        `SELECT research_brief
         FROM interested_autoresponder_drafts
         WHERE contact_id = $1
           AND campaign_id = $2
           AND research_brief IS NOT NULL
         ORDER BY COALESCE(research_completed_at, updated_at, created_at) DESC
         LIMIT 1`,
        [run.contact_id, run.campaign_id]
    );
    const brief = result.rows[0]?.research_brief || null;
    const usable = brief && typeof brief === 'object' && String(brief.summary || '').trim()
        ? brief
        : null;

    await pool.query(
        `UPDATE follow_up_generation_runs
         SET used_research_brief = $3,
             research_brief = $4::jsonb,
             updated_at = NOW()
         WHERE id = $1 AND agency_id = $2 AND status = 'running'`,
        [runId, agencyId, Boolean(usable), usable ? JSON.stringify(usable) : null]
    );

    return usable;
}

async function loadThreadContext(contactId, campaignId) {
    const [draftRow, outboundRow, leadReplyRow, subjectRow] = await Promise.all([
        pool.query(
            `SELECT previous_lead_message, rendered_text
             FROM interested_autoresponder_drafts
             WHERE contact_id = $1 AND campaign_id = $2
             ORDER BY COALESCE(updated_at, created_at) DESC
             LIMIT 1`,
            [contactId, campaignId]
        ),
        pool.query(
            `SELECT fus.rendered_text, fus.created_at, fs.script_order
             FROM follow_up_sends fus
             LEFT JOIN follow_up_scripts fs ON fs.id = fus.follow_up_script_id
             WHERE fus.contact_id = $1 AND fus.campaign_id = $2 AND fus.status = 'sent'
               AND COALESCE(fus.rendered_text, '') <> ''
             ORDER BY fus.created_at ASC, fus.id ASC`,
            [contactId, campaignId]
        ),
        pool.query(
            `SELECT COALESCE(message_text, reply_text_snippet) AS message_text
             FROM contact_instantly_events
             WHERE contact_id = $1 AND campaign_id = $2
               AND event_type = 'reply_received'
               AND COALESCE(message_text, reply_text_snippet, '') <> ''
             ORDER BY event_timestamp DESC
             LIMIT 1`,
            [contactId, campaignId]
        ),
        pool.query(
            `SELECT COALESCE(
                NULLIF(BTRIM(e.payload->>'subject'), ''),
                NULLIF(BTRIM(e.payload->>'email_subject'), ''),
                NULLIF(BTRIM(e.payload->>'thread_subject'), '')
             ) AS thread_subject
             FROM contact_instantly_events e
             WHERE e.contact_id = $1 AND e.campaign_id = $2
               AND COALESCE(
                   NULLIF(BTRIM(e.payload->>'subject'), ''),
                   NULLIF(BTRIM(e.payload->>'email_subject'), ''),
                   NULLIF(BTRIM(e.payload->>'thread_subject'), '')
               ) IS NOT NULL
             ORDER BY e.event_timestamp DESC
             LIMIT 1`,
            [contactId, campaignId]
        )
    ]);

    const draft = draftRow.rows[0] || {};
    const previousLeadMessage = String(
        draft.previous_lead_message || leadReplyRow.rows[0]?.message_text || ''
    ).trim();
    const previousOutbounds = [];
    const initialReply = htmlToPlainText(draft.rendered_text || '').trim();
    if (initialReply) {
        previousOutbounds.push({ label: 'Initial interested reply', text: initialReply });
    }
    for (const row of outboundRow.rows) {
        const text = htmlToPlainText(row.rendered_text || '').trim();
        if (!text) continue;
        const order = Number(row.script_order);
        previousOutbounds.push({
            label: Number.isFinite(order) && order > 0 ? `Follow-up #${order}` : 'Follow-up',
            text
        });
    }
    const previousOutbound = formatOutboundThreadHistory(previousOutbounds);

    return {
        previousLeadMessage,
        previousOutbound,
        previousOutbounds,
        threadSubject: subjectRow.rows[0]?.thread_subject || null
    };
}

function fallbackFromTemplate(script, vars) {
    if (!script?.html_template && !script?.text_template) return null;
    const renderedHtml = sanitizeHtml(renderTemplate(script.html_template || '', vars));
    const renderedText = script.text_template
        ? renderTemplate(script.text_template, vars)
        : htmlToPlainText(renderedHtml);
    if (!String(renderedText || '').trim() && !renderedHtml) return null;
    return { renderedHtml, renderedText, usedTemplateFallback: true };
}

async function callFollowUpModel({ openaiKey, messages }) {
    const client = new OpenAI({ apiKey: openaiKey });
    const response = await client.chat.completions.create({
        model: FOLLOW_UP_MODEL,
        reasoning_effort: FOLLOW_UP_REASONING_EFFORT,
        messages
    });
    return {
        text: String(response.choices?.[0]?.message?.content || '').trim(),
        model: response.model || FOLLOW_UP_MODEL
    };
}

export async function generateFollowUpCopy({ runId, agencyId, researchBrief = null }) {
    await stampGenerationStep(runId, agencyId, 'generate');
    const ctx = await loadRunInputs(runId, agencyId);
    const settings = await fetchAgencyAndClientSettings(agencyId, ctx.clientId);
    const threadMeta = await fetchThreadReplyMetadata(pool, ctx.contactId, ctx.campaignId);
    const vars = await resolveTemplateVars(pool, ctx.contactId, ctx.campaignId, {
        clientId: ctx.clientId,
        emailAccount: threadMeta.eaccount
    });
    const renderedSystemPrompt = renderTemplate(ctx.systemPrompt || '', vars);
    const thread = await loadThreadContext(ctx.contactId, ctx.campaignId);
    const brief = researchBrief && typeof researchBrief === 'object' ? researchBrief : null;

    let generatedText = '';
    let usedTemplateFallback = false;

    if (settings.openaiKey) {
        const messages = assembleFollowUpMessages({
            systemPrompt: renderedSystemPrompt,
            stepInstruction: ctx.script?.step_instruction || '',
            researchBrief: brief,
            threadSubject: thread.threadSubject,
            leadEmail: ctx.email,
            firstName: vars.first_name || '',
            previousLeadMessage: thread.previousLeadMessage,
            previousOutbound: thread.previousOutbound,
            previousOutbounds: thread.previousOutbounds
        });
        try {
            const first = await callFollowUpModel({ openaiKey: settings.openaiKey, messages });
            generatedText = first.text;
            if (isFollowUpCopyTooLong(generatedText)) {
                const retryMessages = assembleFollowUpMessages({
                    systemPrompt: renderedSystemPrompt,
                    stepInstruction: ctx.script?.step_instruction || '',
                    researchBrief: brief,
                    threadSubject: thread.threadSubject,
                    leadEmail: ctx.email,
                    firstName: vars.first_name || '',
                    previousLeadMessage: thread.previousLeadMessage,
                    previousOutbound: thread.previousOutbound,
                    previousOutbounds: thread.previousOutbounds,
                    retryShorter: true
                });
                const retry = await callFollowUpModel({ openaiKey: settings.openaiKey, messages: retryMessages });
                if (retry.text) generatedText = retry.text;
            }
        } catch (err) {
            console.warn(`[warm-follow-up] model failed run=${runId}: ${err?.message || err}`);
        }
    }

    if (isFollowUpCopyTooLong(generatedText)) {
        generatedText = generatedText.slice(0, FOLLOW_UP_MAX_CHARS).trim();
    }

    let renderedText = generatedText ? formatFollowUpPlainText(generatedText) : '';
    let renderedHtml = generatedText ? sanitizeHtml(plainTextToFollowUpHtml(generatedText)) : '';

    const signatureHtml = String(vars.instantly_signature || '').trim();
    if (renderedHtml && signatureHtml) {
        const safeSignature = sanitizeHtml(signatureHtml);
        if (safeSignature) {
            renderedHtml = `${renderedHtml}${safeSignature}`;
            const signatureText = htmlToPlainText(safeSignature);
            if (signatureText && !renderedText.includes(signatureText)) {
                renderedText = `${renderedText}\n\n${signatureText}`;
            }
        }
    }

    if (!renderedText) {
        const fallback = fallbackFromTemplate(ctx.script, vars);
        if (fallback) {
            renderedHtml = fallback.renderedHtml;
            renderedText = fallback.renderedText;
            usedTemplateFallback = true;
        }
    }

    if (!renderedText) {
        throw new Error('Follow-up generation produced empty copy and no HTML template fallback was available.');
    }

    await pool.query(
        `UPDATE follow_up_generation_runs
         SET rendered_subject = $3,
             rendered_html = $4,
             rendered_text = $5,
             used_template_fallback = $6,
             updated_at = NOW()
         WHERE id = $1 AND agency_id = $2 AND status = 'running'`,
        [runId, agencyId, thread.threadSubject, renderedHtml, renderedText, usedTemplateFallback]
    );

    return {
        renderedSubject: thread.threadSubject,
        renderedHtml,
        renderedText,
        usedResearchBrief: Boolean(brief),
        usedTemplateFallback,
        vars
    };
}

export async function finalizePreviewRun({ runId, agencyId }) {
    const run = await requireRunningRun(runId, agencyId);
    await pool.query(
        `UPDATE follow_up_generation_runs
         SET status = 'completed',
             updated_at = NOW()
         WHERE id = $1 AND agency_id = $2 AND status = 'running'`,
        [runId, agencyId]
    );
    return { runId: run.id, status: 'completed' };
}

export async function sendGeneratedFollowUp({ runId, agencyId }) {
    const run = await requireRunningRun(runId, agencyId);
    if (run.mode !== 'send') {
        return finalizePreviewRun({ runId, agencyId });
    }

    await stampGenerationStep(runId, agencyId, 'send');
    const ctx = await loadRunInputs(runId, agencyId);
    const settings = await fetchAgencyAndClientSettings(agencyId, ctx.clientId);
    const apiKey = settings.instantlyKey || ctx.instantlyKey;
    if (!apiKey) {
        throw new Error('No Instantly API key configured for this client.');
    }

    const result = await sendRenderedFollowUp({
        prospect: {
            contact_id: ctx.contactId,
            campaign_id: ctx.campaignId,
            company_id: ctx.companyId,
            instantly_lead_id: ctx.instantlyLeadId,
            instantly_campaign_id: ctx.instantlyCampaignId,
            email: ctx.email,
            thread_subject: run.rendered_subject
        },
        script: ctx.script,
        renderedHtml: run.rendered_html,
        renderedText: run.rendered_text,
        renderedSubject: run.rendered_subject,
        apiKey,
        agencyId,
        clientId: ctx.clientId,
        sentForDate: run.sent_for_date,
        logger: console.log
    });

    await pool.query(
        `UPDATE follow_up_generation_runs
         SET status = $3,
             follow_up_send_id = $4,
             error_message = $5,
             updated_at = NOW()
         WHERE id = $1 AND agency_id = $2 AND status = 'running'`,
        [
            runId,
            agencyId,
            result.failed ? 'failed' : 'completed',
            result.sendId || null,
            result.errorMessage || null
        ]
    );

    if (result.failed) {
        throw new Error(result.errorMessage || 'Follow-up send failed');
    }
    return { runId: run.id, status: 'completed', sendId: result.sendId || null };
}

export async function failGenerationRun({ runId, agencyId, errorInfo }) {
    const message = String(errorInfo?.message || errorInfo || 'Follow-up generation failed').slice(0, 2000);
    await pool.query(
        `UPDATE follow_up_generation_runs
         SET status = 'failed',
             error_message = $3,
             updated_at = NOW()
         WHERE id = $1 AND agency_id = $2 AND status = 'running'`,
        [runId, agencyId, message]
    );
}

export async function startFollowUpGeneration({
    agencyId,
    clientId,
    contactId,
    campaignId,
    scriptId,
    mode,
    sentForDate = null
}) {
    try {
        return await insertGenerationRun({
            agencyId,
            clientId,
            contactId,
            campaignId,
            scriptId,
            mode,
            sentForDate
        });
    } catch (err) {
        if (err?.code === '23505' && mode === 'send') {
            const existing = await pool.query(
                `SELECT *
                 FROM follow_up_generation_runs
                 WHERE contact_id = $1
                   AND campaign_id = $2
                   AND sent_for_date = $3::date
                   AND mode = 'send'
                   AND status = 'running'
                 ORDER BY id DESC
                 LIMIT 1`,
                [contactId, campaignId, sentForDate]
            );
            if (existing.rows[0]) return existing.rows[0];
        }
        throw err;
    }
}

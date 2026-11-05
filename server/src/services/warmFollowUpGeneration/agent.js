/**
 * Follow-up agent: one touch of a lead's sequence, run as the same tool loop as
 * the interested-reply agent (interestedReplyAgent.js) but with no human review,
 * so with its stricter `followUp` rules. The agent reads the thread, researches
 * the store and decides whether to send, skip this touch or end the sequence.
 */
import { pool } from '../../config/db.js';
import {
    callPopupFormGenerate,
    domainFromLeadEmail,
    fetchPromptConfig,
    fetchThreadMessagesForReview,
    normalizeAuditDomain,
    popupOptionsFromResearchBrief,
    resolveReplyPreviewBehavior
} from '../interestedAutoResponder.js';
import { buildAgentLeadProfile, runReplyAgent } from '../interestedReplyAgent.js';
import {
    assembleFollowUpAgentInput,
    assembleFollowUpAgentInstructions,
    FOLLOW_UP_AGENT_MAX_CHARS,
    isFollowUpCopyTooLong
} from './prompt.js';

/** Sends and skips so far, plus the notes the agent left itself on earlier touches. */
async function loadTouchHistory(contactId, campaignId) {
    const [sends, runs] = await Promise.all([
        pool.query(
            `SELECT COUNT(*)::int AS sent
             FROM follow_up_sends
             WHERE contact_id = $1 AND campaign_id = $2 AND status = 'sent'`,
            [contactId, campaignId]
        ),
        pool.query(
            `SELECT agent_outcome, agent_trace->>'notes' AS notes
             FROM follow_up_generation_runs
             WHERE contact_id = $1 AND campaign_id = $2
               AND mode = 'send' AND status = 'completed'
               AND agent_outcome IN ('send', 'skip')
             ORDER BY created_at ASC, id ASC`,
            [contactId, campaignId]
        )
    ]);
    return {
        sent: sends.rows[0]?.sent || 0,
        skipped: runs.rows.filter((row) => row.agent_outcome === 'skip').length,
        priorNotes: runs.rows
            .filter((row) => row.notes)
            .map((row) => (row.agent_outcome === 'skip' ? `(skipped a touch) ${row.notes}` : row.notes))
    };
}

export function validateFollowUpAgentReply(reply) {
    return isFollowUpCopyTooLong(reply, FOLLOW_UP_AGENT_MAX_CHARS)
        ? `The email is too long (${reply.length} characters). Rewrite it under ${FOLLOW_UP_AGENT_MAX_CHARS} characters, then call submit_draft again.`
        : null;
}

export async function runFollowUpAgent({
    ctx,
    settings,
    vars,
    thread,
    researchBrief,
    systemPrompt,
    model,
    reasoningEffort
}) {
    const history = await loadTouchHistory(ctx.contactId, ctx.campaignId);
    const domain = normalizeAuditDomain(vars.company_domain) || domainFromLeadEmail(ctx.email);

    // Same rule as the interested reply: the preview tool is only offered on
    // campaigns whose autoresponder prompt uses it.
    const promptConfig = await fetchPromptConfig(pool, ctx.clientId, ctx.campaignId);
    const canGeneratePreview = Boolean(domain) && resolveReplyPreviewBehavior({
        settings,
        campaignName: ctx.campaignName,
        systemPrompt: promptConfig?.system_prompt || ''
    }).canGenerateEssenceStorePreview;

    return runReplyAgent({
        openaiKey: settings.openaiKey,
        instructions: assembleFollowUpAgentInstructions(systemPrompt),
        input: assembleFollowUpAgentInput({
            today: new Date().toISOString().slice(0, 10),
            touchNumber: history.sent + history.skipped + 1,
            maxTouches: ctx.agentMaxTouches,
            campaignName: ctx.campaignName,
            leadEmail: ctx.email,
            firstName: vars.first_name,
            website: domain ? `https://${domain}` : '',
            threadSubject: thread.threadSubject,
            researchBrief,
            previousLeadMessage: thread.previousLeadMessage,
            priorNotes: history.priorNotes
        }),
        serperKey: settings.serperKey || null,
        loadThread: () => fetchThreadMessagesForReview(pool, ctx.contactId, ctx.campaignId, ctx.email),
        leadProfile: buildAgentLeadProfile(vars),
        generateStorePreview: canGeneratePreview
            ? () => callPopupFormGenerate(ctx.email, popupOptionsFromResearchBrief(researchBrief, domain))
            : null,
        allowedHosts: domain ? [domain.replace(/^www\./, '')] : [],
        model,
        reasoningEffort,
        followUp: true,
        validateReply: validateFollowUpAgentReply
    });
}

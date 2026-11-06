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
    fetchContactHistoryMessages,
    fetchPromptConfig,
    normalizeAuditDomain,
    popupOptionsFromResearchBrief,
    resolveReplyPreviewBehavior
} from '../interestedAutoResponder.js';
import { buildAgentLeadProfile, runReplyAgent } from '../interestedReplyAgent.js';
import {
    assembleFollowUpAgentInput,
    assembleFollowUpAgentInstructions,
    formatThreadState,
    FOLLOW_UP_AGENT_MAX_CHARS,
    isFollowUpCopyTooLong
} from './prompt.js';

// Once a run passes the cap the agent gets one last call to finish, so a run can
// end slightly above it. Every run so far has stayed under.
const FOLLOW_UP_AGENT_MAX_TOTAL_TOKENS = 25_000;
const FOLLOW_UP_AGENT_MAX_TURNS = 5;

/** Sends and skips with this person, plus the notes the agent left itself on earlier touches. */
async function loadTouchHistory(contactId, clientId) {
    const [scripts, sends, runs] = await Promise.all([
        pool.query(
            `SELECT COUNT(*)::int AS count FROM follow_up_scripts WHERE client_id = $1 AND active = TRUE`,
            [clientId]
        ),
        pool.query(
            `SELECT COUNT(*)::int AS sent
             FROM follow_up_sends
             WHERE contact_id = $1 AND status = 'sent'`,
            [contactId]
        ),
        pool.query(
            `SELECT agent_outcome, agent_trace->>'notes' AS notes
             FROM follow_up_generation_runs
             WHERE contact_id = $1
               AND mode = 'send' AND status = 'completed'
               AND agent_outcome IN ('send', 'skip')
             ORDER BY created_at ASC, id ASC`,
            [contactId]
        )
    ]);
    return {
        scriptCount: scripts.rows[0]?.count || 0,
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
    const [history, threadMessages] = await Promise.all([
        loadTouchHistory(ctx.contactId, ctx.clientId),
        fetchContactHistoryMessages(pool, ctx.contactId, ctx.email)
    ]);
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
            threadState: formatThreadState(threadMessages),
            priorNotes: history.priorNotes,
            reengaging: history.scriptCount > 0 && history.sent >= history.scriptCount
        }),
        serperKey: settings.serperKey || null,
        loadThread: async () => threadMessages,
        leadProfile: buildAgentLeadProfile(vars),
        generateStorePreview: canGeneratePreview
            ? () => callPopupFormGenerate(ctx.email, popupOptionsFromResearchBrief(researchBrief, domain))
            : null,
        allowedHosts: domain ? [domain.replace(/^www\./, '')] : [],
        model,
        reasoningEffort,
        maxTurns: FOLLOW_UP_AGENT_MAX_TURNS,
        maxTotalTokens: FOLLOW_UP_AGENT_MAX_TOTAL_TOKENS,
        followUp: true,
        validateReply: validateFollowUpAgentReply
    });
}

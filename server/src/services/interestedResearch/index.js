/**
 * Interested-reply research — step implementations for the
 * `interestedResearchWorkflow` Vercel Workflow (workflows/interested-research.ts).
 *
 * Each exported function backs exactly one workflow step: it re-reads what it
 * needs from Postgres, does its (nondeterministic) network work, and returns a
 * compact serializable result for the workflow event log. The draft row is the
 * single source of truth — a step that finds the draft no longer 'researching'
 * (superseded / cancelled / lead no longer interested) stops the run cleanly
 * instead of overwriting newer state.
 *
 * This deliberately shares LIBRARIES with the interested autoresponder
 * (generateDraftReply, popup generation, signal context) but NOT the enrichment
 * job orchestrator: the reply path is per-event, reply-aware, and human-gated.
 */
import OpenAI from 'openai';
import { pool } from '../../config/db.js';
import { getAgencySettings, apiKeysFromSettings } from '../db/agencySettings.js';
import { resolveTemplateVars, renderTemplate } from '../followUpSender.js';
import {
    applyActiveFungiStoryUrlToTemplateVars,
    buildReviewUrl,
    domainFromLeadEmail,
    fetchAgencyAndClientSettings,
    fetchPromptConfig,
    generateAuditPreviewUrl,
    generateDraftReply,
    resolveReplyPreviewBehavior,
    generateReviewToken,
    humanizeDomainAsCompanyName,
    normalizeAuditDomain,
    resolveContactSignalContext,
    sendNtfyNotification,
    withAuditUrlVars
} from '../interestedAutoResponder.js';
import {
    buildSerperQueries,
    compactSerperResults,
    extractHomepageSummary,
    extractReviewCountFromSerper,
    normalizeResearchBrief,
    RESEARCH_INDUSTRIES
} from './briefUtils.js';

const RESEARCH_MODEL = String(process.env.INTERESTED_RESEARCH_MODEL || 'gpt-5.5').trim() || 'gpt-5.5';
const REVIEW_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const HOMEPAGE_FETCH_TIMEOUT_MS = Math.max(
    Number(process.env.INTERESTED_RESEARCH_HOMEPAGE_TIMEOUT_MS || 15_000) || 15_000,
    1_000
);
const SERPER_TIMEOUT_MS = Math.max(
    Number(process.env.INTERESTED_RESEARCH_SERPER_TIMEOUT_MS || 20_000) || 20_000,
    1_000
);
const SERPER_URL = 'https://google.serper.dev/search';

/** Thrown when the draft is gone / no longer researching — the run should stop, not fail. */
export class ResearchDraftSupersededError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ResearchDraftSupersededError';
        this.code = 'RESEARCH_DRAFT_SUPERSEDED';
    }
}

/** In-process check (custom `code` still present). Workflow code must use the
 * shared detector in lib/interested-research/superseded.ts — step boundaries
 * strip `code` and only name/message survive. */
export function isResearchSupersededError(errorInfo) {
    if (errorInfo?.code === 'RESEARCH_DRAFT_SUPERSEDED') return true;
    if (errorInfo?.name === 'ResearchDraftSupersededError') return true;
    const msg = String(errorInfo?.message || '');
    return (
        msg.includes('— superseded or cancelled') ||
        msg.includes('was superseded before research finalize') ||
        /^Draft \d+ not found for agency /.test(msg)
    );
}

async function loadResearchingDraft(db, draftId, agencyId) {
    const result = await db.query(
        `SELECT d.*, ic.name AS campaign_name
         FROM interested_autoresponder_drafts d
         JOIN instantly_campaigns ic ON ic.id = d.campaign_id
         WHERE d.id = $1 AND d.agency_id = $2
         LIMIT 1`,
        [draftId, agencyId]
    );
    const draft = result.rows[0] || null;
    if (!draft) {
        throw new ResearchDraftSupersededError(`Draft ${draftId} not found for agency ${agencyId}`);
    }
    if (draft.status !== 'researching') {
        throw new ResearchDraftSupersededError(
            `Draft ${draftId} is '${draft.status}', not 'researching' — superseded or cancelled`
        );
    }
    return draft;
}

async function resolveDraftResearchTarget(db, draft) {
    const signalRow = await resolveContactSignalContext(db, draft.contact_id);
    const domain = normalizeAuditDomain(signalRow.company_domain)
        || domainFromLeadEmail(draft.lead_email);
    let companyName = '';
    try {
        const insights = await db.query(
            `SELECT attributes->>'companyName' AS company_name
             FROM contact_insights
             WHERE contact_id = $1`,
            [draft.contact_id]
        );
        companyName = String(insights.rows[0]?.company_name || '').trim();
    } catch {
        // contact_insights is optional context
    }
    if (!companyName) companyName = humanizeDomainAsCompanyName(domain);
    return { signalRow, domain, companyName };
}

/**
 * Step 1 — validate the draft is still ours to research and return the compact
 * context every later step's logs key off. Throws RESEARCH_DRAFT_SUPERSEDED to
 * end duplicate/late runs without touching the row.
 */
export async function hydrateResearchContext({ draftId, agencyId }) {
    const draft = await loadResearchingDraft(pool, draftId, agencyId);
    const { domain, companyName } = await resolveDraftResearchTarget(pool, draft);
    return {
        draftId: draft.id,
        contactId: draft.contact_id,
        campaignId: draft.campaign_id,
        clientId: draft.client_id,
        leadEmail: draft.lead_email,
        campaignName: draft.campaign_name,
        domain,
        companyName
    };
}

/** Fetch and distill a company homepage. Draft-independent; null on any failure. */
export async function fetchHomepageForDomain(domain) {
    if (!domain) return null;

    const url = `https://${domain}/`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HOMEPAGE_FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; ShieldsOutbound/1.0; +https://essence-ai.app)',
                Accept: 'text/html,application/xhtml+xml'
            },
            redirect: 'follow',
            signal: controller.signal
        });
        if (!response.ok) {
            console.warn(`[interested-research] homepage fetch status=${response.status} domain=${domain}`);
            return null;
        }
        const contentType = String(response.headers.get('content-type') || '');
        if (contentType && !contentType.includes('html')) return null;
        const html = await response.text();
        const summary = extractHomepageSummary(html);
        if (!summary.title && !summary.description && !summary.text) return null;
        return { url, ...summary };
    } catch (err) {
        const reason = err?.name === 'AbortError' ? 'timeout' : err?.message || err;
        console.warn(`[interested-research] homepage fetch failed domain=${domain}: ${reason}`);
        return null;
    } finally {
        clearTimeout(timeoutId);
    }
}

/** Step 2a — fetch and distill the company homepage. Best-effort: null on any failure. */
export async function runHomepageResearch({ draftId, agencyId }) {
    const draft = await loadResearchingDraft(pool, draftId, agencyId);
    const { domain } = await resolveDraftResearchTarget(pool, draft);
    return fetchHomepageForDomain(domain);
}

/** Serper sweep for one target. Draft-independent; null when no key/queries/results. */
export async function fetchSerperForTarget({ companyName, domain, serperKey }) {
    if (!serperKey) return null;

    const queries = buildSerperQueries({ companyName, domain });
    if (!queries.length) return null;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SERPER_TIMEOUT_MS);
    try {
        const response = await fetch(SERPER_URL, {
            method: 'POST',
            headers: {
                'X-API-KEY': serperKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(queries),
            signal: controller.signal
        });
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            console.warn(
                `[interested-research] serper status=${response.status} domain=${domain}: ${text.slice(0, 200)}`
            );
            return null;
        }
        const payload = await response.json();
        const results = compactSerperResults(Array.isArray(payload) ? payload : [payload]);
        return results.length ? { results } : null;
    } catch (err) {
        const reason = err?.name === 'AbortError' ? 'timeout' : err?.message || err;
        console.warn(`[interested-research] serper failed domain=${domain}: ${reason}`);
        return null;
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * Step 2b — Serper sweep (company overview + recent news) using the agency's
 * own Serper key. Best-effort: null when no key, no domain, or the call fails.
 */
export async function runSerperResearch({ draftId, agencyId }) {
    const draft = await loadResearchingDraft(pool, draftId, agencyId);
    const { domain, companyName } = await resolveDraftResearchTarget(pool, draft);
    const agencySettings = await getAgencySettings(agencyId);
    const serperKey = apiKeysFromSettings(agencySettings).serper;
    if (!serperKey) {
        console.warn(`[interested-research] no Serper key for agency=${agencyId} — skipping web sweep`);
        return null;
    }
    return fetchSerperForTarget({ companyName, domain, serperKey });
}

/**
 * Synthesize the structured brief from research context. Draft-independent and
 * side-effect free; returns the normalized brief, or null when research was too
 * thin to say anything grounded.
 *
 * @param {{
 *   openaiKey: string,
 *   companyName?: string,
 *   domain?: string,
 *   leadEmail?: string,
 *   homepage?: { url: string, title: string, description: string, text: string } | null,
 *   serper?: { results: Array<{ title: string, link: string | null, snippet: string, date: string | null }> } | null
 * }} args
 */
export async function synthesizeBriefFromContext({
    openaiKey,
    companyName = '',
    domain = '',
    leadEmail = '',
    homepage = null,
    serper = null
}) {
    const hasSignal = Boolean(homepage?.text || homepage?.description || serper?.results?.length);
    if (!hasSignal) return null;

    const contextBlocks = [];
    if (homepage) {
        contextBlocks.push([
            `Homepage (${homepage.url}):`,
            homepage.title ? `Title: ${homepage.title}` : '',
            homepage.description ? `Meta description: ${homepage.description}` : '',
            homepage.text ? `Content:\n${homepage.text}` : ''
        ].filter(Boolean).join('\n'));
    }
    if (serper?.results?.length) {
        contextBlocks.push([
            'Web search results:',
            ...serper.results.map((result, index) => [
                `${index + 1}. ${result.title}`,
                result.link ? `   URL: ${result.link}` : '',
                result.date ? `   Date: ${result.date}` : '',
                result.snippet ? `   ${result.snippet}` : ''
            ].filter(Boolean).join('\n'))
        ].join('\n'));
    }

    const openaiClient = new OpenAI({ apiKey: openaiKey });
    const response = await openaiClient.chat.completions.create({
        model: RESEARCH_MODEL,
        response_format: { type: 'json_object' },
        messages: [
            {
                role: 'system',
                content: [
                    'You are a B2B sales research analyst. From the provided web research,',
                    'produce a compact JSON brief about the company so a salesperson can write',
                    'a sharp, personalized reply to an interested lead.',
                    '',
                    'Respond with JSON exactly in this shape:',
                    '{',
                    '  "company": string,            // display name',
                    '  "domain": string,',
                    `  "industry": string|null,      // exactly one of: ${RESEARCH_INDUSTRIES.join(', ')} — or null if none clearly fits`,
                    '  "summary": string,            // 2-4 sentences: what they sell, who to, anything notable/recent',
                    '  "talkingPoints": string[],    // up to 5 specific, verifiable hooks for the reply',
                    '  "risks": string[],            // up to 3 things to avoid claiming or assuming',
                    '  "sources": [{"title": string, "url": string}],',
                    '  "reviewCount": number|null    // total published site/store reviews if explicitly stated',
                    '                                // (Trustpilot, Google, on-site aggregate). null if unknown.',
                    '                                // Never invent or estimate this number.',
                    '}',
                    '',
                    'Only state facts supported by the research below. If the research is too',
                    'thin to say anything specific, return {"summary": ""}.'
                ].join('\n')
            },
            {
                role: 'user',
                content: [
                    `Company: ${companyName || '(unknown)'}`,
                    `Domain: ${domain || '(unknown)'}`,
                    leadEmail ? `Lead email: ${leadEmail}` : '',
                    '',
                    contextBlocks.join('\n\n')
                ].filter(Boolean).join('\n')
            }
        ]
    });

    let parsed = null;
    try {
        parsed = JSON.parse(response.choices?.[0]?.message?.content || 'null');
    } catch {
        parsed = null;
    }
    const fallbackReviewCount = extractReviewCountFromSerper(serper?.results);
    return normalizeResearchBrief(parsed, {
        company: companyName,
        domain,
        fallbackReviewCount
    });
}

/**
 * Step 3 — synthesize the structured brief from homepage + Serper context and
 * persist it on the draft (research_brief JSONB). Returns the brief, or null
 * when research was too thin to say anything grounded.
 *
 * @param {{
 *   draftId: number,
 *   agencyId: string,
 *   homepage?: { url: string, title: string, description: string, text: string } | null,
 *   serper?: { results: Array<{ title: string, link: string | null, snippet: string, date: string | null }> } | null
 * }} args
 */
export async function synthesizeResearchBrief({ draftId, agencyId, homepage = null, serper = null }) {
    const draft = await loadResearchingDraft(pool, draftId, agencyId);
    const { domain, companyName } = await resolveDraftResearchTarget(pool, draft);

    const settings = await fetchAgencyAndClientSettings(agencyId, draft.client_id);
    if (!settings.openaiKey) {
        console.warn(`[interested-research] missing OpenAI key for agency=${agencyId} — skipping brief`);
        return null;
    }

    const brief = await synthesizeBriefFromContext({
        openaiKey: settings.openaiKey,
        companyName,
        domain,
        leadEmail: draft.lead_email,
        homepage,
        serper
    });
    if (!brief) {
        console.log(`[interested-research] brief too thin for draft=${draftId}`);
        return null;
    }

    await pool.query(
        `UPDATE interested_autoresponder_drafts
         SET research_brief = $2::jsonb,
             updated_at = NOW()
         WHERE id = $1 AND status = 'researching'`,
        [draftId, JSON.stringify(brief)]
    );
    return brief;
}

/**
 * Step 4 — external popup / lead-magnet URL, exactly as the inline path does it:
 * Vulcan audit for shopping-audit reply agencies, Essence popup only when the
 * campaign prompt uses it, skipped otherwise. Popup generation stays external.
 */
export async function runPopupGeneration({ draftId, agencyId }) {
    const draft = await loadResearchingDraft(pool, draftId, agencyId);
    const [settings, signalRow, promptConfig] = await Promise.all([
        fetchAgencyAndClientSettings(agencyId, draft.client_id),
        resolveContactSignalContext(pool, draft.contact_id),
        fetchPromptConfig(pool, draft.client_id, draft.campaign_id)
    ]);
    const auditDomain = normalizeAuditDomain(signalRow.company_domain)
        || domainFromLeadEmail(draft.lead_email);
    const preview = resolveReplyPreviewBehavior({
        settings,
        campaignName: promptConfig?.campaign_name,
        systemPrompt: promptConfig?.system_prompt
    });
    const useShoppingAuditReply = preview.useShoppingAuditReply;

    if (preview.useActiveFungiStoryUrl || preview.skipPopupPreview) {
        // Story URL is built from template vars at draft time; Cut Klaviyo Bill
        // and other non-preview campaigns skip Essence popup generate entirely.
        return { auditPreviewUrl: null, auditDomain };
    }

    // Brief was persisted by the synthesize step (which runs before this one);
    // pass its popup-relevant fields so the external generator can pick
    // vertical/template/copy instead of rediscovering the company from the
    // bare domain. Absent brief (thin research) → payload identical to before.
    const brief = draft.research_brief && typeof draft.research_brief === 'object'
        ? draft.research_brief
        : null;

    const auditPreviewUrl = await generateAuditPreviewUrl(draft.lead_email, {
        domain: auditDomain,
        useVulcanShoppingAudit: useShoppingAuditReply,
        skipPopupPreview: preview.skipPopupPreview,
        // Human-gated review: don't hold the workflow step for audit readiness.
        waitForReady: false,
        ...(brief
            ? {
                industry: brief.industry || null,
                companyName: brief.company || null,
                researchSummary: brief.summary || null,
                talkingPoints: Array.isArray(brief.talkingPoints) ? brief.talkingPoints : null,
                estimatedVisitors: Number.isFinite(Number(brief.estimatedVisitors))
                    && Number(brief.estimatedVisitors) > 0
                    ? Math.round(Number(brief.estimatedVisitors))
                    : null,
                reviewCount: Number.isFinite(Number(brief.reviewCount))
                    && Number(brief.reviewCount) > 0
                    ? Math.round(Number(brief.reviewCount))
                    : null
            }
            : {}),
        ...(useShoppingAuditReply
            ? {
                signalEmissionId: signalRow.signal_emission_id || null,
                signalType: signalRow.signal_type || null,
                observed: signalRow.observed || null,
                expected: signalRow.expected || null
            }
            : {})
    });
    return { auditPreviewUrl: auditPreviewUrl || null, auditDomain };
}

/**
 * Step 5 — generate the reply (brief-aware) and promote the draft to
 * pending_review. Reuses an existing review_token when present (regenerate
 * from the review page) so the reviewer's URL stays valid; otherwise mints a
 * fresh token. ntfy is skipped on regenerate — the reviewer is already on the page.
 * The UPDATE is guarded on status='researching' so a draft cancelled while
 * this run was in flight is never resurrected.
 *
 * @param {{
 *   draftId: number,
 *   agencyId: string,
 *   auditPreviewUrl?: string | null,
 *   isFollowUp?: boolean,
 *   skipNtfy?: boolean,
 *   additionalInstructions?: string | null
 * }} args
 */
export async function finalizeResearchDraft({
    draftId,
    agencyId,
    auditPreviewUrl = null,
    isFollowUp = false,
    skipNtfy = false,
    additionalInstructions = null
}) {
    const draft = await loadResearchingDraft(pool, draftId, agencyId);
    const settings = await fetchAgencyAndClientSettings(agencyId, draft.client_id);
    if (!settings.openaiKey) {
        throw new Error('missing_openai_key');
    }
    const promptConfig = await fetchPromptConfig(pool, draft.client_id, draft.campaign_id);
    if (!promptConfig) {
        throw new Error('missing_active_prompt');
    }

    const { domain } = await resolveDraftResearchTarget(pool, draft);
    const resolvedTemplateVars = await resolveTemplateVars(pool, draft.contact_id, draft.campaign_id, {
        clientId: draft.client_id,
        emailAccount: draft.eaccount
    });
    const preview = resolveReplyPreviewBehavior({
        settings,
        campaignName: promptConfig.campaign_name,
        systemPrompt: promptConfig.system_prompt
    });
    const useActiveFungiStoryUrl = preview.useActiveFungiStoryUrl;
    const templateVars = useActiveFungiStoryUrl
        ? applyActiveFungiStoryUrlToTemplateVars(resolvedTemplateVars, { domain })
        : withAuditUrlVars(resolvedTemplateVars, auditPreviewUrl);
    const renderedSystemPrompt = renderTemplate(promptConfig.system_prompt, templateVars);

    const generation = await generateDraftReply({
        openaiKey: settings.openaiKey,
        systemPrompt: renderedSystemPrompt,
        campaignName: promptConfig.campaign_name,
        leadEmail: draft.lead_email,
        threadSubject: draft.thread_subject,
        previousLeadMessage: draft.previous_lead_message,
        auditPreviewUrl: useActiveFungiStoryUrl ? null : auditPreviewUrl,
        researchBrief: draft.research_brief || null,
        systemPromptOwnsCta: preview.systemPromptOwnsCta,
        additionalInstructions
    });

    const existingToken = String(draft.review_token || '').trim();
    const reviewToken = existingToken || generateReviewToken();
    const reviewTokenExpiresAt = new Date(Date.now() + REVIEW_TOKEN_TTL_MS).toISOString();
    const updateResult = await pool.query(
        `UPDATE interested_autoresponder_drafts
         SET status = 'pending_review',
             review_token = $2,
             review_token_expires_at = $3,
             model = $4,
             rendered_text = $5,
             system_prompt_version = $6,
             research_completed_at = NOW(),
             updated_at = NOW()
         WHERE id = $1 AND status = 'researching'
         RETURNING id`,
        [
            draftId,
            reviewToken,
            reviewTokenExpiresAt,
            generation.model,
            generation.renderedText,
            promptConfig.version
        ]
    );
    if (!updateResult.rowCount) {
        throw new ResearchDraftSupersededError(
            `Draft ${draftId} was superseded before research finalize could promote it`
        );
    }

    const reviewUrl = buildReviewUrl(reviewToken);
    if (!skipNtfy && settings.ntfyTopic) {
        try {
            await sendNtfyNotification(settings.ntfyTopic, {
                leadEmail: draft.lead_email,
                campaignName: promptConfig.campaign_name,
                reviewUrl,
                isFollowUp
            });
        } catch (error) {
            console.error(
                `[interested-research] ntfy notification failed draft=${draftId}: ${error?.message || error}`
            );
        }
    }

    return { promoted: true, draftId, reviewUrl };
}

/**
 * Keystone failure handler — without it a workflow crash strands the draft at
 * 'researching' forever. Regenerates-from-review keep their prior reply + token,
 * so restore those to pending_review instead of killing the review link.
 * Fresh first-run shells (no token/text) still mark generation_failed.
 */
export async function handleResearchFailure({ draftId, agencyId }, errorInfo) {
    const message = String(errorInfo?.message || 'research_failed').slice(0, 500);
    const restored = await pool.query(
        `UPDATE interested_autoresponder_drafts
         SET status = 'pending_review',
             blocked_reason = NULL,
             updated_at = NOW()
         WHERE id = $1
           AND agency_id = $2
           AND status = 'researching'
           AND review_token IS NOT NULL
           AND COALESCE(BTRIM(rendered_text), '') <> ''
         RETURNING id`,
        [draftId, agencyId]
    );
    if (restored.rowCount) {
        console.error(
            `[interested-research] run failed draft=${draftId} restored to pending_review: ${message}`
        );
        return { marked: false, restored: true };
    }

    const result = await pool.query(
        `UPDATE interested_autoresponder_drafts
         SET status = 'generation_failed',
             blocked_reason = $3,
             updated_at = NOW()
         WHERE id = $1 AND agency_id = $2 AND status = 'researching'
         RETURNING id`,
        [draftId, agencyId, message]
    );
    console.error(
        `[interested-research] run failed draft=${draftId} marked=${result.rowCount > 0}: ${message}`
    );
    return { marked: result.rowCount > 0 };
}

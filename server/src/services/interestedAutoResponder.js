import crypto from 'crypto';
import OpenAI from 'openai';
import { pool } from '../config/db.js';
import {
    getAgencySettings,
    hasInterestedReplyShoppingAuditFeature,
    hasReplyResearchAgentFeature
} from './db/agencySettings.js';
import { formatResearchBriefForPrompt } from './interestedResearch/briefUtils.js';
import {
    isInterestedResearchWorkflowConfigured,
    triggerInterestedResearchWorkflow
} from './interestedResearch/trigger.js';
import { getClientRowById, resolveClientRow } from './db/queries.js';
import {
    fetchThreadReplyMetadata,
    persistWarmFollowUpAnchorFromAutoresponder,
    resolveTemplateVars,
    renderTemplate
} from './followUpSender.js';
import {
    applyWarmFollowUpStatusAfterAutoresponderSend,
    resolveWarmFollowUpStatusConfig
} from './warmFollowUpStatus.js';

const DEFAULT_MODEL = String(process.env.INTERESTED_AUTORESPONDER_MODEL || 'gpt-5.5').trim() || 'gpt-5.5';
const REVIEW_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const POPUP_FORM_GENERATE_URL = 'https://essence-retention-ai-popup-demo.vercel.app/api/popup-form/generate';
const POPUP_FORM_API_KEY = 'CNl6iVR6YwmlPU9iw6gOW1LAF4roUxxPNB9YrI2kdIeMmbcfUKh4Rgdl0gdmZBQo';
const POPUP_FORM_GENERATE_TIMEOUT_MS = Math.max(
    Number(process.env.INTERESTED_AUTORESPONDER_POPUP_TIMEOUT_MS || 90_000) || 90_000,
    1
);
const POPUP_FORM_GENERATE_MAX_ATTEMPTS = 2;
/** Active Fungi only — story-page personalization; never run Essence popup generate. */
const ACTIVE_FUNGI_CLIENT_SLUG = 'active-fungi';
const ACTIVE_FUNGI_STORY_BASE_URL = String(
    process.env.ACTIVE_FUNGI_STORY_BASE_URL || 'https://active-fungi.vercel.app'
).trim().replace(/\/$/, '');
const ACTIVE_FUNGI_STORY_GOALS = new Set(['focus', 'calm', 'creativity', 'energy']);
const POPUP_PREVIEW_SKIP_CLIENT_SLUGS = new Set([ACTIVE_FUNGI_CLIENT_SLUG]);

/** Vulcan shopping-ad profit audit (POST /api/audits → page /?domain=). */
const VULCAN_SHOPPING_AUDIT_BASE_URL = String(
    process.env.VULCAN_SHOPPING_AUDIT_BASE_URL || 'https://vulcan-shopping-audit.vercel.app'
).trim().replace(/\/$/, '');
const VULCAN_AUDITS_TRIGGER_SECRET = String(
    process.env.VULCAN_AUDITS_TRIGGER_SECRET || process.env.AUDITS_TRIGGER_SECRET || ''
).trim();
const VULCAN_AUDIT_TRIGGER_TIMEOUT_MS = Math.max(
    Number(process.env.VULCAN_AUDIT_TRIGGER_TIMEOUT_MS || 30_000) || 30_000,
    1
);
const VULCAN_AUDIT_READY_WAIT_MS = Math.max(
    Number(process.env.VULCAN_AUDIT_READY_WAIT_MS || 90_000) || 90_000,
    0
);
const VULCAN_AUDIT_POLL_INTERVAL_MS = Math.max(
    Number(process.env.VULCAN_AUDIT_POLL_INTERVAL_MS || 3_000) || 3_000,
    500
);

const OPEN_DRAFT_STATUSES = ['pending_review', 'blocked_missing_thread', 'researching'];
const MAX_REGENERATE_INSTRUCTIONS_LENGTH = 4000;
const INSTANTLY_API_BASE_URL = 'https://api.instantly.ai';
const INSTANTLY_REQUEST_TIMEOUT_MS = 30_000;

/** last_event_type values where a pending-review draft is still valid (lead still at "interested"). */
export const INTERESTED_PENDING_REVIEW_LAST_EVENT_TYPES = [
    'lead_interested',
    'interested',
    'reply_received',
    'interested_reply_sent',
    'email_sent',
    'email_opened',
    'email_link_clicked',
    'state_sync'
];

export function isCampaignCurrentlyInterested({ interest_status: interestStatus, last_event_type: lastEventType } = {}) {
    if (interestStatus !== 1) return false;
    const normalizedLastEvent = String(lastEventType || '').trim().toLowerCase();
    if (!normalizedLastEvent) return true;
    return INTERESTED_PENDING_REVIEW_LAST_EVENT_TYPES.includes(normalizedLastEvent);
}

function isPopupFormGenerateRetryableError(error) {
    return error?.name === 'AbortError' || error instanceof TypeError;
}

/** Normalize to bare host (matches vulcan-shopping-audit `normalizeDomain`). */
export function normalizeAuditDomain(raw) {
    if (!raw) return null;
    let s = String(raw).trim().toLowerCase();
    if (!s) return null;
    if (s.includes('://')) {
        try {
            s = new URL(s).hostname;
        } catch {
            // fall through
        }
    }
    s = s.replace(/^www\./, '').split('/')[0].split('?')[0].split('#')[0].split(':')[0];
    if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(s)) return null;
    return s;
}

export function domainFromLeadEmail(leadEmail) {
    const atIndex = String(leadEmail || '').indexOf('@');
    if (atIndex === -1) return null;
    return normalizeAuditDomain(String(leadEmail).slice(atIndex + 1));
}

/** Lead website: company domain, else the domain in the lead email. */
export function resolveLeadWebsite(companyDomain, leadEmail) {
    const domain = normalizeAuditDomain(companyDomain) || domainFromLeadEmail(leadEmail);
    if (!domain) return { domain: null, url: null };
    return { domain, url: `https://${domain}` };
}

/** Turn `wildorchard.com` → `Wildorchard` when no company display name exists. */
export function humanizeDomainAsCompanyName(domain) {
    const normalized = normalizeAuditDomain(domain);
    if (!normalized) return '';
    const label = normalized.split('.')[0] || '';
    if (!label) return '';
    return label
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * Active Fungi story page URL (`?name=&company=&logo=&cta=&goal=`).
 * Only used for the active-fungi client — see `useActiveFungiStoryUrl`.
 */
export function buildActiveFungiStoryUrl({
    name = '',
    company = '',
    domain = '',
    goal = '',
    cta = ''
} = {}) {
    const params = new URLSearchParams();
    const trimmedName = String(name || '').trim();
    const normalizedDomain = normalizeAuditDomain(domain);
    const trimmedCompany = String(company || '').trim()
        || humanizeDomainAsCompanyName(normalizedDomain);
    const trimmedGoal = String(goal || '').trim().toLowerCase();
    const trimmedCta = String(cta || '').trim();

    if (trimmedName) params.set('name', trimmedName);
    if (trimmedCompany) params.set('company', trimmedCompany);
    if (normalizedDomain) {
        params.set(
            'logo',
            `https://www.google.com/s2/favicons?domain=${normalizedDomain}&sz=128`
        );
    }
    if (ACTIVE_FUNGI_STORY_GOALS.has(trimmedGoal)) params.set('goal', trimmedGoal);
    if (trimmedCta) params.set('cta', trimmedCta);

    const qs = params.toString();
    return qs ? `${ACTIVE_FUNGI_STORY_BASE_URL}/?${qs}` : `${ACTIVE_FUNGI_STORY_BASE_URL}/`;
}

/** Attach `story_url` for Active Fungi templates (`{{story_url}}`). No-op otherwise. */
export function applyActiveFungiStoryUrlToTemplateVars(templateVars = {}, options = {}) {
    const pick = (...values) => {
        for (const value of values) {
            const text = value === null || value === undefined ? '' : String(value).trim();
            if (text) return text;
        }
        return '';
    };
    const name = pick(templateVars.first_name, templateVars.firstName);
    const company = pick(templateVars.companyName, templateVars.company_name);
    const domain = pick(options.domain, templateVars.company_domain);
    return {
        ...templateVars,
        story_url: buildActiveFungiStoryUrl({
            name,
            company,
            domain,
            goal: options.goal,
            cta: options.cta
        })
    };
}

export function buildVulcanShoppingAuditUrl(domain) {
    const normalized = normalizeAuditDomain(domain);
    if (!normalized) return null;
    return `${VULCAN_SHOPPING_AUDIT_BASE_URL}/?domain=${encodeURIComponent(normalized)}`;
}

/**
 * Trigger Vulcan shopping-ad profit audit generation for a domain.
 * POST /api/audits { domain } with Bearer AUDITS_TRIGGER_SECRET.
 * Always returns the public page URL once the domain is valid — trigger/wait
 * failures must not strip the CTA from the interested reply. Waiting for ready
 * is opt-in (`waitForReady: true`); review is human-gated so the page can finish
 * generating after the draft is already in the inbox.
 */
export async function triggerVulcanShoppingAudit(domain, options = {}) {
    const normalized = normalizeAuditDomain(domain);
    if (!normalized) {
        console.log('[vulcan-audit] skipped — invalid domain:', domain);
        return null;
    }

    const publicUrl = buildVulcanShoppingAuditUrl(normalized);
    const waitForReady = options.waitForReady === true;

    if (!VULCAN_AUDITS_TRIGGER_SECRET) {
        console.warn(
            `[vulcan-audit] trigger skipped — VULCAN_AUDITS_TRIGGER_SECRET / AUDITS_TRIGGER_SECRET not set; still returning page URL domain=${normalized}`
        );
        return publicUrl;
    }

    const start = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), VULCAN_AUDIT_TRIGGER_TIMEOUT_MS);

    try {
        console.log(`[vulcan-audit] POST /api/audits domain=${normalized}`);
        const response = await fetch(`${VULCAN_SHOPPING_AUDIT_BASE_URL}/api/audits`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${VULCAN_AUDITS_TRIGGER_SECRET}`
            },
            body: JSON.stringify({ domain: normalized }),
            signal: controller.signal
        });
        const elapsed = Date.now() - start;
        if (response.status !== 202 && !response.ok) {
            const bodyText = await response.text().catch(() => '');
            console.warn(
                `[vulcan-audit] trigger failed status=${response.status} domain=${normalized} elapsed=${elapsed}ms body=${bodyText.slice(0, 200)} — still returning page URL`
            );
        } else {
            let payload = null;
            try {
                payload = await response.json();
            } catch {
                payload = null;
            }
            console.log(
                `[vulcan-audit] triggered status=${response.status} domain=${normalized} runId=${payload?.runId || 'n/a'} elapsed=${elapsed}ms`
            );
        }
    } catch (err) {
        const reason = err?.name === 'AbortError' ? 'timeout' : err.message;
        console.error(
            `[vulcan-audit] trigger error domain=${normalized}: ${reason} — still returning page URL`
        );
    } finally {
        clearTimeout(timeoutId);
    }

    if (waitForReady && VULCAN_AUDIT_READY_WAIT_MS > 0) {
        const ready = await waitForVulcanAuditReady(normalized, VULCAN_AUDIT_READY_WAIT_MS);
        if (!ready) {
            console.warn(
                `[vulcan-audit] not ready within ${VULCAN_AUDIT_READY_WAIT_MS}ms domain=${normalized} — still returning page URL for review`
            );
        }
    }

    return publicUrl;
}

async function waitForVulcanAuditReady(domain, maxWaitMs) {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(
                `${VULCAN_SHOPPING_AUDIT_BASE_URL}/api/audit?domain=${encodeURIComponent(domain)}`,
                { method: 'GET', cache: 'no-store' }
            );
            if (response.ok) {
                console.log(`[vulcan-audit] ready domain=${domain}`);
                return true;
            }
        } catch (err) {
            console.warn(`[vulcan-audit] poll error domain=${domain}: ${err?.message || err}`);
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(VULCAN_AUDIT_POLL_INTERVAL_MS, remaining)));
    }
    return false;
}

export async function callPopupFormGenerate(leadEmail, options = {}) {
    const domain = normalizeAuditDomain(options.domain) || domainFromLeadEmail(leadEmail);
    if (!domain) {
        console.log('[popup-form/generate] skipped — no domain extractable from leadEmail:', leadEmail);
        return null;
    }

    const signalEmissionId = options.signalEmissionId || null;
    const signalType = options.signalType || null;
    const previewBase = signalEmissionId
        ? `https://essence-ai.app/shopping-preview?domain=${encodeURIComponent(domain)}&signalId=${encodeURIComponent(String(signalEmissionId))}`
        : `https://essence-ai.app/preview-popup?domain=${encodeURIComponent(domain)}`;
    const previewUrl = signalType
        ? `${previewBase}&signalType=${encodeURIComponent(String(signalType))}`
        : previewBase;
    const start = Date.now();

    for (let attempt = 0; attempt < POPUP_FORM_GENERATE_MAX_ATTEMPTS; attempt += 1) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), POPUP_FORM_GENERATE_TIMEOUT_MS);
        try {
            console.log(
                `[popup-form/generate] calling for domain=${domain} attempt=${attempt + 1}/${POPUP_FORM_GENERATE_MAX_ATTEMPTS} timeoutMs=${POPUP_FORM_GENERATE_TIMEOUT_MS}`
            );
            const siteTrafficRaw = options.siteTraffic ?? options.estimatedVisitors;
            const siteTraffic = Number.isFinite(Number(siteTrafficRaw)) && Number(siteTrafficRaw) > 0
                ? Math.round(Number(siteTrafficRaw))
                : null;
            const bodyPayload = {
                domain,
                // Research-brief context (interested-research workflow only —
                // inline drafts have none). Additive: the generate API ignores
                // unknown keys until it branches on them.
                ...(options.industry ? { industry: options.industry } : {}),
                ...(options.companyName ? { companyName: options.companyName } : {}),
                ...(options.researchSummary ? { summary: options.researchSummary } : {}),
                ...(Array.isArray(options.talkingPoints) && options.talkingPoints.length
                    ? { talkingPoints: options.talkingPoints }
                    : {}),
                // Popup API key is siteTraffic → popup_leads.site_traffic.
                // Research brief keeps estimatedVisitors internally; map here.
                ...(siteTraffic ? { siteTraffic } : {}),
                ...(Number.isFinite(Number(options.reviewCount))
                    && Number(options.reviewCount) > 0
                    ? { reviewCount: Math.round(Number(options.reviewCount)) }
                    : {}),
                ...(options.signalEmissionId ? { signalEmissionId: options.signalEmissionId } : {}),
                ...(options.signalType ? { signalType: options.signalType } : {}),
                ...(options.observed ? { observed: options.observed } : {}),
                ...(options.expected ? { expected: options.expected } : {})
            };
            const response = await fetch(POPUP_FORM_GENERATE_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-Key': POPUP_FORM_API_KEY
                },
                body: JSON.stringify(bodyPayload),
                signal: controller.signal
            });
            const elapsed = Date.now() - start;
            if (!response.ok) {
                const retryable = response.status === 429 || response.status >= 500;
                console.warn(
                    `[popup-form/generate] non-200 response status=${response.status} domain=${domain} elapsed=${elapsed}ms attempt=${attempt + 1}/${POPUP_FORM_GENERATE_MAX_ATTEMPTS}`
                );
                if (retryable && attempt < POPUP_FORM_GENERATE_MAX_ATTEMPTS - 1) {
                    await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
                    continue;
                }
                return null;
            }
            console.log(`[popup-form/generate] success domain=${domain} elapsed=${elapsed}ms previewUrl=${previewUrl}`);
            return previewUrl;
        } catch (err) {
            const elapsed = Date.now() - start;
            const reason = err?.name === 'AbortError' ? 'timeout' : err.message;
            console.error(
                `[popup-form/generate] fetch error domain=${domain} elapsed=${elapsed}ms attempt=${attempt + 1}/${POPUP_FORM_GENERATE_MAX_ATTEMPTS}: ${reason}`
            );
            if (isPopupFormGenerateRetryableError(err) && attempt < POPUP_FORM_GENERATE_MAX_ATTEMPTS - 1) {
                await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
                continue;
            }
            return null;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    return null;
}

/**
 * Essence list-growth store preview (`preview-popup`) is campaign-opt-in.
 * "ESSENCE AI Email Generation" uses a `PREVIEW_URL` placeholder. Other
 * Essence Retention campaigns (e.g. Cut Klaviyo Bill) own their own Calendly
 * CTA and must not generate or inject a store preview.
 */
export function campaignUsesEssenceStorePreview({ campaignName, systemPrompt } = {}) {
    const prompt = String(systemPrompt || '');
    if (/\bPREVIEW_URL\b/.test(prompt)) return true;
    if (/essence-ai\.app\/(?:preview-popup|shopping-preview|preview)\b/i.test(prompt)) return true;
    return /essence\s*ai\s*email\s*generation/i.test(String(campaignName || ''));
}

/**
 * Decide whether this reply generates a store/audit preview and whether the
 * campaign prompt already owns the CTA (so generateDraftReply must not inject
 * the shopping-audit / Essence-AI-demo fallback).
 */
export function resolveReplyPreviewBehavior({ settings, campaignName, systemPrompt } = {}) {
    const useShoppingAuditReply = Boolean(settings?.shoppingAuditReply);
    const useActiveFungiStoryUrl = Boolean(settings?.useActiveFungiStoryUrl);
    const usesEssenceStorePreview = campaignUsesEssenceStorePreview({ campaignName, systemPrompt });
    const skipPopupPreview = Boolean(settings?.skipPopupPreview)
        || useActiveFungiStoryUrl
        || (!useShoppingAuditReply && !usesEssenceStorePreview);
    const systemPromptOwnsCta = useActiveFungiStoryUrl
        || (!useShoppingAuditReply && !usesEssenceStorePreview);
    return {
        useShoppingAuditReply,
        useActiveFungiStoryUrl,
        usesEssenceStorePreview,
        skipPopupPreview,
        systemPromptOwnsCta
    };
}

/**
 * Build the lead-magnet / audit preview URL for an interested reply.
 * Shopping-audit agencies (Vulcan) → POST vulcan-shopping-audit /api/audits.
 * Active Fungi / campaigns without PREVIEW_URL → no Essence popup.
 * Essence AI Email Generation → legacy Essence popup-form generate.
 */
export async function generateAuditPreviewUrl(leadEmail, options = {}) {
    const domain = normalizeAuditDomain(options.domain) || domainFromLeadEmail(leadEmail);
    if (!domain) return null;

    if (options.useVulcanShoppingAudit) {
        const triggered = await triggerVulcanShoppingAudit(domain, { waitForReady: options.waitForReady });
        return triggered || buildVulcanShoppingAuditUrl(domain);
    }

    if (options.skipPopupPreview) {
        console.log(
            `[popup-form/generate] skipped — Essence AI store preview not used for this reply domain=${domain}`
        );
        return null;
    }

    return callPopupFormGenerate(leadEmail, { ...options, domain });
}

function asTrimmedText(value) {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    return text || null;
}

export function getPublicAppBaseUrl() {
    const baseUrl = String(
        process.env.NEXT_PUBLIC_APP_URL
        || process.env.APP_BASE_URL
        || process.env.PUBLIC_APP_URL
        || 'https://shields-outbound-fulfill.vercel.app'
    ).trim();
    return baseUrl.replace(/\/$/, '');
}

export function buildReviewUrl(token) {
    return `${getPublicAppBaseUrl()}/interested-autoresponder/${encodeURIComponent(token)}`;
}

/**
 * Vulcan campaign prompts use a bare `AUDIT_URL` token (and sometimes `[AUDIT_URL]`)
 * as the audit href. If generation didn't receive a real URL, the model copies the
 * token into the HTML; the review page then treats it as a relative path
 * (`/interested-autoresponder/[AUDIT_URL]` → "Review draft not found").
 * Swap those placeholders for the real shopping-audit URL.
 */
export function applyReplyLinkPlaceholders(text, { auditUrl } = {}) {
    const source = text == null ? '' : String(text);
    const url = String(auditUrl || '').trim();
    if (!source || !url) return source;
    let out = source
        .replace(/https?:\/\/[^\s"'<>]*\/interested-autoresponder\/\[?AUDIT_URL\]?/gi, url)
        .replace(/\[AUDIT_URL\]/g, url)
        .replace(/AUDIT_URL/g, url)
        .replace(/\[PREVIEW_URL\]/g, url)
        .replace(/\bPREVIEW_URL\b/g, url);
    // Prompt copies sometimes emit <a href=""> when no audit URL was supplied.
    if (!/vulcan-shopping-audit(?:-[a-z0-9-]+)?\.vercel\.app/i.test(out)) {
        out = out.replace(/<a(\s+)href=(["'])\2/i, `<a$1href=$2${url}$2`);
    }
    return out;
}

export function withAuditUrlVars(vars, auditUrl) {
    const url = String(auditUrl || '').trim();
    if (!url) return vars || {};
    return { ...(vars || {}), audit_url: url };
}

export function generateReviewToken() {
    return crypto.randomBytes(32).toString('hex');
}

function escapeHtml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function linkifyEscapedText(escapedText) {
    // escapedText has already been HTML-escaped, but URLs with & are escaped as &amp;
    // We re-detect URLs in the original-ish form by reversing &amp; → & for URL matching
    return escapedText.replace(/https?:\/\/[^\s<>"']+/g, (url) => {
        const href = url.replace(/&amp;/g, '&');
        return `<a href="${href}" style="color:#2563eb;">${url}</a>`;
    });
}

function plainTextToHtml(text = '') {
    const trimmed = String(text || '').trim();
    if (!trimmed) return '';
    const paragraphs = trimmed
        .split(/\n{2,}/)
        .map((paragraph) => {
            const escaped = escapeHtml(paragraph).replace(/\n/g, '<br>');
            return `<p style="margin:0 0 1em 0;">${linkifyEscapedText(escaped)}</p>`;
        })
        .join('\n');
    return `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#222;">\n${paragraphs}\n</body></html>`;
}

function decodeBasicHtmlEntities(text = '') {
    return String(text || '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/gi, "'")
        .replace(/&#x2F;/gi, '/');
}

function htmlToPlainText(html = '') {
    if (!html || typeof html !== 'string') return '';

    let text = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '');

    text = text.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_match, attrs, label) => {
        const hrefMatch = String(attrs || '').match(/\bhref\s*=\s*["']([^"']+)["']/i);
        const href = decodeBasicHtmlEntities(hrefMatch?.[1] || '').trim();
        const cleanLabel = htmlToPlainText(label).trim();
        if (!href) return cleanLabel;
        if (!cleanLabel || cleanLabel === href) return href;
        return `${cleanLabel}: ${href}`;
    });

    return decodeBasicHtmlEntities(text)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<\/li>/gi, '\n')
        .replace(/<\/h[1-6]>/gi, '\n\n')
        .replace(/<\/blockquote>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function normalizeOutgoingReplyText(text = '') {
    const normalized = String(text || '').trim();
    if (!normalized) return '';
    const decoded = decodeBasicHtmlEntities(normalized);
    if (!/<\/?[a-z][\s\S]*>/i.test(normalized) && !/<\/?[a-z][\s\S]*>/i.test(decoded)) {
        return decoded;
    }
    return htmlToPlainText(decoded);
}

function buildReplySnippet(text = '') {
    if (!text) return null;
    const firstLine = String(text)
        .split('\n')
        .map((line) => line.trim())
        .find(Boolean);
    return firstLine || null;
}

export async function fetchPromptConfig(db, clientId, campaignId) {
    const result = await db.query(
        `SELECT p.id, p.campaign_id, p.version, p.system_prompt, p.active,
                ic.name AS campaign_name
         FROM interested_autoresponder_prompts p
         JOIN instantly_campaigns ic ON ic.id = p.campaign_id
         WHERE p.client_id = $1
           AND p.campaign_id = $2
           AND p.active = TRUE
         LIMIT 1`,
        [clientId, campaignId]
    );
    return result.rows[0] || null;
}

async function cancelSupersededOpenDrafts(db, contactId, campaignId) {
    const result = await db.query(
        `UPDATE interested_autoresponder_drafts
         SET status = 'cancelled',
             updated_at = NOW()
         WHERE contact_id = $1
           AND campaign_id = $2
           AND status = ANY($3::text[])
         RETURNING id`,
        [contactId, campaignId, OPEN_DRAFT_STATUSES]
    );
    return result.rows.map((row) => row.id);
}

/** Cancel open drafts when the lead's Instantly interest status is no longer "interested" (1). */
export async function cancelNonInterestedAutoResponderDrafts(db, contactId, campaignId) {
    const result = await db.query(
        `UPDATE interested_autoresponder_drafts d
         SET status = 'cancelled',
             updated_at = NOW()
         FROM contact_instantly_campaigns cic
         WHERE d.contact_id = $1
           AND d.campaign_id = $2
           AND d.contact_id = cic.contact_id
           AND d.campaign_id = cic.campaign_id
           AND d.status = ANY($3::text[])
           AND (
               COALESCE(cic.interest_status, -999) <> 1
               OR (
                   COALESCE(cic.last_event_type, '') <> ''
                   AND NOT (LOWER(cic.last_event_type) = ANY($4::text[]))
               )
           )
         RETURNING d.id`,
        [contactId, campaignId, OPEN_DRAFT_STATUSES, INTERESTED_PENDING_REVIEW_LAST_EVENT_TYPES]
    );
    return result.rows.map((row) => row.id);
}

/** Sweep stale open drafts for a client whose interest status has moved away from interested. */
export async function cancelStalePendingReviewDraftsForClient(db, clientId) {
    const result = await db.query(
        `UPDATE interested_autoresponder_drafts d
         SET status = 'cancelled',
             updated_at = NOW()
         FROM contact_instantly_campaigns cic
         WHERE d.client_id = $1
           AND d.contact_id = cic.contact_id
           AND d.campaign_id = cic.campaign_id
           AND d.status = 'pending_review'
           AND (
               COALESCE(cic.interest_status, -999) <> 1
               OR (
                   COALESCE(cic.last_event_type, '') <> ''
                   AND NOT (LOWER(cic.last_event_type) = ANY($2::text[]))
               )
           )
         RETURNING d.id`,
        [clientId, INTERESTED_PENDING_REVIEW_LAST_EVENT_TYPES]
    );
    return result.rows.map((row) => row.id);
}

async function fetchSourceEventDetails(db, sourceEventId) {
    const result = await db.query(
        `SELECT id, lead_email, message_text, reply_text_snippet, reply_category, payload
         FROM contact_instantly_events
         WHERE id = $1
         LIMIT 1`,
        [sourceEventId]
    );
    return result.rows[0] || null;
}

function extractMessageTextFromEventRow(row) {
    if (!row) return null;

    const direct = asTrimmedText(row.message_text) || asTrimmedText(row.reply_text_snippet);
    if (direct) return direct;

    let payload = row.payload;
    if (typeof payload === 'string') {
        try {
            payload = JSON.parse(payload);
        } catch {
            payload = null;
        }
    }
    if (!payload || typeof payload !== 'object') return null;

    const nested = payload.data && typeof payload.data === 'object' ? payload.data : null;
    return asTrimmedText(
        payload.message_text
        || payload.reply_text
        || payload.text
        || payload.body
        || payload.message
        || payload.reply_text_snippet
        || nested?.message_text
        || nested?.reply_text
        || nested?.text
        || nested?.body
    );
}

async function fetchRecentThreadMessages(db, contactId, campaignId, { limit = 5 } = {}) {
    const result = await db.query(
        `SELECT message_text, reply_text_snippet, payload, event_timestamp
         FROM contact_instantly_events
         WHERE contact_id = $1
           AND campaign_id = $2
           AND (
               message_text IS NOT NULL
               OR reply_text_snippet IS NOT NULL
               OR COALESCE(payload->>'message_text', '') <> ''
               OR COALESCE(payload->>'reply_text', '') <> ''
               OR COALESCE(payload->>'text', '') <> ''
           )
         ORDER BY event_timestamp DESC NULLS LAST, created_at DESC NULLS LAST
         LIMIT $3`,
        [contactId, campaignId, limit]
    );

    const parts = result.rows
        .slice()
        .reverse()
        .map((row) => extractMessageTextFromEventRow(row))
        .filter(Boolean);

    return parts.length ? parts.join('\n\n---\n\n') : null;
}

async function resolvePreviousLeadMessageForDraft(db, {
    sourceEvent,
    contactId,
    campaignId,
    replySourceEventId = null
}) {
    if (replySourceEventId) {
        const replyEvent = await fetchSourceEventDetails(db, replySourceEventId);
        const fromReply = extractMessageTextFromEventRow(replyEvent);
        if (fromReply) return fromReply;
    }

    const fromSource = extractMessageTextFromEventRow(sourceEvent);
    if (fromSource) return fromSource;

    return fetchRecentThreadMessages(db, contactId, campaignId);
}

async function fetchLatestThreadMetadata(db, contactId, campaignId) {
    const [subjectResult, threadReply] = await Promise.all([
        db.query(
            `SELECT COALESCE(
                NULLIF(BTRIM(e.payload->>'subject'), ''),
                NULLIF(BTRIM(e.payload->>'email_subject'), ''),
                NULLIF(BTRIM(e.payload->>'thread_subject'), ''),
                NULLIF(BTRIM(e.payload->>'reply_subject'), '')
            ) AS thread_subject
             FROM contact_instantly_events e
             WHERE e.contact_id = $1
               AND e.campaign_id = $2
               AND COALESCE(
                   NULLIF(BTRIM(e.payload->>'subject'), ''),
                   NULLIF(BTRIM(e.payload->>'email_subject'), ''),
                   NULLIF(BTRIM(e.payload->>'thread_subject'), ''),
                   NULLIF(BTRIM(e.payload->>'reply_subject'), '')
               ) IS NOT NULL
             ORDER BY e.event_timestamp DESC NULLS LAST, e.created_at DESC NULLS LAST
             LIMIT 1`,
            [contactId, campaignId]
        ),
        fetchThreadReplyMetadata(db, contactId, campaignId)
    ]);

    return {
        thread_subject: subjectResult.rows[0]?.thread_subject || null,
        reply_to_uuid: threadReply.reply_to_uuid || null,
        eaccount: threadReply.eaccount || null
    };
}

export async function fetchAgencyAndClientSettings(agencyId, clientIdOrSlug) {
    const [agencySettings, clientRow] = await Promise.all([
        getAgencySettings(agencyId),
        resolveClientRow(agencyId, clientIdOrSlug)
    ]);
    const clientSlug = String(clientRow?.slug || '').trim().toLowerCase();
    const useActiveFungiStoryUrl = clientSlug === ACTIVE_FUNGI_CLIENT_SLUG;
    return {
        openaiKey: asTrimmedText(agencySettings?.openai_key),
        ntfyTopic: asTrimmedText(clientRow?.ntfy_topic),
        instantlyKey: asTrimmedText(clientRow?.instantly_key),
        clientSlug: clientSlug || null,
        // Reply preview mechanism, NOT pipeline access: only agencies with
        // features.autoresponderShoppingAudit (Vulcan) build audit previews.
        // Essence list-growth popup is campaign-opt-in (PREVIEW_URL / ESSENCE
        // AI Email Generation); Active Fungi and Cut Klaviyo Bill skip it.
        shoppingAuditReply: hasInterestedReplyShoppingAuditFeature(agencySettings),
        skipPopupPreview: POPUP_PREVIEW_SKIP_CLIENT_SLUGS.has(clientSlug),
        // Durable research workflow before drafting — per-agency opt-in.
        replyResearchAgent: hasReplyResearchAgentFeature(agencySettings),
        // Active Fungi only: personalized story page via {{story_url}} — never
        // for other clients on this agency (Essence Retention, Vulcan, etc.).
        useActiveFungiStoryUrl
    };
}

async function resolveClientInstantlyKey(agencyId, clientId, cachedKey = null) {
    const fromDraft = asTrimmedText(cachedKey);
    if (fromDraft) return fromDraft;
    const clientRow = await getClientRowById(agencyId, clientId);
    return asTrimmedText(clientRow?.instantly_key);
}

export function normalizeRegenerateInstructions(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return null;
    return text.slice(0, MAX_REGENERATE_INSTRUCTIONS_LENGTH);
}

/**
 * Puts reviewer regenerate instructions above the campaign system prompt so they
 * win conflicts with campaign copy, CTA guidance, and the research brief.
 */
export function prependPriorityInstructions(systemPrompt, additionalInstructions) {
    const extra = normalizeRegenerateInstructions(additionalInstructions);
    const base = String(systemPrompt || '');
    if (!extra) return base;
    return [
        'HIGHEST PRIORITY — additional instructions from the reviewer for this regeneration.',
        'Follow these even if they conflict with the campaign system prompt, CTA guidance, or research brief below.',
        '',
        extra,
        '',
        '---',
        '',
        base
    ].join('\n');
}

export async function generateDraftReply({
    openaiKey,
    systemPrompt,
    campaignName,
    leadEmail,
    threadSubject,
    previousLeadMessage,
    auditPreviewUrl = null,
    essenceAiPreviewUrl = null,
    // Structured research brief ({ company, domain, industry, summary, talkingPoints,
    // risks, sources, reviewCount, estimatedVisitors })
    // produced by the interested-research workflow. Optional — inline drafts pass nothing.
    researchBrief = null,
    // When true, the campaign system prompt already owns the CTA (Active Fungi
    // story URL, Cut Klaviyo Bill Calendly, etc.). Skip shopping-audit /
    // Essence-AI-demo CTA instructions so they don't fight it.
    systemPromptOwnsCta = false,
    additionalInstructions = null
}) {
    const previewUrl = asTrimmedText(auditPreviewUrl) || asTrimmedText(essenceAiPreviewUrl);
    const client = new OpenAI({ apiKey: openaiKey });
    let ctaBlock = '';
    if (!systemPromptOwnsCta) {
        ctaBlock = previewUrl
            ? `CTA instruction: A personalized shopping ad audit has already been generated for this prospect's store. Use the Shopping audit URL above as the sole CTA link — link text should be "See what we built for your store". Do NOT include the Calendly booking link.`
            : `CTA instruction: Use the Calendly booking link as the CTA: https://calendly.com/essencesoftwaredevelopment/essence-ai-demo`;
    }
    const briefBlock = formatResearchBriefForPrompt(researchBrief);
    const effectiveSystemPrompt = applyReplyLinkPlaceholders(
        prependPriorityInstructions(systemPrompt, additionalInstructions),
        { auditUrl: previewUrl }
    );
    const response = await client.chat.completions.create({
        model: DEFAULT_MODEL,
        // temperature: 0.6,
        messages: [
            { role: 'system', content: effectiveSystemPrompt },
            {
                role: 'user',
                content: [
                    `Campaign: ${campaignName || 'Unknown campaign'}`,
                    `Lead email: ${leadEmail || 'Unknown lead'}`,
                    `Thread subject: ${threadSubject || '(use existing thread subject)'}`,
                    previewUrl && !systemPromptOwnsCta
                        ? [
                            `Shopping audit URL: ${previewUrl}`,
                            'Use that exact URL as the audit href. Never output AUDIT_URL, [AUDIT_URL], or any other placeholder in an <a> tag.'
                        ].join('\n')
                        : '',
                    '',
                    'Write a plain-text reply to the interested lead.',
                    'Do not include a subject line.',
                    'Do not use markdown.',
                    'Preserve the conversational context from the lead message below.',
                    '',
                    ctaBlock,
                    '',
                    briefBlock
                        ? [
                            'Research brief on the lead\'s company (verified via web research).',
                            'Use it to make the reply specific to their business — reference at most',
                            'one or two of these facts naturally; never invent facts beyond the brief:',
                            briefBlock,
                            ''
                        ].join('\n')
                        : '',
                    'Lead message/thread context:',
                    previousLeadMessage || '(no message text available)'
                ].filter(Boolean).join('\n')
            }
        ]
    });
    const content = response.choices?.[0]?.message?.content || '';
    return {
        model: response.model || DEFAULT_MODEL,
        renderedText: applyReplyLinkPlaceholders(String(content).trim(), { auditUrl: previewUrl })
    };
}

export async function sendNtfyNotification(topic, { leadEmail, campaignName, reviewUrl, isFollowUp = false }) {
    if (!topic) return { notified: false, reason: 'missing_topic' };

    const titlePrefix = isFollowUp
        ? 'New Response Follow-up Review'
        : 'Interested lead reply review';

    const response = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Title': `${titlePrefix}: ${leadEmail}`,
            'Tags': 'mailbox_with_mail,robot_face',
            'Click': reviewUrl
        },
        body: [
            `Lead: ${leadEmail}`,
            `Campaign: ${campaignName || 'Unknown campaign'}`,
            isFollowUp ? 'Type: Post-autoresponder follow-up' : null,
            `Review URL: ${reviewUrl}`
        ].filter(Boolean).join('\n')
    });

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`ntfy notification failed (${response.status}): ${text || response.statusText}`);
    }

    return { notified: true };
}

/** Instantly POST /emails/reply requires `subject`; use thread subject or a minimal fallback. */
export function resolveInstantlyReplySubject(threadSubject) {
    return asTrimmedText(threadSubject) || 'Re:';
}

async function fetchInstantlyEmailSubject(apiKey, emailId) {
    const id = asTrimmedText(emailId);
    if (!apiKey || !id) return null;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), INSTANTLY_REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(`${INSTANTLY_API_BASE_URL}/api/v2/emails/${encodeURIComponent(id)}`, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                Accept: 'application/json'
            },
            signal: controller.signal
        });
        if (!response.ok || response.status === 204) return null;
        const email = await response.json().catch(() => null);
        return asTrimmedText(email?.subject || email?.email_subject || email?.reply_subject || null);
    } catch {
        return null;
    } finally {
        clearTimeout(timeoutId);
    }
}

async function sendInstantlyReplyDirect(apiKey, replyPayload) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), INSTANTLY_REQUEST_TIMEOUT_MS);
        try {
            const response = await fetch(`${INSTANTLY_API_BASE_URL}/api/v2/emails/reply`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    Accept: 'application/json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(replyPayload),
                signal: controller.signal
            });

            if (!response.ok) {
                const text = await response.text().catch(() => '');
                const retryable = response.status === 429 || response.status >= 500;
                if (retryable && attempt < 2) {
                    await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
                    continue;
                }
                const error = new Error(`Instantly reply failed (${response.status}): ${text || response.statusText}`);
                error.statusCode = response.status;
                throw error;
            }

            if (response.status === 204) return null;
            return response.json();
        } catch (error) {
            if (attempt < 2 && (error?.name === 'AbortError' || error instanceof TypeError)) {
                await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
                continue;
            }
            throw error;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    return null;
}

function stripQuotedReplyThread(messageText = '') {
    const lines = String(messageText || '').split('\n');
    const kept = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (/^On .+ wrote:$/i.test(trimmed)) break;
        if (/^>{1,}\s/.test(trimmed)) break;
        if (/^From:\s/i.test(trimmed) && kept.length > 3) break;
        kept.push(line);
    }
    return kept.join('\n').trim();
}

/** Whether a post-autoresponder inbound reply is positive/neutral enough to draft a response. */
export function isEligiblePostAutoresponderReplyCategory(replyCategory, interestStatus) {
    if (asNullableInt(interestStatus) !== 1) return false;
    const category = String(replyCategory || '').trim().toLowerCase();
    if (category === 'negative') return false;
    if (category === 'positive' || category === 'neutral') return true;
    // reply_received webhooks often land as "other" while Instantly still marks the lead interested.
    return category === 'other' || category === '';
}

/** Lead asked a question or sent substantive follow-up content worth replying to. */
export function leadReplyMessageAsksOrEngages(messageText) {
    const text = stripQuotedReplyThread(messageText);
    if (!text || text.length < 15) return false;

    if (/\?/.test(text)) return true;

    const minimal = text.replace(/\s+/g, ' ').trim().toLowerCase();
    if (/^(thanks|thank you|ok|okay|got it|will do|sounds good|perfect|great)\.?!?$/.test(minimal)) {
        return false;
    }

    return text.length >= 20;
}

function asNullableInt(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) ? parsed : null;
}

async function hasOpenInterestedAutoresponderDraft(db, contactId, campaignId) {
    const result = await db.query(
        `SELECT 1
         FROM interested_autoresponder_drafts
         WHERE contact_id = $1
           AND campaign_id = $2
           AND status = ANY($3::text[])
         LIMIT 1`,
        [contactId, campaignId, OPEN_DRAFT_STATUSES]
    );
    return result.rowCount > 0;
}

async function hasDraftForSourceEvent(db, sourceEventId) {
    const result = await db.query(
        `SELECT 1
         FROM interested_autoresponder_drafts
         WHERE source_event_id = $1
         LIMIT 1`,
        [sourceEventId]
    );
    return result.rowCount > 0;
}

async function hasSentAutoresponderBeforeReplyEvent(db, contactId, campaignId, replyEventId) {
    const result = await db.query(
        `SELECT EXISTS (
            SELECT 1
            FROM contact_instantly_events sent
            JOIN contact_instantly_events reply ON reply.id = $3
            WHERE sent.contact_id = $1
              AND sent.campaign_id = $2
              AND sent.event_type = 'interested_reply_sent'
              AND sent.event_timestamp < reply.event_timestamp
         ) OR EXISTS (
            SELECT 1
            FROM interested_autoresponder_drafts d
            JOIN contact_instantly_events reply ON reply.id = $3
            WHERE d.contact_id = $1
              AND d.campaign_id = $2
              AND d.status = 'sent'
              AND d.sent_at IS NOT NULL
              AND d.sent_at < reply.event_timestamp
         ) AS has_prior_autoresponder`,
        [contactId, campaignId, replyEventId]
    );
    return result.rows[0]?.has_prior_autoresponder === true;
}

/**
 * After we've sent an interested autoresponder, create a new review draft when the lead
 * sends another positive/neutral follow-up that asks or engages substantively.
 */
export async function maybeCreatePostAutoresponderFollowUpDraft({
    agencyId,
    clientSlug,
    clientId,
    campaignId,
    contactId,
    instantlyLeadId,
    leadEmail,
    replyEventId,
    interestStatus = null,
    replyCategory = null,
    logger = () => {}
}) {
    if (!campaignId || !contactId || !replyEventId) {
        return { created: false, reason: 'missing_required_context' };
    }

    if (await hasDraftForSourceEvent(pool, replyEventId)) {
        return { created: false, reason: 'draft_already_exists_for_reply' };
    }

    if (await hasOpenInterestedAutoresponderDraft(pool, contactId, campaignId)) {
        return { created: false, reason: 'open_draft_exists' };
    }

    const priorAutoresponder = await hasSentAutoresponderBeforeReplyEvent(
        pool,
        contactId,
        campaignId,
        replyEventId
    );
    if (!priorAutoresponder) {
        return { created: false, reason: 'no_prior_autoresponder' };
    }

    let resolvedInterestStatus = asNullableInt(interestStatus);
    if (resolvedInterestStatus === null) {
        const campaignState = await pool.query(
            `SELECT interest_status
             FROM contact_instantly_campaigns
             WHERE contact_id = $1 AND campaign_id = $2
             LIMIT 1`,
            [contactId, campaignId]
        );
        resolvedInterestStatus = asNullableInt(campaignState.rows[0]?.interest_status);
    }

    const replyEvent = await fetchSourceEventDetails(pool, replyEventId);
    const resolvedReplyCategory = asTrimmedText(replyCategory)
        || asTrimmedText(replyEvent?.reply_category)
        || 'other';

    if (!isEligiblePostAutoresponderReplyCategory(resolvedReplyCategory, resolvedInterestStatus)) {
        return {
            created: false,
            reason: 'ineligible_reply_category',
            replyCategory: resolvedReplyCategory,
            interestStatus: resolvedInterestStatus
        };
    }

    const messageText = extractMessageTextFromEventRow(replyEvent);
    if (!leadReplyMessageAsksOrEngages(messageText)) {
        return { created: false, reason: 'reply_not_engaged' };
    }

    logger(
        `[interested-autoresponder] post-autoresponder follow-up draft for contact=${contactId}`
        + ` campaign=${campaignId} replyEvent=${replyEventId}`
    );

    return createInterestedAutoResponderDraftFromEvent({
        agencyId,
        clientSlug,
        clientId,
        campaignId,
        contactId,
        instantlyLeadId,
        sourceEventId: replyEventId,
        replySourceEventId: replyEventId,
        leadEmail,
        isFollowUp: true,
        logger
    });
}

/**
 * Precomputed shopping-audit signal + company domain for a contact. Best-effort:
 * the joins are optional and a lookup failure must never block a draft.
 */
export async function resolveContactSignalContext(db, contactId) {
    try {
        const result = await db.query(
            `SELECT c.signal_emission_id, se.signal_type, se.observed, se.expected,
                    co.domain_normalized AS company_domain
             FROM contacts c
             LEFT JOIN signal_emissions se ON se.id = c.signal_emission_id
             LEFT JOIN companies co ON co.id = c.company_id
             WHERE c.id = $1`,
            [contactId]
        );
        return result.rows[0] || {};
    } catch (signalErr) {
        console.warn('[interested-autoresponder] signal lookup skipped:', signalErr?.message || signalErr);
        return {};
    }
}

async function insertDraftRow(db, draft) {
    const result = await db.query(
        `INSERT INTO interested_autoresponder_drafts (
            agency_id, client_id, campaign_id, contact_id, instantly_lead_id, source_event_id,
            review_token, review_token_expires_at, status, blocked_reason, reply_to_uuid, eaccount,
            thread_subject, lead_email, previous_lead_message, system_prompt_version, model, rendered_text
        )
        VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10, $11, $12,
            $13, $14, $15, $16, $17, $18
        )
        RETURNING *`,
        [
            draft.agency_id,
            draft.client_id,
            draft.campaign_id,
            draft.contact_id,
            draft.instantly_lead_id,
            draft.source_event_id,
            draft.review_token,
            draft.review_token_expires_at,
            draft.status,
            draft.blocked_reason,
            draft.reply_to_uuid,
            draft.eaccount,
            draft.thread_subject,
            draft.lead_email,
            draft.previous_lead_message,
            draft.system_prompt_version,
            draft.model,
            draft.rendered_text
        ]
    );
    return result.rows[0] || null;
}

export async function createInterestedAutoResponderDraftFromEvent({
    agencyId,
    clientSlug,
    clientId,
    campaignId,
    contactId,
    instantlyLeadId,
    sourceEventId,
    replySourceEventId = null,
    leadEmail,
    isFollowUp = false,
    logger = () => {}
}) {
    if (!campaignId || !contactId || !sourceEventId) {
        return { created: false, reason: 'missing_required_context' };
    }

    const client = await pool.connect();
    try {
        const [promptConfig, sourceEvent, threadMetadata, settings] = await Promise.all([
            fetchPromptConfig(client, clientId, campaignId),
            fetchSourceEventDetails(client, sourceEventId),
            fetchLatestThreadMetadata(client, contactId, campaignId),
            fetchAgencyAndClientSettings(agencyId, clientId)
        ]);

        if (!promptConfig) {
            return { created: false, reason: 'missing_active_prompt' };
        }

        const cancelledDraftIds = await cancelSupersededOpenDrafts(client, contactId, campaignId);
        if (cancelledDraftIds.length) {
            logger(`[interested-autoresponder] cancelled superseded drafts for contact=${contactId} campaign=${campaignId}: ${cancelledDraftIds.join(', ')}`);
        }

        const previousLeadMessage = await resolvePreviousLeadMessageForDraft(client, {
            sourceEvent,
            contactId,
            campaignId,
            replySourceEventId
        });
        const normalizedLeadEmail = asTrimmedText(leadEmail)
            || asTrimmedText(sourceEvent?.lead_email)
            || '';
        const replyToUuid = asTrimmedText(threadMetadata.reply_to_uuid);
        const eaccount = asTrimmedText(threadMetadata.eaccount);
        const threadSubject = asTrimmedText(threadMetadata.thread_subject);

        if (!replyToUuid || !eaccount) {
            const blockedDraft = await insertDraftRow(client, {
                agency_id: agencyId,
                client_id: clientId,
                campaign_id: campaignId,
                contact_id: contactId,
                instantly_lead_id: instantlyLeadId || null,
                source_event_id: sourceEventId,
                review_token: null,
                review_token_expires_at: null,
                status: 'blocked_missing_thread',
                blocked_reason: 'missing_thread_metadata',
                reply_to_uuid: replyToUuid,
                eaccount,
                thread_subject: threadSubject,
                lead_email: normalizedLeadEmail,
                previous_lead_message: previousLeadMessage,
                system_prompt_version: promptConfig.version,
                model: DEFAULT_MODEL,
                rendered_text: null
            });
            return { created: false, reason: 'blocked_missing_thread', draftId: blockedDraft?.id || null };
        }

        if (!settings.openaiKey) {
            const failedDraft = await insertDraftRow(client, {
                agency_id: agencyId,
                client_id: clientId,
                campaign_id: campaignId,
                contact_id: contactId,
                instantly_lead_id: instantlyLeadId || null,
                source_event_id: sourceEventId,
                review_token: null,
                review_token_expires_at: null,
                status: 'generation_failed',
                blocked_reason: 'missing_openai_key',
                reply_to_uuid: replyToUuid,
                eaccount,
                thread_subject: threadSubject,
                lead_email: normalizedLeadEmail,
                previous_lead_message: previousLeadMessage,
                system_prompt_version: promptConfig.version,
                model: DEFAULT_MODEL,
                rendered_text: null
            });
            return { created: false, reason: 'missing_openai_key', draftId: failedDraft?.id || null };
        }

        // Durable research path (per-agency flag): insert the draft shell as
        // 'researching' and hand off to the Vercel Workflow, which researches the
        // lead, stores the brief, builds the popup, generates the reply, and
        // promotes the draft to pending_review (+ ntfy). Trigger failure falls
        // back to the inline path below — an interested lead must never lose its
        // draft to an unreachable workflow runtime.
        if (settings.replyResearchAgent && isInterestedResearchWorkflowConfigured()) {
            const researchDraft = await insertDraftRow(client, {
                agency_id: agencyId,
                client_id: clientId,
                campaign_id: campaignId,
                contact_id: contactId,
                instantly_lead_id: instantlyLeadId || null,
                source_event_id: sourceEventId,
                review_token: null,
                review_token_expires_at: null,
                status: 'researching',
                blocked_reason: null,
                reply_to_uuid: replyToUuid,
                eaccount,
                thread_subject: threadSubject,
                lead_email: normalizedLeadEmail,
                previous_lead_message: previousLeadMessage,
                system_prompt_version: promptConfig.version,
                model: DEFAULT_MODEL,
                rendered_text: null
            });
            try {
                await triggerInterestedResearchWorkflow({
                    draftId: researchDraft.id,
                    agencyId,
                    isFollowUp
                });
                logger(
                    `[interested-autoresponder] research workflow started draft=${researchDraft.id}`
                    + ` contact=${contactId} campaign=${campaignId}`
                );
                return { created: true, researching: true, draftId: researchDraft.id, reviewUrl: null };
            } catch (error) {
                logger(
                    `[interested-autoresponder] research workflow trigger failed draft=${researchDraft.id}`
                    + ` — falling back to inline generation: ${error.message}`
                );
                // Free the open-thread slot so the inline insert below succeeds.
                await client.query(
                    `UPDATE interested_autoresponder_drafts
                     SET status = 'cancelled',
                         blocked_reason = 'research_trigger_failed',
                         updated_at = NOW()
                     WHERE id = $1 AND status = 'researching'`,
                    [researchDraft.id]
                );
            }
        }

        let generation;
        try {
            const signalRow = await resolveContactSignalContext(client, contactId);
            const auditDomain = normalizeAuditDomain(signalRow.company_domain)
                || domainFromLeadEmail(normalizedLeadEmail);
            const preview = resolveReplyPreviewBehavior({
                settings,
                campaignName: promptConfig.campaign_name,
                systemPrompt: promptConfig.system_prompt
            });
            const useShoppingAuditReply = preview.useShoppingAuditReply;
            const useActiveFungiStoryUrl = preview.useActiveFungiStoryUrl;
            const [auditPreviewUrl, resolvedTemplateVars] = await Promise.all([
                generateAuditPreviewUrl(normalizedLeadEmail, {
                    domain: auditDomain,
                    useVulcanShoppingAudit: useShoppingAuditReply,
                    skipPopupPreview: preview.skipPopupPreview,
                    // Signal context only for shopping-audit reply agencies: passing it
                    // for anyone else flips the popup-form call into the shopping-
                    // preview ad, which list-growth agencies must never send.
                    ...(useShoppingAuditReply
                        ? {
                            signalEmissionId: signalRow.signal_emission_id || null,
                            signalType: signalRow.signal_type || null,
                            observed: signalRow.observed || null,
                            expected: signalRow.expected || null
                        }
                        : {})
                }),
                resolveTemplateVars(client, contactId, campaignId, {
                    clientId,
                    emailAccount: eaccount
                })
            ]);
            const templateVars = useActiveFungiStoryUrl
                ? applyActiveFungiStoryUrlToTemplateVars(resolvedTemplateVars, { domain: auditDomain })
                : withAuditUrlVars(resolvedTemplateVars, auditPreviewUrl);
            if (useActiveFungiStoryUrl) {
                logger(`[interested-autoresponder] active-fungi story_url=${templateVars.story_url}`);
            }
            const renderedSystemPrompt = renderTemplate(promptConfig.system_prompt, templateVars);
            generation = await generateDraftReply({
                openaiKey: settings.openaiKey,
                systemPrompt: renderedSystemPrompt,
                campaignName: promptConfig.campaign_name,
                leadEmail: normalizedLeadEmail,
                threadSubject,
                previousLeadMessage,
                // Never feed the Active Fungi story URL into the shopping-audit CTA path.
                auditPreviewUrl: useActiveFungiStoryUrl ? null : auditPreviewUrl,
                systemPromptOwnsCta: preview.systemPromptOwnsCta
            });
        } catch (error) {
            const failedDraft = await insertDraftRow(client, {
                agency_id: agencyId,
                client_id: clientId,
                campaign_id: campaignId,
                contact_id: contactId,
                instantly_lead_id: instantlyLeadId || null,
                source_event_id: sourceEventId,
                review_token: null,
                review_token_expires_at: null,
                status: 'generation_failed',
                blocked_reason: error.message || 'generation_failed',
                reply_to_uuid: replyToUuid,
                eaccount,
                thread_subject: threadSubject,
                lead_email: normalizedLeadEmail,
                previous_lead_message: previousLeadMessage,
                system_prompt_version: promptConfig.version,
                model: DEFAULT_MODEL,
                rendered_text: null
            });
            return { created: false, reason: 'generation_failed', draftId: failedDraft?.id || null };
        }

        const reviewToken = generateReviewToken();
        const reviewTokenExpiresAt = new Date(Date.now() + REVIEW_TOKEN_TTL_MS).toISOString();
        const savedDraft = await insertDraftRow(client, {
            agency_id: agencyId,
            client_id: clientId,
            campaign_id: campaignId,
            contact_id: contactId,
            instantly_lead_id: instantlyLeadId || null,
            source_event_id: sourceEventId,
            review_token: reviewToken,
            review_token_expires_at: reviewTokenExpiresAt,
            status: 'pending_review',
            blocked_reason: null,
            reply_to_uuid: replyToUuid,
            eaccount,
            thread_subject: threadSubject,
            lead_email: normalizedLeadEmail,
            previous_lead_message: previousLeadMessage,
            system_prompt_version: promptConfig.version,
            model: generation.model,
            rendered_text: generation.renderedText
        });

        if (settings.ntfyTopic && savedDraft?.review_token) {
            const reviewUrl = buildReviewUrl(savedDraft.review_token);
            try {
                await sendNtfyNotification(settings.ntfyTopic, {
                    leadEmail: normalizedLeadEmail,
                    campaignName: promptConfig.campaign_name,
                    reviewUrl,
                    isFollowUp
                });
            } catch (error) {
                logger(`[interested-autoresponder] ntfy notification failed for draft=${savedDraft.id}: ${error.message}`);
            }
        }

        return {
            created: true,
            draftId: savedDraft?.id || null,
            reviewUrl: savedDraft?.review_token ? buildReviewUrl(savedDraft.review_token) : null
        };
    } finally {
        client.release();
    }
}

async function loadDraftByReviewToken(token) {
    const result = await pool.query(
        `SELECT d.*,
                ic.name AS campaign_name,
                ic.instantly_campaign_id,
                c.slug AS client_slug,
                c.instantly_key AS client_instantly_key,
                c.warm_follow_up_interest_value AS client_warm_follow_up_interest_value,
                c.warm_follow_up_interest_label AS client_warm_follow_up_interest_label,
                co.domain_normalized AS company_domain
         FROM interested_autoresponder_drafts d
         JOIN instantly_campaigns ic ON ic.id = d.campaign_id
         JOIN clients c ON c.id = d.client_id AND c.agency_id = d.agency_id
         LEFT JOIN contacts ct ON ct.id = d.contact_id
         LEFT JOIN companies co ON co.id = ct.company_id
         WHERE d.review_token = $1
         LIMIT 1`,
        [token]
    );
    const draft = result.rows[0] || null;
    if (!draft) {
        const error = new Error('Review draft not found.');
        error.statusCode = 404;
        throw error;
    }
    if (draft.review_token_expires_at && new Date(draft.review_token_expires_at).getTime() < Date.now()) {
        await pool.query(
            `UPDATE interested_autoresponder_drafts
             SET status = 'expired', updated_at = NOW()
             WHERE id = $1 AND status <> 'sent'`,
            [draft.id]
        );
        const error = new Error('Review link has expired.');
        error.statusCode = 410;
        throw error;
    }
    return draft;
}

async function loadPendingReviewDraft(token) {
    const draft = await loadDraftByReviewToken(token);
    if (draft.status === 'researching') {
        const error = new Error('Draft is regenerating. Please wait for it to finish.');
        error.statusCode = 409;
        throw error;
    }
    if (draft.status !== 'pending_review') {
        const error = new Error('Review draft is no longer available.');
        error.statusCode = 409;
        throw error;
    }
    return draft;
}

function serializeReviewDraft(draft) {
    const website = resolveLeadWebsite(draft.company_domain, draft.lead_email);
    return {
        id: draft.id,
        leadEmail: draft.lead_email,
        campaignName: draft.campaign_name,
        previousLeadMessage: draft.previous_lead_message,
        renderedText: applyReplyLinkPlaceholders(draft.rendered_text, {
            auditUrl: buildVulcanShoppingAuditUrl(website.domain)
        }),
        expiresAt: draft.review_token_expires_at,
        status: draft.status,
        websiteDomain: website.domain,
        websiteUrl: website.url
    };
}

export async function getInterestedAutoResponderDraftByToken(token) {
    const draft = await loadDraftByReviewToken(token);
    if (draft.status !== 'pending_review' && draft.status !== 'researching') {
        const error = new Error('Review draft is no longer available.');
        error.statusCode = 409;
        throw error;
    }
    return serializeReviewDraft(draft);
}

export async function updateInterestedAutoResponderDraftTextByToken({ token, renderedText }) {
    const normalizedText = String(renderedText || '').trim();
    if (!normalizedText) {
        const error = new Error('Reply text is required.');
        error.statusCode = 400;
        throw error;
    }

    const draft = await loadPendingReviewDraft(token);
    const result = await pool.query(
        `UPDATE interested_autoresponder_drafts
         SET rendered_text = $2,
             updated_at = NOW()
         WHERE id = $1
         RETURNING id, rendered_text, review_token_expires_at`,
        [draft.id, normalizedText]
    );
    return {
        id: result.rows[0].id,
        renderedText: result.rows[0].rendered_text,
        expiresAt: result.rows[0].review_token_expires_at
    };
}

async function persistSentAutoResponderActivity(db, {
    draftId,
    agencyId,
    clientId,
    campaignId,
    contactId,
    instantlyCampaignId,
    instantlyLeadId,
    leadEmail,
    eaccount,
    threadSubject,
    sentReplyId,
    parentReplyToUuid,
    renderedText
}) {
    const eventTimestamp = new Date().toISOString();
    const fingerprint = crypto.createHash('sha256').update(`interested-autoresponder-email-sent|${draftId}`).digest('hex');
    const payload = {
        event_type: 'interested_reply_sent',
        source: 'interested_autoresponder',
        subject: threadSubject || null,
        email_subject: threadSubject || null,
        email_text: renderedText || null,
        email_html: plainTextToHtml(renderedText || ''),
        email_id: sentReplyId || null,
        parent_reply_to_uuid: parentReplyToUuid || null,
        interested_autoresponder_draft_id: draftId
    };

    const result = await db.query(
        `INSERT INTO contact_instantly_events (
            agency_id, client_id, contact_id, campaign_id, instantly_campaign_id, instantly_lead_id,
            event_type, reply_category, lead_email, email_account, message_text,
            reply_text_snippet, reply_to_uuid, event_timestamp, fingerprint, source, payload
        )
        VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10, $11,
            $12, $13, $14, $15, $16, $17::jsonb
        )
        ON CONFLICT (source, fingerprint) DO NOTHING
        RETURNING id`,
        [
            agencyId,
            clientId,
            contactId,
            campaignId,
            instantlyCampaignId || null,
            instantlyLeadId || null,
            'interested_reply_sent',
            null,
            leadEmail || null,
            eaccount || null,
            renderedText || null,
            buildReplySnippet(renderedText || ''),
            sentReplyId || parentReplyToUuid || null,
            eventTimestamp,
            fingerprint,
            'interested_autoresponder',
            JSON.stringify(payload)
        ]
    );
    return result.rows[0]?.id || null;
}

export async function sendInterestedAutoResponderDraftByToken({ token }) {
    const draft = await loadPendingReviewDraft(token);
    const metadata = await fetchLatestThreadMetadata(pool, draft.contact_id, draft.campaign_id);
    const replyToUuid = asTrimmedText(metadata.reply_to_uuid) || asTrimmedText(draft.reply_to_uuid);
    const eaccount = asTrimmedText(metadata.eaccount) || asTrimmedText(draft.eaccount);
    const threadSubject = asTrimmedText(metadata.thread_subject) || asTrimmedText(draft.thread_subject);

    if (!replyToUuid || !eaccount) {
        const error = new Error('Thread metadata is missing for this draft.');
        error.statusCode = 409;
        throw error;
    }

    const clientInstantlyKey = await resolveClientInstantlyKey(
        draft.agency_id,
        draft.client_id,
        draft.client_instantly_key
    );
    if (!clientInstantlyKey) {
        const error = new Error('Missing Instantly API key for this client. Add it under client settings.');
        error.statusCode = 500;
        throw error;
    }

    // Instantly requires `subject` on /emails/reply. Backfilled / webhook events often omit it.
    let resolvedSubject = threadSubject;
    if (!resolvedSubject) {
        resolvedSubject = await fetchInstantlyEmailSubject(clientInstantlyKey, replyToUuid);
        if (resolvedSubject) {
            await pool.query(
                `UPDATE interested_autoresponder_drafts
                 SET thread_subject = $2, updated_at = NOW()
                 WHERE id = $1
                   AND (thread_subject IS NULL OR BTRIM(thread_subject) = '')`,
                [draft.id, resolvedSubject]
            );
        }
    }
    resolvedSubject = resolveInstantlyReplySubject(resolvedSubject);

    const website = resolveLeadWebsite(draft.company_domain, draft.lead_email);
    const renderedHtml = applyReplyLinkPlaceholders(
        String(draft.rendered_text || '').trim(),
        { auditUrl: buildVulcanShoppingAuditUrl(website.domain) }
    );
    const outgoingText = normalizeOutgoingReplyText(renderedHtml);
    const isHtml = /<\/?[a-z][\s\S]*>/i.test(renderedHtml);
    const replyPayload = {
        reply_to_uuid: replyToUuid,
        eaccount,
        subject: resolvedSubject,
        body: {
            html: isHtml ? decodeBasicHtmlEntities(renderedHtml) : plainTextToHtml(outgoingText)
        }
    };

    const replyResult = await sendInstantlyReplyDirect(clientInstantlyKey, replyPayload);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const sentEventId = await persistSentAutoResponderActivity(client, {
            draftId: draft.id,
            agencyId: draft.agency_id,
            clientId: draft.client_id,
            campaignId: draft.campaign_id,
            contactId: draft.contact_id,
            instantlyCampaignId: draft.instantly_campaign_id,
            instantlyLeadId: draft.instantly_lead_id,
            leadEmail: draft.lead_email,
            eaccount,
            threadSubject: resolvedSubject,
            sentReplyId: replyResult?.id || replyResult?.email_id || null,
            parentReplyToUuid: replyToUuid,
            renderedText: outgoingText
        });
        await persistWarmFollowUpAnchorFromAutoresponder(client, {
            draftId: draft.id,
            agencyId: draft.agency_id,
            clientId: draft.client_id,
            contactId: draft.contact_id,
            campaignId: draft.campaign_id,
            instantlyCampaignId: draft.instantly_campaign_id,
            instantlyLeadId: draft.instantly_lead_id,
            leadEmail: draft.lead_email,
            eaccount,
            autoresponderSentEventId: sentEventId
        });
        await client.query(
            `UPDATE interested_autoresponder_drafts
             SET status = 'sent',
                 sent_event_id = $2,
                 sent_at = NOW(),
                 updated_at = NOW()
             WHERE id = $1`,
            [draft.id, sentEventId]
        );
        await client.query('COMMIT');

        // Best-effort Instantly status update ("Warm Follow Up" label) after the
        // send is committed: never blocks the response; outcome markers/logs are
        // handled inside the service.
        applyWarmFollowUpStatusAfterAutoresponderSend({
            draftId: draft.id,
            agencyId: draft.agency_id,
            clientId: draft.client_id,
            contactId: draft.contact_id,
            campaignId: draft.campaign_id,
            instantlyCampaignId: draft.instantly_campaign_id,
            instantlyLeadId: draft.instantly_lead_id,
            leadEmail: draft.lead_email,
            apiKey: clientInstantlyKey,
            statusConfig: resolveWarmFollowUpStatusConfig({
                warm_follow_up_interest_value: draft.client_warm_follow_up_interest_value,
                warm_follow_up_interest_label: draft.client_warm_follow_up_interest_label
            }),
            logger: (message) => console.log(message)
        }).catch((error) => {
            console.error(`[warm-follow-up-label] unexpected error draft=${draft.id}:`, error?.message || error);
        });

        return { sent: true, sentEventId };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

export async function cancelInterestedAutoResponderDraftByToken({ token }) {
    const draft = await loadPendingReviewDraft(token);
    await pool.query(
        `UPDATE interested_autoresponder_drafts
         SET status = 'cancelled',
             review_token = NULL,
             review_token_expires_at = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [draft.id]
    );
    return { cancelled: true, id: draft.id };
}

/**
 * Re-run research + popup + reply generation for a pending_review draft, keeping
 * the same review token/URL. Prefer the durable research workflow when enabled;
 * otherwise regenerate inline (popup generate + draft reply).
 */
export async function regenerateInterestedAutoResponderDraftByToken({ token, additionalInstructions = null }) {
    const draft = await loadPendingReviewDraft(token);
    const settings = await fetchAgencyAndClientSettings(draft.agency_id, draft.client_id);
    if (!settings.openaiKey) {
        const error = new Error('No OpenAI API key configured for this agency.');
        error.statusCode = 400;
        throw error;
    }

    const promptConfig = await fetchPromptConfig(pool, draft.client_id, draft.campaign_id);
    if (!promptConfig) {
        const error = new Error('No active auto-responder prompt for this campaign.');
        error.statusCode = 400;
        throw error;
    }

    const extraInstructions = normalizeRegenerateInstructions(additionalInstructions);
    const useResearchPath = Boolean(settings.replyResearchAgent)
        && isInterestedResearchWorkflowConfigured();

    if (useResearchPath) {
        const reset = await pool.query(
            `UPDATE interested_autoresponder_drafts
             SET status = 'researching',
                 research_brief = NULL,
                 research_completed_at = NULL,
                 blocked_reason = NULL,
                 updated_at = NOW()
             WHERE id = $1 AND status = 'pending_review'
             RETURNING id`,
            [draft.id]
        );
        if (!reset.rowCount) {
            const error = new Error('Draft is no longer available to regenerate.');
            error.statusCode = 409;
            throw error;
        }

        try {
            await triggerInterestedResearchWorkflow({
                draftId: draft.id,
                agencyId: draft.agency_id,
                skipNtfy: true,
                additionalInstructions: extraInstructions
            });
            return {
                regenerating: true,
                status: 'researching',
                draftId: draft.id,
                draft: serializeReviewDraft({ ...draft, status: 'researching' })
            };
        } catch (error) {
            console.error(
                `[interested-autoresponder] regenerate workflow trigger failed draft=${draft.id}`
                + ` — falling back to inline: ${error?.message || error}`
            );
            // Fall through to inline regen below (draft is still 'researching').
        }
    }

    const regenerated = await regenerateDraftInline({
        draft,
        settings,
        promptConfig,
        additionalInstructions: extraInstructions
    });
    return {
        regenerating: false,
        regenerated: true,
        status: 'pending_review',
        draftId: draft.id,
        draft: regenerated
    };
}

/** Popup (or Vulcan/story) + reply generation in-process; restores pending_review. */
async function regenerateDraftInline({ draft, settings, promptConfig, additionalInstructions = null }) {
    const signalRow = await resolveContactSignalContext(pool, draft.contact_id);
    const auditDomain = normalizeAuditDomain(signalRow.company_domain)
        || domainFromLeadEmail(draft.lead_email);
    const preview = resolveReplyPreviewBehavior({
        settings,
        campaignName: promptConfig.campaign_name,
        systemPrompt: promptConfig.system_prompt
    });
    const useShoppingAuditReply = preview.useShoppingAuditReply;
    const useActiveFungiStoryUrl = preview.useActiveFungiStoryUrl;

    const [auditPreviewUrl, resolvedTemplateVars] = await Promise.all([
        generateAuditPreviewUrl(draft.lead_email, {
            domain: auditDomain,
            useVulcanShoppingAudit: useShoppingAuditReply,
            skipPopupPreview: preview.skipPopupPreview,
            ...(useShoppingAuditReply
                ? {
                    signalEmissionId: signalRow.signal_emission_id || null,
                    signalType: signalRow.signal_type || null,
                    observed: signalRow.observed || null,
                    expected: signalRow.expected || null
                }
                : {})
        }),
        resolveTemplateVars(pool, draft.contact_id, draft.campaign_id, {
            clientId: draft.client_id,
            emailAccount: draft.eaccount
        })
    ]);

    const templateVars = useActiveFungiStoryUrl
        ? applyActiveFungiStoryUrlToTemplateVars(resolvedTemplateVars, { domain: auditDomain })
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
        researchBrief: null,
        systemPromptOwnsCta: preview.systemPromptOwnsCta,
        additionalInstructions
    });

    const reviewTokenExpiresAt = new Date(Date.now() + REVIEW_TOKEN_TTL_MS).toISOString();
    const result = await pool.query(
        `UPDATE interested_autoresponder_drafts
         SET status = 'pending_review',
             review_token_expires_at = $2,
             model = $3,
             rendered_text = $4,
             system_prompt_version = $5,
             research_brief = NULL,
             research_completed_at = NULL,
             blocked_reason = NULL,
             updated_at = NOW()
         WHERE id = $1
           AND status = ANY($6::text[])
         RETURNING *`,
        [
            draft.id,
            reviewTokenExpiresAt,
            generation.model,
            generation.renderedText,
            promptConfig.version,
            ['pending_review', 'researching']
        ]
    );
    if (!result.rowCount) {
        const error = new Error('Draft is no longer available to regenerate.');
        error.statusCode = 409;
        throw error;
    }

    return serializeReviewDraft({
        ...draft,
        ...result.rows[0],
        campaign_name: draft.campaign_name
    });
}

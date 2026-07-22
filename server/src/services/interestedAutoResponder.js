import crypto from 'crypto';
import OpenAI from 'openai';
import { pool } from '../config/db.js';
import { getAgencySettings, hasShoppingAuditFeature } from './db/agencySettings.js';
import { getClientRowById, resolveClientRow } from './db/queries.js';
import {
    fetchThreadReplyMetadata,
    persistWarmFollowUpAnchorFromAutoresponder,
    resolveTemplateVars,
    renderTemplate
} from './followUpSender.js';

const DEFAULT_MODEL = String(process.env.INTERESTED_AUTORESPONDER_MODEL || 'gpt-5.5').trim() || 'gpt-5.5';
const REVIEW_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const POPUP_FORM_GENERATE_URL = 'https://essence-retention-ai-popup-demo.vercel.app/api/popup-form/generate';
const POPUP_FORM_API_KEY = 'CNl6iVR6YwmlPU9iw6gOW1LAF4roUxxPNB9YrI2kdIeMmbcfUKh4Rgdl0gdmZBQo';
const POPUP_FORM_GENERATE_TIMEOUT_MS = Math.max(
    Number(process.env.INTERESTED_AUTORESPONDER_POPUP_TIMEOUT_MS || 90_000) || 90_000,
    1
);
const POPUP_FORM_GENERATE_MAX_ATTEMPTS = 2;

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

const OPEN_DRAFT_STATUSES = ['pending_review', 'blocked_missing_thread'];
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

export function buildVulcanShoppingAuditUrl(domain) {
    const normalized = normalizeAuditDomain(domain);
    if (!normalized) return null;
    return `${VULCAN_SHOPPING_AUDIT_BASE_URL}/?domain=${encodeURIComponent(normalized)}`;
}

/**
 * Trigger Vulcan shopping-ad profit audit generation for a domain.
 * POST /api/audits { domain } with Bearer AUDITS_TRIGGER_SECRET.
 * Optionally polls GET /api/audit until ready (or timeout), then returns the public page URL.
 */
export async function triggerVulcanShoppingAudit(domain, options = {}) {
    const normalized = normalizeAuditDomain(domain);
    if (!normalized) {
        console.log('[vulcan-audit] skipped — invalid domain:', domain);
        return null;
    }
    if (!VULCAN_AUDITS_TRIGGER_SECRET) {
        console.warn('[vulcan-audit] skipped — VULCAN_AUDITS_TRIGGER_SECRET / AUDITS_TRIGGER_SECRET not set');
        return null;
    }

    const publicUrl = buildVulcanShoppingAuditUrl(normalized);
    const waitForReady = options.waitForReady !== false;
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
                `[vulcan-audit] trigger failed status=${response.status} domain=${normalized} elapsed=${elapsed}ms body=${bodyText.slice(0, 200)}`
            );
            return null;
        }
        let payload = null;
        try {
            payload = await response.json();
        } catch {
            payload = null;
        }
        console.log(
            `[vulcan-audit] triggered status=${response.status} domain=${normalized} runId=${payload?.runId || 'n/a'} elapsed=${elapsed}ms`
        );
    } catch (err) {
        const reason = err?.name === 'AbortError' ? 'timeout' : err.message;
        console.error(`[vulcan-audit] trigger error domain=${normalized}: ${reason}`);
        return null;
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
        : `https://essence-ai.app/preview?domain=${encodeURIComponent(domain)}`;
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
            const bodyPayload = {
                domain,
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
 * Build the lead-magnet / audit preview URL for an interested reply.
 * Shopping-audit agencies (Vulcan) → POST vulcan-shopping-audit /api/audits.
 * Everyone else → legacy Essence popup-form generate.
 */
export async function generateAuditPreviewUrl(leadEmail, options = {}) {
    const domain = normalizeAuditDomain(options.domain) || domainFromLeadEmail(leadEmail);
    if (!domain) return null;

    if (options.useVulcanShoppingAudit) {
        return triggerVulcanShoppingAudit(domain, { waitForReady: options.waitForReady });
    }

    return callPopupFormGenerate(leadEmail, { ...options, domain });
}

function asTrimmedText(value) {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    return text || null;
}

function getPublicAppBaseUrl() {
    const baseUrl = String(
        process.env.NEXT_PUBLIC_APP_URL
        || process.env.APP_BASE_URL
        || process.env.PUBLIC_APP_URL
        || 'https://shields-outbound-fulfill.vercel.app'
    ).trim();
    return baseUrl.replace(/\/$/, '');
}

function buildReviewUrl(token) {
    return `${getPublicAppBaseUrl()}/interested-autoresponder/${encodeURIComponent(token)}`;
}

function generateReviewToken() {
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

async function fetchPromptConfig(db, clientId, campaignId) {
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
    return {
        openaiKey: asTrimmedText(agencySettings?.openai_key),
        ntfyTopic: asTrimmedText(clientRow?.ntfy_topic),
        instantlyKey: asTrimmedText(clientRow?.instantly_key),
        shoppingAudit: hasShoppingAuditFeature(agencySettings)
    };
}

async function resolveClientInstantlyKey(agencyId, clientId, cachedKey = null) {
    const fromDraft = asTrimmedText(cachedKey);
    if (fromDraft) return fromDraft;
    const clientRow = await getClientRowById(agencyId, clientId);
    return asTrimmedText(clientRow?.instantly_key);
}

export async function generateDraftReply({
    openaiKey,
    systemPrompt,
    campaignName,
    leadEmail,
    threadSubject,
    previousLeadMessage,
    auditPreviewUrl = null,
    essenceAiPreviewUrl = null
}) {
    const previewUrl = auditPreviewUrl || essenceAiPreviewUrl || null;
    const client = new OpenAI({ apiKey: openaiKey });
    const response = await client.chat.completions.create({
        model: DEFAULT_MODEL,
        // temperature: 0.6,
        messages: [
            { role: 'system', content: systemPrompt },
            {
                role: 'user',
                content: [
                    `Campaign: ${campaignName || 'Unknown campaign'}`,
                    `Lead email: ${leadEmail || 'Unknown lead'}`,
                    `Thread subject: ${threadSubject || '(use existing thread subject)'}`,
                    previewUrl
                        ? `Shopping audit URL: ${previewUrl}`
                        : '',
                    '',
                    'Write a plain-text reply to the interested lead.',
                    'Do not include a subject line.',
                    'Do not use markdown.',
                    'Preserve the conversational context from the lead message below.',
                    '',
                    previewUrl
                        ? `CTA instruction: A personalized shopping ad audit has already been generated for this prospect's store. Use the Shopping audit URL above as the sole CTA link — link text should be "See what we built for your store". Do NOT include the Calendly booking link.`
                        : `CTA instruction: Use the Calendly booking link as the CTA: https://calendly.com/essencesoftwaredevelopment/essence-ai-demo`,
                    '',
                    'Lead message/thread context:',
                    previousLeadMessage || '(no message text available)'
                ].filter(Boolean).join('\n')
            }
        ]
    });
    const content = response.choices?.[0]?.message?.content || '';
    return {
        model: response.model || DEFAULT_MODEL,
        renderedText: String(content).trim()
    };
}

async function sendNtfyNotification(topic, { leadEmail, campaignName, reviewUrl, isFollowUp = false }) {
    if (!topic) return { notified: false, reason: 'missing_topic' };

    const titlePrefix = isFollowUp
        ? 'Interested lead follow-up review'
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

        let generation;
        try {
            let signalRow = {};
            try {
                const contactSignalResult = await client.query(
                    `SELECT c.signal_emission_id, se.signal_type, se.observed, se.expected,
                            co.domain_normalized AS company_domain
                     FROM contacts c
                     LEFT JOIN signal_emissions se ON se.id = c.signal_emission_id
                     LEFT JOIN companies co ON co.id = c.company_id
                     WHERE c.id = $1`,
                    [contactId]
                );
                signalRow = contactSignalResult.rows[0] || {};
            } catch (signalErr) {
                console.warn('[interested-autoresponder] signal lookup skipped:', signalErr?.message || signalErr);
            }
            const auditDomain = normalizeAuditDomain(signalRow.company_domain)
                || domainFromLeadEmail(normalizedLeadEmail);
            const [auditPreviewUrl, templateVars] = await Promise.all([
                generateAuditPreviewUrl(normalizedLeadEmail, {
                    domain: auditDomain,
                    useVulcanShoppingAudit: Boolean(settings.shoppingAudit),
                    signalEmissionId: signalRow.signal_emission_id || null,
                    signalType: signalRow.signal_type || null,
                    observed: signalRow.observed || null,
                    expected: signalRow.expected || null
                }),
                resolveTemplateVars(client, contactId, campaignId, {
                    clientId,
                    emailAccount: eaccount
                })
            ]);
            const renderedSystemPrompt = renderTemplate(promptConfig.system_prompt, templateVars);
            generation = await generateDraftReply({
                openaiKey: settings.openaiKey,
                systemPrompt: renderedSystemPrompt,
                campaignName: promptConfig.campaign_name,
                leadEmail: normalizedLeadEmail,
                threadSubject,
                previousLeadMessage,
                auditPreviewUrl
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

async function loadPendingReviewDraft(token) {
    const result = await pool.query(
        `SELECT d.*,
                ic.name AS campaign_name,
                ic.instantly_campaign_id,
                c.slug AS client_slug,
                c.instantly_key AS client_instantly_key
         FROM interested_autoresponder_drafts d
         JOIN instantly_campaigns ic ON ic.id = d.campaign_id
         JOIN clients c ON c.id = d.client_id AND c.agency_id = d.agency_id
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
    if (draft.status !== 'pending_review') {
        const error = new Error('Review draft is no longer available.');
        error.statusCode = 409;
        throw error;
    }
    return draft;
}

export async function getInterestedAutoResponderDraftByToken(token) {
    const draft = await loadPendingReviewDraft(token);
    return {
        id: draft.id,
        leadEmail: draft.lead_email,
        campaignName: draft.campaign_name,
        previousLeadMessage: draft.previous_lead_message,
        renderedText: draft.rendered_text,
        expiresAt: draft.review_token_expires_at
    };
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

    const outgoingText = normalizeOutgoingReplyText(draft.rendered_text);
    const renderedHtml = String(draft.rendered_text || '').trim();
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

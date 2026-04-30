/**
 * followUpSender.js
 *
 * Automated follow-up sender driven by Warm Follow Up events in
 * contact_instantly_events. Sequence continues through email_sent events
 * (including those produced by our own sends) and stops only when a blocking
 * event (reply, status-change) appears after the last Warm Follow Up anchor.
 *
 * Key entry points:
 *   runFollowUpsOnce({ dryRun, filterAgencyId, filterClientSlug, logger })
 *   runFollowUpsForClient({ agencyId, clientSlug, instantlyKey, dryRun, batchSize, logger })
 */

import { pool } from '../config/db.js';
import { firestore } from '../config/firebase.js';
import { sendInstantlyReply } from './instantlyState.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const WARM_FOLLOW_UP_EVENT = 'Warm Follow Up';

/**
 * Events that stop the follow-up sequence for a contact+campaign, provided
 * they appear AFTER the latest Warm Follow Up anchor event. email_sent is
 * intentionally absent — it must never block sequence progression.
 */
const BLOCKER_EVENT_TYPES = [
    'reply_received',
    'email_bounced',
    'lead_unsubscribed',
    'lead_not_interested',
    'lead_meeting_booked',
    'lead_meeting_completed',
    'lead_closed',
    'lead_wrong_person',
    'lead_no_show',
];

const BATCH_SIZE_DEFAULT = parseInt(process.env.FOLLOWUP_BATCH_SIZE || '50', 10) || 50;

// ─── Template rendering ───────────────────────────────────────────────────────

/**
 * Render a template string, replacing {{variable}} placeholders with values
 * from the vars object. Missing variables are replaced with an empty string.
 */
export function renderTemplate(template, vars = {}) {
    if (!template || typeof template !== 'string') return '';
    return template.replace(/\{\{(\s*[\w.]+\s*)\}\}/g, (_, key) => {
        const trimmedKey = key.trim();
        const value = vars[trimmedKey];
        if (value === null || value === undefined) return '';
        return String(value);
    });
}

/**
 * Sanitize an HTML string, allowing only a safe subset of tags and attributes.
 * Strips everything else to prevent injection via templates.
 *
 * Allowed tags: p, br, a, img, b, i, em, strong, ul, ol, li, span, div, h1–h4, blockquote
 * Allowed attributes on <a>: href (http/https only), target, rel
 * Allowed attributes on <img>: src (http/https only), alt, width, height
 * All other attributes are stripped.
 */
export function sanitizeHtml(html) {
    if (!html || typeof html !== 'string') return '';

    const ALLOWED_TAGS = new Set([
        'p', 'br', 'a', 'img', 'b', 'i', 'em', 'strong',
        'ul', 'ol', 'li', 'span', 'div',
        'h1', 'h2', 'h3', 'h4', 'blockquote'
    ]);

    // Remove script/style blocks entirely (including their content)
    let safe = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '');

    // Process tags: keep allowed tags, strip disallowed ones but keep their inner text
    safe = safe.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (match, tag, attrs) => {
        const tagLower = tag.toLowerCase();
        if (!ALLOWED_TAGS.has(tagLower)) {
            return ''; // strip disallowed tag entirely
        }
        if (match.startsWith('</')) {
            return `</${tagLower}>`; // closing tag, no attrs
        }
        if (tagLower === 'br') {
            return '<br>';
        }
        if (tagLower === 'a') {
            const hrefMatch = attrs.match(/href\s*=\s*["']([^"']*)["']/i);
            const href = hrefMatch ? hrefMatch[1].trim() : '';
            if (!href || !/^https?:\/\//i.test(href)) {
                return ''; // strip anchor with no safe href
            }
            const escapedHref = href.replace(/"/g, '&quot;');
            return `<a href="${escapedHref}" target="_blank" rel="noopener noreferrer">`;
        }
        if (tagLower === 'img') {
            const srcMatch = attrs.match(/src\s*=\s*["']([^"']*)["']/i);
            const altMatch = attrs.match(/alt\s*=\s*["']([^"']*)["']/i);
            const widthMatch = attrs.match(/width\s*=\s*["']?(\d{1,4})["']?/i);
            const heightMatch = attrs.match(/height\s*=\s*["']?(\d{1,4})["']?/i);

            const src = srcMatch ? srcMatch[1].trim() : '';
            if (!src || !/^https?:\/\//i.test(src)) {
                return '';
            }

            const parts = [`src="${src.replace(/"/g, '&quot;')}"`];
            if (altMatch) {
                parts.push(`alt="${altMatch[1].replace(/"/g, '&quot;')}"`);
            }
            if (widthMatch) {
                parts.push(`width="${widthMatch[1]}"`);
            }
            if (heightMatch) {
                parts.push(`height="${heightMatch[1]}"`);
            }
            return `<img ${parts.join(' ')}>`;
        }
        // For all other allowed tags, strip all attributes
        return `<${tagLower}>`;
    });

    return safe;
}

/**
 * Convert an HTML string to plain text for email plain-text parts.
 * Handles common block tags and strips the rest.
 */
export function htmlToPlainText(html) {
    if (!html || typeof html !== 'string') return '';
    return html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<\/li>/gi, '\n')
        .replace(/<\/h[1-6]>/gi, '\n\n')
        .replace(/<\/blockquote>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// ─── Template variable resolution ────────────────────────────────────────────

/**
 * Resolve template variables for a given contact and campaign from SQL.
 * Returns a flat object of variable name → value.
 */
export async function resolveTemplateVars(db, contactId, campaignId, options = {}) {
    const { clientId = null, emailAccount = null } = options;
    const [contactRow, insightsRow, campaignRow, emailAccountRow] = await Promise.all([
        db.query(
            `SELECT c.full_name, c.email, c.role_type,
                    co.domain_normalized AS company_domain
             FROM contacts c
             LEFT JOIN companies co ON co.id = c.company_id
             WHERE c.id = $1`,
            [contactId]
        ),
        db.query(
            `SELECT attributes FROM contact_insights WHERE contact_id = $1`,
            [contactId]
        ),
        db.query(
            `SELECT name FROM instantly_campaigns WHERE id = $1`,
            [campaignId]
        ),
        clientId && emailAccount
            ? db.query(
                `SELECT email, signature, first_name, last_name
                 FROM email_accounts
                 WHERE client_id = $1
                   AND LOWER(email) = LOWER($2)
                 LIMIT 1`,
                [clientId, emailAccount]
            )
            : Promise.resolve({ rows: [] }),
    ]);

    const contact = contactRow.rows[0] || {};
    const attributes = insightsRow.rows[0]?.attributes || {};
    const campaign = campaignRow.rows[0] || {};
    const account = emailAccountRow.rows[0] || {};

    const fullName = contact.full_name || '';
    const nameParts = fullName.trim().split(/\s+/);
    const firstName = attributes.firstName || attributes.first_name || nameParts[0] || '';
    const lastName = attributes.lastName || attributes.last_name || (nameParts.length > 1 ? nameParts.slice(1).join(' ') : '');

    return {
        first_name: firstName,
        last_name: lastName,
        full_name: fullName,
        email: contact.email || '',
        role_type: contact.role_type || '',
        company_domain: contact.company_domain || '',
        campaign_name: campaign.name || '',
        email_account: account.email || emailAccount || '',
        instantly_signature: account.signature || '',
        email_account_first_name: account.first_name || '',
        email_account_last_name: account.last_name || '',
        // Also expose any contact_insights attributes directly as top-level vars
        ...Object.fromEntries(
            Object.entries(attributes)
                .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
                .map(([k, v]) => [k, String(v)])
        ),
    };
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

/**
 * Fetch the first active follow_up_script for a client, ordered by script_order.
 */
async function getActiveScript(db, clientId) {
    const result = await db.query(
        `SELECT id, name, html_template, text_template
         FROM follow_up_scripts
         WHERE client_id = $1 AND active = TRUE
         ORDER BY script_order ASC
         LIMIT 1`,
        [clientId]
    );
    return result.rows[0] || null;
}

/**
 * Fetch eligible contact+campaign rows for a client+date.
 *
 * Eligibility requires:
 *   1. Active campaign/contact row with a non-null email.
 *   2. At least one Warm Follow Up event exists.
 *   3. No blocking event appears AFTER the latest Warm Follow Up anchor.
 *      (email_sent is explicitly excluded from blockers.)
 *   4. No successful follow_up_send exists for today.
 */
async function getEligibleProspects(db, clientId, sentForDate) {
    const result = await db.query(
        `SELECT
            cic.contact_id,
            cic.campaign_id,
            cic.instantly_lead_id,
            ic.instantly_campaign_id,
            c.email,
            c.company_id,
            (
                SELECT COALESCE(
                    e.payload->>'subject',
                    e.payload->>'email_subject',
                    e.payload->>'thread_subject'
                )
                FROM contact_instantly_events e
                WHERE e.contact_id = cic.contact_id
                  AND e.campaign_id = cic.campaign_id
                  AND COALESCE(
                      e.payload->>'subject',
                      e.payload->>'email_subject',
                      e.payload->>'thread_subject'
                  ) IS NOT NULL
                ORDER BY e.event_timestamp DESC
                LIMIT 1
            ) AS thread_subject,
            -- Latest reply_to_uuid from any event in this contact+campaign
            (
                SELECT e.reply_to_uuid
                FROM contact_instantly_events e
                WHERE e.contact_id = cic.contact_id
                  AND e.campaign_id = cic.campaign_id
                  AND e.reply_to_uuid IS NOT NULL
                ORDER BY e.event_timestamp DESC
                LIMIT 1
            ) AS reply_to_uuid,
            -- Latest sending account from any event
            (
                SELECT e.email_account
                FROM contact_instantly_events e
                WHERE e.contact_id = cic.contact_id
                  AND e.campaign_id = cic.campaign_id
                  AND e.email_account IS NOT NULL
                ORDER BY e.event_timestamp DESC
                LIMIT 1
            ) AS eaccount
         FROM contact_instantly_campaigns cic
         JOIN instantly_campaigns ic ON ic.id = cic.campaign_id
         JOIN contacts c ON c.id = cic.contact_id
         WHERE ic.client_id = $1
           AND cic.active = TRUE
           AND c.email IS NOT NULL
           -- Must have at least one Warm Follow Up event
           AND EXISTS (
               SELECT 1
               FROM contact_instantly_events wfu
               WHERE wfu.contact_id = cic.contact_id
                 AND wfu.campaign_id = cic.campaign_id
                 AND wfu.event_type = $2
           )
           -- No blocker event after the latest Warm Follow Up anchor
           AND NOT EXISTS (
               SELECT 1
               FROM contact_instantly_events blocker
               WHERE blocker.contact_id = cic.contact_id
                 AND blocker.campaign_id = cic.campaign_id
                 AND blocker.event_type = ANY($3::text[])
                 AND blocker.event_timestamp > (
                     SELECT MAX(anchor.event_timestamp)
                     FROM contact_instantly_events anchor
                     WHERE anchor.contact_id = cic.contact_id
                       AND anchor.campaign_id = cic.campaign_id
                       AND anchor.event_type = $2
                 )
           )
           -- No successful send today
           AND NOT EXISTS (
               SELECT 1
               FROM follow_up_sends fus
               WHERE fus.contact_id = cic.contact_id
                 AND fus.campaign_id = cic.campaign_id
                 AND fus.status = 'sent'
                 AND fus.sent_for_date = $4::date
           )`,
        [clientId, WARM_FOLLOW_UP_EVENT, BLOCKER_EVENT_TYPES, sentForDate]
    );
    return result.rows;
}

/**
 * Race-safe pre-send recheck executed inside a short transaction.
 * Returns { blocked: true, reason } or { blocked: false }.
 *
 * This prevents stale queued work from sending after a reply or status change
 * arrives between eligibility scan and the actual API call.
 */
async function recheckProspect(db, contactId, campaignId, sentForDate) {
    // Check for blocking event after latest Warm Follow Up anchor
    const blockerResult = await db.query(
        `SELECT 1
         FROM contact_instantly_events blocker
         WHERE blocker.contact_id = $1
           AND blocker.campaign_id = $2
           AND blocker.event_type = ANY($3::text[])
           AND blocker.event_timestamp > (
               SELECT MAX(anchor.event_timestamp)
               FROM contact_instantly_events anchor
               WHERE anchor.contact_id = $1
                 AND anchor.campaign_id = $2
                 AND anchor.event_type = $4
           )
         LIMIT 1`,
        [contactId, campaignId, BLOCKER_EVENT_TYPES, WARM_FOLLOW_UP_EVENT]
    );
    if (blockerResult.rows.length > 0) {
        return { blocked: true, reason: 'blocker_event_appeared' };
    }

    // Check for duplicate successful send today
    const dupResult = await db.query(
        `SELECT 1
         FROM follow_up_sends
         WHERE contact_id = $1
           AND campaign_id = $2
           AND status = 'sent'
           AND sent_for_date = $3::date
         LIMIT 1`,
        [contactId, campaignId, sentForDate]
    );
    if (dupResult.rows.length > 0) {
        return { blocked: true, reason: 'already_sent_today' };
    }

    return { blocked: false };
}

/**
 * Insert a follow_up_sends row. Returns the inserted id.
 */
async function persistSend(db, {
    clientId, contactId, companyId, campaignId, scriptId,
    instantlyLeadId, replyToUuid, eaccount,
    renderedSubject, renderedHtml, renderedText,
    status, errorCode, errorMessage, retryable, sentForDate
}) {
    const result = await db.query(
        `INSERT INTO follow_up_sends (
            client_id, contact_id, company_id, campaign_id, follow_up_script_id,
            instantly_lead_id, reply_to_uuid, eaccount,
            rendered_subject, rendered_html, rendered_text,
            status, error_code, error_message, retryable, sent_for_date
        ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8,
            $9, $10, $11,
            $12, $13, $14, $15, $16::date
        )
        ON CONFLICT DO NOTHING
        RETURNING id`,
        [
            clientId, contactId, companyId, campaignId, scriptId,
            instantlyLeadId, replyToUuid, eaccount,
            renderedSubject, renderedHtml, renderedText,
            status, errorCode, errorMessage, retryable, sentForDate
        ]
    );
    return result.rows[0]?.id || null;
}

/**
 * Update a follow_up_sends row outcome after the API call resolves.
 */
async function updateSendOutcome(db, sendId, { status, errorCode, errorMessage, retryable }) {
    await db.query(
        `UPDATE follow_up_sends
         SET status = $2, error_code = $3, error_message = $4,
             retryable = $5, updated_at = NOW()
         WHERE id = $1`,
        [sendId, status, errorCode || null, errorMessage || null, retryable]
    );
}

// ─── Sending ─────────────────────────────────────────────────────────────────

/**
 * Send a single follow-up reply via Instantly and record the outcome.
 */
async function sendFollowUpForProspect({
    prospect, script, vars, apiKey, clientId, sentForDate, dryRun, logger
}) {
    const { contact_id: contactId, campaign_id: campaignId, company_id: companyId,
            instantly_lead_id: instantlyLeadId, reply_to_uuid: replyToUuid,
            eaccount, email, thread_subject: threadSubject } = prospect;

    const renderedSubject = threadSubject || null;
    const rawHtml = renderTemplate(script.html_template, vars);
    const renderedHtml = sanitizeHtml(rawHtml);
    const renderedText = script.text_template
        ? renderTemplate(script.text_template, vars)
        : htmlToPlainText(renderedHtml);

    const sendId = await persistSend(pool, {
        clientId, contactId, companyId, campaignId, scriptId: script.id,
        instantlyLeadId, replyToUuid, eaccount,
        renderedSubject, renderedHtml, renderedText,
        status: 'pending', errorCode: null, errorMessage: null,
        retryable: false, sentForDate
    });

    if (!sendId) {
        // ON CONFLICT DO NOTHING means a row already exists (race between workers)
        logger(`[follow-up] Skipped duplicate pending row for contact=${contactId} campaign=${campaignId}`);
        return { skipped: true, reason: 'duplicate_pending' };
    }

    if (dryRun) {
        logger(`[follow-up] [DRY RUN] Would send to ${email} (contact=${contactId}) subject="${renderedSubject || '(thread subject)'}"`);
        await updateSendOutcome(pool, sendId, { status: 'dry_run', retryable: false });
        return { dryRun: true, sendId, subject: renderedSubject };
    }

    if (!replyToUuid || !eaccount) {
        logger(`[follow-up] Blocked: missing thread metadata for contact=${contactId} (reply_to_uuid=${replyToUuid}, eaccount=${eaccount})`);
        await updateSendOutcome(pool, sendId, {
            status: 'blocked_missing_thread',
            errorCode: 'missing_thread_metadata',
            errorMessage: `reply_to_uuid=${replyToUuid ?? 'null'}, eaccount=${eaccount ?? 'null'}`,
            retryable: false
        });
        return { blocked: true, reason: 'missing_thread_metadata', sendId };
    }

    try {
        const replyPayload = {
            reply_to_uuid: replyToUuid,
            eaccount,
            body: { html: renderedHtml, text: renderedText },
        };
        if (renderedSubject) {
            replyPayload.subject = renderedSubject;
        }

        await sendInstantlyReply(apiKey, replyPayload);

        await updateSendOutcome(pool, sendId, { status: 'sent', retryable: false });
        logger(`[follow-up] Sent to ${email} (contact=${contactId}) subject="${renderedSubject || '(thread subject)'}"`);
        return { sent: true, sendId };
    } catch (err) {
        const retryable = err?.retryable === true;
        const status = retryable ? 'failed_retryable' : 'failed_permanent';
        const errorCode = String(err?.statusCode || err?.code || 'unknown');
        const errorMessage = err?.message || String(err);

        await updateSendOutcome(pool, sendId, { status, errorCode, errorMessage, retryable });
        logger(`[follow-up] Failed send to ${email} (contact=${contactId}): [${errorCode}] ${errorMessage}`);
        return { failed: true, retryable, sendId, errorCode, errorMessage };
    }
}

// ─── Client-level orchestration ──────────────────────────────────────────────

/**
 * Run follow-up sends for a single client.
 * Returns a summary of outcomes.
 */
export async function runFollowUpsForClient({
    agencyId,
    clientSlug,
    instantlyKey,
    clientId,
    dryRun = false,
    batchSize = BATCH_SIZE_DEFAULT,
    logger = () => {}
}) {
    const summary = { eligible: 0, sent: 0, blocked: 0, skipped: 0, failed: 0, dryRun: 0 };

    const script = await getActiveScript(pool, clientId);
    if (!script) {
        logger(`[follow-up] No active follow_up_script for client ${clientId} (${agencyId}/${clientSlug}), skipping`);
        return summary;
    }

    // Use today in UTC; worker can override sentForDate to apply timezone offset externally
    const sentForDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    const prospects = await getEligibleProspects(pool, clientId, sentForDate);
    summary.eligible = prospects.length;
    logger(`[follow-up] ${prospects.length} eligible prospect(s) for client=${clientId} date=${sentForDate}`);

    const batch = prospects.slice(0, batchSize);

    for (const prospect of batch) {
        // Race-safe recheck immediately before sending
        const recheck = await recheckProspect(pool, prospect.contact_id, prospect.campaign_id, sentForDate);
        if (recheck.blocked) {
            logger(`[follow-up] Recheck blocked contact=${prospect.contact_id}: ${recheck.reason}`);
            summary.skipped += 1;
            continue;
        }

        let vars;
        try {
            vars = await resolveTemplateVars(pool, prospect.contact_id, prospect.campaign_id, {
                clientId,
                emailAccount: prospect.eaccount || null
            });
        } catch (err) {
            logger(`[follow-up] Failed to resolve vars for contact=${prospect.contact_id}: ${err.message}`);
            summary.skipped += 1;
            continue;
        }

        const result = await sendFollowUpForProspect({
            prospect, script, vars, apiKey: instantlyKey,
            clientId, sentForDate, dryRun, logger
        });

        if (result.sent) summary.sent += 1;
        else if (result.dryRun) summary.dryRun += 1;
        else if (result.blocked) summary.blocked += 1;
        else if (result.skipped) summary.skipped += 1;
        else if (result.failed) summary.failed += 1;
    }

    return summary;
}

// ─── Top-level entry point ────────────────────────────────────────────────────

/**
 * List all clients with an Instantly key from Firestore, resolve their SQL
 * client_id, then run follow-ups for each. Exported for use by worker and
 * one-off scripts.
 */
export async function runFollowUpsOnce({
    dryRun = false,
    filterAgencyId = '',
    filterClientSlug = '',
    batchSize = BATCH_SIZE_DEFAULT,
    logger = console.log
} = {}) {
    const snapshot = await firestore.collectionGroup('clients').get();
    const allClients = snapshot.docs
        .map((doc) => {
            const parent = doc.ref.parent?.parent;
            const agencyId = parent?.id || null;
            const instantlyKey = doc.data()?.instantly_key?.trim() || null;
            return { agencyId, clientSlug: doc.id, instantlyKey };
        })
        .filter((c) => c.agencyId && c.clientSlug && c.instantlyKey);

    const selected = allClients.filter((c) => {
        if (filterAgencyId && c.agencyId !== filterAgencyId) return false;
        if (filterClientSlug && c.clientSlug !== filterClientSlug) return false;
        return true;
    });

    if (!selected.length) {
        logger('[follow-up] No clients matched the filters.');
        return;
    }

    const overallSummary = { sent: 0, blocked: 0, skipped: 0, failed: 0, dryRun: 0, eligible: 0 };

    for (const client of selected) {
        // Resolve SQL client_id
        let clientId;
        try {
            const res = await pool.query(
                `SELECT id FROM clients WHERE agency_id = $1 AND name = $2 LIMIT 1`,
                [client.agencyId, client.clientSlug]
            );
            if (!res.rows.length) {
                // Try by slug match with relaxed case
                const res2 = await pool.query(
                    `SELECT id FROM clients WHERE agency_id = $1 LIMIT 1`,
                    [client.agencyId]
                );
                clientId = Number(res2.rows[0]?.id) || null;
            } else {
                clientId = Number(res.rows[0].id);
            }
        } catch (err) {
            logger(`[follow-up] Failed to resolve SQL client for ${client.agencyId}/${client.clientSlug}: ${err.message}`);
            continue;
        }

        if (!clientId) {
            logger(`[follow-up] No SQL client row found for ${client.agencyId}/${client.clientSlug}, skipping`);
            continue;
        }

        try {
            const summary = await runFollowUpsForClient({
                agencyId: client.agencyId,
                clientSlug: client.clientSlug,
                instantlyKey: client.instantlyKey,
                clientId,
                dryRun,
                batchSize,
                logger
            });
            logger(`[follow-up] Summary for ${client.agencyId}/${client.clientSlug}:`, summary);
            for (const key of Object.keys(overallSummary)) {
                overallSummary[key] += summary[key] || 0;
            }
        } catch (err) {
            logger(`[follow-up] Client run failed for ${client.agencyId}/${client.clientSlug}: ${err.message}`);
        }
    }

    logger('[follow-up] Overall summary:', overallSummary);
    return overallSummary;
}

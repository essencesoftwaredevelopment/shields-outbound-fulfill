/**
 * Close.com lead on positive replies — Close is the team's dialer.
 *
 * Runs once the founder phone lookup has settled (so the number usually rides
 * the first write), on both reply paths: inline draft generation and the
 * research workflow's phone step. Per contact:
 *   no close_lead_id → find a Close lead that already has this email, else
 *                      create one (company + contact with name / title / email /
 *                      phone) in the configured status, and add the reply as a note
 *   close_lead_id    → only add a phone found since the last sync
 *
 * Gated by features.closeLeads + agency_settings.close_key (+ optional
 * features.closeClients.ids). New leads get the status named in
 * features.closeLeadStatus.label (default "Potential"); a linked existing lead
 * keeps its status. Never throws: Close is a convenience next to the
 * reply, never a blocker.
 */
import { pool } from '../config/db.js';
import { getAgencySettings, closeLeadsEnabled } from './db/agencySettings.js';
import {
    addPhoneToCloseContact,
    closeLeadUrl,
    createCloseContact,
    createCloseLead,
    createCloseNote,
    findCloseLeadIdByEmail,
    findCloseLeadStatusId,
    getCloseLead
} from './close.js';

/** A 'pending' claim older than this is a crashed run. */
const STALE_CLAIM_MS = 5 * 60 * 1000;
export const DEFAULT_CLOSE_LEAD_STATUS = 'Potential';

const defaultDeps = {
    getAgencySettings,
    findCloseLeadIdByEmail,
    findCloseLeadStatusId,
    getCloseLead,
    createCloseLead,
    createCloseContact,
    addPhoneToCloseContact,
    createCloseNote
};

/** Close status label new leads are created in (features.closeLeadStatus.label). */
export function closeLeadStatusLabel(settings) {
    const label = String(settings?.features?.closeLeadStatus?.label || '').trim();
    return label || DEFAULT_CLOSE_LEAD_STATUS;
}

/** 'founder' → 'Founder', 'head_of_growth' → 'Head Of Growth'. */
function humanizeRole(role) {
    return String(role || '')
        .replace(/[-_]+/g, ' ')
        .trim()
        .replace(/\b\w/g, (char) => char.toUpperCase());
}

function companyNameFromDomain(domain) {
    const label = String(domain || '').split('.')[0] || '';
    return label.replace(/[-_]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function stripHtml(text) {
    return String(text || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Close lead + contact payload from our contact row.
 *
 * @param {{ full_name?: string | null, email?: string | null, role_type?: string | null, phone?: string | null,
 *           company_domain?: string | null, attributes?: Record<string, unknown> | null }} contact
 * @param {{ campaignName?: string | null }} [context]
 */
export function buildCloseLeadPayload(contact, { campaignName = null } = {}) {
    const attributes = contact.attributes && typeof contact.attributes === 'object' ? contact.attributes : {};
    const email = String(contact.email || '').trim().toLowerCase();
    const domain = String(contact.company_domain || '').trim().toLowerCase()
        || email.split('@')[1]
        || '';
    const attrName = [attributes.firstName || attributes.first_name, attributes.lastName || attributes.last_name]
        .filter(Boolean)
        .join(' ');
    const name = String(contact.full_name || '').trim() || attrName.trim() || null;
    const company = String(attributes.companyName || attributes.company_name || '').trim()
        || companyNameFromDomain(domain)
        || name
        || email;
    const title = String(attributes.jobTitle || attributes.job_title || attributes.title || '').trim()
        || humanizeRole(contact.role_type)
        || null;
    return {
        name: company,
        url: domain ? `https://${domain}` : null,
        description: campaignName ? `Positive reply — ${campaignName}` : 'Positive reply',
        contact: {
            name,
            title,
            email: email || null,
            phone: String(contact.phone || '').trim() || null
        }
    };
}

function replyNote({ campaignName, replyText }) {
    const reply = stripHtml(replyText);
    return [
        `Positive reply${campaignName ? ` (${campaignName})` : ''}`,
        reply ? `\n${reply}` : null
    ].filter(Boolean).join('\n');
}

/**
 * Create / link the Close lead for one contact, or top up its phone.
 *
 * @param {{
 *   agencyId: string,
 *   contactId: number | string,
 *   clientId?: number | string | null,
 *   campaignName?: string | null,
 *   replyText?: string | null,
 *   force?: boolean,
 *   db?: { query: Function },
 *   logger?: (msg: string) => void,
 *   deps?: Partial<typeof defaultDeps>
 * }} args  `force` skips the feature flag (manual "Add to Close"); the key is still required.
 * @returns {Promise<{ status: 'created' | 'linked' | 'exists' | 'disabled' | 'skipped' | 'error', leadId?: string, url?: string | null, reason?: string }>}
 */
export async function syncCloseLeadForContact({
    agencyId,
    contactId,
    clientId = null,
    campaignName = null,
    replyText = null,
    force = false,
    db = pool,
    logger = (msg) => console.log(msg),
    deps = {}
}) {
    const d = { ...defaultDeps, ...deps };
    const log = (msg) => logger(`[close] agency=${agencyId} contact=${contactId} ${msg}`);
    try {
        if (!agencyId || contactId == null) return { status: 'skipped', reason: 'missing_ids' };
        const settings = await d.getAgencySettings(agencyId);
        const apiKey = String(settings?.close_key || '').trim();
        if (!apiKey || (!force && !closeLeadsEnabled(settings, clientId))) return { status: 'disabled' };

        const contact = await loadContact(db, agencyId, contactId);
        if (!contact) return { status: 'skipped', reason: 'contact_not_found' };
        const phone = String(contact.phone || '').trim() || null;

        if (contact.close_lead_id) {
            const url = closeLeadUrl(contact.close_lead_id);
            if (phone && phone !== contact.close_phone && contact.close_contact_id) {
                try {
                    await d.addPhoneToCloseContact(apiKey, contact.close_contact_id, phone);
                    await db.query(
                        `UPDATE contacts SET close_phone = $2, close_checked_at = NOW(), updated_at = NOW() WHERE id = $1`,
                        [contactId, phone]
                    );
                    log(`added phone ${phone} to Close contact ${contact.close_contact_id}`);
                } catch (err) {
                    log(`phone update failed: ${err?.message || err}`);
                }
            }
            return { status: 'exists', leadId: contact.close_lead_id, url };
        }

        if (!(await claimSync(db, agencyId, contactId))) {
            return { status: 'skipped', reason: 'claimed_elsewhere' };
        }

        try {
            const payload = buildCloseLeadPayload(contact, { campaignName });
            const result = await linkOrCreate(d, apiKey, payload, closeLeadStatusLabel(settings), log);
            await createNoteQuietly(d, apiKey, result.leadId, replyNote({ campaignName, replyText }), log);
            await db.query(
                `UPDATE contacts
                 SET close_lead_id = $2, close_contact_id = $3, close_phone = $4,
                     close_status = 'synced', close_error = NULL,
                     close_checked_at = NOW(), updated_at = NOW()
                 WHERE id = $1`,
                [contactId, result.leadId, result.contactId, result.phoneWritten ? phone : null]
            );
            log(`${result.status} Close lead ${result.leadId}`);
            return { status: result.status, leadId: result.leadId, url: closeLeadUrl(result.leadId) };
        } catch (err) {
            const reason = String(err?.code || err?.message || 'close_failed').slice(0, 500);
            await db.query(
                `UPDATE contacts
                 SET close_status = 'error', close_error = $2, close_checked_at = NOW(), updated_at = NOW()
                 WHERE id = $1 AND close_status = 'pending'`,
                [contactId, String(err?.message || reason).slice(0, 500)]
            );
            log(`sync failed: ${err?.message || err}`);
            return { status: 'error', reason };
        }
    } catch (err) {
        log(`sync failed: ${err?.message || err}`);
        return { status: 'error', reason: err?.message || String(err) };
    }
}

/**
 * Reuse a Close lead that already holds this email (added by hand, or by an
 * earlier sync whose DB write failed); otherwise create one.
 */
async function linkOrCreate(d, apiKey, payload, statusLabel, log) {
    const email = payload.contact.email;
    let existingId = null;
    if (email) {
        try {
            existingId = await d.findCloseLeadIdByEmail(apiKey, email);
        } catch (err) {
            // A bad key fails create too; anything else just risks a duplicate lead.
            if (err?.code === 'CLOSE_UNAUTHORIZED') throw err;
            log(`email search failed, creating: ${err?.message || err}`);
        }
    }

    if (!existingId) {
        let statusId = null;
        try {
            statusId = await d.findCloseLeadStatusId(apiKey, statusLabel);
            if (!statusId) log(`no Close lead status "${statusLabel}" — using the org default`);
        } catch (err) {
            if (err?.code === 'CLOSE_UNAUTHORIZED') throw err;
            log(`status lookup failed, using the org default: ${err?.message || err}`);
        }
        const created = await d.createCloseLead(apiKey, { ...payload, statusId });
        return { status: 'created', leadId: created.leadId, contactId: created.contactId, phoneWritten: !!payload.contact.phone };
    }

    const lead = await d.getCloseLead(apiKey, existingId);
    const match = (lead?.contacts || []).find((c) =>
        (c.emails || []).some((e) => String(e.email || '').trim().toLowerCase() === email)
    );
    if (match) {
        if (payload.contact.phone) await d.addPhoneToCloseContact(apiKey, match.id, payload.contact.phone);
        return { status: 'linked', leadId: existingId, contactId: String(match.id), phoneWritten: !!payload.contact.phone };
    }
    const contactId = await d.createCloseContact(apiKey, existingId, payload.contact);
    return { status: 'linked', leadId: existingId, contactId, phoneWritten: !!payload.contact.phone };
}

async function createNoteQuietly(d, apiKey, leadId, note, log) {
    try {
        await d.createCloseNote(apiKey, leadId, note);
    } catch (err) {
        log(`note failed on ${leadId}: ${err?.message || err}`);
    }
}

async function loadContact(db, agencyId, contactId) {
    const result = await db.query(
        `SELECT c.id, c.full_name, c.email, c.role_type, c.phone,
                c.close_lead_id, c.close_contact_id, c.close_phone,
                co.domain_normalized AS company_domain,
                ci.attributes
         FROM contacts c
         LEFT JOIN companies co ON co.id = c.company_id
         LEFT JOIN contact_insights ci ON ci.contact_id = c.id
         WHERE c.id = $1 AND c.agency_id = $2
         LIMIT 1`,
        [contactId, agencyId]
    );
    return result.rows[0] || null;
}

/** Atomic claim so two replies from the same lead can't create two Close leads. */
async function claimSync(db, agencyId, contactId) {
    const result = await db.query(
        `UPDATE contacts
         SET close_status = 'pending', close_error = NULL, close_checked_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND agency_id = $2
           AND close_lead_id IS NULL
           AND (
                close_status IS NULL
                OR close_status = 'error'
                OR (close_status = 'pending' AND close_checked_at < NOW() - make_interval(secs => $3))
           )
         RETURNING id`,
        [contactId, agencyId, STALE_CLAIM_MS / 1000]
    );
    return result.rowCount > 0;
}

/** Close lead link for a contact, or null. */
export async function loadContactCloseUrl(db, contactId) {
    if (contactId == null) return null;
    try {
        const result = await db.query(`SELECT close_lead_id FROM contacts WHERE id = $1`, [contactId]);
        return closeLeadUrl(result.rows[0]?.close_lead_id);
    } catch (error) {
        console.warn(`[close] lead link read failed contact=${contactId}:`, error?.message || error);
        return null;
    }
}

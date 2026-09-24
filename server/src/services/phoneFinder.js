/**
 * Founder phone lookup on positive replies — Enrow Phone Finder.
 *
 * Runs once per contact when a lead replies interested (research workflow step,
 * or alongside inline draft generation). Enrow bills when a search is LAUNCHED,
 * so every attempt is recorded on the contact (see migration 0067) and a contact
 * is never searched twice:
 *   found / not_found  → final, never re-searched
 *   timeout / pending  → the next reply re-polls phone_search_id (GETs are free)
 *   error              → nothing was billed (submit failed); retried next reply
 *
 * Input: the founder's LinkedIn URL (via the Serper + OpenAI `searchLead`) when
 * it's a confident match, otherwise first + last name + company domain. A wrong
 * LinkedIn means paying for someone else's number, so a low-confidence match
 * falls back to the name.
 *
 * Never throws: every failure is returned as a status so callers can treat the
 * phone as best-effort context for the reply, never a blocker.
 */
import { pool } from '../config/db.js';
import { getAgencySettings, apiKeysFromSettings, enrowPhoneLookupEnabled } from './db/agencySettings.js';
import { submitEnrowPhoneFind, getEnrowPhone } from './enrow.js';
import { searchLead } from './leadWebhook.js';
import { refreshProviderCreditsAfterBatch } from './providerCredits.js';

const POLL_INTERVAL_MS = 3_000;
/** Default overall budget; the workflow step must finish well inside maxDuration. */
export const PHONE_LOOKUP_TIMEOUT_MS = Math.max(
    Number(process.env.PHONE_LOOKUP_TIMEOUT_MS || 60_000) || 60_000,
    10_000
);
const LINKEDIN_SEARCH_TIMEOUT_MS = 20_000;
/** A 'pending' claim with no search id older than this is a crashed run. */
const STALE_CLAIM_MS = 10 * 60 * 1000;
const LINKEDIN_MIN_CONFIDENCE = 0.6;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * What to do for a contact given its stored phone state.
 *
 * @param {{ phone?: string | null, phone_status?: string | null, phone_search_id?: string | null, phone_checked_at?: string | Date | null }} contact
 * @param {number} [now]
 * @returns {'have' | 'skip' | 'resume' | 'search'}
 */
export function decidePhoneAction(contact, now = Date.now()) {
    if (String(contact?.phone || '').trim()) return 'have';
    const status = contact?.phone_status || null;
    if (status === 'found' || status === 'not_found') return 'skip';
    if ((status === 'pending' || status === 'timeout') && contact?.phone_search_id) return 'resume';
    if (status === 'pending') {
        const checkedAt = contact?.phone_checked_at ? new Date(contact.phone_checked_at).getTime() : 0;
        // Another run is launching this search right now.
        if (now - checkedAt < STALE_CLAIM_MS) return 'skip';
    }
    return 'search';
}

/**
 * @param {string | null | undefined} fullName
 * @returns {{ firstName: string, lastName: string } | null}
 */
export function splitFullName(fullName) {
    const parts = String(fullName || '')
        .replace(/\s+/g, ' ')
        .trim()
        .split(' ')
        .filter(Boolean);
    if (parts.length < 2) return null;
    return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

/**
 * Canonical https://www.linkedin.com/in/<slug>/ — Enrow 400s on anything that
 * isn't a profile URL, and Serper hits carry locale subdomains / query strings.
 *
 * @param {string | null | undefined} url
 * @returns {string | null}
 */
export function normalizeLinkedinProfileUrl(url) {
    const raw = String(url || '').trim();
    if (!raw) return null;
    let parsed;
    try {
        parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
        return null;
    }
    if (!/(^|\.)linkedin\.com$/i.test(parsed.hostname)) return null;
    const match = parsed.pathname.match(/^\/in\/([^/?#]+)/i);
    if (!match) return null;
    let slug;
    try {
        slug = decodeURIComponent(match[1]);
    } catch {
        slug = match[1];
    }
    if (!slug.trim()) return null;
    return `https://www.linkedin.com/in/${encodeURIComponent(slug.trim())}/`;
}

function withTimeout(promise, ms, fallback) {
    let timer;
    return Promise.race([
        promise,
        new Promise((resolve) => {
            timer = setTimeout(() => resolve(fallback), ms);
        })
    ]).finally(() => clearTimeout(timer));
}

const defaultDeps = {
    submitEnrowPhoneFind,
    getEnrowPhone,
    searchLead,
    getAgencySettings,
    refreshCredits: refreshProviderCreditsAfterBatch,
    sleep,
    now: () => Date.now()
};

/**
 * Look up (or resume looking up) the founder phone for one contact.
 *
 * @param {{
 *   agencyId: string,
 *   contactId: number | string,
 *   clientId?: number | string | null,
 *   timeoutMs?: number,
 *   db?: { query: Function },
 *   logger?: (msg: string) => void,
 *   deps?: Partial<typeof defaultDeps>
 * }} args
 * @returns {Promise<{ status: 'found' | 'not_found' | 'timeout' | 'error' | 'skipped' | 'disabled', number?: string | null, country?: string | null, reason?: string }>}
 */
export async function findPhoneForContact({
    agencyId,
    contactId,
    clientId = null,
    timeoutMs = PHONE_LOOKUP_TIMEOUT_MS,
    db = pool,
    logger = (msg) => console.log(msg),
    deps = {}
}) {
    const d = { ...defaultDeps, ...deps };
    const log = (msg) => logger(`[phone-finder] agency=${agencyId} contact=${contactId} ${msg}`);
    try {
        if (!agencyId || contactId == null) return { status: 'skipped', reason: 'missing_ids' };
        const settings = await d.getAgencySettings(agencyId);
        if (!enrowPhoneLookupEnabled(settings, clientId)) return { status: 'disabled' };
        const deadline = d.now() + timeoutMs;

        const contact = await loadContact(db, agencyId, contactId);
        if (!contact) return { status: 'skipped', reason: 'contact_not_found' };

        const apiKey = String(settings.enrow_key || '').trim();
        const action = decidePhoneAction(contact, d.now());
        if (action === 'have') {
            return { status: 'found', number: contact.phone, country: contact.phone_country || null };
        }
        if (action === 'skip') {
            return { status: 'skipped', reason: `phone_status=${contact.phone_status}` };
        }
        if (action === 'resume') {
            log(`resuming Enrow search ${contact.phone_search_id}`);
            return await pollAndStore(db, d, { apiKey, contactId, searchId: contact.phone_search_id, deadline, log });
        }

        if (!(await claimSearch(db, agencyId, contactId))) {
            return { status: 'skipped', reason: 'claimed_elsewhere' };
        }

        const input = await buildSearchInput(d, settings, contact, deadline, log);
        if (!input) {
            await markError(db, contactId, 'no_search_input');
            log('no LinkedIn match and no first + last name + domain — skipped');
            return { status: 'error', reason: 'no_search_input' };
        }

        let submitted;
        try {
            submitted = await submitWithFallback(d, apiKey, input, contact, contactId, log);
        } catch (err) {
            const reason = err?.code || err?.message || 'submit_failed';
            await markError(db, contactId, String(reason).slice(0, 500));
            log(`Enrow submit failed: ${err?.message || err}`);
            if (err?.code === 'ENROW_CREDIT_EXHAUSTED') await d.refreshCredits(agencyId, { force: true });
            return { status: 'error', reason: String(reason) };
        }

        await db.query(
            `UPDATE contacts
             SET phone_search_id = $2,
                 phone_search_input = $3,
                 phone_credits_used = $4,
                 phone_error = NULL,
                 updated_at = NOW()
             WHERE id = $1`,
            [contactId, submitted.id, submitted.input, submitted.creditsUsed]
        );
        log(`Enrow search ${submitted.id} launched by ${submitted.input} (credits_used=${submitted.creditsUsed ?? 'n/a'})`);
        // Keeps the Pipeline tab's Enrow balance honest; never throws, not awaited.
        void d.refreshCredits(agencyId);

        return await pollAndStore(db, d, { apiKey, contactId, searchId: submitted.id, deadline, log });
    } catch (err) {
        log(`lookup failed: ${err?.message || err}`);
        return { status: 'error', reason: err?.message || String(err) };
    }
}

async function loadContact(db, agencyId, contactId) {
    const result = await db.query(
        `SELECT c.id, c.full_name, c.email, c.phone, c.phone_country, c.phone_status,
                c.phone_search_id, c.phone_checked_at,
                co.domain_normalized AS company_domain
         FROM contacts c
         LEFT JOIN companies co ON co.id = c.company_id
         WHERE c.id = $1 AND c.agency_id = $2
         LIMIT 1`,
        [contactId, agencyId]
    );
    return result.rows[0] || null;
}

/** Atomic claim so two replies from the same lead can't launch two paid searches. */
async function claimSearch(db, agencyId, contactId) {
    const result = await db.query(
        `UPDATE contacts
         SET phone_status = 'pending',
             phone_search_id = NULL,
             phone_error = NULL,
             phone_checked_at = NOW(),
             updated_at = NOW()
         WHERE id = $1 AND agency_id = $2
           AND (phone IS NULL OR BTRIM(phone) = '')
           AND (
                phone_status IS NULL
                OR phone_status = 'error'
                OR (phone_status = 'pending' AND phone_search_id IS NULL
                    AND phone_checked_at < NOW() - make_interval(secs => $3))
           )
         RETURNING id`,
        [contactId, agencyId, STALE_CLAIM_MS / 1000]
    );
    return result.rowCount > 0;
}

async function markError(db, contactId, reason) {
    await db.query(
        `UPDATE contacts
         SET phone_status = 'error', phone_error = $2, phone_checked_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND phone_status = 'pending'`,
        [contactId, reason]
    );
}

async function buildSearchInput(d, settings, contact, deadline, log) {
    const domain = String(contact.company_domain || '').trim().toLowerCase()
        || String(contact.email || '').split('@')[1]?.trim().toLowerCase()
        || '';
    const name = splitFullName(contact.full_name);
    const byName = name && domain ? { ...name, companyDomain: domain } : null;

    const keys = apiKeysFromSettings(settings);
    const email = String(contact.email || '');
    if (keys.serper && email.includes('@')) {
        const budget = Math.min(LINKEDIN_SEARCH_TIMEOUT_MS, Math.max(deadline - d.now() - 15_000, 0));
        const match = budget > 0
            ? await withTimeout(
                d.searchLead({
                    name: contact.full_name || '',
                    email,
                    serperKey: keys.serper,
                    openaiKey: keys.openai,
                    openaiModel: settings.openai_founder_model || undefined
                }).catch((err) => {
                    log(`LinkedIn search failed: ${err?.message || err}`);
                    return null;
                }),
                budget,
                null
            )
            : null;
        const linkedinUrl = normalizeLinkedinProfileUrl(match?.url);
        if (linkedinUrl && (match?.confidence || 0) >= LINKEDIN_MIN_CONFIDENCE) {
            return { linkedinUrl, byName };
        }
        if (match?.url) log(`LinkedIn match below confidence (${match.confidence}) — using name`);
    }
    return byName ? { linkedinUrl: null, byName } : null;
}

async function submitWithFallback(d, apiKey, input, contact, contactId, log) {
    const custom = `contact:${contactId}`;
    if (input.linkedinUrl) {
        try {
            const res = await d.submitEnrowPhoneFind(apiKey, { linkedinUrl: input.linkedinUrl, custom });
            return { ...res, input: 'linkedin' };
        } catch (err) {
            // 400 = Enrow rejected the URL (nothing billed); the name may still work.
            if (err?.status !== 400 || !input.byName) throw err;
            log(`Enrow rejected LinkedIn URL (${err.message}) — retrying by name`);
        }
    }
    const res = await d.submitEnrowPhoneFind(apiKey, { ...input.byName, custom });
    return { ...res, input: 'name' };
}

async function pollAndStore(db, d, { apiKey, contactId, searchId, deadline, log }) {
    for (;;) {
        let result = null;
        try {
            result = await d.getEnrowPhone(apiKey, searchId);
        } catch (err) {
            // Transient (enrowRequest already retried 5xx/429); keep polling to the deadline.
            log(`Enrow poll error for ${searchId}: ${err?.message || err}`);
        }
        if (result && result.qualification === 'found') {
            await db.query(
                `UPDATE contacts
                 SET phone = $2, phone_country = $3, phone_source = 'enrow',
                     phone_status = 'found', phone_error = NULL,
                     phone_checked_at = NOW(), updated_at = NOW()
                 WHERE id = $1`,
                [contactId, result.number, result.country]
            );
            log(`found ${result.number} (${result.country || '??'})`);
            return { status: 'found', number: result.number, country: result.country };
        }
        if (result && result.qualification === 'not_found') {
            await db.query(
                `UPDATE contacts
                 SET phone_status = 'not_found', phone_checked_at = NOW(), updated_at = NOW()
                 WHERE id = $1`,
                [contactId]
            );
            log('Enrow found no number');
            return { status: 'not_found' };
        }
        if (d.now() + POLL_INTERVAL_MS > deadline) break;
        await d.sleep(POLL_INTERVAL_MS);
    }
    await db.query(
        `UPDATE contacts
         SET phone_status = 'timeout', phone_checked_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND phone_status IN ('pending', 'timeout')`,
        [contactId]
    );
    log(`Enrow search ${searchId} still running at the deadline — will re-poll on the next reply`);
    return { status: 'timeout' };
}

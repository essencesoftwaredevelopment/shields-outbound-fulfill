/**
 * Leads we never email from anything automated: follow-ups, the follow-up
 * agent, the re-engagement send, the interested autoresponder, or adding leads
 * to an Instantly campaign. A lead is do-not-email when either:
 *
 * - they were ever marked won: a lead_closed event or Instantly interest status
 *   4 ("won") on any campaign, at any time, by contact or by the same email
 *   within the client; or
 * - their email domain or their company's domain is on the client's
 *   blocked_domains list (subdomains match too).
 */

export const WON_EVENT_TYPE = 'lead_closed';
export const WON_INTEREST_STATUS = 4;

/** SQL that is true when the contact was ever won (or anyone with their email in the same client was). */
export function everWonSql(contactIdSql) {
    return `EXISTS (
               SELECT 1
               FROM contacts won_self
               JOIN contacts won_any
                 ON won_any.client_id = won_self.client_id
                AND LOWER(won_any.email) = LOWER(won_self.email)
               WHERE won_self.id = ${contactIdSql}
                 AND (
                     EXISTS (
                         SELECT 1 FROM contact_instantly_events won_e
                         WHERE won_e.contact_id IN (won_self.id, won_any.id)
                           AND won_e.event_type = '${WON_EVENT_TYPE}'
                     )
                     OR EXISTS (
                         SELECT 1 FROM contact_instantly_campaigns won_c
                         WHERE won_c.contact_id IN (won_self.id, won_any.id)
                           AND (won_c.interest_status = ${WON_INTEREST_STATUS}
                                OR LOWER(COALESCE(won_c.interest_status_label, '')) = 'won')
                     )
                 )
           )`;
}

function domainMatchSql(domainSql, blockedSql) {
    return `(${domainSql} = ${blockedSql} OR ${domainSql} LIKE '%.' || ${blockedSql})`;
}

/** SQL that is true when the contact's email domain or company domain is on their client's blocklist. */
export function blockedDomainSql(contactIdSql) {
    return `EXISTS (
               SELECT 1
               FROM contacts bd_c
               JOIN clients bd_cl ON bd_cl.id = bd_c.client_id
               LEFT JOIN companies bd_co ON bd_co.id = bd_c.company_id
               CROSS JOIN LATERAL unnest(bd_cl.blocked_domains) AS bd(domain)
               WHERE bd_c.id = ${contactIdSql}
                 AND (
                     ${domainMatchSql(`split_part(LOWER(bd_c.email), '@', 2)`, 'bd.domain')}
                     OR ${domainMatchSql(`LOWER(COALESCE(bd_co.domain_normalized, ''))`, 'bd.domain')}
                 )
           )`;
}

export function doNotEmailSql(contactIdSql) {
    return `(${everWonSql(contactIdSql)}
           OR ${blockedDomainSql(contactIdSql)})`;
}

export async function isContactDoNotEmail(db, contactId) {
    if (!contactId) return false;
    const result = await db.query(`SELECT ${doNotEmailSql('$1')} AS blocked`, [contactId]);
    return result.rows[0]?.blocked === true;
}

/** Normalize a pasted domain: lowercase, no scheme, no www., no path. */
export function normalizeBlockedDomain(raw) {
    return String(raw || '')
        .trim()
        .toLowerCase()
        .replace(/^[a-z]+:\/\//, '')
        .replace(/^www\./, '')
        .split(/[/?#]/)[0]
        .replace(/\.$/, '');
}

export function emailDomainIsBlocked(email, blockedDomains) {
    const domain = String(email || '').trim().toLowerCase().split('@')[1] || '';
    if (!domain) return false;
    return (blockedDomains || []).some((blocked) => domain === blocked || domain.endsWith(`.${blocked}`));
}

function domainIsBlocked(domain, blockedDomains) {
    const value = String(domain || '').trim().toLowerCase();
    if (!value) return false;
    return (blockedDomains || []).some((blocked) => value === blocked || value.endsWith(`.${blocked}`));
}

/**
 * The client's whole do-not-email list is small (a few dozen blocked domains,
 * a handful of won emails), so it is loaded once and matched in memory instead
 * of evaluating doNotEmailSql per candidate row, which timed out on large
 * auto-add batches. Cached briefly per process; a lead marked won is blocked
 * within DO_NOT_EMAIL_CACHE_TTL_MS.
 */
const DO_NOT_EMAIL_CACHE_TTL_MS = 60_000;
const doNotEmailCache = new Map();

export function clearDoNotEmailCache() {
    doNotEmailCache.clear();
}

export async function loadDoNotEmailList(db, clientId) {
    const key = String(clientId);
    const cached = doNotEmailCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const [clientResult, wonResult] = await Promise.all([
        db.query(`SELECT blocked_domains FROM clients WHERE id = $1`, [clientId]),
        db.query(
            `SELECT DISTINCT LOWER(c.email) AS email
             FROM contacts c
             WHERE c.client_id = $1
               AND c.email IS NOT NULL
               AND c.id IN (
                   SELECT e.contact_id
                   FROM contact_instantly_events e
                   WHERE e.agency_id = (SELECT agency_id FROM clients WHERE id = $1)
                     AND e.client_id = $1
                     AND e.event_type = '${WON_EVENT_TYPE}'
                     AND e.contact_id IS NOT NULL
                   UNION
                   SELECT w.contact_id
                   FROM contact_instantly_campaigns w
                   WHERE w.interest_status = ${WON_INTEREST_STATUS}
                      OR LOWER(COALESCE(w.interest_status_label, '')) = 'won'
               )`,
            [clientId]
        )
    ]);
    const value = {
        blockedDomains: (clientResult.rows[0]?.blocked_domains || []).map((d) => String(d).toLowerCase()),
        wonEmails: new Set(wonResult.rows.map((row) => row.email).filter(Boolean))
    };
    doNotEmailCache.set(key, { value, expiresAt: Date.now() + DO_NOT_EMAIL_CACHE_TTL_MS });
    return value;
}

/**
 * Lowercased emails, among those given, that must not be emailed for this
 * client: the same email was ever won in the client, the email domain is
 * blocked, or the contact's company domain is blocked.
 */
export async function findDoNotEmailEmails(db, clientId, emails) {
    const wanted = [...new Set((emails || []).map((email) => String(email || '').trim().toLowerCase()).filter(Boolean))];
    if (!wanted.length) return new Set();
    const { blockedDomains, wonEmails } = await loadDoNotEmailList(db, clientId);

    const out = new Set();
    for (const email of wanted) {
        if (wonEmails.has(email) || emailDomainIsBlocked(email, blockedDomains)) out.add(email);
    }
    if (blockedDomains.length) {
        // Company-domain check: one indexed lookup for just these emails.
        const companyResult = await db.query(
            `SELECT LOWER(c.email) AS email, LOWER(co.domain_normalized) AS domain
             FROM contacts c
             JOIN companies co ON co.id = c.company_id
             WHERE c.client_id = $1
               AND c.email IS NOT NULL
               AND LOWER(c.email) = ANY($2::text[])`,
            [clientId, wanted]
        );
        for (const row of companyResult.rows) {
            if (domainIsBlocked(row.domain, blockedDomains)) out.add(row.email);
        }
    }
    return out;
}

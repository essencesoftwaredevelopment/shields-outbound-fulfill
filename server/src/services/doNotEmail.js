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

/**
 * Lowercased emails, among those given, that must not be emailed for this
 * client: blocked email domains, plus contacts in the client that were ever
 * won or whose company domain is blocked.
 */
export async function findDoNotEmailEmails(db, clientId, emails) {
    const wanted = [...new Set((emails || []).map((email) => String(email || '').trim().toLowerCase()).filter(Boolean))];
    if (!wanted.length) return new Set();
    const [clientResult, contactResult] = await Promise.all([
        db.query(`SELECT blocked_domains FROM clients WHERE id = $1`, [clientId]),
        db.query(
            `SELECT DISTINCT LOWER(c.email) AS email
             FROM contacts c
             WHERE c.client_id = $1
               AND LOWER(c.email) = ANY($2::text[])
               AND ${doNotEmailSql('c.id')}`,
            [clientId, wanted]
        )
    ]);
    const blockedDomains = clientResult.rows[0]?.blocked_domains || [];
    const out = new Set(contactResult.rows.map((row) => row.email));
    for (const email of wanted) {
        if (emailDomainIsBlocked(email, blockedDomains)) out.add(email);
    }
    return out;
}

/**
 * Leads ever marked won are never emailed by anything automated: follow-ups,
 * the re-engagement send, the interested autoresponder, or adding leads to an
 * Instantly campaign. "Won" means a lead_closed event or Instantly interest
 * status 4 ("won") on any of their campaigns, at any time, matched by contact
 * and by email within the same client.
 */

export const WON_EVENT_TYPE = 'lead_closed';
export const WON_INTEREST_STATUS = 4;

/** SQL that is true when the contact (or anyone with their email in the same client) was ever won. */
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

export async function isContactEverWon(db, contactId) {
    if (!contactId) return false;
    const result = await db.query(`SELECT ${everWonSql('$1')} AS won`, [contactId]);
    return result.rows[0]?.won === true;
}

/** Lowercased emails, among those given, that belong to a contact in this client who was ever won. */
export async function findEverWonEmails(db, clientId, emails) {
    const wanted = [...new Set((emails || []).map((email) => String(email || '').trim().toLowerCase()).filter(Boolean))];
    if (!wanted.length) return new Set();
    const result = await db.query(
        `SELECT DISTINCT LOWER(c.email) AS email
         FROM contacts c
         WHERE c.client_id = $1
           AND LOWER(c.email) = ANY($2::text[])
           AND ${everWonSql('c.id')}`,
        [clientId, wanted]
    );
    return new Set(result.rows.map((row) => row.email));
}

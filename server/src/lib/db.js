/**
 * Database utilities and transaction helper
 *
 * Provides:
 * 1. Single shared pg.Pool instance (already created in config/db.js)
 * 2. withTx() helper for transaction management
 * 3. Batch operation helpers for crash-safe pipeline processing
 *
 * All operations are scope-aware:
 * - Agency_id is the primary auth boundary (always enforced)
 * - Client_id (if present in schema) is a product concern (optional, per-request)
 */

import { pool as dbPool } from '../config/db.js';

// Re-export pool for convenience
export const pool = dbPool;

/**
 * Execute a callback within a database transaction
 * Automatically commits on success, rolls back on error
 *
 * Usage:
 *   const result = await withTx(async (client) => {
 *       await client.query(...);
 *       return result;
 *   });
 *
 * @param {Function} fn - Async callback receiving pg.PoolClient
 * @returns {Promise<any>} - Result from fn
 * @throws - Original error if transaction fails
 */
export async function withTx(fn) {
    const client = await dbPool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Batch upsert companies with checkpoint management
 * All rows are scoped to a single agency and client
 *
 * @param {pg.PoolClient} txClient - Transaction client
 * @param {string} agencyId - Agency identifier (Firebase uid)
 * @param {number} clientId - Client ID (required)
 * @param {Array} rows - Array of {domain, ...} objects
 * @returns {Promise<Map<string, number>>} Map of domain -> company_id
 */
export async function batchUpsertCompanies(txClient, agencyId, clientId, rows) {
    if (!rows.length) return new Map();
    if (!clientId) throw new Error('clientId is required');

    const domainMap = new Map();
    const uniqueDomains = [...new Set(rows.map((r) => (r.domain || '').toLowerCase()).filter(Boolean))];

    if (!uniqueDomains.length) return domainMap;

    // Batch upsert in a single query for efficiency
    const valuesList = [];
    const params = [agencyId]; // Start with agencyId only
    let paramIndex = 2;

    for (const domain of uniqueDomains) {
        params.push(domain.toLowerCase());
        valuesList.push(`($1, $${paramIndex})`);
        paramIndex += 1;
    }

    const query = `
        INSERT INTO companies (agency_id, domain_normalized)
        VALUES ${valuesList.join(', ')}
        ON CONFLICT (agency_id, domain_normalized)
        DO UPDATE SET updated_at = now()
        RETURNING id, domain_normalized
    `;

    const result = await txClient.query(query, params);

    for (const row of result.rows) {
        domainMap.set(row.domain_normalized, row.id);
    }

    return domainMap;
}

/**
 * Batch upsert contacts for companies
 * Idempotent: updates existing (company_id, role_type) pairs
 * Never overwrites non-null fields with nulls
 *
 * @param {pg.PoolClient} txClient - Transaction client
 * @param {string} agencyId - Agency identifier
 * @param {number} clientId - Client ID (required)
 * @param {Array} rows - Array of {company_id, role_type, full_name?, email?, email_status?, confidence?, ...} objects
 * @returns {Promise<Array>} Updated/inserted contact rows
 */
export async function batchUpsertContacts(txClient, agencyId, clientId, rows) {
    if (!rows.length) return [];
    if (!clientId) throw new Error('clientId is required');

    const valuesList = [];
    const params = []; // No client_id param
    let paramIndex = 1;

    for (const row of rows) {
        const { 
            company_id, 
            role_type, 
            full_name = null, 
            email = null, 
            email_status = null, 
            confidence = null,
            personalization_first_line = null
        } = row;

        if (!company_id || !role_type) continue; // Skip invalid rows

        params.push(company_id, role_type, full_name, email, email_status, confidence, agencyId, personalization_first_line);
        valuesList.push(`($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5}, $${paramIndex + 6}, $${paramIndex + 7})`);
        paramIndex += 8;
    }

    if (!valuesList.length) return [];

    const query = `
        INSERT INTO contacts (company_id, role_type, full_name, email, email_status, confidence, agency_id, personalization_first_line)
        VALUES ${valuesList.join(', ')}
        ON CONFLICT (company_id, role_type)
        DO UPDATE SET
            company_id = COALESCE(EXCLUDED.company_id, contacts.company_id),
            role_type = COALESCE(EXCLUDED.role_type, contacts.role_type),
            full_name = COALESCE(EXCLUDED.full_name, contacts.full_name),
            email_status = COALESCE(EXCLUDED.email_status, contacts.email_status),
            confidence = COALESCE(EXCLUDED.confidence, contacts.confidence),
            personalization_first_line = COALESCE(EXCLUDED.personalization_first_line, contacts.personalization_first_line),
            updated_at = now()
        RETURNING id, agency_id, company_id, role_type, full_name, email, email_status, 
                  last_verified_at, last_contacted_at, confidence, personalization_first_line, created_at, updated_at
    `;

    const result = await txClient.query(query, params);
    return result.rows;
}

/**
 * Write or update a job stage checkpoint
 * Used to track progress for crash-safe resume
 *
 * @param {pg.PoolClient} txClient - Transaction client
 * @param {string} agencyId - Agency identifier
 * @param {number} clientId - Client ID (required)
 * @param {string} jobId - Job identifier
 * @param {string} stage - Stage name (founder, email_find, verify, personalize)
 * @param {string} cursor - Current processing cursor/position
 * @returns {Promise<Object>} Checkpoint row
 */
export async function writeCheckpoint(txClient, agencyId, clientId, jobId, stage, cursor) {
    const query = `
        INSERT INTO job_stage_checkpoints (agency_id, job_id, stage, cursor)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (agency_id, job_id, stage)
        DO UPDATE SET cursor = $4, updated_at = now()
        RETURNING agency_id, job_id, stage, cursor, updated_at
    `;
    const result = await txClient.query(query, [agencyId, jobId, stage, cursor]);
    return result.rows[0];
}

/**
 * Fetch existing domains for deduplication
 * Returns domain -> boolean map for quick lookup
 *
 * @param {number} clientId - Client ID (required)
 * @param {Array} domains - Domains to check
 * @returns {Promise<Set<string>>} Set of domains that already exist
 */
export async function getExistingDomainsSet(clientId, domains) {
    if (!domains.length) return new Set();
    if (!clientId) throw new Error('clientId is required');

    const normalizedDomains = domains.map((d) => (d || '').toLowerCase()).filter(Boolean);
    if (!normalizedDomains.length) return new Set();

    const placeholders = normalizedDomains.map((_, i) => `$${i + 2}`).join(',');
    const query = `
        SELECT domain_normalized
        FROM companies
        WHERE client_id = $1 AND domain_normalized IN (${placeholders})
    `;

    const result = await pool.query(query, [clientId, ...normalizedDomains]);
    return new Set(result.rows.map((r) => r.domain_normalized));
}

/**
 * Mark multiple contacts as contacted/sent
 * Updates last_contacted_at to prevent accidental resends
 *
 * @param {number} clientId - Client ID (required)
 * @param {Array} contactIds - Contact IDs to mark
 * @returns {Promise<Array>} Updated contact rows
 */
export async function markContactsContacted(clientId, contactIds) {
    if (!contactIds.length) return [];
    if (!clientId) throw new Error('clientId is required');

    const placeholders = contactIds.map((_, i) => `$${i + 2}`).join(',');
    const query = `
        UPDATE contacts
        SET last_contacted_at = now(), updated_at = now()
        WHERE client_id = $1 AND id IN (${placeholders})
        RETURNING id, email, full_name, last_contacted_at, updated_at
    `;

    const result = await pool.query(query, [clientId, ...contactIds]);
    return result.rows;
}

/**
 * Mark contacts as contacted by email list
 * Useful when you have email addresses but not contact IDs
 * NOTE: This updates by email, which could match across companies within a client
 * Use markContactsContacted with IDs for per-company precision if needed
 *
 * @param {number} clientId - Client ID (required)
 * @param {Array} emails - Email addresses to mark as contacted
 * @returns {Promise<Array>} Updated contact rows
 */
export async function markEmailsContacted(clientId, emails) {
    if (!emails.length) return [];
    if (!clientId) throw new Error('clientId is required');

    const validEmails = emails.map((e) => (e || '').trim().toLowerCase()).filter(Boolean);
    if (!validEmails.length) return [];

    const placeholders = validEmails.map((_, i) => `$${i + 2}`).join(',');
    const query = `
        UPDATE contacts
        SET last_contacted_at = now(), updated_at = now()
        WHERE client_id = $1 AND email IN (${placeholders})
        RETURNING id, email, full_name, last_contacted_at, updated_at
    `;

    const result = await pool.query(query, [clientId, ...validEmails]);
    return result.rows;
}

export default {
    pool,
    withTx,
    batchUpsertCompanies,
    batchUpsertContacts,
    writeCheckpoint,
    getExistingDomainsSet,
    markContactsContacted,
    markEmailsContacted
};

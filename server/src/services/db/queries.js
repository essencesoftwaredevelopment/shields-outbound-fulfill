/**
 * Database query helpers for multi-tenant PostgreSQL operations.
 *
 * CANONICAL AGENCY IDENTIFIER RULE:
 * The Firestore users/{uid} document ID is the canonical agency identifier.
 * This same Firebase Auth uid is used directly as agency_id in all PostgreSQL tables.
 * No reconciliation or mapping is required.
 *
 * MVP SCOPE: Single implicit client per agency
 * In the current MVP, there is no clients table. All queries are scoped by agency_id only.
 * This means each agency manages one implicit "client" (brand/workspace).
 *
 * FUTURE EVOLUTION: Client-level support
 * When client support is added, these functions will accept an optional client_id parameter.
 * For example: getContactsByAgency(agencyId, clientId, filters)
 * The middleware will still only handle agencyId (from auth); client_id is a product concern.
 * See server/AGENCY_IDENTITY.md for complete architecture guidance.
 *
 * Every query in this module:
 * 1. Requires agency_id as a parameter (scoping key)
 * 2. Always includes WHERE agency_id = ? in the query
 * 3. Never allows unscoped queries
 */

import { pool } from '../../config/db.js';

function safeDecodeURIComponent(value = '') {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function safeEncodeURIComponent(value = '') {
    try {
        return encodeURIComponent(value);
    } catch {
        return value;
    }
}

function buildClientLookupVariants(clientName) {
    const textVariants = new Set();
    const slugVariants = new Set();
    const compactVariants = new Set();

    const addValue = (value) => {
        const raw = String(value || '').trim();
        if (!raw) return;

        const decoded = safeDecodeURIComponent(raw);
        const encodedRaw = safeEncodeURIComponent(raw);
        const encodedDecoded = safeEncodeURIComponent(decoded);

        const variants = [raw, decoded, encodedRaw, encodedDecoded]
            .map((variant) => String(variant || '').trim().toLowerCase())
            .filter(Boolean);

        for (const variant of variants) {
            textVariants.add(variant);

            const slug = variant
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '');
            if (slug) slugVariants.add(slug);

            const compact = variant.replace(/[^a-z0-9]+/g, '');
            if (compact) compactVariants.add(compact);
        }
    };

    addValue(clientName);

    return {
        textVariants: Array.from(textVariants),
        slugVariants: Array.from(slugVariants),
        compactVariants: Array.from(compactVariants)
    };
}

/**
 * Get or create a client by name for an agency
 * Returns the numeric client ID
 *
 * @param {string} agencyId - The Firebase uid (canonical agency identifier)
 * @param {string} clientName - The client name/identifier (e.g., "essence")
 * @returns {Promise<number>} The numeric client ID
 */
export async function getOrCreateClient(agencyId, clientName) {
    if (!agencyId || !clientName) {
        throw new Error('agencyId and clientName are required');
    }

    const normalizedClientName = String(clientName).trim();
    const variants = buildClientLookupVariants(normalizedClientName);

    // Try to find existing client
    const findQuery = `
        WITH client_candidates AS (
            SELECT
                id,
                LOWER(name) AS lower_name,
                REPLACE(REPLACE(LOWER(name), '%40', '@'), '%2e', '.') AS decoded_name,
                REGEXP_REPLACE(LOWER(name), '[^a-z0-9]+', '-', 'g') AS slug_name,
                REGEXP_REPLACE(LOWER(name), '[^a-z0-9]+', '', 'g') AS compact_name,
                REGEXP_REPLACE(REPLACE(REPLACE(LOWER(name), '%40', '@'), '%2e', '.'), '[^a-z0-9]+', '-', 'g') AS decoded_slug_name,
                REGEXP_REPLACE(REPLACE(REPLACE(LOWER(name), '%40', '@'), '%2e', '.'), '[^a-z0-9]+', '', 'g') AS decoded_compact_name
            FROM clients
            WHERE agency_id = $1
        )
        SELECT id
        FROM client_candidates
        WHERE
            lower_name = ANY($2::text[])
            OR decoded_name = ANY($2::text[])
            OR slug_name = ANY($3::text[])
            OR decoded_slug_name = ANY($3::text[])
            OR compact_name = ANY($4::text[])
            OR decoded_compact_name = ANY($4::text[])
        ORDER BY id ASC
        LIMIT 1
    `;
    const findResult = await pool.query(findQuery, [
        agencyId,
        variants.textVariants,
        variants.slugVariants,
        variants.compactVariants
    ]);
    
    if (findResult.rows.length > 0) {
        return findResult.rows[0].id;
    }

    // Create new client if not found
    const insertQuery = `
        INSERT INTO clients (agency_id, name)
        VALUES ($1, $2)
        RETURNING id
    `;
    const insertResult = await pool.query(insertQuery, [agencyId, normalizedClientName]);
    return insertResult.rows[0].id;
}

/**
 * Fetch or create a company by domain, scoped to an agency
 *
 * @param {string} agencyId - The Firebase uid (canonical agency identifier)
 * @param {string} domainNormalized - The normalized domain (e.g., "fashionnova.com")
 * @returns {Promise<{id: number, agency_id: string, domain_normalized: string}>}
 */
export async function upsertCompany(agencyId, domainNormalized) {
    const query = `
        INSERT INTO companies (agency_id, domain_normalized)
        VALUES ($1, $2)
        ON CONFLICT (agency_id, domain_normalized)
        DO UPDATE SET updated_at = now()
        RETURNING id, agency_id, domain_normalized, created_at, updated_at
    `;
    const result = await pool.query(query, [agencyId, domainNormalized]);
    return result.rows[0];
}

/**
 * Fetch all companies for an agency
 *
 * @param {string} agencyId - The Firebase uid
 * @returns {Promise<Array>}
 */
export async function getCompaniesByAgency(agencyId) {
    const query = `
        SELECT id, agency_id, domain_normalized, created_at, updated_at
        FROM companies
        WHERE agency_id = $1
        ORDER BY created_at DESC
    `;
    const result = await pool.query(query, [agencyId]);
    return result.rows;
}

/**
 * Check which domains already exist for an agency (for dedup)
 *
 * @param {string} agencyId - The Firebase uid
 * @param {string[]} domainNormalized - Array of domains to check
 * @returns {Promise<Set<string>>} Set of domains that already exist
 */
export async function getExistingDomains(agencyId, domainsNormalized) {
    if (!domainsNormalized.length) return new Set();

    const placeholders = domainsNormalized.map((_, i) => `$${i + 2}`).join(',');
    const query = `
        SELECT domain_normalized
        FROM companies
        WHERE agency_id = $1 AND domain_normalized IN (${placeholders})
    `;
    const params = [agencyId, ...domainsNormalized];
    const result = await pool.query(query, params);
    return new Set(result.rows.map((r) => r.domain_normalized));
}

/**
 * Upsert a contact for a company, scoped to an agency
 * Idempotent: updates if (company_id, role_type) already exists
 *
 * @param {string} agencyId - The Firebase uid
 * @param {number} companyId - Company ID
 * @param {string} roleType - Role type (founder, dm, etc.)
 * @param {Object} data - Contact data to upsert
 * @param {string} [data.full_name]
 * @param {string} [data.email]
 * @param {string} [data.email_status]
 * @param {string} [data.confidence]
 * @returns {Promise<{id: number, ...}>}
 */
export async function upsertContact(agencyId, companyId, roleType, data = {}) {
    const {
        full_name = null,
        email = null,
        email_status = null,
        confidence = null,
        job_id = null
    } = data;

    const query = `
        INSERT INTO contacts (
            agency_id, company_id, role_type, full_name, email, email_status, confidence, job_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (company_id, role_type)
        DO UPDATE SET
            full_name = COALESCE(EXCLUDED.full_name, contacts.full_name),
            email = COALESCE(EXCLUDED.email, contacts.email),
            email_status = COALESCE(EXCLUDED.email_status, contacts.email_status),
            confidence = COALESCE(EXCLUDED.confidence, contacts.confidence),
            job_id = COALESCE(EXCLUDED.job_id, contacts.job_id),
            updated_at = now()
        RETURNING id, agency_id, company_id, role_type, full_name, email, email_status, 
                  last_verified_at, last_contacted_at, confidence, job_id, created_at, updated_at
    `;
    
    try {
        const result = await pool.query(query, [
            agencyId,
            companyId,
            roleType,
            full_name,
            email,
            email_status,
            confidence,
            job_id
        ]);
        return result.rows[0];
    } catch (err) {
        // Handle email uniqueness constraint violations
        // Note: This handles both (agency_id, email) and (client_id, email) constraints
        if (err.code === '23505' && email && (err.constraint?.includes('email') || err.message?.includes('email'))) {
            console.warn(`[upsertContact] Email uniqueness violation for ${email}, updating existing record`);
            
            // Update the existing contact with this email
            const updateQuery = `
                UPDATE contacts
                SET
                    company_id = $1,
                    role_type = $2,
                    full_name = COALESCE($3, full_name),
                    email_status = COALESCE($4, email_status),
                    confidence = COALESCE($5, confidence),
                    job_id = COALESCE($6, job_id),
                    updated_at = now()
                WHERE agency_id = $7 AND email = $8
                RETURNING id, agency_id, company_id, role_type, full_name, email, email_status, 
                          last_verified_at, last_contacted_at, confidence, job_id, created_at, updated_at
            `;
            const updateResult = await pool.query(updateQuery, [
                companyId,
                roleType,
                full_name,
                email_status,
                confidence,
                job_id,
                agencyId,
                email
            ]);
            
            if (updateResult.rows[0]) {
                return updateResult.rows[0];
            }
            
            // If update didn't find a row, re-throw original error
            throw err;
        }
        
        // Re-throw any other errors
        throw err;
    }
}

/**
 * Get all contacts for an agency with optional filters
 *
 * @param {string} agencyId - The Firebase uid
 * @param {Object} [filters={}] - Optional filters
 * @param {string} [filters.emailStatus] - Filter by email_status
 * @param {number} [filters.limit] - Limit results
 * @param {number} [filters.offset] - Offset results
 * @returns {Promise<{count: number, rows: Array}>}
 */
export async function getContactsByAgency(agencyId, filters = {}) {
    const { emailStatus, limit = 500, offset = 0 } = filters;

    let query = `
        SELECT
            c.id,
            c.agency_id,
            c.company_id,
            c.role_type,
            c.full_name,
            c.email,
            c.email_status,
            c.last_verified_at,
            c.last_contacted_at,
            c.confidence,
            c.created_at,
            c.updated_at,
            co.domain_normalized
        FROM contacts c
        JOIN companies co ON c.company_id = co.id
        WHERE c.agency_id = $1
    `;

    const params = [agencyId];
    let paramIndex = 2;

    if (emailStatus) {
        query += ` AND c.email_status = $${paramIndex}`;
        params.push(emailStatus);
        paramIndex++;
    }

    query += ` ORDER BY c.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);
    return result.rows;
}

/**
 * Mark contacts as sent/exported by updating last_contacted_at
 * This is the "send safety" guardrail to prevent accidental resends
 *
 * @param {string} agencyId - The Firebase uid
 * @param {number[]} contactIds - Contact IDs to mark as sent
 * @returns {Promise<Array>} Updated contact rows
 */
export async function markContactsAsSent(agencyId, contactIds) {
    if (!contactIds.length) return [];

    const placeholders = contactIds.map((_, i) => `$${i + 2}`).join(',');
    const query = `
        UPDATE contacts
        SET last_contacted_at = now(), updated_at = now()
        WHERE agency_id = $1 AND id IN (${placeholders})
        RETURNING id, last_contacted_at, updated_at
    `;
    const result = await pool.query(query, [agencyId, ...contactIds]);
    return result.rows;
}

/**
 * Get or create a job stage checkpoint, scoped to an agency
 *
 * @param {string} agencyId - The Firebase uid
 * @param {string} jobId - Job identifier
 * @param {string} stage - Stage name (founder, email_find, verify, personalize)
 * @param {string} [cursor=''] - Starting cursor (default empty string)
 * @returns {Promise<{agency_id: string, job_id: string, stage: string, cursor: string, updated_at: Date}>}
 */
export async function getOrCreateCheckpoint(agencyId, jobId, stage, cursor = '') {
    const query = `
        INSERT INTO job_stage_checkpoints (agency_id, job_id, stage, cursor)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (agency_id, job_id, stage)
        DO UPDATE SET updated_at = now()
        RETURNING agency_id, job_id, stage, cursor, updated_at
    `;
    const result = await pool.query(query, [agencyId, jobId, stage, cursor]);
    return result.rows[0];
}

/**
 * Update a job stage checkpoint with new cursor, scoped to an agency
 *
 * @param {string} agencyId - The Firebase uid
 * @param {string} jobId - Job identifier
 * @param {string} stage - Stage name
 * @param {string} newCursor - New cursor value
 * @returns {Promise<{agency_id: string, job_id: string, stage: string, cursor: string, updated_at: Date}>}
 */
export async function updateCheckpoint(agencyId, jobId, stage, newCursor) {
    const query = `
        UPDATE job_stage_checkpoints
        SET cursor = $4, updated_at = now()
        WHERE agency_id = $1 AND job_id = $2 AND stage = $3
        RETURNING agency_id, job_id, stage, cursor, updated_at
    `;
    const result = await pool.query(query, [agencyId, jobId, stage, newCursor]);
    return result.rows[0];
}

/**
 * Get all checkpoints for a job, scoped to an agency
 *
 * @param {string} agencyId - The Firebase uid
 * @param {string} jobId - Job identifier
 * @returns {Promise<Array>}
 */
export async function getJobCheckpoints(agencyId, jobId) {
    const query = `
        SELECT agency_id, job_id, stage, cursor, updated_at
        FROM job_stage_checkpoints
        WHERE agency_id = $1 AND job_id = $2
        ORDER BY stage
    `;
    const result = await pool.query(query, [agencyId, jobId]);
    return result.rows;
}

/**
 * Delete all data for an agency (for cleanup/testing)
 * WARNING: This is destructive and should only be used by admin operations
 *
 * @param {string} agencyId - The Firebase uid
 * @returns {Promise<{companies: number, contacts: number, checkpoints: number}>}
 */
export async function deleteAgencyData(agencyId) {
    const results = {};

    // Delete contacts (cascades via FK if any remain)
    let result = await pool.query('DELETE FROM contacts WHERE agency_id = $1', [agencyId]);
    results.contacts = result.rowCount;

    // Delete companies
    result = await pool.query('DELETE FROM companies WHERE agency_id = $1', [agencyId]);
    results.companies = result.rowCount;

    // Delete checkpoints
    result = await pool.query('DELETE FROM job_stage_checkpoints WHERE agency_id = $1', [agencyId]);
    results.checkpoints = result.rowCount;

    return results;
}

export default {
    upsertCompany,
    getCompaniesByAgency,
    getExistingDomains,
    upsertContact,
    getContactsByAgency,
    markContactsAsSent,
    getOrCreateCheckpoint,
    updateCheckpoint,
    getJobCheckpoints,
    deleteAgencyData,
    pool
};

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
import { normalizeDomain } from '../utils/domain.js';

// Re-export pool for convenience
export const pool = dbPool;

const MAX_SAFE_QUERY_PARAMS = 4000;
const COMPANY_FIXED_PARAMS = 2;
const CONTACT_FIXED_PARAMS = 1;
const CONTACT_PARAMS_PER_ROW = 11;

function chunkArray(items, size) {
    if (!Array.isArray(items) || items.length === 0) return [];
    const chunks = [];
    for (let i = 0; i < items.length; i += size) {
        chunks.push(items.slice(i, i + size));
    }
    return chunks;
}

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
    const uniqueDomains = [...new Set(rows.map((r) => normalizeDomain(r.domain)).filter(Boolean))];

    if (!uniqueDomains.length) {
        console.warn(`[batchUpsertCompanies] No valid domains found in ${rows.length} rows`);
        return domainMap;
    }

    console.log(`[batchUpsertCompanies] Upserting ${uniqueDomains.length} unique domains for agency ${agencyId}, client ${clientId}`);

    const maxDomainsPerChunk = Math.max(1, MAX_SAFE_QUERY_PARAMS - COMPANY_FIXED_PARAMS);
    const domainChunks = chunkArray(uniqueDomains, maxDomainsPerChunk);

    try {
        let totalUpserted = 0;

        for (const domainChunk of domainChunks) {
            const valuesList = [];
            const params = [agencyId, clientId];
            let paramIndex = 3;

            for (const domain of domainChunk) {
                params.push(domain);
                valuesList.push(`($1, $2, $${paramIndex})`);
                paramIndex += 1;
            }

            const query = `
                INSERT INTO companies (agency_id, client_id, domain_normalized)
                VALUES ${valuesList.join(', ')}
                ON CONFLICT (client_id, domain_normalized)
                DO UPDATE SET updated_at = now()
                RETURNING id, domain_normalized
            `;

            const result = await txClient.query(query, params);
            totalUpserted += result.rows.length;

            for (const row of result.rows) {
                domainMap.set(row.domain_normalized, row.id);
            }
        }

        console.log(`[batchUpsertCompanies] Upserted ${totalUpserted} companies across ${domainChunks.length} chunk(s)`);
        return domainMap;
    } catch (err) {
        console.error(`[batchUpsertCompanies] Query failed:`, err.message);
        throw err;
    }
}

/**
 * Batch upsert contacts for companies
 * Idempotent: updates existing (company_id, role_type) pairs
 * Never overwrites non-null fields with nulls
 *
 * @param {pg.PoolClient} txClient - Transaction client
 * @param {string} agencyId - Agency identifier
 * @param {number} clientId - Client ID (required)
 * @param {Array} rows - Array of {company_id, role_type, full_name?, email?, email_status?, email_find_completed_at?, email_verify_completed_at?, confidence?, ...} objects
 * @returns {Promise<Array>} Updated/inserted contact rows
 */
function buildContactUpsertUpdateClause(mergeMode, upsertType = 'default') {
    if (mergeMode === 'preserve') {
        return `
            full_name = COALESCE(EXCLUDED.full_name, contacts.full_name),
            email = COALESCE(EXCLUDED.email, contacts.email),
            email_status = COALESCE(EXCLUDED.email_status, contacts.email_status),
            email_find_completed_at = COALESCE(EXCLUDED.email_find_completed_at, contacts.email_find_completed_at),
            email_verify_completed_at = COALESCE(EXCLUDED.email_verify_completed_at, contacts.email_verify_completed_at),
            confidence = COALESCE(EXCLUDED.confidence, contacts.confidence),
            personalization_first_line = COALESCE(EXCLUDED.personalization_first_line, contacts.personalization_first_line),
            job_id = COALESCE(EXCLUDED.job_id, contacts.job_id),
            updated_at = now()`;
    }

    if (upsertType === 'founders') {
        return `
            full_name = CASE
                WHEN EXCLUDED.full_name IS NOT NULL AND BTRIM(EXCLUDED.full_name) <> ''
                     AND LOWER(BTRIM(EXCLUDED.full_name)) <> 'not found'
                THEN EXCLUDED.full_name
                ELSE contacts.full_name
            END,
            email = COALESCE(EXCLUDED.email, contacts.email),
            email_status = COALESCE(EXCLUDED.email_status, contacts.email_status),
            confidence = COALESCE(EXCLUDED.confidence, contacts.confidence),
            personalization_first_line = COALESCE(EXCLUDED.personalization_first_line, contacts.personalization_first_line),
            job_id = COALESCE(EXCLUDED.job_id, contacts.job_id),
            updated_at = now()`;
    }

    if (upsertType === 'emails') {
        return `
            full_name = COALESCE(EXCLUDED.full_name, contacts.full_name),
            email = CASE
                WHEN EXCLUDED.email IS NOT NULL AND BTRIM(EXCLUDED.email) <> '' THEN EXCLUDED.email
                ELSE contacts.email
            END,
            email_find_completed_at = COALESCE(EXCLUDED.email_find_completed_at, contacts.email_find_completed_at),
            confidence = COALESCE(EXCLUDED.confidence, contacts.confidence),
            personalization_first_line = COALESCE(EXCLUDED.personalization_first_line, contacts.personalization_first_line),
            job_id = COALESCE(EXCLUDED.job_id, contacts.job_id),
            updated_at = now()`;
    }

    if (upsertType === 'verification') {
        return `
            full_name = COALESCE(EXCLUDED.full_name, contacts.full_name),
            email = COALESCE(EXCLUDED.email, contacts.email),
            email_status = COALESCE(EXCLUDED.email_status, contacts.email_status),
            email_verify_completed_at = COALESCE(EXCLUDED.email_verify_completed_at, contacts.email_verify_completed_at),
            confidence = COALESCE(EXCLUDED.confidence, contacts.confidence),
            personalization_first_line = COALESCE(EXCLUDED.personalization_first_line, contacts.personalization_first_line),
            job_id = COALESCE(EXCLUDED.job_id, contacts.job_id),
            updated_at = now()`;
    }

    if (upsertType === 'personalization') {
        return `
            full_name = COALESCE(EXCLUDED.full_name, contacts.full_name),
            email = COALESCE(EXCLUDED.email, contacts.email),
            email_status = COALESCE(EXCLUDED.email_status, contacts.email_status),
            confidence = COALESCE(EXCLUDED.confidence, contacts.confidence),
            personalization_first_line = CASE
                WHEN EXCLUDED.personalization_first_line IS NOT NULL AND BTRIM(EXCLUDED.personalization_first_line) <> ''
                THEN EXCLUDED.personalization_first_line
                ELSE contacts.personalization_first_line
            END,
            job_id = COALESCE(EXCLUDED.job_id, contacts.job_id),
            updated_at = now()`;
    }

    return `
            full_name = COALESCE(EXCLUDED.full_name, contacts.full_name),
            email = CASE
                WHEN EXCLUDED.email IS NOT NULL AND BTRIM(EXCLUDED.email) <> '' THEN EXCLUDED.email
                ELSE contacts.email
            END,
            email_status = COALESCE(EXCLUDED.email_status, contacts.email_status),
            confidence = COALESCE(EXCLUDED.confidence, contacts.confidence),
            personalization_first_line = CASE
                WHEN EXCLUDED.personalization_first_line IS NOT NULL AND BTRIM(EXCLUDED.personalization_first_line) <> ''
                THEN EXCLUDED.personalization_first_line
                ELSE contacts.personalization_first_line
            END,
            job_id = COALESCE(EXCLUDED.job_id, contacts.job_id),
            updated_at = now()`;
}

export async function batchUpsertContacts(txClient, agencyId, clientId, rows, options = {}) {
    if (!rows.length) return [];
    if (!clientId) throw new Error('clientId is required');
    const mergeMode = options.mergeMode === 'enrichment_b' ? 'enrichment_b' : 'preserve';
    const upsertType = options.upsertType || 'default';
    const updateClause = buildContactUpsertUpdateClause(mergeMode, upsertType);

    const isEmailUniqueViolation = (err) => {
        if (err?.code !== '23505') return false;
        const constraint = String(err?.constraint || '').toLowerCase();
        const message = String(err?.message || '').toLowerCase();
        return constraint.includes('email') || message.includes('email');
    };

    const isCompanyRoleUniqueViolation = (err) => {
        if (err?.code !== '23505') return false;
        const constraint = String(err?.constraint || '').toLowerCase();
        const message = String(err?.message || '').toLowerCase();
        return constraint.includes('company_id_role_type') ||
            (message.includes('company_id') && message.includes('role_type'));
    };

    const normalizeEmail = (email) => {
        if (!email || typeof email !== 'string') return null;
        const normalized = email.trim().toLowerCase();
        return normalized || null;
    };

    const normalizeOptionalText = (value) => {
        if (value === null || value === undefined) return null;
        const normalized = String(value).trim();
        return normalized || null;
    };

    const rollbackAndReleaseSavepoint = async (savepointName) => {
        await txClient.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
        await txClient.query(`RELEASE SAVEPOINT ${savepointName}`);
    };

    // 1) Dedupe by upsert target key first: (company_id, role_type)
    // Keep the richest non-null values when duplicate rows target the same contact.
    const dedupedByTargetKey = new Map();
    let validInputRows = 0;

    for (const row of rows) {
        const {
            company_id,
            role_type,
            full_name = null,
            email = null,
            email_status = null,
            email_find_completed_at = null,
            email_verify_completed_at = null,
            confidence = null,
            personalization_first_line = null,
            job_id = null
        } = row;

        const normalizedCompanyId = normalizeOptionalText(company_id);
        const normalizedRoleType = normalizeOptionalText(role_type);

        if (!normalizedCompanyId || !normalizedRoleType) {
            console.warn(`[batchUpsertContacts] Skipping row with null company_id or role_type:`, { company_id, role_type, email });
            continue;
        }
        validInputRows += 1;

        const key = `${normalizedCompanyId}::${normalizedRoleType}`;
        const normalizedRow = {
            company_id: normalizedCompanyId,
            role_type: normalizedRoleType,
            full_name: normalizeOptionalText(full_name),
            email: normalizeEmail(email),
            email_status: normalizeOptionalText(email_status),
            email_find_completed_at: email_find_completed_at || null,
            email_verify_completed_at: email_verify_completed_at || null,
            confidence,
            personalization_first_line: normalizeOptionalText(personalization_first_line),
            job_id: normalizeOptionalText(job_id)
        };
        const previous = dedupedByTargetKey.get(key);
        if (!previous) {
            dedupedByTargetKey.set(key, normalizedRow);
            continue;
        }
        dedupedByTargetKey.set(key, {
            company_id: normalizedCompanyId,
            role_type: normalizedRoleType,
            full_name: normalizedRow.full_name ?? previous.full_name,
            email: normalizedRow.email ?? previous.email,
            email_status: normalizedRow.email_status ?? previous.email_status,
            email_find_completed_at: normalizedRow.email_find_completed_at ?? previous.email_find_completed_at,
            email_verify_completed_at: normalizedRow.email_verify_completed_at ?? previous.email_verify_completed_at,
            confidence: normalizedRow.confidence ?? previous.confidence,
            personalization_first_line: normalizedRow.personalization_first_line ?? previous.personalization_first_line,
            job_id: normalizedRow.job_id ?? previous.job_id
        });
    }

    const rowsMetadata = Array.from(dedupedByTargetKey.values());
    if (!rowsMetadata.length) return [];

    if (rowsMetadata.length < validInputRows) {
        console.warn(`[batchUpsertContacts] Deduped ${validInputRows - rowsMetadata.length} duplicate (company_id, role_type) rows before upsert`);
    }

    // 2) Dedupe duplicate non-null emails inside this batch to avoid self-collision on unique email index.
    const emailOwners = new Map();
    for (const row of rowsMetadata) {
        if (!row.email) continue;
        const existingOwner = emailOwners.get(row.email);
        if (existingOwner) {
            console.warn(
                `[batchUpsertContacts] Duplicate email in batch (${row.email}); dropping email for company_id=${row.company_id}, role_type=${row.role_type}. ` +
                `Keeping company_id=${existingOwner.company_id}, role_type=${existingOwner.role_type}`
            );
            row.email = null;
            continue;
        }
        emailOwners.set(row.email, { company_id: row.company_id, role_type: row.role_type });
    }

    const buildBulkContactUpsertQuery = (valuesSql) => `
        INSERT INTO contacts (client_id, company_id, role_type, full_name, email, email_status, email_find_completed_at, email_verify_completed_at, confidence, agency_id, personalization_first_line, job_id)
        VALUES ${valuesSql}
        ON CONFLICT (company_id, role_type)
        DO UPDATE SET ${updateClause}
        RETURNING id, agency_id, company_id, role_type, full_name, email, email_status,
                  email_find_completed_at, email_verify_completed_at,
                  last_contacted_at, confidence, personalization_first_line, job_id, created_at, updated_at
    `;

    const upsertContactsIndividually = async (rowsForFallback) => {
        console.warn(`[batchUpsertContacts] Email uniqueness violation detected, falling back to individual updates`);
        const results = [];

        for (const row of rowsForFallback) {
            try {
                await txClient.query('SAVEPOINT contacts_row_upsert');
                const individualQuery = `
                    INSERT INTO contacts (client_id, company_id, role_type, full_name, email, email_status, email_find_completed_at, email_verify_completed_at, confidence, agency_id, personalization_first_line, job_id)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                    ON CONFLICT (company_id, role_type)
                    DO UPDATE SET ${updateClause}
                    RETURNING id, agency_id, company_id, role_type, full_name, email, email_status,
                              email_find_completed_at, email_verify_completed_at,
                              last_contacted_at, confidence, personalization_first_line, job_id, created_at, updated_at
                `;
                const individualResult = await txClient.query(individualQuery, [
                    clientId, row.company_id, row.role_type, row.full_name,
                    row.email, row.email_status, row.email_find_completed_at, row.email_verify_completed_at,
                    row.confidence, agencyId, row.personalization_first_line, row.job_id
                ]);
                await txClient.query('RELEASE SAVEPOINT contacts_row_upsert');
                results.push(individualResult.rows[0]);
            } catch (innerErr) {
                await rollbackAndReleaseSavepoint('contacts_row_upsert');

                if (isEmailUniqueViolation(innerErr) && row.email) {
                    console.warn(`[batchUpsertContacts] Updating existing contact with email: ${row.email}`);
                    const updateQuery = `
                        UPDATE contacts
                        SET
                            company_id = $1,
                            role_type = $2,
                            full_name = COALESCE($3, full_name),
                            email_status = COALESCE($4, email_status),
                            email_find_completed_at = COALESCE($5::timestamptz, email_find_completed_at),
                            email_verify_completed_at = COALESCE($6::timestamptz, email_verify_completed_at),
                            confidence = COALESCE($7, confidence),
                            personalization_first_line = COALESCE($8, personalization_first_line),
                            job_id = COALESCE($9, job_id),
                            updated_at = now()
                        WHERE client_id = $10 AND email = $11
                        RETURNING id, agency_id, company_id, role_type, full_name, email, email_status,
                                  email_find_completed_at, email_verify_completed_at,
                                  last_contacted_at, confidence, personalization_first_line, job_id, created_at, updated_at
                    `;
                    try {
                        await txClient.query('SAVEPOINT contacts_email_owner_update');
                        const updateResult = await txClient.query(updateQuery, [
                            row.company_id, row.role_type, row.full_name,
                            row.email_status, row.email_find_completed_at, row.email_verify_completed_at,
                            row.confidence, row.personalization_first_line, row.job_id,
                            clientId, row.email
                        ]);
                        await txClient.query('RELEASE SAVEPOINT contacts_email_owner_update');
                        if (updateResult.rows[0]) {
                            results.push(updateResult.rows[0]);
                        }
                    } catch (updateErr) {
                        await rollbackAndReleaseSavepoint('contacts_email_owner_update');

                        if (isCompanyRoleUniqueViolation(updateErr)) {
                            console.warn(
                                `[batchUpsertContacts] Email owner move hit (company_id, role_type) conflict; ` +
                                `upserting target contact without taking email: ${row.email}`
                            );

                            const upsertTargetWithoutEmailQuery = `
                                INSERT INTO contacts (client_id, company_id, role_type, full_name, email, email_status, email_find_completed_at, email_verify_completed_at, confidence, agency_id, personalization_first_line, job_id)
                                VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, $9, $10, $11)
                                ON CONFLICT (company_id, role_type)
                                DO UPDATE SET
                                    full_name = COALESCE(EXCLUDED.full_name, contacts.full_name),
                                    email_status = COALESCE(EXCLUDED.email_status, contacts.email_status),
                                    email_find_completed_at = COALESCE(EXCLUDED.email_find_completed_at, contacts.email_find_completed_at),
                                    email_verify_completed_at = COALESCE(EXCLUDED.email_verify_completed_at, contacts.email_verify_completed_at),
                                    confidence = COALESCE(EXCLUDED.confidence, contacts.confidence),
                                    personalization_first_line = COALESCE(EXCLUDED.personalization_first_line, contacts.personalization_first_line),
                                    job_id = COALESCE(EXCLUDED.job_id, contacts.job_id),
                                    updated_at = now()
                                RETURNING id, agency_id, company_id, role_type, full_name, email, email_status,
                                          email_find_completed_at, email_verify_completed_at,
                                          last_contacted_at, confidence, personalization_first_line, job_id, created_at, updated_at
                            `;
                            const targetResult = await txClient.query(upsertTargetWithoutEmailQuery, [
                                clientId,
                                row.company_id,
                                row.role_type,
                                row.full_name,
                                row.email_status,
                                row.email_find_completed_at,
                                row.email_verify_completed_at,
                                row.confidence,
                                agencyId,
                                row.personalization_first_line,
                                row.job_id
                            ]);
                            if (targetResult.rows[0]) {
                                results.push(targetResult.rows[0]);
                            }
                        } else {
                            throw updateErr;
                        }
                    }
                } else {
                    console.error(`[batchUpsertContacts] Failed to insert/update contact:`, innerErr.message, row);
                    throw innerErr;
                }
            }
        }

        return results;
    };

    const maxRowsPerChunk = Math.max(
        1,
        Math.floor((MAX_SAFE_QUERY_PARAMS - CONTACT_FIXED_PARAMS) / CONTACT_PARAMS_PER_ROW)
    );
    const contactChunks = chunkArray(rowsMetadata, maxRowsPerChunk);
    const results = [];

    for (const contactChunk of contactChunks) {
        const valuesList = [];
        const params = [clientId];
        let paramIndex = 2;

        for (const row of contactChunk) {
            const {
                company_id,
                role_type,
                full_name,
                email,
                email_status,
                email_find_completed_at,
                email_verify_completed_at,
                confidence,
                personalization_first_line,
                job_id
            } = row;

            params.push(
                company_id,
                role_type,
                full_name,
                email,
                email_status,
                email_find_completed_at,
                email_verify_completed_at,
                confidence,
                agencyId,
                personalization_first_line,
                job_id
            );
            valuesList.push(`($1, $${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5}, $${paramIndex + 6}, $${paramIndex + 7}, $${paramIndex + 8}, $${paramIndex + 9}, $${paramIndex + 10})`);
            paramIndex += CONTACT_PARAMS_PER_ROW;
        }

        const query = buildBulkContactUpsertQuery(valuesList.join(', '));

        try {
            await txClient.query('SAVEPOINT contacts_batch_upsert');
            const result = await txClient.query(query, params);
            await txClient.query('RELEASE SAVEPOINT contacts_batch_upsert');
            results.push(...result.rows);
        } catch (err) {
            try {
                await rollbackAndReleaseSavepoint('contacts_batch_upsert');
            } catch (savepointErr) {
                console.error(`[batchUpsertContacts] Failed to rollback savepoint:`, savepointErr?.message || savepointErr);
                throw err;
            }

            if (isEmailUniqueViolation(err)) {
                const fallbackRows = await upsertContactsIndividually(contactChunk);
                results.push(...fallbackRows);
                continue;
            }

            throw err;
        }
    }

    return results;
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

    const normalizedDomains = domains.map((d) => normalizeDomain(d)).filter(Boolean);
    if (!normalizedDomains.length) return new Set();

    const query = `
        SELECT domain_normalized
        FROM companies
        WHERE client_id = $1 AND domain_normalized = ANY($2::text[])
    `;

    const result = await pool.query(query, [clientId, normalizedDomains]);
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

    const query = `
        UPDATE contacts
        SET last_contacted_at = now(), updated_at = now()
        WHERE client_id = $1 AND id = ANY($2)
        RETURNING id, email, full_name, last_contacted_at, updated_at
    `;

    const result = await pool.query(query, [clientId, contactIds]);
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

    const query = `
        UPDATE contacts
        SET last_contacted_at = now(), updated_at = now()
        WHERE client_id = $1 AND email = ANY($2::text[])
        RETURNING id, email, full_name, last_contacted_at, updated_at
    `;

    const result = await pool.query(query, [clientId, validEmails]);
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

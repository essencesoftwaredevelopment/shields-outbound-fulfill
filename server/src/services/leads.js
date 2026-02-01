/**
 * Lead/contact database operations service (SQL-only)
 *
 * Canonical Agency Identifier Rule:
 * Firebase uid = agency_id directly, no mapping table.
 * Agency_id is ALWAYS the auth boundary, derived from verified token.
 * Client_id (if present) is a product concern, resolved per-request.
 *
 * This service handles:
 * - Batch company (domain) upsertion with idempotency
 * - Batch contact upsertion with email deduplication
 * - Pipeline stage persistence with checkpoints (crash-safe)
 * - Send-safety: marking contacts as contacted to prevent resends
 * - Domain deduplication for new job runs
 *
 * All operations are scoped by agency_id (and client_id if present).
 * NO Firestore usage. Cloud SQL is the single source of truth.
 */

import fs from 'fs';
import { parse as csvParse } from 'csv-parse';
import { pool, withTx, batchUpsertCompanies, batchUpsertContacts, writeCheckpoint, getExistingDomainsSet, markEmailsContacted } from '../lib/db.js';
import * as queries from './db/queries.js';

/**
 * Parse and normalize email status from various sources
 * Maps email finder statuses to database valid values
 */
function normalizeEmailStatus(rawStatus) {
    if (!rawStatus) return null;
    const status = String(rawStatus).toLowerCase().trim();

    // Already valid
    if (['valid', 'risky', 'invalid', 'unknown'].includes(status)) return status;

    // Map email finder statuses
    if (status === 'found') return 'valid';
    if (status === 'not_found') return 'invalid';
    if (status.startsWith('error')) return 'unknown';
    if (status === 'skipped_no_founder') return null;

    return 'unknown';
}

/**
 * Build a standardized contact payload from a CSV row
 * Handles multiple CSV formats (founders, emails, verification, personalization)
 */
function buildContactPayload(row, type) {
    const domain = String(row.domain || '').trim().toLowerCase();
    const founderName = String(row.founder_name || row.full_name || row.name || '').trim() || null;
    const confidence = row.confidence ? Number(row.confidence) : null;
    const email = String(row.email || '').trim() || null;
    const lookupStatus = String(row.lookup_status || '').trim() || null;
    const emailStatus = String(row.email_status || lookupStatus || '').trim() || null;

    if (!domain) return null;

    if (type === 'founders') {
        return { domain, roleType: 'founder', fullName: founderName, confidence: Number.isFinite(confidence) ? confidence : null };
    }
    if (type === 'emails') {
        return { domain, roleType: 'founder', fullName: founderName, email, emailStatus: normalizeEmailStatus(lookupStatus), confidence: Number.isFinite(confidence) ? confidence : null };
    }
    if (type === 'verification') {
        return { domain, roleType: 'founder', fullName: founderName, email, emailStatus: normalizeEmailStatus(emailStatus), lastVerifiedAt: emailStatus ? new Date().toISOString() : null };
    }
    if (type === 'personalization') {
        const firstLine = String(row.personalization_first_line || row.first_line || row.personalization || '').trim() || null;
        return { domain, roleType: 'founder', fullName: founderName, email, personalizationFirstLine: firstLine };
    }
    return { domain, roleType: 'founder', fullName: founderName };
}

/**
 * Upsert an in-memory batch of lead rows (no CSV needed)
 */
export async function upsertLeadRowsBatch({ agencyId, clientId, rows, type, jobId = null }) {
    if (!Array.isArray(rows) || rows.length === 0) return;
    if (!agencyId || !clientId) return;

    const payloads = rows.map((r) => buildContactPayload(r, type)).filter(Boolean);
    if (!payloads.length) return;

    await withTx(async (client) => {
        const domainMap = await batchUpsertCompanies(client, agencyId, clientId, payloads);
        
        console.log(`[upsertLeadRowsBatch] Domain map has ${domainMap.size} entries`);

        const contactRows = payloads.map((p) => {
            const company_id = domainMap.get(p.domain);
            if (!company_id) {
                console.warn(`[upsertLeadRowsBatch] No company_id found for domain: ${p.domain}`);
            }
            return {
                company_id,
                role_type: p.roleType,
                full_name: p.fullName || null,
                email: p.email || null,
                email_status: p.emailStatus || null,
                confidence: p.confidence || null,
                personalization_first_line: p.personalizationFirstLine || null,
                last_verified_at: p.lastVerifiedAt || null,
                job_id: jobId
            };
        }).filter((r) => r.company_id);
        
        console.log(`[upsertLeadRowsBatch] Filtered to ${contactRows.length} contacts with valid company_id`);

        if (contactRows.length > 0) {
            await batchUpsertContacts(client, agencyId, clientId, contactRows);
        }
    });
}

/**
 * Fetch all contacts for an agency from SQL with optional filters
 * Used by frontend to display leads
 */
export async function getContactsForAgency(agencyId, { emailStatus, roleType, limit = 500, offset = 0 } = {}) {
    return queries.getContactsByAgency(agencyId, { emailStatus, roleType, limit, offset });
}

/**
 * Get company (domain) list with contact counts
 */
export async function getCompaniesForAgency(agencyId, { limit = 500, offset = 0 } = {}) {
    const query = `
        SELECT
            c.id,
            c.domain_normalized as domain,
            COUNT(ct.id) as contact_count,
            COUNT(CASE WHEN ct.email_status = 'valid' THEN 1 END) as verified_count,
            c.created_at,
            c.updated_at
        FROM companies c
        LEFT JOIN contacts ct ON ct.company_id = c.id
        WHERE c.agency_id = $1
        GROUP BY c.id, c.domain_normalized, c.created_at, c.updated_at
        ORDER BY c.updated_at DESC
        LIMIT $2 OFFSET $3
    `;
    const result = await pool.query(query, [agencyId, limit, offset]);
    return result.rows;
}

/**
 * Get summary statistics for agency leads
 */
export async function getLeadStats(agencyId) {
    const query = `
        SELECT
            COUNT(DISTINCT c.id) as total_contacts,
            COUNT(DISTINCT c.company_id) as total_companies,
            COUNT(CASE WHEN c.email_status = 'valid' THEN 1 END) as verified_emails,
            COUNT(CASE WHEN c.last_contacted_at IS NOT NULL THEN 1 END) as contacted_count,
            COUNT(CASE WHEN c.last_contacted_at IS NULL THEN 1 END) as untouched_count
        FROM contacts c
        WHERE c.agency_id = $1
    `;
    const result = await pool.query(query, [agencyId]);
    return result.rows[0] || {};
}

async function upsertContact({ agencyId, companyId, roleType = 'founder', fullName = null, email = null, emailStatus = null, confidence = null, lastVerifiedAt = null, jobId = null }) {
    try {
        await queries.upsertContact(agencyId, companyId, roleType, {
            full_name: fullName,
            email,
            email_status: emailStatus,
            confidence,
            job_id: jobId
        });
    } catch (err) {
        console.error('Contact upsert error:', err?.message || err);
        throw err;
    }
}

/**
 * Upsert a single lead (contact) scoped by agency_id
 * Legacy function kept for backward compatibility
 */
export async function upsertLead(agencyId, domain, data) {
    if (!agencyId || !domain) return;
    const company = await queries.upsertCompany(agencyId, domain.toLowerCase());
    const fullName = typeof data?.name === 'string' ? data.name : null;
    const email = typeof data?.email === 'string' ? data.email : null;
    await upsertContact({ agencyId, companyId: company.id, roleType: 'founder', fullName, email });
}

/**
 * Upsert leads from a CSV file, scoped by agency_id and client_id
 * Legacy function kept for backward compatibility
 * Use processCsvWithCheckpoints for crash-safe processing
 */
export async function upsertLeadsFromCsv({ agencyId, clientId, csvPath, type, jobId = null }) {
    if (!fs.existsSync(csvPath) || !agencyId || !clientId) return;
    const rows = [];
    await new Promise((resolve, reject) => {
        fs.createReadStream(csvPath)
            .pipe(csvParse({ columns: true, trim: true }))
            .on('data', (row) => rows.push(row))
            .on('end', resolve)
            .on('error', reject);
    });

    // Process in batches for better performance
    const batchSize = 100;
    for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        
        await withTx(async (client) => {
            // Build payloads
            const payloads = batch.map((r) => buildContactPayload(r, type)).filter(Boolean);
            if (!payloads.length) return;

            // Upsert companies (domains)
            const domainMap = await batchUpsertCompanies(client, agencyId, clientId, payloads);

            // Upsert contacts with company_id from domainMap
            const contactRows = payloads.map((p) => ({
                company_id: domainMap.get(p.domain),
                role_type: p.roleType,
                full_name: p.fullName || null,
                email: p.email || null,
                email_status: p.emailStatus || null,
                confidence: p.confidence || null,
                personalization_first_line: p.personalizationFirstLine || null,
                job_id: jobId
            })).filter((r) => r.company_id);

            if (contactRows.length > 0) {
                await batchUpsertContacts(client, agencyId, clientId, contactRows);
            }
        });
    }
}

/**
 * Batch process a CSV file with transactional checkpoint support
 * Reads CSV in chunks, batches upserts, writes checkpoint
 * Crash-safe: can resume from last checkpoint
 */
export async function processCsvWithCheckpoints({ agencyId, clientId, jobId, stage, csvPath, type, chunkSize = 100 }) {
    if (!agencyId || !clientId || !jobId || !csvPath || !fs.existsSync(csvPath)) {
        console.error(`[${jobId}] Invalid inputs for CSV processing`);
        return { processed: 0, checkpoint: null };
    }

    // Get last checkpoint
    const lastCheckpoint = await queries.getOrCreateCheckpoint(agencyId, jobId, stage, '');

    const rows = [];
    let processedCount = 0;

    try {
        // Read CSV and process in chunks
        await new Promise((resolve, reject) => {
            fs.createReadStream(csvPath)
                .pipe(csvParse({ columns: true, trim: true, skip_empty_lines: true }))
                .on('data', async (row) => {
                    rows.push(row);

                    if (rows.length >= chunkSize) {
                        const chunk = rows.splice(0, chunkSize);

                        // Process chunk within transaction
                        await withTx(async (client) => {
                            // Build payloads
                            const payloads = chunk.map((r) => buildContactPayload(r, type)).filter(Boolean);

                            // Upsert companies
                            const domainMap = await batchUpsertCompanies(client, agencyId, clientId, payloads);

                            // Upsert contacts with company_id from domainMap
                            const contactRows = payloads.map((p) => ({
                                company_id: domainMap.get(p.domain),
                                role_type: p.roleType,
                                full_name: p.fullName || null,
                                email: p.email || null,
                                email_status: p.emailStatus || null,
                                confidence: p.confidence || null,
                                job_id: jobId
                            })).filter((r) => r.company_id);

                            if (contactRows.length > 0) {
                                await batchUpsertContacts(client, agencyId, clientId, contactRows);
                            }

                            // Write checkpoint
                            const cursorValue = `${processedCount + chunk.length}`;
                            await writeCheckpoint(client, agencyId, clientId, jobId, stage, cursorValue);
                        });

                        processedCount += chunk.length;
                        console.log(`[${jobId}/${stage}] Processed ${processedCount} rows`);
                    }
                })
                .on('end', resolve)
                .on('error', reject);
        });

        // Process remaining rows
        if (rows.length > 0) {
            await withTx(async (client) => {
                const payloads = rows.map((r) => buildContactPayload(r, type)).filter(Boolean);
                const domainMap = await batchUpsertCompanies(client, agencyId, clientId, payloads);

                const contactRows = payloads.map((p) => ({
                    company_id: domainMap.get(p.domain),
                    role_type: p.roleType,
                    full_name: p.fullName || null,
                    email: p.email || null,
                    email_status: p.emailStatus || null,
                    confidence: p.confidence || null,
                    job_id: jobId
                })).filter((r) => r.company_id);

                if (contactRows.length > 0) {
                    await batchUpsertContacts(client, agencyId, clientId, contactRows);
                }

                const cursorValue = `${processedCount + rows.length}`;
                await writeCheckpoint(client, agencyId, clientId, jobId, stage, cursorValue);
            });

            processedCount += rows.length;
        }

        const checkpoint = await queries.getOrCreateCheckpoint(agencyId, jobId, stage);
        return { processed: processedCount, checkpoint };
    } catch (error) {
        console.error(`[${jobId}/${stage}] Processing failed:`, error);
        throw error;
    }
}

/**
 * Filter domains to exclude already-processed ones (deduplication)
 * Returns filtered CSV path and statistics
 */
export async function filterAndWriteProcessedDomains({ agencyId, clientId, jobId, domainsCsvPath, dedupeStrategy = 'skip', domainColumn = 'domain' }) {
    if (!agencyId || !clientId || !domainsCsvPath) {
        console.warn(`[${jobId}] Missing agencyId/clientId/domainsCsvPath`);
        return { filtered: domainsCsvPath, stats: { total: 0, skipped: 0, new: 0 } };
    }

    if (!fs.existsSync(domainsCsvPath)) {
        console.warn(`[${jobId}] CSV file not found: ${domainsCsvPath}`);
        return { filtered: domainsCsvPath, stats: { total: 0, skipped: 0, new: 0 } };
    }

    // Read domains from CSV (raw, may include duplicates)
    const domains = [];
    await new Promise((resolve, reject) => {
        fs.createReadStream(domainsCsvPath)
            .pipe(csvParse({ columns: true, trim: true }))
            .on('data', (row) => {
                const domain = String(row[domainColumn] || row.domain || '').trim();
                if (domain) domains.push(domain.toLowerCase());
            })
            .on('end', resolve)
            .on('error', reject);
    });

    const totalRaw = domains.length;
    const uniqueDomains = Array.from(new Set(domains));
    const duplicatesRemoved = totalRaw - uniqueDomains.length;

    const stats = {
        total: totalRaw,
        unique: uniqueDomains.length,
        duplicatesRemoved,
        skipped: 0,
        existing: 0,
        new: 0
    };

    if (uniqueDomains.length === 0) return { filtered: domainsCsvPath, stats };

    // Get existing domains from SQL (unique list only)
    const existingSet = await getExistingDomainsSet(clientId, uniqueDomains);
    stats.existing = existingSet.size;

    let filteredDomains = uniqueDomains;
    if (dedupeStrategy === 'skip') {
        filteredDomains = uniqueDomains.filter((d) => !existingSet.has(d));
        stats.skipped = existingSet.size;
        stats.new = filteredDomains.length;
    } else {
        // include strategy: keep unique list but still compute new vs existing
        stats.skipped = 0;
        stats.new = uniqueDomains.length - existingSet.size;
    }

    // Always write a deduped/filtered CSV for downstream stages
    const filteredPath = domainsCsvPath.replace('.csv', '-dedup.csv');
    const writer = fs.createWriteStream(filteredPath);
    writer.write('domain\n');
    filteredDomains.forEach((domain) => writer.write(`${domain}\n`));
    writer.end();
    await new Promise((resolve) => writer.on('finish', resolve));

    return { filtered: filteredPath, stats };
}

/**
 * Mark contacts as contacted (send-safety guardrail)
 * Updates last_contacted_at to prevent accidental resends
 */
export async function markContactsAsSent(agencyId, contactIds) {
    if (!Array.isArray(contactIds) || contactIds.length === 0) return [];
    return queries.markContactsAsSent(agencyId, contactIds);
}

/**
 * Mark contacts as contacted by email list
 * Useful for campaign export workflows
 */
export async function markEmailsAsSent(agencyId, emails) {
    if (!Array.isArray(emails) || emails.length === 0) return [];
    return markEmailsContacted(agencyId, emails);
}

/**
 * Legacy function for backward compatibility
 * Marks emails as contacted using email list from row array
 */
export async function attachCampaignToLeads({ agencyId, rows }) {
    if (!agencyId || !Array.isArray(rows) || rows.length === 0) return;

    const emails = rows
        .map((r) => String(r.email || '').trim())
        .filter(Boolean);

    if (emails.length === 0) return;

    return markEmailsContacted(agencyId, emails);
}

/**
 * Legacy function for backward compatibility
 */
export async function incrementCampaignLeadCount() {
    // No-op: aggregates now computed on-demand in getLeadStats
    return;
}

export default {
    getContactsForAgency,
    getCompaniesForAgency,
    getLeadStats,
    filterAndWriteProcessedDomains,
    processCsvWithCheckpoints,
    markContactsAsSent,
    markEmailsAsSent,
    attachCampaignToLeads,
    upsertLeadRowsBatch,
    incrementCampaignLeadCount
};

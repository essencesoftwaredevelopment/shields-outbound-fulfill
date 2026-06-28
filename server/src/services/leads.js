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
 * NO Firestore usage. PostgreSQL is the single source of truth.
 */

import fs from 'fs';
import { parse as csvParse } from 'csv-parse';
import { pool, withTx, batchUpsertCompanies, batchUpsertContacts, writeCheckpoint, getExistingDomainsSet, markEmailsContacted } from '../lib/db.js';
import { normalizeDomain } from '../utils/domain.js';
import { isNotFoundValue } from './enrichmentCohort.js';
import { markJobDomainsFounderExcluded } from './db/jobs.js';
import * as queries from './db/queries.js';

/**
 * Normalize SMTP / verification status for contacts.email_status only.
 * Does not map email-finder lookup outcomes (use email_find_completed_at for that).
 */
export function normalizeEmailStatus(rawStatus) {
    if (!rawStatus) return null;
    const status = String(rawStatus).toLowerCase().trim();

    if (['valid', 'risky', 'invalid', 'unknown'].includes(status)) return status;

    if (status === 'valid-risky') return 'risky';
    if (status.startsWith('error')) return 'unknown';

    return 'unknown';
}

/**
 * Build a standardized contact payload from a CSV row
 * Handles multiple CSV formats (founders, emails, verification, personalization)
 */
function buildContactPayload(row, type) {
    const domain = normalizeDomain(row.domain);
    const founderName = String(row.founder_name || row.full_name || row.name || '').trim() || null;
    const confidence = row.confidence ? Number(row.confidence) : null;
    const email = String(row.email || '').trim() || null;
    const verificationStatus = String(row.email_status || '').trim() || null;
    const completedAt = new Date().toISOString();

    if (!domain) return null;

    if (type === 'founders') {
        return {
            domain,
            roleType: 'founder',
            fullName: isNotFoundValue(founderName) ? null : founderName,
            founderFindCompletedAt: completedAt,
            confidence: Number.isFinite(confidence) ? confidence : null
        };
    }
    if (type === 'emails') {
        return {
            domain,
            roleType: 'founder',
            fullName: founderName,
            email,
            emailFindCompletedAt: completedAt,
            confidence: Number.isFinite(confidence) ? confidence : null
        };
    }
    if (type === 'verification') {
        const emailStatus = normalizeEmailStatus(verificationStatus);
        return {
            domain,
            roleType: 'founder',
            fullName: founderName,
            email,
            emailStatus,
            emailVerifyCompletedAt: emailStatus ? completedAt : null
        };
    }
    if (type === 'personalization') {
        const firstLine = String(row.personalization_first_line || row.first_line || row.personalization || '').trim() || null;
        return {
            domain,
            roleType: 'founder',
            fullName: founderName,
            email,
            emailStatus: verificationStatus ? normalizeEmailStatus(verificationStatus) : null,
            personalizationFirstLine: firstLine,
            signalEmissionId: row.signal_emission_id ? Number(row.signal_emission_id) : null
        };
    }
    return { domain, roleType: 'founder', fullName: founderName };
}

/**
 * Persist founder search outcomes (found and not-found) with completion timestamps.
 */
export async function upsertFounderSearchBatch({
    agencyId,
    clientId,
    jobId,
    rows,
    mergeMode = 'preserve',
    onTiming = null
}) {
    if (!Array.isArray(rows) || rows.length === 0) return;
    if (!agencyId || !clientId) return;

    const excludedDomains = [];
    const upsertRows = [];

    for (const row of rows) {
        const domain = normalizeDomain(row.domain);
        if (!domain) continue;
        const founderName = String(row.founder_name || row.full_name || row.name || '').trim();
        if (isNotFoundValue(founderName)) {
            excludedDomains.push(domain);
        }
        upsertRows.push({
            ...row,
            domain,
            founder_name: isNotFoundValue(founderName) ? '' : founderName
        });
    }

    if (excludedDomains.length && jobId) {
        await markJobDomainsFounderExcluded(jobId, excludedDomains);
    }

    if (upsertRows.length) {
        await upsertLeadRowsBatch({
            agencyId,
            clientId,
            rows: upsertRows,
            type: 'founders',
            jobId,
            mergeMode,
            onTiming
        });
    }
}

/**
 * Upsert an in-memory batch of lead rows (no CSV needed)
 */
export async function upsertLeadRowsBatch({
    agencyId,
    clientId,
    rows,
    type,
    jobId = null,
    mergeMode = 'preserve',
    onTiming = null
}) {
    if (!Array.isArray(rows) || rows.length === 0) return;
    if (!agencyId || !clientId) return;

    const payloads = rows.map((r) => buildContactPayload(r, type)).filter(Boolean);
    if (!payloads.length) return;

    const batchStart = Date.now();
    let companiesMs = 0;
    let contactsMs = 0;
    let signalMs = 0;

    await withTx(async (client) => {
        const companiesStart = Date.now();
        const domainMap = await batchUpsertCompanies(client, agencyId, clientId, payloads);
        companiesMs = Date.now() - companiesStart;

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
                email_find_completed_at: p.emailFindCompletedAt || null,
                email_verify_completed_at: p.emailVerifyCompletedAt || null,
                founder_find_completed_at: p.founderFindCompletedAt || null,
                confidence: p.confidence || null,
                personalization_first_line: p.personalizationFirstLine || null,
                job_id: jobId
            };
        }).filter((r) => r.company_id);

        if (contactRows.length > 0) {
            const contactsStart = Date.now();
            await batchUpsertContacts(client, agencyId, clientId, contactRows, {
                mergeMode,
                upsertType: type
            });
            contactsMs = Date.now() - contactsStart;
        }

        if (type === 'personalization') {
            const signalStart = Date.now();
            for (const p of payloads) {
                if (!p.signalEmissionId) continue;
                const companyId = domainMap.get(p.domain);
                if (!companyId) continue;
                await client.query(
                    `UPDATE contacts SET signal_emission_id = $1, updated_at = NOW()
                     WHERE company_id = $2 AND role_type = 'founder' AND client_id = $3`,
                    [p.signalEmissionId, companyId, clientId]
                );
            }
            signalMs = Date.now() - signalStart;
        }
    });

    if (typeof onTiming === 'function') {
        onTiming({
            type,
            rows: rows.length,
            companiesMs,
            contactsMs,
            signalMs,
            totalMs: Date.now() - batchStart
        });
    }

    if (jobId && agencyId) {
        void import('../enrichment/stageReconcileScheduler.js')
            .then(({ scheduleStageReconcile }) => scheduleStageReconcile(jobId, agencyId))
            .catch(() => {});
    }
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

async function upsertContact({ agencyId, companyId, roleType = 'founder', fullName = null, email = null, emailStatus = null, confidence = null, jobId = null }) {
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
    const normalizedDomain = normalizeDomain(domain);
    if (!agencyId || !normalizedDomain) return;
    const company = await queries.upsertCompany(agencyId, normalizedDomain);
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
                email_find_completed_at: p.emailFindCompletedAt || null,
                email_verify_completed_at: p.emailVerifyCompletedAt || null,
                confidence: p.confidence || null,
                personalization_first_line: p.personalizationFirstLine || null,
                job_id: jobId
            })).filter((r) => r.company_id);

            if (contactRows.length > 0) {
                await batchUpsertContacts(client, agencyId, clientId, contactRows, { upsertType: type });
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
                                email_find_completed_at: p.emailFindCompletedAt || null,
                                email_verify_completed_at: p.emailVerifyCompletedAt || null,
                                confidence: p.confidence || null,
                                job_id: jobId
                            })).filter((r) => r.company_id);

                            if (contactRows.length > 0) {
                                await batchUpsertContacts(client, agencyId, clientId, contactRows, { upsertType: type });
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
                    email_find_completed_at: p.emailFindCompletedAt || null,
                    email_verify_completed_at: p.emailVerifyCompletedAt || null,
                    confidence: p.confidence || null,
                    job_id: jobId
                })).filter((r) => r.company_id);

                if (contactRows.length > 0) {
                    await batchUpsertContacts(client, agencyId, clientId, contactRows, { upsertType: type });
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
/**
 * Mark job_domains as skipped when company already exists (SQL queue mode).
 */
export async function filterJobDomainsForDedupe({
    agencyId,
    clientId,
    jobId,
    dedupeStrategy = 'skip',
    reauditMonths = null
}) {
    const { pool } = await import('../config/db.js');
    const { markJobDomainsSkipped } = await import('./db/jobs.js');

    const pending = await pool.query(
        `SELECT domain_normalized FROM job_domains WHERE job_id = $1 AND status = 'pending'`,
        [jobId]
    );
    const domains = pending.rows.map((r) => r.domain_normalized);
    const stats = {
        total: domains.length,
        unique: domains.length,
        duplicatesRemoved: 0,
        skipped: 0,
        existing: 0,
        new: domains.length
    };
    if (!domains.length) return { stats };

    const existingSet = await getExistingDomainsSet(clientId, domains, { reauditMonths });
    stats.existing = existingSet.size;

    if (dedupeStrategy === 'skip') {
        const toSkip = domains.filter((d) => existingSet.has(d));
        stats.skipped = toSkip.length;
        stats.new = domains.length - toSkip.length;
        if (toSkip.length) {
            await markJobDomainsSkipped(jobId, toSkip);
        }
    } else {
        stats.skipped = 0;
        stats.new = domains.length - existingSet.size;
    }

    return { stats };
}

export async function filterAndWriteProcessedDomains({ agencyId, clientId, jobId, domainsCsvPath, dedupeStrategy = 'skip', domainColumn = 'domain', reauditMonths = null }) {
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
                const domain = normalizeDomain(row[domainColumn] || row.domain);
                if (domain) domains.push(domain);
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
    const existingSet = await getExistingDomainsSet(clientId, uniqueDomains, { reauditMonths });
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

export async function deleteContactsForClient(agencyId, clientId, { contactIds, filterContext } = {}) {
    if (filterContext) {
        return queries.deleteContactsByFilter(agencyId, clientId, filterContext);
    }
    if (!Array.isArray(contactIds) || contactIds.length === 0) {
        return { deletedCount: 0, deletedIds: [], deletedCompanyCount: 0 };
    }
    return queries.deleteContactsByIds(agencyId, clientId, contactIds);
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
    deleteContactsForClient,
    markEmailsAsSent,
    attachCampaignToLeads,
    upsertLeadRowsBatch,
    incrementCampaignLeadCount
};

/**
 * No-enrichment CSV lead imports (column-mapped) — feature-owned service.
 *
 * Writes contacts/companies (+ contact_insights) directly, batched and
 * crash-observable via lead_import_batches progress rows. Deliberately NOT a
 * pipeline job: imports never contend with the one-active-job-per-client
 * constraint and have no stages.
 *
 * Collision strategies (per upload):
 * - fill_blanks (default): CSV values only land in empty fields; enriched data
 *   (found emails, verification status, first lines) is never overwritten.
 * - overwrite: non-empty CSV values replace existing values; blank cells keep
 *   existing data. Changing a contact's email resets email_status to the CSV's
 *   status (or clears it) so a stale "valid" can't survive an address swap.
 * - skip: only net-new domains are created; rows for existing domains are
 *   counted as skipped and left untouched.
 *
 * One contact per domain, role_type='founder' (pipeline cohort requirement).
 * Extra rows for the same domain merge into that contact (first row wins,
 * later non-empty values fill its blanks). Unmapped CSV columns are preserved
 * into contact_insights.attributes keyed by header unless keepUnmapped=false.
 */

import { parse as csvParse } from 'csv-parse';
import { pool, withTx, batchUpsertCompanies, getExistingDomainsSet } from '../lib/db.js';
import { normalizeDomain } from '../utils/domain.js';
import { normalizeEmailStatus } from './leads.js';

// 350 keeps the widest per-row statement (insights: 10 params/row + 2 fixed)
// under the 4000-param convention shared with lib/db.js MAX_SAFE_QUERY_PARAMS.
const CHUNK_SIZE = 350;
const MAX_ATTRIBUTE_VALUE_LENGTH = 1000;
const MAX_TEXT_LENGTH = 500;
const MAX_ERROR_ROWS_PER_BATCH = 5000;

export const IMPORT_COLLISION_STRATEGIES = new Set(['fill_blanks', 'overwrite', 'skip']);

/** Mapping targets the UI may send. Keys are canonical; values are CSV headers. */
export const IMPORT_MAPPING_TARGETS = new Set([
    'domain',
    'fullName',
    'email',
    'emailStatus',
    'annualRevenueText',
    'annualRevenueMin',
    'annualRevenueMax',
    'usesKlaviyo',
    'klaviyoPercent',
    'discoveryCallHeld',
    'source',
    'notes'
]);

const INSIGHT_TARGET_KEYS = [
    'annualRevenueText',
    'annualRevenueMin',
    'annualRevenueMax',
    'usesKlaviyo',
    'klaviyoPercent',
    'discoveryCallHeld',
    'source',
    'notes'
];

function trimmedOrNull(value, maxLength = MAX_TEXT_LENGTH) {
    if (value === null || value === undefined) return null;
    const normalized = String(value).trim();
    if (!normalized) return null;
    return normalized.slice(0, maxLength);
}

function parseOptionalNumber(value) {
    const text = trimmedOrNull(value);
    if (!text) return null;
    const cleaned = text.replace(/[$,%\s]/g, '').replace(/,/g, '');
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
}

function parseOptionalBoolean(value) {
    const text = trimmedOrNull(value);
    if (!text) return null;
    const lowered = text.toLowerCase();
    if (['true', 'yes', 'y', '1'].includes(lowered)) return true;
    if (['false', 'no', 'n', '0'].includes(lowered)) return false;
    return null;
}

export function sanitizeImportColumnMapping(rawMapping) {
    const mapping = {};
    if (!rawMapping || typeof rawMapping !== 'object' || Array.isArray(rawMapping)) {
        return mapping;
    }
    for (const [target, header] of Object.entries(rawMapping)) {
        if (!IMPORT_MAPPING_TARGETS.has(target)) continue;
        const normalizedHeader = trimmedOrNull(header, 200);
        if (!normalizedHeader) continue;
        mapping[target] = normalizedHeader;
    }
    return mapping;
}

/** Rough data-row count (newlines minus header) so progress has a total before parsing ends. */
export function estimateCsvRowCount(buffer) {
    if (!buffer || !buffer.length) return 0;
    let count = 0;
    for (let i = 0; i < buffer.length; i++) {
        if (buffer[i] === 10) count++;
    }
    if (buffer[buffer.length - 1] !== 10) count++;
    return Math.max(0, count - 1);
}

export async function createImportBatch({
    agencyId,
    clientId,
    fileName,
    collisionStrategy,
    columnMapping,
    keepUnmapped,
    totalRowsEstimate
}) {
    const result = await pool.query(
        `INSERT INTO lead_import_batches (
            agency_id, client_id, file_name, status, collision_strategy, column_mapping, total_rows
        ) VALUES ($1, $2, $3, 'processing', $4, $5::jsonb, $6)
        RETURNING *`,
        [
            agencyId,
            clientId,
            fileName || null,
            collisionStrategy,
            JSON.stringify({ ...columnMapping, _keepUnmapped: keepUnmapped !== false }),
            Math.max(0, Number(totalRowsEstimate) || 0)
        ]
    );
    return result.rows[0];
}

async function updateBatchProgress(batchId, patch) {
    const sets = ['updated_at = NOW()', 'heartbeat_at = NOW()'];
    const params = [batchId];
    let idx = 2;
    for (const key of ['processed_rows', 'created_count', 'updated_count', 'skipped_count', 'error_count', 'total_rows']) {
        if (patch[key] !== undefined) {
            sets.push(`${key} = $${idx}`);
            params.push(patch[key]);
            idx++;
        }
    }
    if (patch.status !== undefined) {
        sets.push(`status = $${idx}`);
        params.push(patch.status);
        idx++;
        if (patch.status === 'completed' || patch.status === 'failed') {
            sets.push('completed_at = NOW()');
        }
    }
    if (patch.error !== undefined) {
        sets.push(`error = $${idx}`);
        params.push(patch.error);
        idx++;
    }
    await pool.query(`UPDATE lead_import_batches SET ${sets.join(', ')} WHERE id = $1`, params);
}

async function insertErrorRows(batchId, agencyId, errorRows) {
    if (!errorRows.length) return;
    const CHUNK = 200;
    for (let i = 0; i < errorRows.length; i += CHUNK) {
        const chunk = errorRows.slice(i, i + CHUNK);
        const values = [];
        const params = [batchId, agencyId];
        let idx = 3;
        for (const row of chunk) {
            values.push(`($1, $2, $${idx}, $${idx + 1}, $${idx + 2}::jsonb)`);
            params.push(row.rowNumber ?? null, row.reason || 'Unknown error', JSON.stringify(row.raw || {}));
            idx += 3;
        }
        await pool.query(
            `INSERT INTO lead_import_errors (batch_id, agency_id, row_number, reason, raw_row)
             VALUES ${values.join(', ')}`,
            params
        );
    }
}

/** Normalize one CSV row against the mapping. Returns { entry, problems[] } or { error }. */
function normalizeImportRow(row, rowNumber, columnMapping, keepUnmapped) {
    const readMapped = (target) => (columnMapping[target] ? row[columnMapping[target]] : undefined);

    const domain = normalizeDomain(trimmedOrNull(readMapped('domain')) || '');
    if (!domain) {
        return { error: { rowNumber, reason: 'Missing or invalid domain', raw: row } };
    }

    const problems = [];
    const fullNameRaw = trimmedOrNull(readMapped('fullName'));
    const fullName = fullNameRaw && fullNameRaw.toLowerCase() !== 'not found' ? fullNameRaw : null;

    let email = trimmedOrNull(readMapped('email'), 320);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        problems.push({ rowNumber, reason: `Invalid email "${email}" — lead imported without it`, raw: row });
        email = null;
    }
    if (email) email = email.toLowerCase();

    // Status only means something alongside an email; 'unknown' adds nothing.
    let emailStatus = null;
    const statusRaw = trimmedOrNull(readMapped('emailStatus'));
    if (email && statusRaw) {
        const normalized = normalizeEmailStatus(statusRaw);
        if (normalized && normalized !== 'unknown') emailStatus = normalized;
    }

    const insights = {
        annual_revenue_text: trimmedOrNull(readMapped('annualRevenueText')),
        annual_revenue_min: parseOptionalNumber(readMapped('annualRevenueMin')),
        annual_revenue_max: parseOptionalNumber(readMapped('annualRevenueMax')),
        uses_klaviyo: parseOptionalBoolean(readMapped('usesKlaviyo')),
        klaviyo_percent: parseOptionalNumber(readMapped('klaviyoPercent')),
        discovery_call_held: parseOptionalBoolean(readMapped('discoveryCallHeld')),
        source: trimmedOrNull(readMapped('source')),
        notes: trimmedOrNull(readMapped('notes'), 5000)
    };

    const attributes = {};
    if (keepUnmapped) {
        const mappedHeaders = new Set(Object.values(columnMapping));
        for (const [header, value] of Object.entries(row)) {
            if (!header || mappedHeaders.has(header)) continue;
            const normalizedValue = trimmedOrNull(value, MAX_ATTRIBUTE_VALUE_LENGTH);
            if (normalizedValue === null) continue;
            attributes[header] = normalizedValue;
        }
    }

    return {
        entry: {
            rowNumber,
            domain,
            fullName,
            email,
            emailStatus,
            insights,
            attributes
        },
        problems
    };
}

function hasAnyInsightData(entry) {
    return Object.values(entry.insights).some((value) => value !== null)
        || Object.keys(entry.attributes).length > 0;
}

/** Merge a later row for the same domain into the first one (fill its blanks). */
function mergeDomainEntry(target, incoming) {
    if (!target.fullName && incoming.fullName) target.fullName = incoming.fullName;
    if (!target.email && incoming.email) {
        target.email = incoming.email;
        target.emailStatus = incoming.emailStatus;
    }
    for (const key of Object.keys(target.insights)) {
        if (target.insights[key] === null && incoming.insights[key] !== null) {
            target.insights[key] = incoming.insights[key];
        }
    }
    for (const [key, value] of Object.entries(incoming.attributes)) {
        if (!(key in target.attributes)) target.attributes[key] = value;
    }
}

function contactUpdateClauseForStrategy(strategy) {
    if (strategy === 'overwrite') {
        return `
            full_name = COALESCE(EXCLUDED.full_name, contacts.full_name),
            email = COALESCE(EXCLUDED.email, contacts.email),
            email_status = CASE
                WHEN EXCLUDED.email IS NOT NULL AND (contacts.email IS NULL OR LOWER(contacts.email) <> LOWER(EXCLUDED.email))
                    THEN EXCLUDED.email_status
                ELSE COALESCE(EXCLUDED.email_status, contacts.email_status)
            END,
            email_verify_completed_at = CASE
                WHEN EXCLUDED.email IS NOT NULL AND (contacts.email IS NULL OR LOWER(contacts.email) <> LOWER(EXCLUDED.email))
                    THEN EXCLUDED.email_verify_completed_at
                ELSE COALESCE(EXCLUDED.email_verify_completed_at, contacts.email_verify_completed_at)
            END,
            import_batch_id = EXCLUDED.import_batch_id,
            updated_at = NOW()`;
    }
    // fill_blanks: existing non-empty values always win.
    return `
        full_name = CASE
            WHEN contacts.full_name IS NULL OR BTRIM(contacts.full_name) = '' OR LOWER(BTRIM(contacts.full_name)) = 'not found'
                THEN COALESCE(EXCLUDED.full_name, contacts.full_name)
            ELSE contacts.full_name
        END,
        email = CASE
            WHEN contacts.email IS NULL OR BTRIM(contacts.email) = ''
                THEN COALESCE(EXCLUDED.email, contacts.email)
            ELSE contacts.email
        END,
        email_status = CASE
            WHEN (contacts.email IS NULL OR BTRIM(contacts.email) = '') AND EXCLUDED.email IS NOT NULL
                THEN EXCLUDED.email_status
            ELSE contacts.email_status
        END,
        email_verify_completed_at = CASE
            WHEN (contacts.email IS NULL OR BTRIM(contacts.email) = '') AND EXCLUDED.email IS NOT NULL
                THEN EXCLUDED.email_verify_completed_at
            ELSE contacts.email_verify_completed_at
        END,
        import_batch_id = EXCLUDED.import_batch_id,
        updated_at = NOW()`;
}

function isEmailUniqueViolation(err) {
    if (err?.code !== '23505') return false;
    const constraint = String(err?.constraint || '').toLowerCase();
    const message = String(err?.message || '').toLowerCase();
    return constraint.includes('email') || message.includes('email');
}

async function upsertImportContactsChunk(txClient, {
    agencyId,
    clientId,
    batchId,
    strategy,
    entries,
    domainMap,
    errorRows
}) {
    const updateClause = contactUpdateClauseForStrategy(strategy);
    const verifiedAt = new Date().toISOString();

    const buildParams = (entry) => [
        clientId,
        domainMap.get(entry.domain),
        'founder',
        entry.fullName,
        entry.email,
        entry.emailStatus,
        entry.emailStatus ? verifiedAt : null,
        agencyId,
        batchId
    ];

    const insertSql = (valuesSql) => `
        INSERT INTO contacts (
            client_id, company_id, role_type, full_name, email, email_status,
            email_verify_completed_at, agency_id, import_batch_id
        )
        VALUES ${valuesSql}
        ON CONFLICT (company_id, role_type)
        DO UPDATE SET ${updateClause}
        RETURNING id, company_id, (xmax = 0) AS inserted`;

    const insertable = entries.filter((entry) => domainMap.get(entry.domain));

    const upsertRows = async (rows) => {
        if (!rows.length) return [];
        const values = [];
        const params = [];
        let idx = 1;
        for (const entry of rows) {
            const entryParams = buildParams(entry);
            values.push(`(${entryParams.map(() => `$${idx++}`).join(', ')})`);
            params.push(...entryParams);
        }
        const result = await txClient.query(insertSql(values.join(', ')), params);
        return result.rows;
    };

    try {
        await txClient.query('SAVEPOINT lead_import_chunk');
        const rows = await upsertRows(insertable);
        await txClient.query('RELEASE SAVEPOINT lead_import_chunk');
        return { rows, entries: insertable };
    } catch (err) {
        await txClient.query('ROLLBACK TO SAVEPOINT lead_import_chunk');
        await txClient.query('RELEASE SAVEPOINT lead_import_chunk');
        if (!isEmailUniqueViolation(err)) throw err;

        // Slow path: someone in this chunk collides with an email owned by
        // another lead (agency-wide unique on LOWER(email)). Upsert row by row,
        // converting collisions into error-report rows instead of failing the file.
        const rows = [];
        const okEntries = [];
        for (const entry of insertable) {
            try {
                await txClient.query('SAVEPOINT lead_import_row');
                const result = await upsertRows([entry]);
                await txClient.query('RELEASE SAVEPOINT lead_import_row');
                rows.push(...result);
                okEntries.push(entry);
            } catch (rowErr) {
                await txClient.query('ROLLBACK TO SAVEPOINT lead_import_row');
                await txClient.query('RELEASE SAVEPOINT lead_import_row');
                if (isEmailUniqueViolation(rowErr)) {
                    errorRows.push({
                        rowNumber: entry.rowNumber,
                        reason: `Email "${entry.email}" already belongs to another lead — row skipped`,
                        raw: { domain: entry.domain, email: entry.email, full_name: entry.fullName }
                    });
                } else {
                    errorRows.push({
                        rowNumber: entry.rowNumber,
                        reason: `Database error: ${rowErr.message}`,
                        raw: { domain: entry.domain, email: entry.email }
                    });
                }
            }
        }
        return { rows, entries: okEntries };
    }
}

function insightUpdateClauseForStrategy(strategy) {
    if (strategy === 'overwrite') {
        return `
            annual_revenue_text = COALESCE(EXCLUDED.annual_revenue_text, contact_insights.annual_revenue_text),
            annual_revenue_min = COALESCE(EXCLUDED.annual_revenue_min, contact_insights.annual_revenue_min),
            annual_revenue_max = COALESCE(EXCLUDED.annual_revenue_max, contact_insights.annual_revenue_max),
            uses_klaviyo = COALESCE(EXCLUDED.uses_klaviyo, contact_insights.uses_klaviyo),
            klaviyo_percent = COALESCE(EXCLUDED.klaviyo_percent, contact_insights.klaviyo_percent),
            discovery_call_held = COALESCE(EXCLUDED.discovery_call_held, contact_insights.discovery_call_held),
            source = COALESCE(EXCLUDED.source, contact_insights.source),
            notes = COALESCE(EXCLUDED.notes, contact_insights.notes),
            attributes = contact_insights.attributes || EXCLUDED.attributes,
            updated_at = NOW()`;
    }
    return `
        annual_revenue_text = COALESCE(contact_insights.annual_revenue_text, EXCLUDED.annual_revenue_text),
        annual_revenue_min = COALESCE(contact_insights.annual_revenue_min, EXCLUDED.annual_revenue_min),
        annual_revenue_max = COALESCE(contact_insights.annual_revenue_max, EXCLUDED.annual_revenue_max),
        uses_klaviyo = COALESCE(contact_insights.uses_klaviyo, EXCLUDED.uses_klaviyo),
        klaviyo_percent = COALESCE(contact_insights.klaviyo_percent, EXCLUDED.klaviyo_percent),
        discovery_call_held = COALESCE(contact_insights.discovery_call_held, EXCLUDED.discovery_call_held),
        source = COALESCE(contact_insights.source, EXCLUDED.source),
        notes = COALESCE(contact_insights.notes, EXCLUDED.notes),
        attributes = EXCLUDED.attributes || contact_insights.attributes,
        updated_at = NOW()`;
}

async function upsertImportInsightsChunk(txClient, { agencyId, clientId, strategy, rowsWithContactIds }) {
    const insightRows = rowsWithContactIds.filter(({ entry }) => hasAnyInsightData(entry));
    if (!insightRows.length) return;

    const values = [];
    const params = [agencyId, clientId];
    let idx = 3;
    for (const { contactId, entry } of insightRows) {
        values.push(`($${idx}, $1, $2, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6}, $${idx + 7}, $${idx + 8}, $${idx + 9}::jsonb)`);
        params.push(
            contactId,
            entry.insights.annual_revenue_text,
            entry.insights.annual_revenue_min,
            entry.insights.annual_revenue_max,
            entry.insights.uses_klaviyo,
            entry.insights.klaviyo_percent,
            entry.insights.discovery_call_held,
            entry.insights.source,
            entry.insights.notes,
            JSON.stringify(entry.attributes)
        );
        idx += 10;
    }

    await txClient.query(
        `INSERT INTO contact_insights (
            contact_id, agency_id, client_id, annual_revenue_text, annual_revenue_min,
            annual_revenue_max, uses_klaviyo, klaviyo_percent, discovery_call_held,
            source, notes, attributes
        )
        VALUES ${values.join(', ')}
        ON CONFLICT (contact_id)
        DO UPDATE SET ${insightUpdateClauseForStrategy(strategy)}`,
        params
    );
}

async function processChunk({
    agencyId,
    clientId,
    batchId,
    strategy,
    chunkEntries,
    counters,
    errorRows
}) {
    // One contact per domain: merge duplicate-domain rows within the chunk.
    const byDomain = new Map();
    for (const entry of chunkEntries) {
        const existing = byDomain.get(entry.domain);
        if (existing) {
            mergeDomainEntry(existing, entry);
        } else {
            byDomain.set(entry.domain, entry);
        }
    }
    let entries = Array.from(byDomain.values());

    if (strategy === 'skip') {
        const existingSet = await getExistingDomainsSet(clientId, entries.map((e) => e.domain));
        const skipped = entries.filter((entry) => existingSet.has(entry.domain));
        counters.skipped += skipped.length;
        entries = entries.filter((entry) => !existingSet.has(entry.domain));
    }

    if (!entries.length) return;

    await withTx(async (txClient) => {
        const domainMap = await batchUpsertCompanies(
            txClient,
            agencyId,
            clientId,
            entries.map((entry) => ({ domain: entry.domain }))
        );

        const { rows, entries: upsertedEntries } = await upsertImportContactsChunk(txClient, {
            agencyId,
            clientId,
            batchId,
            strategy,
            entries,
            domainMap,
            errorRows
        });

        const contactIdByCompany = new Map(rows.map((row) => [String(row.company_id), row]));
        const rowsWithContactIds = [];
        for (const entry of upsertedEntries) {
            const companyId = domainMap.get(entry.domain);
            const row = companyId !== undefined ? contactIdByCompany.get(String(companyId)) : null;
            if (!row) continue;
            rowsWithContactIds.push({ contactId: row.id, entry });
            if (row.inserted) counters.created += 1;
            else counters.updated += 1;
        }

        await upsertImportInsightsChunk(txClient, { agencyId, clientId, strategy, rowsWithContactIds });
    });
}

/**
 * Parse + import the whole CSV buffer, updating batch progress per chunk.
 * Runs in the background (fire-and-forget from the route); all failures land
 * on the batch row as status='failed'.
 */
export async function processLeadImportBatch({
    batchId,
    agencyId,
    clientId,
    fileBuffer,
    columnMapping,
    collisionStrategy,
    keepUnmapped
}) {
    const counters = { created: 0, updated: 0, skipped: 0 };
    const errorRows = [];
    let persistedErrorCount = 0;
    let processedRows = 0;
    let dataRows = 0;

    const flushErrors = async () => {
        if (!errorRows.length) return;
        const room = MAX_ERROR_ROWS_PER_BATCH - persistedErrorCount;
        if (room > 0) {
            await insertErrorRows(batchId, agencyId, errorRows.slice(0, room));
            persistedErrorCount += Math.min(room, errorRows.length);
        }
        errorRows.length = 0;
    };

    try {
        const parser = csvParse({ columns: true, trim: true, skip_empty_lines: true, bom: true, relax_column_count: true });
        parser.write(fileBuffer);
        parser.end();

        let chunkEntries = [];
        let errorCountTotal = 0;

        const flushChunk = async () => {
            if (chunkEntries.length) {
                await processChunk({
                    agencyId,
                    clientId,
                    batchId,
                    strategy: collisionStrategy,
                    chunkEntries,
                    counters,
                    errorRows
                });
                chunkEntries = [];
            }
            errorCountTotal += errorRows.length;
            await flushErrors();
            await updateBatchProgress(batchId, {
                processed_rows: processedRows,
                created_count: counters.created,
                updated_count: counters.updated,
                skipped_count: counters.skipped,
                error_count: errorCountTotal
            });
        };

        for await (const row of parser) {
            dataRows += 1;
            processedRows += 1;
            const { entry, problems, error } = normalizeImportRow(row, dataRows, columnMapping, keepUnmapped);
            if (error) {
                errorRows.push(error);
                continue;
            }
            if (problems?.length) errorRows.push(...problems);
            chunkEntries.push(entry);
            if (chunkEntries.length >= CHUNK_SIZE) {
                await flushChunk();
            }
        }
        await flushChunk();

        await updateBatchProgress(batchId, {
            status: 'completed',
            total_rows: dataRows,
            processed_rows: processedRows,
            created_count: counters.created,
            updated_count: counters.updated,
            skipped_count: counters.skipped,
            error_count: errorCountTotal
        });
    } catch (error) {
        console.error(`[lead-import ${batchId}] failed:`, error);
        await flushErrors().catch(() => { });
        await updateBatchProgress(batchId, {
            status: 'failed',
            error: error?.message || 'Import failed',
            processed_rows: processedRows,
            created_count: counters.created,
            updated_count: counters.updated,
            skipped_count: counters.skipped
        }).catch(() => { });
    }
}

const STALL_THRESHOLD_MS = 2 * 60 * 1000;

export function serializeImportBatch(row) {
    if (!row) return null;
    const heartbeatAt = row.heartbeat_at ? new Date(row.heartbeat_at).getTime() : 0;
    const stalled = row.status === 'processing' && heartbeatAt > 0
        && Date.now() - heartbeatAt > STALL_THRESHOLD_MS;
    return {
        id: String(row.id),
        fileName: row.file_name,
        status: row.status,
        stalled,
        collisionStrategy: row.collision_strategy,
        totalRows: row.total_rows,
        processedRows: row.processed_rows,
        createdCount: row.created_count,
        updatedCount: row.updated_count,
        skippedCount: row.skipped_count,
        errorCount: row.error_count,
        error: row.error,
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
        completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null
    };
}

export async function getImportBatch(agencyId, clientId, batchId) {
    const result = await pool.query(
        `SELECT * FROM lead_import_batches
         WHERE id = $1 AND agency_id = $2 AND client_id = $3`,
        [batchId, agencyId, clientId]
    );
    return result.rows[0] || null;
}

export async function listImportBatches(agencyId, clientId, limit = 50) {
    const result = await pool.query(
        `SELECT * FROM lead_import_batches
         WHERE agency_id = $1 AND client_id = $2
         ORDER BY created_at DESC
         LIMIT $3`,
        [agencyId, clientId, Math.min(Math.max(1, limit), 200)]
    );
    return result.rows;
}

export async function listImportErrors(agencyId, batchId, limit = MAX_ERROR_ROWS_PER_BATCH) {
    const result = await pool.query(
        `SELECT row_number, reason, raw_row
         FROM lead_import_errors
         WHERE batch_id = $1 AND agency_id = $2
         ORDER BY row_number ASC NULLS LAST, id ASC
         LIMIT $3`,
        [batchId, agencyId, limit]
    );
    return result.rows.map((row) => ({
        rowNumber: row.row_number,
        reason: row.reason,
        raw: row.raw_row || {}
    }));
}

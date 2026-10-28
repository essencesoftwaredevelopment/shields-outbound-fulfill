/**
 * Store Leads → lead bank imports (manual, run from the leads tab).
 *
 * Two modes, both tracked as lead_import_batches rows (source='storeleads') so
 * progress polling, the stall flag and the "Import Batch" filter come for free:
 *
 * - export: one Store Leads cursor=all export per filter segment (segments are
 *   ORed; Store Leads ANDs filters within one). New domains become companies +
 *   an empty founder contact stamped with the batch, ready for "Enrich
 *   filtered". Existing domains get their store data refreshed (or are skipped).
 * - backfill: Bulk Retrieve for this client's existing domains that were never
 *   synced or are older than staleDays. Misses are stamped 'Not Found'.
 *
 * Store facts land on companies (est_monthly_sales_usd, country_code, ...);
 * Klaviyo/Shopify detection is also folded into contact_insights.uses_klaviyo /
 * uses_shopify, where positive Store Leads evidence wins and a "no" only fills
 * a blank. Runs fire-and-forget on the API host like CSV imports; every write is
 * an idempotent upsert, so a stalled run is recovered by starting it again.
 */

import { pool, withTx } from '../lib/db.js';
import {
    STORELEADS_BULK_MAX,
    bulkLookupStoreLeadsDomains,
    exportStoreLeadsDomains,
    mapStoreLeadsDomain,
    segmentExcludesDomain
} from './storeLeads.js';

/** Whole-run de-dupe set cap; past this, duplicates across segments are just re-upserted. */
const MAX_TRACKED_DOMAINS = 2_000_000;
const BACKFILL_PAGE_SIZE = 1000;
/** Pro/Elite allow 5 bulk requests/s; stay under it without coordinating callers. */
const BULK_MIN_INTERVAL_MS = 250;
/** cursor=all is limited to 1 request/minute per Store Leads account. */
const EXPORT_MIN_INTERVAL_MS = 61_000;

export const STORELEADS_EXISTING_STRATEGIES = new Set(['update', 'skip']);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function storeRowJson(mapped) {
    return {
        domain: mapped.domain,
        sales: mapped.estMonthlySalesUsd,
        cc: mapped.countryCode,
        platform: mapped.platform,
        plan: mapped.plan,
        state: mapped.state,
        apps: mapped.apps,
        tech: mapped.technologies
    };
}

const STORE_COLUMNS_SQL = `
    est_monthly_sales_usd = EXCLUDED.est_monthly_sales_usd,
    country_code = EXCLUDED.country_code,
    store_platform = EXCLUDED.store_platform,
    store_plan = EXCLUDED.store_plan,
    store_state = EXCLUDED.store_state,
    store_apps = EXCLUDED.store_apps,
    store_technologies = EXCLUDED.store_technologies,
    storeleads_synced_at = EXCLUDED.storeleads_synced_at,
    updated_at = NOW()`;

/**
 * Upsert companies with store data. Returns { id, domain, inserted }[] for the
 * rows written; with skipExisting, existing domains are left untouched and
 * absent from the result.
 */
async function upsertStoreCompanies(txClient, { agencyId, clientId, mappedRows, skipExisting }) {
    const result = await txClient.query(
        `INSERT INTO companies (
            agency_id, client_id, domain_normalized, est_monthly_sales_usd, country_code,
            store_platform, store_plan, store_state, store_apps, store_technologies, storeleads_synced_at
        )
        SELECT $1, $2, v.domain, v.sales, v.cc, v.platform, v.plan, v.state,
            ARRAY(SELECT jsonb_array_elements_text(COALESCE(v.apps, '[]'::jsonb))),
            ARRAY(SELECT jsonb_array_elements_text(COALESCE(v.tech, '[]'::jsonb))),
            NOW()
        FROM jsonb_to_recordset($3::jsonb) AS v(
            domain text, sales numeric, cc text, platform text, plan text, state text, apps jsonb, tech jsonb
        )
        ON CONFLICT (client_id, domain_normalized) DO ${skipExisting ? 'NOTHING' : `UPDATE SET ${STORE_COLUMNS_SQL}`}
        RETURNING id, domain_normalized AS domain, (xmax = 0) AS inserted`,
        [agencyId, clientId, JSON.stringify(mappedRows.map(storeRowJson))]
    );
    return result.rows;
}

/** Store data for companies that already exist (backfill). */
async function updateStoreCompaniesById(txClient, { clientId, rows }) {
    if (!rows.length) return;
    await txClient.query(
        `UPDATE companies co SET
            est_monthly_sales_usd = v.sales,
            country_code = v.cc,
            store_platform = v.platform,
            store_plan = v.plan,
            store_state = v.state,
            store_apps = ARRAY(SELECT jsonb_array_elements_text(COALESCE(v.apps, '[]'::jsonb))),
            store_technologies = ARRAY(SELECT jsonb_array_elements_text(COALESCE(v.tech, '[]'::jsonb))),
            storeleads_synced_at = NOW(),
            updated_at = NOW()
        FROM jsonb_to_recordset($2::jsonb) AS v(
            id bigint, sales numeric, cc text, platform text, plan text, state text, apps jsonb, tech jsonb
        )
        WHERE co.id = v.id AND co.client_id = $1`,
        [clientId, JSON.stringify(rows.map(({ companyId, mapped }) => ({ id: companyId, ...storeRowJson(mapped) })))]
    );
}

async function markCompaniesNotFound(txClient, { clientId, companyIds }) {
    if (!companyIds.length) return;
    await txClient.query(
        `UPDATE companies
         SET store_state = 'Not Found', storeleads_synced_at = NOW(), updated_at = NOW()
         WHERE client_id = $1 AND id = ANY($2::bigint[])`,
        [clientId, companyIds]
    );
}

/** Founder placeholder for domains with no contact yet, so they show in the lead bank. */
async function insertFounderPlaceholders(txClient, { agencyId, clientId, batchId, companyIds }) {
    if (!companyIds.length) return 0;
    const result = await txClient.query(
        `INSERT INTO contacts (client_id, company_id, role_type, agency_id, import_batch_id)
         SELECT $1, ids.id, 'founder', $2, $3
         FROM UNNEST($4::bigint[]) AS ids(id)
         WHERE NOT EXISTS (SELECT 1 FROM contacts c WHERE c.company_id = ids.id)
         ON CONFLICT (company_id, role_type) DO NOTHING
         RETURNING id`,
        [clientId, agencyId, batchId, companyIds]
    );
    return result.rowCount || 0;
}

/**
 * Fold Klaviyo/Shopify detection into contact_insights for every contact of the
 * given companies. Store Leads seeing the technology wins; a "no" only fills a
 * blank (DNS lookups or CSVs may know better for headless stores).
 */
async function upsertStoreInsights(txClient, { agencyId, clientId, rows }) {
    const signals = rows
        .filter(({ mapped }) => mapped)
        .map(({ companyId, mapped }) => ({ company_id: companyId, klaviyo: mapped.usesKlaviyo, shopify: mapped.usesShopify }));
    if (!signals.length) return;
    await txClient.query(
        `INSERT INTO contact_insights (contact_id, agency_id, client_id, uses_klaviyo, uses_shopify)
         SELECT c.id, $1, $2, v.klaviyo, v.shopify
         FROM jsonb_to_recordset($3::jsonb) AS v(company_id bigint, klaviyo boolean, shopify boolean)
         JOIN contacts c ON c.company_id = v.company_id AND c.client_id = $2
         ON CONFLICT (contact_id) DO UPDATE SET
            uses_klaviyo = CASE WHEN EXCLUDED.uses_klaviyo IS TRUE THEN TRUE
                ELSE COALESCE(contact_insights.uses_klaviyo, EXCLUDED.uses_klaviyo) END,
            uses_shopify = CASE WHEN EXCLUDED.uses_shopify IS TRUE THEN TRUE
                ELSE COALESCE(contact_insights.uses_shopify, EXCLUDED.uses_shopify) END,
            updated_at = NOW()
         WHERE (EXCLUDED.uses_klaviyo IS TRUE AND contact_insights.uses_klaviyo IS NOT TRUE)
            OR (contact_insights.uses_klaviyo IS NULL AND EXCLUDED.uses_klaviyo IS NOT NULL)
            OR (EXCLUDED.uses_shopify IS TRUE AND contact_insights.uses_shopify IS NOT TRUE)
            OR (contact_insights.uses_shopify IS NULL AND EXCLUDED.uses_shopify IS NOT NULL)`,
        [agencyId, clientId, JSON.stringify(signals)]
    );
}

async function updateBatch(batchId, patch) {
    const sets = ['updated_at = NOW()', 'heartbeat_at = NOW()'];
    const params = [batchId];
    for (const key of ['processed_rows', 'created_count', 'updated_count', 'skipped_count', 'error_count', 'total_rows']) {
        if (patch[key] !== undefined) {
            params.push(patch[key]);
            sets.push(`${key} = $${params.length}`);
        }
    }
    if (patch.status !== undefined) {
        params.push(patch.status);
        sets.push(`status = $${params.length}`);
        if (patch.status === 'completed' || patch.status === 'failed') sets.push('completed_at = NOW()');
    }
    if (patch.error !== undefined) {
        params.push(patch.error);
        sets.push(`error = $${params.length}`);
    }
    if (patch.options !== undefined) {
        params.push(JSON.stringify(patch.options));
        sets.push(`options = $${params.length}::jsonb`);
    }
    await pool.query(`UPDATE lead_import_batches SET ${sets.join(', ')} WHERE id = $1`, params);
}

/**
 * Refuse a second concurrent Store Leads run for the agency: cursor=all is
 * rate-limited per Store Leads account and two runs would trip each other.
 * Stalled runs (no heartbeat for 2 min) don't block.
 */
export async function findActiveStoreLeadsBatch(agencyId) {
    const result = await pool.query(
        `SELECT id, client_id FROM lead_import_batches
         WHERE agency_id = $1 AND source = 'storeleads' AND status = 'processing'
           AND heartbeat_at > NOW() - INTERVAL '2 minutes'
         ORDER BY created_at DESC
         LIMIT 1`,
        [agencyId]
    );
    return result.rows[0] || null;
}

export async function createStoreLeadsBatch({ agencyId, clientId, label, mode, existingStrategy, options, totalRows = 0 }) {
    const result = await pool.query(
        `INSERT INTO lead_import_batches (
            agency_id, client_id, file_name, status, collision_strategy, column_mapping,
            total_rows, source, options
        ) VALUES ($1, $2, $3, 'processing', $4, '{}'::jsonb, $5, 'storeleads', $6::jsonb)
        RETURNING *`,
        [
            agencyId,
            clientId,
            label,
            existingStrategy === 'skip' ? 'skip' : 'overwrite',
            Math.max(0, Number(totalRows) || 0),
            JSON.stringify({ mode, existingStrategy, ...options })
        ]
    );
    return result.rows[0];
}

async function failBatch(batchId, error, counters) {
    console.error(`[storeleads-import ${batchId}] failed:`, error);
    await updateBatch(batchId, {
        status: 'failed',
        error: error?.message || 'Store Leads import failed',
        ...counters
    }).catch(() => { });
}

/**
 * Export mode: run each segment's cursor=all export and stream it into the
 * lead bank. Fire-and-forget; all outcomes land on the batch row.
 */
export async function runStoreLeadsExportImport({ batchId, agencyId, clientId, apiKey, segments, existingStrategy }) {
    const skipExisting = existingStrategy === 'skip';
    const seen = new Set();
    const counters = { processed_rows: 0, created_count: 0, updated_count: 0, skipped_count: 0, total_rows: 0 };
    const segmentTotals = [];

    try {
        for (let index = 0; index < segments.length; index += 1) {
            const segment = segments[index];
            if (index > 0) {
                // Heartbeat through the cursor=all cooldown so the batch never looks stalled.
                const until = Date.now() + EXPORT_MIN_INTERVAL_MS;
                while (Date.now() < until) {
                    await updateBatch(batchId, {});
                    await wait(Math.min(20_000, until - Date.now()));
                }
            }

            const baseTotal = counters.total_rows;
            const { received } = await exportStoreLeadsDomains(apiKey, segment, {
                onProgress: async ({ total }) => {
                    // While Store Leads builds the export, show its total so the bar has a denominator.
                    if (total) counters.total_rows = Math.max(counters.total_rows, baseTotal + total);
                    await updateBatch(batchId, { total_rows: counters.total_rows });
                },
                onDomains: async (rawDomains) => {
                    const mappedRows = [];
                    for (const raw of rawDomains) {
                        counters.processed_rows += 1;
                        const mapped = mapStoreLeadsDomain(raw);
                        if (!mapped || segmentExcludesDomain(segment, mapped)) {
                            counters.skipped_count += 1;
                            continue;
                        }
                        if (seen.has(mapped.domain)) continue; // already written by an earlier segment
                        if (seen.size < MAX_TRACKED_DOMAINS) seen.add(mapped.domain);
                        mappedRows.push(mapped);
                    }
                    counters.total_rows = Math.max(counters.total_rows, counters.processed_rows);
                    if (mappedRows.length) {
                        await withTx(async (txClient) => {
                            const written = await upsertStoreCompanies(txClient, { agencyId, clientId, mappedRows, skipExisting });
                            const byDomain = new Map(mappedRows.map((mapped) => [mapped.domain, mapped]));
                            const inserted = written.filter((row) => row.inserted);
                            counters.created_count += inserted.length;
                            counters.updated_count += written.length - inserted.length;
                            counters.skipped_count += mappedRows.length - written.length;
                            await insertFounderPlaceholders(txClient, {
                                agencyId,
                                clientId,
                                batchId,
                                companyIds: inserted.map((row) => row.id)
                            });
                            await upsertStoreInsights(txClient, {
                                agencyId,
                                clientId,
                                rows: written.map((row) => ({ companyId: row.id, mapped: byDomain.get(row.domain) }))
                            });
                        });
                    }
                    await updateBatch(batchId, counters);
                }
            });
            segmentTotals.push(received);
            counters.total_rows = Math.max(counters.processed_rows, baseTotal);
            await updateBatch(batchId, counters);
        }

        await updateBatch(batchId, { ...counters, total_rows: counters.processed_rows, status: 'completed' });
        console.log(`[storeleads-import ${batchId}] export done: ${JSON.stringify({ ...counters, segmentTotals })}`);
    } catch (error) {
        await failBatch(batchId, error, counters);
    }
}

/** Domains in this client due a Store Leads refresh. */
const BACKFILL_STALE_SQL = `(storeleads_synced_at IS NULL OR storeleads_synced_at < NOW() - ($3::int * INTERVAL '1 day'))`;

/**
 * importBatchId (optional) limits the backfill to companies with a contact
 * stamped with that batch. Callers check the batch belongs to the agency and client.
 */
export async function countBackfillCandidates(agencyId, clientId, staleDays, importBatchId = null) {
    const params = [agencyId, clientId, staleDays];
    if (importBatchId) params.push(importBatchId);
    const result = await pool.query(
        `SELECT COUNT(*)::int AS count FROM companies
         WHERE agency_id = $1 AND client_id = $2 AND ${BACKFILL_STALE_SQL}
           ${importBatchId ? 'AND id IN (SELECT company_id FROM contacts WHERE import_batch_id = $4::bigint)' : ''}`,
        params
    );
    return result.rows[0]?.count || 0;
}

/**
 * Pages of { id, domain_normalized } still due a lookup, in id order.
 * A batch-scoped run loads the batch's company ids once and pages through them
 * by primary key: a join on contacts made Postgres walk the client's companies
 * from the start on every page (~7 s each for the 680k-domain batch 19).
 */
async function createBackfillPager({ agencyId, clientId, staleDays, importBatchId }) {
    if (!importBatchId) {
        let lastId = 0;
        return async () => {
            const page = await pool.query(
                `SELECT id, domain_normalized FROM companies
                 WHERE agency_id = $1 AND client_id = $2 AND id > $4 AND ${BACKFILL_STALE_SQL}
                 ORDER BY id
                 LIMIT $5`,
                [agencyId, clientId, staleDays, lastId, BACKFILL_PAGE_SIZE]
            );
            if (page.rows.length) lastId = page.rows[page.rows.length - 1].id;
            return page.rows;
        };
    }

    const idsResult = await pool.query(
        `SELECT DISTINCT company_id FROM contacts
         WHERE import_batch_id = $1 AND client_id = $2
         ORDER BY company_id`,
        [importBatchId, clientId]
    );
    const companyIds = idsResult.rows.map((row) => row.company_id);
    let offset = 0;
    return async () => {
        // Skip id slices whose companies were all synced recently.
        while (offset < companyIds.length) {
            const slice = companyIds.slice(offset, offset + BACKFILL_PAGE_SIZE);
            offset += slice.length;
            const page = await pool.query(
                `SELECT id, domain_normalized FROM companies
                 WHERE agency_id = $1 AND client_id = $2 AND id = ANY($4::bigint[]) AND ${BACKFILL_STALE_SQL}
                 ORDER BY id`,
                [agencyId, clientId, staleDays, slice]
            );
            if (page.rows.length) return page.rows;
        }
        return [];
    };
}

/**
 * Backfill mode: Bulk Retrieve this client's stale/unsynced domains 100 at a
 * time, optionally only those from one import batch. Paged by id, so a re-run
 * after a crash resumes where it stopped (synced rows drop out of the
 * candidate set).
 */
export async function runStoreLeadsBackfill({ batchId, agencyId, clientId, apiKey, staleDays, importBatchId = null }) {
    const counters = { processed_rows: 0, created_count: 0, updated_count: 0, skipped_count: 0 };
    let lastRequestAt = 0;

    try {
        const nextPage = await createBackfillPager({ agencyId, clientId, staleDays, importBatchId });
        for (;;) {
            const rows = await nextPage();
            if (!rows.length) break;

            for (let offset = 0; offset < rows.length; offset += STORELEADS_BULK_MAX) {
                const slice = rows.slice(offset, offset + STORELEADS_BULK_MAX);
                const sinceLast = Date.now() - lastRequestAt;
                if (sinceLast < BULK_MIN_INTERVAL_MS) await wait(BULK_MIN_INTERVAL_MS - sinceLast);
                lastRequestAt = Date.now();
                const rawDomains = await bulkLookupStoreLeadsDomains(apiKey, slice.map((row) => row.domain_normalized));

                // Responses are keyed by Store Leads' canonical name (often www.-prefixed
                // or a redirect target), so match on the normalized name and its aliases.
                const companyIdByDomain = new Map(slice.map((row) => [row.domain_normalized, row.id]));
                const found = new Map();
                for (const raw of rawDomains) {
                    const mapped = mapStoreLeadsDomain(raw);
                    if (!mapped) continue;
                    for (const candidate of [mapped.domain, ...mapped.aliases]) {
                        const companyId = companyIdByDomain.get(candidate);
                        if (companyId !== undefined && !found.has(companyId)) found.set(companyId, mapped);
                    }
                }
                const foundRows = [...found.entries()].map(([companyId, mapped]) => ({ companyId, mapped }));
                const missingIds = slice.filter((row) => !found.has(row.id)).map((row) => row.id);

                await withTx(async (txClient) => {
                    await updateStoreCompaniesById(txClient, { clientId, rows: foundRows });
                    await markCompaniesNotFound(txClient, { clientId, companyIds: missingIds });
                    await upsertStoreInsights(txClient, { agencyId, clientId, rows: foundRows });
                });

                counters.processed_rows += slice.length;
                counters.updated_count += foundRows.length;
                counters.skipped_count += missingIds.length;
                await updateBatch(batchId, counters);
            }
        }

        await updateBatch(batchId, { ...counters, status: 'completed' });
        console.log(`[storeleads-import ${batchId}] backfill done: ${JSON.stringify(counters)}`);
    } catch (error) {
        await failBatch(batchId, error, counters);
    }
}

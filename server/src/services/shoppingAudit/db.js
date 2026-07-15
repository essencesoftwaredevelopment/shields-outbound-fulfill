import { pool } from '../../config/db.js';
import { heroVariantPrice } from './utils.js';

const QUERY_PARAM_BUDGET = 4000;

function chunkArray(items, size) {
    const chunks = [];
    for (let i = 0; i < items.length; i += size) {
        chunks.push(items.slice(i, i + size));
    }
    return chunks;
}

export async function loadSerperShoppingCacheMap(jobId) {
    const result = await pool.query(
        `SELECT domain_normalized, payload FROM job_serper_shopping_cache WHERE job_id = $1`,
        [jobId]
    );
    const map = new Map();
    for (const row of result.rows) {
        map.set(row.domain_normalized, row.payload);
    }
    return map;
}

export async function upsertSerperShoppingCacheBatch(jobId, entries) {
    if (!entries?.length) return;
    const paramsPerRow = 2;
    const chunkSize = Math.max(1, Math.floor((QUERY_PARAM_BUDGET - 1) / paramsPerRow));

    for (const chunk of chunkArray(entries, chunkSize)) {
        const values = [];
        const params = [jobId];
        let idx = 2;
        for (const { domain, payload } of chunk) {
            values.push(`($1, $${idx}, $${idx + 1}::jsonb, NOW())`);
            params.push(domain, JSON.stringify(payload));
            idx += 2;
        }
        await pool.query(
            `INSERT INTO job_serper_shopping_cache (job_id, domain_normalized, payload, updated_at)
             VALUES ${values.join(', ')}
             ON CONFLICT (job_id, domain_normalized) DO UPDATE SET
                payload = EXCLUDED.payload,
                updated_at = NOW()`,
            params
        );
    }
}

/**
 * Load persisted catalog snapshots for a job domain set — used by heroSelection
 * after the catalog step drops in-memory snapshots from workflow step state.
 * @param {string} jobId
 * @param {string[]} domains
 * @returns {Promise<Map<string, object[]>>} domain_normalized → snapshot rows
 */
export async function loadShopifySnapshotsForDomains(jobId, domains) {
    const map = new Map();
    const list = (domains || []).map((d) => String(d || '').toLowerCase()).filter(Boolean);
    if (!jobId || !list.length) return map;

    for (const chunk of chunkArray(list, 200)) {
        const result = await pool.query(
            `SELECT domain_normalized, handle, product_id, title, variants, review_signals,
                    tags, image_count, published_at
             FROM shopify_snapshots
             WHERE job_id = $1
               AND domain_normalized = ANY($2::text[])`,
            [jobId, chunk]
        );
        for (const row of result.rows) {
            const domain = row.domain_normalized;
            if (!map.has(domain)) map.set(domain, []);
            map.get(domain).push({
                domain_normalized: domain,
                handle: row.handle,
                product_id: row.product_id,
                title: row.title || '',
                variants: row.variants || [],
                review_signals: row.review_signals || {},
                tags: row.tags || '',
                image_count: row.image_count || 0,
                published_at: row.published_at || null
            });
        }
    }
    return map;
}

export async function upsertShopifySnapshotsBatch({
    agencyId,
    clientId,
    companyIdByDomain,
    jobId,
    rows
}) {
    if (!rows?.length) return [];

    const paramsPerRow = 13;
    const chunkSize = Math.max(1, Math.floor(QUERY_PARAM_BUDGET / paramsPerRow));
    const ids = [];

    for (const chunk of chunkArray(rows, chunkSize)) {
        const values = [];
        const params = [];
        let idx = 1;

        for (const row of chunk) {
            const companyId = companyIdByDomain?.get(row.domain_normalized) ?? null;
            values.push(
                `($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6}, $${idx + 7}, $${idx + 8}::jsonb, $${idx + 9}::jsonb, $${idx + 10}, $${idx + 11}, $${idx + 12}, NOW(), NOW())`
            );
            params.push(
                agencyId,
                clientId,
                companyId,
                jobId,
                row.domain_normalized,
                row.handle,
                row.product_id,
                row.title,
                JSON.stringify(row.variants || []),
                JSON.stringify(row.review_signals || {}),
                row.tags || null,
                row.image_count || 0,
                row.published_at || null
            );
            idx += paramsPerRow;
        }

        const result = await pool.query(
            `INSERT INTO shopify_snapshots (
                agency_id, client_id, company_id, job_id, domain_normalized, handle,
                product_id, title, variants, review_signals, tags, image_count, published_at,
                fetched_at, updated_at
            ) VALUES ${values.join(', ')}
            ON CONFLICT (client_id, domain_normalized, product_id) DO UPDATE SET
                company_id = COALESCE(EXCLUDED.company_id, shopify_snapshots.company_id),
                job_id = EXCLUDED.job_id,
                title = EXCLUDED.title,
                variants = EXCLUDED.variants,
                review_signals = EXCLUDED.review_signals,
                tags = EXCLUDED.tags,
                image_count = EXCLUDED.image_count,
                published_at = EXCLUDED.published_at,
                fetched_at = NOW(),
                updated_at = NOW()
            RETURNING id, domain_normalized, product_id`,
            params
        );

        for (const row of result.rows) {
            ids.push({
                domain: row.domain_normalized,
                product_id: row.product_id,
                id: row.id
            });
        }
    }

    return ids;
}

function snapshotKey(domain, productId) {
    return `${domain}:${productId}`;
}

export async function insertHeroSelectionsBatch({
    agencyId,
    clientId,
    companyIdByDomain,
    jobId,
    rows
}) {
    if (!rows?.length) return new Map();

    const paramsPerRow = 8;
    const chunkSize = Math.max(1, Math.floor(QUERY_PARAM_BUDGET / paramsPerRow));
    const idByDomain = new Map();

    for (const chunk of chunkArray(rows, chunkSize)) {
        const values = [];
        const params = [];
        let idx = 1;

        for (const row of chunk) {
            values.push(
                `($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6}, $${idx + 7}::jsonb)`
            );
            params.push(
                agencyId,
                clientId,
                row.companyId ?? companyIdByDomain?.get(row.domain) ?? null,
                jobId,
                row.shopifySnapshotId,
                row.domain,
                row.heuristicVersion,
                JSON.stringify(row.selectionReason || {})
            );
            idx += paramsPerRow;
        }

        const result = await pool.query(
            `INSERT INTO hero_selections (
                agency_id, client_id, company_id, job_id, shopify_snapshot_id,
                domain_normalized, heuristic_version, selection_reason
            ) VALUES ${values.join(', ')}
            ON CONFLICT (job_id, domain_normalized) DO UPDATE SET
                shopify_snapshot_id = EXCLUDED.shopify_snapshot_id,
                heuristic_version = EXCLUDED.heuristic_version,
                selection_reason = EXCLUDED.selection_reason
            RETURNING id, domain_normalized`,
            params
        );

        for (const row of result.rows) {
            idByDomain.set(row.domain_normalized, row.id);
        }
    }

    return idByDomain;
}

export async function insertHeroSelection(params) {
    const idByDomain = await insertHeroSelectionsBatch({
        agencyId: params.agencyId,
        clientId: params.clientId,
        companyIdByDomain: new Map([[params.domain, params.companyId]]),
        jobId: params.jobId,
        rows: [{
            domain: params.domain,
            companyId: params.companyId,
            shopifySnapshotId: params.shopifySnapshotId,
            heuristicVersion: params.heuristicVersion,
            selectionReason: params.selectionReason
        }]
    });
    return idByDomain.get(params.domain);
}

export async function insertAdObservationsBatch({
    agencyId,
    clientId,
    jobId,
    rows
}) {
    if (!rows?.length) return [];

    const paramsPerRow = 11;
    const chunkSize = Math.max(1, Math.floor(QUERY_PARAM_BUDGET / paramsPerRow));
    const ids = [];

    for (const chunk of chunkArray(rows, chunkSize)) {
        const values = [];
        const params = [];
        let idx = 1;

        for (const row of chunk) {
            values.push(
                `($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}::jsonb, $${idx + 6}::jsonb, $${idx + 7}, $${idx + 8}::jsonb, $${idx + 9}, $${idx + 10})`
            );
            params.push(
                agencyId,
                clientId,
                row.heroSelectionId ?? null,
                jobId,
                row.branch || 'none',
                row.matchedCard ? JSON.stringify(row.matchedCard) : null,
                JSON.stringify(row.allCards || []),
                row.source || 'serper',
                JSON.stringify(row.geo || {}),
                row.queryText || null,
                row.observedAt || new Date().toISOString()
            );
            idx += paramsPerRow;
        }

        const result = await pool.query(
            `INSERT INTO ad_observations (
                agency_id, client_id, hero_selection_id, job_id, branch,
                matched_card, all_cards, source, geo, query_text, observed_at
            ) VALUES ${values.join(', ')}
            RETURNING id`,
            params
        );

        for (const row of result.rows) {
            ids.push(row.id);
        }
    }

    return ids;
}

export async function insertAdObservation(params) {
    const [id] = await insertAdObservationsBatch({
        agencyId: params.agencyId,
        clientId: params.clientId,
        jobId: params.jobId,
        rows: [{
            heroSelectionId: params.heroSelectionId,
            branch: params.branch,
            matchedCard: params.matchedCard,
            allCards: params.allCards,
            source: params.source,
            geo: params.geo,
            queryText: params.queryText,
            observedAt: params.observedAt
        }]
    });
    return id ?? null;
}

export async function insertSignalEmissionsBatch({
    agencyId,
    clientId,
    companyIdByDomain,
    jobId,
    rows
}) {
    if (!rows?.length) return new Map();

    const paramsPerRow = 14;
    const chunkSize = Math.max(1, Math.floor(QUERY_PARAM_BUDGET / paramsPerRow));
    const idByDomain = new Map();

    for (const chunk of chunkArray(rows, chunkSize)) {
        const values = [];
        const params = [];
        let idx = 1;

        for (const row of chunk) {
            const signal = row.signal;
            values.push(
                `($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6}, $${idx + 7}, $${idx + 8}::jsonb, $${idx + 9}::jsonb, $${idx + 10}::jsonb, $${idx + 11}, $${idx + 12}::jsonb, $${idx + 13}::jsonb)`
            );
            params.push(
                agencyId,
                clientId,
                row.companyId ?? companyIdByDomain?.get(row.domain) ?? null,
                jobId,
                row.adObservationId ?? null,
                row.domain,
                signal.signal_type,
                signal.tier,
                JSON.stringify(signal.observed || {}),
                JSON.stringify(signal.expected || {}),
                signal.competitor_ref ? JSON.stringify(signal.competitor_ref) : null,
                signal.observed_at || new Date().toISOString(),
                signal.export_vars ? JSON.stringify(signal.export_vars) : null,
                signal.secondary_signals ? JSON.stringify(signal.secondary_signals) : null
            );
            idx += paramsPerRow;
        }

        const result = await pool.query(
            `INSERT INTO signal_emissions (
                agency_id, client_id, company_id, job_id, ad_observation_id,
                domain_normalized, signal_type, tier, observed, expected, competitor_ref, observed_at,
                export_vars, secondary_signals
            ) VALUES ${values.join(', ')}
            ON CONFLICT (job_id, domain_normalized) DO UPDATE SET
                ad_observation_id = EXCLUDED.ad_observation_id,
                signal_type = EXCLUDED.signal_type,
                tier = EXCLUDED.tier,
                observed = EXCLUDED.observed,
                expected = EXCLUDED.expected,
                competitor_ref = EXCLUDED.competitor_ref,
                observed_at = EXCLUDED.observed_at,
                export_vars = COALESCE(EXCLUDED.export_vars, signal_emissions.export_vars),
                secondary_signals = COALESCE(EXCLUDED.secondary_signals, signal_emissions.secondary_signals)
            RETURNING id, domain_normalized`,
            params
        );

        for (const row of result.rows) {
            idByDomain.set(row.domain_normalized, row.id);
        }
    }

    return idByDomain;
}

export async function insertSignalEmission(params) {
    const idByDomain = await insertSignalEmissionsBatch({
        agencyId: params.agencyId,
        clientId: params.clientId,
        companyIdByDomain: new Map([[params.domain, params.companyId]]),
        jobId: params.jobId,
        rows: [{
            domain: params.domain,
            companyId: params.companyId,
            adObservationId: params.adObservationId,
            signal: params.signal
        }]
    });
    return idByDomain.get(params.domain);
}

/**
 * Merge fields into signal_emissions.export_vars (e.g. product_short from the
 * personalization stage). patches: [{ id, vars: {..} }]
 */
export async function updateSignalEmissionExportVars(patches) {
    const rows = (patches || []).filter((p) => p?.id && p?.vars && Object.keys(p.vars).length);
    if (!rows.length) return;
    for (const chunk of chunkArray(rows, 50)) {
        await Promise.all(chunk.map(({ id, vars }) =>
            pool.query(
                `UPDATE signal_emissions
                 SET export_vars = COALESCE(export_vars, '{}'::jsonb) || $2::jsonb
                 WHERE id = $1`,
                [id, JSON.stringify(vars)]
            )
        ));
    }
}

export async function updateCompanyLastAudit(clientId, domains) {
    if (!domains?.length) return;
    await pool.query(
        `UPDATE companies SET last_audit_at = NOW(), updated_at = NOW()
         WHERE client_id = $1 AND domain_normalized = ANY($2::text[])`,
        [clientId, domains]
    );
}

export async function getSignalEmissionByDomain(jobId, domain) {
    const result = await pool.query(
        `SELECT * FROM signal_emissions WHERE job_id = $1 AND domain_normalized = $2`,
        [jobId, domain]
    );
    return result.rows[0] || null;
}

export async function getSignalEmissionById(id) {
    const result = await pool.query(`SELECT * FROM signal_emissions WHERE id = $1`, [id]);
    return result.rows[0] || null;
}

export async function getSignalEmissionsForJob(jobId) {
    const result = await pool.query(
        `SELECT * FROM signal_emissions WHERE job_id = $1 ORDER BY id`,
        [jobId]
    );
    return result.rows;
}

export function passesHeadlessValueGate(snapshot, features) {
    const minPrice = Number(features?.headlessMinPrice ?? 75);
    const price = heroVariantPrice(snapshot?.variants || []);
    const reviews = snapshot?.review_signals?.review_count || 0;
    const widgets = snapshot?.review_signals?.widgets?.length || 0;
    return (price != null && price >= minPrice) || reviews > 0 || widgets > 0;
}

export async function linkContactSignalEmission(contactId, signalEmissionId) {
    await pool.query(
        `UPDATE contacts SET signal_emission_id = $2, updated_at = NOW() WHERE id = $1`,
        [contactId, signalEmissionId]
    );
}

export async function getBatchAuditMetrics(jobId) {
    const result = await pool.query(
        `SELECT
            COUNT(*) FILTER (WHERE signal_type = 'price_mismatch') AS price_mismatch_count,
            COUNT(*) AS any_signal_count,
            (SELECT COUNT(*) FROM ad_observations WHERE job_id = $1 AND branch = 'clean') AS ad_found_clean,
            (SELECT COUNT(*) FROM ad_observations WHERE job_id = $1) AS ad_observation_total,
            (SELECT COUNT(*) FROM ad_observations WHERE job_id = $1 AND source = 'headless') AS headless_count
         FROM signal_emissions WHERE job_id = $1`,
        [jobId]
    );
    return result.rows[0] || {};
}

export { snapshotKey };

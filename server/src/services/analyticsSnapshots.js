/**
 * Precomputed Analytics-tab headline numbers + chart (the "core" scope) per
 * client and period, stored in client_analytics_snapshots.
 *
 * Core aggregates raw contact_instantly_events rows (positive replies alone is
 * ~1s on the largest client), so every period switch used to recompute it.
 * The sweep refreshes each active client every ANALYTICS_SNAPSHOT_INTERVAL_MS;
 * reads serve the snapshot and only fall back to a live compute when it is
 * missing. Campaign-filtered views stay live (not snapshotted).
 */
import {
    loadInstantlyEventAnalyticsCore,
    mergeAnalyticsBuckets
} from '../utils/instantlyEventAnalytics.js';
import { INSTANTLY_ANALYTICS_PERIODS } from '../utils/instantlyAnalyticsPeriods.js';

const SWEEP_INTERVAL_MS = Math.max(
    60_000,
    Number(process.env.ANALYTICS_SNAPSHOT_INTERVAL_MS || 600_000) || 600_000
);
// A snapshot older than this is served once more while a background refresh runs.
const STALE_AFTER_MS = Math.max(SWEEP_INTERVAL_MS + 5 * 60_000, 15 * 60_000);

const refreshesInFlight = new Map();

export function isAnalyticsSnapshotSweepEnabled(env = process.env) {
    const raw = String(env.ANALYTICS_SNAPSHOT_ENABLED ?? '').trim().toLowerCase();
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    // Local dev servers share the prod database; only sweep from the prod host by default.
    return env.NODE_ENV === 'production';
}

/**
 * Re-lay stored buckets onto the current bucket series, so a snapshot taken
 * before an hour/day boundary still ends at "now" (new bucket shows as 0).
 */
export function rebuildSnapshotAnalytics(periodConfig, payload) {
    const storedRows = Array.isArray(payload?.byHour) ? payload.byHour : [];
    const pick = (key) => storedRows.map((row) => ({ bucket: row.bucket, count: row[key] ?? 0 }));

    return {
        summary: payload?.summary || {},
        byHour: mergeAnalyticsBuckets({
            periodConfig,
            eventBucketRows: [],
            emailsSentBucketRows: pick('emails_sent'),
            positiveReplyBucketRows: pick('positive_replies'),
            meetingsBookedBucketRows: pick('meetings_booked')
        })
    };
}

async function readSnapshot(pool, agencyId, sqlClientId, period) {
    const { rows } = await pool.query(
        `SELECT payload, computed_at
         FROM client_analytics_snapshots
         WHERE agency_id = $1 AND client_id = $2 AND period = $3`,
        [agencyId, sqlClientId, period]
    );
    return rows[0] || null;
}

async function computeAndStoreSnapshot(pool, agencyId, sqlClientId, periodConfig) {
    const analytics = await loadInstantlyEventAnalyticsCore({
        pool,
        agencyId,
        sqlClientId,
        periodConfig,
        skipCache: true
    });
    const { rows } = await pool.query(
        `INSERT INTO client_analytics_snapshots (agency_id, client_id, period, payload, computed_at)
         VALUES ($1, $2, $3, $4::jsonb, NOW())
         ON CONFLICT (agency_id, client_id, period)
         DO UPDATE SET payload = EXCLUDED.payload, computed_at = EXCLUDED.computed_at
         RETURNING computed_at`,
        [agencyId, sqlClientId, periodConfig.period, JSON.stringify(analytics)]
    );
    return { analytics, computedAt: rows[0]?.computed_at ?? new Date() };
}

function refreshSnapshot(pool, agencyId, sqlClientId, periodConfig) {
    const key = `${agencyId}:${sqlClientId}:${periodConfig.period}`;
    const existing = refreshesInFlight.get(key);
    if (existing) return existing;

    const promise = computeAndStoreSnapshot(pool, agencyId, sqlClientId, periodConfig)
        .finally(() => refreshesInFlight.delete(key));
    refreshesInFlight.set(key, promise);
    return promise;
}

/**
 * Core analytics for the all-campaigns view, served from the snapshot.
 * Returns { analytics, computedAt }.
 */
export async function loadCoreAnalyticsWithSnapshot({ pool, agencyId, sqlClientId, periodConfig }) {
    let snapshot = null;
    try {
        snapshot = await readSnapshot(pool, agencyId, sqlClientId, periodConfig.period);
    } catch (error) {
        // Table missing (migration not applied yet) or read failure: fall back to live.
        console.warn('[analyticsSnapshots] snapshot read failed, computing live:', error?.message || error);
        const analytics = await loadInstantlyEventAnalyticsCore({ pool, agencyId, sqlClientId, periodConfig });
        return { analytics, computedAt: new Date() };
    }

    if (!snapshot) {
        return refreshSnapshot(pool, agencyId, sqlClientId, periodConfig);
    }

    const ageMs = Date.now() - new Date(snapshot.computed_at).getTime();
    if (ageMs > STALE_AFTER_MS) {
        refreshSnapshot(pool, agencyId, sqlClientId, periodConfig).catch((error) => {
            console.error('[analyticsSnapshots] background refresh failed:', error?.message || error);
        });
    }

    return {
        analytics: rebuildSnapshotAnalytics(periodConfig, snapshot.payload),
        computedAt: snapshot.computed_at
    };
}

/** Refresh every period for one client, one period at a time. */
export async function refreshClientAnalyticsSnapshots({ pool, agencyId, sqlClientId }) {
    for (const periodConfig of Object.values(INSTANTLY_ANALYTICS_PERIODS)) {
        await refreshSnapshot(pool, agencyId, sqlClientId, periodConfig);
    }
}

async function listActiveAnalyticsClients(pool) {
    const { rows } = await pool.query(
        `SELECT c.agency_id, c.id AS client_id
         FROM clients c
         WHERE EXISTS (
             SELECT 1
             FROM contact_instantly_events cie
             WHERE cie.client_id = c.id
               AND cie.event_timestamp >= NOW() - INTERVAL '90 days'
         )
         ORDER BY c.id`
    );
    return rows;
}

export async function runAnalyticsSnapshotSweep(pool) {
    const startedAt = Date.now();
    const clients = await listActiveAnalyticsClients(pool);
    let failed = 0;
    for (const { agency_id: agencyId, client_id: sqlClientId } of clients) {
        try {
            await refreshClientAnalyticsSnapshots({ pool, agencyId, sqlClientId: Number(sqlClientId) });
        } catch (error) {
            failed += 1;
            console.error(`[analyticsSnapshots] refresh failed for client ${sqlClientId}:`, error?.message || error);
        }
    }
    console.log(
        `[analyticsSnapshots] swept ${clients.length} client(s) in ${Date.now() - startedAt}ms`
        + (failed ? ` (${failed} failed)` : '')
    );
}

/** Start the periodic sweep. Returns a stop function. */
export function startAnalyticsSnapshotSweep(pool) {
    if (!isAnalyticsSnapshotSweepEnabled()) {
        console.log('[analyticsSnapshots] sweep disabled (ANALYTICS_SNAPSHOT_ENABLED / NODE_ENV)');
        return () => {};
    }

    let running = false;
    const tick = async () => {
        if (running) return;
        running = true;
        try {
            await runAnalyticsSnapshotSweep(pool);
        } catch (error) {
            console.error('[analyticsSnapshots] sweep failed:', error?.message || error);
        } finally {
            running = false;
        }
    };

    const initial = setTimeout(tick, 15_000);
    const interval = setInterval(tick, SWEEP_INTERVAL_MS);
    initial.unref?.();
    interval.unref?.();
    console.log(`[analyticsSnapshots] sweep every ${Math.round(SWEEP_INTERVAL_MS / 1000)}s`);

    return () => {
        clearTimeout(initial);
        clearInterval(interval);
    };
}

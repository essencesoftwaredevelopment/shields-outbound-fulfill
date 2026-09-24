/**
 * Automatic deletion of finished leads from Instantly, per client (opt-in on the
 * client Info tab). Frees the workspace's lead allowance without losing history.
 *
 * A lead (never a campaign — campaigns keep running and taking new leads) is
 * deleted when its own sequence is over and nothing more is expected from it:
 *   no_reply        completed, no label, no replies
 *   out_of_office   completed, labelled Out of office
 *   not_interested  completed, labelled Not interested
 *   wrong_person    completed, labelled Wrong person
 *   bad_fit         completed, labelled with the workspace's "Bad Fit" label
 *   bounced         bounced
 *   unsubscribed    unsubscribed
 * …and its last send / bounce / unsubscribe is more than `days` ago. Positive
 * labels (Interested, Meeting booked, Warm Follow Up, Day N, …) and replied-but-
 * unlabelled leads are always kept.
 *
 * Order per run — our copy must be current before Instantly forgets the lead:
 *   1. the usual full Instantly sync (same as the Info tab's sync button), so
 *      statuses, labels, counters and timestamps are fresh; if it fails,
 *      nothing is deleted
 *   2. select candidates from the freshly synced data
 *   3. bulk DELETE /api/v2/leads by exact ids + lead status (per-lead fallback
 *      on a count mismatch), then mark our membership rows removed (kept for
 *      lead filters, analytics and Deal Flow)
 */

import { pool } from '../config/db.js';
import {
    getInstantlySyncRun,
    instantlyRequest,
    listInstantlyLeadLabels,
    runInstantlySyncJob
} from './instantlyState.js';

export const CLEANUP_CATEGORIES = [
    'no_reply',
    'out_of_office',
    'not_interested',
    'wrong_person',
    'bad_fit',
    'bounced',
    'unsubscribed'
];

/** Waiting on a sync someone else already started (e.g. from the Info tab). */
const SYNC_WAIT_POLL_MS = 10_000;
const SYNC_WAIT_MAX_MS = 60 * 60 * 1000;
/** Lead ids per bulk DELETE (Instantly allows up to 10,000). */
const BULK_DELETE_CHUNK = 500;
/** Scheduled runs happen at most this often per client. */
export const CLEANUP_MIN_INTERVAL_MS = 20 * 60 * 60 * 1000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Interest-status values of the workspace's "Bad Fit" label(s). */
export function badFitStatusesFromLabels(labels) {
    return (Array.isArray(labels) ? labels : [])
        .filter((l) => /^\s*bad\s*fit\s*$/i.test(String(l?.label || '')))
        .map((l) => Number(l?.interest_status))
        .filter((n) => Number.isInteger(n));
}

/**
 * Candidate memberships for a client. `badFitStatuses` empty = bad-fit category
 * off (label missing / labels unavailable).
 *
 * @param {import('pg').Pool | import('pg').PoolClient} db
 * @param {number} clientSqlId
 * @param {{ days: number, badFitStatuses?: number[], campaignIds?: number[] | null }} opts
 */
export async function selectCleanupCandidates(db, clientSqlId, { days, badFitStatuses = [], campaignIds = null }) {
    const params = [clientSqlId, days, badFitStatuses];
    let campaignFilter = '';
    if (Array.isArray(campaignIds)) {
        params.push(campaignIds);
        campaignFilter = `AND cic.campaign_id = ANY($${params.length}::bigint[])`;
    }
    const { rows } = await db.query(
        `SELECT *
         FROM (
            SELECT cic.contact_id,
                   cic.campaign_id,
                   ic.instantly_campaign_id,
                   cic.instantly_lead_id,
                   cic.lead_status,
                   COALESCE(cic.email_reply_count, 0)::int AS email_reply_count,
                   CASE
                     WHEN cic.lead_status = -1 THEN 'bounced'
                     WHEN cic.lead_status = -2 THEN 'unsubscribed'
                     WHEN cic.lead_status = 3 AND cic.interest_status IS NULL
                          AND COALESCE(cic.email_reply_count, 0) = 0 THEN 'no_reply'
                     WHEN cic.lead_status = 3 AND cic.interest_status = 0 THEN 'out_of_office'
                     WHEN cic.lead_status = 3 AND cic.interest_status = -1 THEN 'not_interested'
                     WHEN cic.lead_status = 3 AND cic.interest_status = -2 THEN 'wrong_person'
                     WHEN cic.lead_status = 3 AND cic.interest_status = ANY($3::int[]) THEN 'bad_fit'
                   END AS category
            FROM contact_instantly_campaigns cic
            JOIN contacts ct ON ct.id = cic.contact_id
            JOIN instantly_campaigns ic ON ic.id = cic.campaign_id
            WHERE ct.client_id = $1
              AND cic.active = TRUE
              AND cic.instantly_lead_id IS NOT NULL
              -- Bounced / unsubscribed with a positive label are still kept.
              AND NOT (COALESCE(cic.interest_status, 0) >= 1)
              AND GREATEST(cic.timestamp_last_contact, cic.last_bounce_at, cic.last_unsubscribe_at)
                  < NOW() - make_interval(days => $2::int)
              ${campaignFilter}
         ) c
         WHERE c.category IS NOT NULL`,
        params
    );
    return rows;
}

export async function getCleanupSettings(clientSqlId) {
    const { rows: [row] } = await pool.query(
        `SELECT instantly_cleanup_enabled AS enabled, instantly_cleanup_days AS days,
                instantly_cleanup_last_run_at AS last_run_at
         FROM clients WHERE id = $1`,
        [clientSqlId]
    );
    return row || null;
}

export async function updateCleanupSettings(clientSqlId, { enabled, days }) {
    const { rows: [row] } = await pool.query(
        `UPDATE clients SET
            instantly_cleanup_enabled = COALESCE($2, instantly_cleanup_enabled),
            instantly_cleanup_days = COALESCE($3, instantly_cleanup_days)
         WHERE id = $1
         RETURNING instantly_cleanup_enabled AS enabled, instantly_cleanup_days AS days,
                   instantly_cleanup_last_run_at AS last_run_at`,
        [clientSqlId, typeof enabled === 'boolean' ? enabled : null, Number.isInteger(days) ? days : null]
    );
    return row || null;
}

export async function getLatestCleanupRun(clientSqlId) {
    const { rows: [row] } = await pool.query(
        `SELECT id, trigger_source, status, days, summary, error, started_at, completed_at
         FROM instantly_cleanup_runs WHERE client_id = $1
         ORDER BY started_at DESC LIMIT 1`,
        [clientSqlId]
    );
    return row || null;
}

function countByCategory(rows) {
    const counts = Object.fromEntries(CLEANUP_CATEGORIES.map((c) => [c, 0]));
    for (const row of rows) counts[row.category] = (counts[row.category] || 0) + 1;
    return counts;
}

/**
 * What a run would delete right now (DB only — no sync, no Instantly writes).
 * A real run syncs first, so the count can shift slightly.
 */
export async function previewCleanup({ clientSqlId, instantlyKey, days }) {
    let badFitStatuses = [];
    let labelsAvailable = true;
    try {
        badFitStatuses = badFitStatusesFromLabels(await listInstantlyLeadLabels(instantlyKey));
    } catch {
        labelsAvailable = false;
    }
    const rows = await selectCleanupCandidates(pool, clientSqlId, { days, badFitStatuses });
    return {
        total: rows.length,
        byCategory: countByCategory(rows),
        campaigns: new Set(rows.map((r) => r.campaign_id)).size,
        badFitLabelFound: badFitStatuses.length > 0,
        labelsAvailable
    };
}

/**
 * The usual full Instantly sync. If one is already running (someone pressed
 * sync on the Info tab), wait for it instead of starting a second. Throws when
 * the sync didn't complete, so nothing is deleted on stale data.
 */
async function syncBeforeCleanup({ agencyId, clientSlug, instantlyKey, logger }) {
    const result = await runInstantlySyncJob({
        agencyId,
        clientSlug,
        instantlyKey,
        triggerSource: 'manual',
        logger: (m) => logger(`[sync] ${m}`)
    });
    let run = result.run;
    if (result.alreadyRunning && run?.id) {
        logger(`a sync is already running (${run.id}); waiting for it`);
        const deadline = Date.now() + SYNC_WAIT_MAX_MS;
        while (Date.now() < deadline) {
            await wait(SYNC_WAIT_POLL_MS);
            run = await getInstantlySyncRun({ agencyId, clientSlug, runId: run.id });
            if (run && run.status !== 'running' && run.status !== 'queued') break;
        }
    }
    const status = String(run?.status || '');
    if (status !== 'completed') {
        throw new Error(`Instantly sync did not complete (${status || 'unknown'}${run?.error ? `: ${run.error}` : ''}); no leads deleted.`);
    }
    return run;
}

/**
 * Bulk-delete by exact lead ids, grouped by lead status, with two guards that
 * were verified against Instantly (2026-09-24): ids + `status` are ANDed, and
 * `limit` caps the call at the chunk size. A count mismatch (some already gone,
 * or anything unexpected) re-does that chunk one lead at a time, where a 404
 * means the lead is already gone. Our rows are marked removed per chunk.
 */
async function deleteFromInstantly({ apiKey, campaign, rows, logger }) {
    let deleted = 0;
    const removed = [];
    const byStatus = new Map();
    for (const row of rows) {
        const key = Number(row.lead_status);
        if (!byStatus.has(key)) byStatus.set(key, []);
        byStatus.get(key).push(row);
    }
    for (const [status, group] of byStatus) {
        for (let i = 0; i < group.length; i += BULK_DELETE_CHUNK) {
            const chunk = group.slice(i, i + BULK_DELETE_CHUNK);
            const body = await instantlyRequest({
                apiKey,
                path: '/api/v2/leads',
                method: 'DELETE',
                body: {
                    campaign_id: campaign.instantly_campaign_id,
                    ids: chunk.map((r) => r.instantly_lead_id),
                    status,
                    limit: chunk.length
                }
            });
            const count = Number(body?.count) || 0;
            if (count === chunk.length) {
                deleted += count;
            } else {
                logger(`campaign ${campaign.instantly_campaign_id}: bulk delete removed ${count} of ${chunk.length} (status ${status}); checking each`);
                deleted += count + await deleteOneByOne({ apiKey, rows: chunk });
            }
            await markRemoved(chunk);
            removed.push(...chunk);
        }
    }
    return { deleted, removed };
}

/** Per-lead fallback; returns how many this call deleted (404 = already gone). */
async function deleteOneByOne({ apiKey, rows }) {
    let deleted = 0;
    for (const row of rows) {
        try {
            await instantlyRequest({
                apiKey,
                path: `/api/v2/leads/${encodeURIComponent(row.instantly_lead_id)}`,
                method: 'DELETE'
            });
            deleted += 1;
        } catch (error) {
            if (error?.statusCode !== 404) throw error;
        }
    }
    return deleted;
}

async function markRemoved(rows) {
    if (!rows.length) return;
    await pool.query(
        `UPDATE contact_instantly_campaigns cic
         SET active = FALSE,
             removed_at = COALESCE(cic.removed_at, NOW()),
             notes = 'auto_cleanup:' || i.category
         FROM jsonb_to_recordset($1::jsonb) AS i(contact_id BIGINT, campaign_id BIGINT, category TEXT)
         WHERE cic.contact_id = i.contact_id AND cic.campaign_id = i.campaign_id`,
        [JSON.stringify(rows.map((r) => ({ contact_id: r.contact_id, campaign_id: r.campaign_id, category: r.category })))]
    );
}

/**
 * Run the cleanup for one client. Scheduled runs require the client to be
 * enabled; `force` (manual/scripts) ignores the toggle but still honours `days`.
 */
export async function runInstantlyCleanup({
    agencyId,
    clientSqlId,
    clientSlug,
    instantlyKey,
    triggerSource = 'scheduled',
    force = false,
    logger = () => {}
}) {
    const settings = await getCleanupSettings(clientSqlId);
    if (!settings) throw new Error(`Client ${clientSqlId} not found`);
    if (!settings.enabled && !force) return { skipped: 'disabled' };

    const days = settings.days;
    const { rows: [run] } = await pool.query(
        `INSERT INTO instantly_cleanup_runs (agency_id, client_id, trigger_source, days)
         VALUES ($1, $2, $3, $4) RETURNING id, started_at`,
        [agencyId, clientSqlId, triggerSource, days]
    );

    const summary = {
        candidates: 0,
        campaigns: 0,
        deleted: 0,
        instantlyReportedDeleted: 0,
        byCategory: {},
        badFitLabelFound: false
    };
    try {
        // 1. Everything current in our database first.
        await syncBeforeCleanup({ agencyId, clientSlug, instantlyKey, logger });

        // 2. Candidates from the freshly synced data.
        const badFitStatuses = badFitStatusesFromLabels(await listInstantlyLeadLabels(instantlyKey));
        summary.badFitLabelFound = badFitStatuses.length > 0;
        const candidates = await selectCleanupCandidates(pool, clientSqlId, { days, badFitStatuses });
        const byCampaign = new Map();
        for (const row of candidates) {
            if (!byCampaign.has(row.campaign_id)) {
                byCampaign.set(row.campaign_id, {
                    campaign: { campaign_id: row.campaign_id, instantly_campaign_id: row.instantly_campaign_id },
                    rows: []
                });
            }
            byCampaign.get(row.campaign_id).rows.push(row);
        }
        summary.candidates = candidates.length;
        summary.campaigns = byCampaign.size;
        logger(`${candidates.length} lead(s) to delete across ${byCampaign.size} campaign(s)`);

        // 3. Delete by exact lead id and keep our record.
        for (const { campaign, rows } of byCampaign.values()) {
            const { deleted, removed } = await deleteFromInstantly({ apiKey: instantlyKey, campaign, rows, logger });
            summary.instantlyReportedDeleted += deleted;
            summary.deleted += removed.length;
            for (const r of removed) summary.byCategory[r.category] = (summary.byCategory[r.category] || 0) + 1;
            logger(`campaign ${campaign.instantly_campaign_id}: removed ${removed.length}`);
        }

        await pool.query(
            `UPDATE instantly_cleanup_runs SET status = 'completed', summary = $2::jsonb, completed_at = NOW() WHERE id = $1`,
            [run.id, JSON.stringify(summary)]
        );
        await pool.query(`UPDATE clients SET instantly_cleanup_last_run_at = NOW() WHERE id = $1`, [clientSqlId]);
        logger(`deleted ${summary.deleted} lead(s)`);
        return { runId: run.id, summary };
    } catch (error) {
        await pool.query(
            `UPDATE instantly_cleanup_runs SET status = 'failed', summary = $2::jsonb, error = $3, completed_at = NOW() WHERE id = $1`,
            [run.id, JSON.stringify(summary), String(error?.message || error).slice(0, 2000)]
        );
        throw error;
    }
}

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Deletes in Instantly — local dev servers share the prod DB, so prod host only by default. */
export function isInstantlyCleanupSweepEnabled(env = process.env) {
    const raw = String(env.INSTANTLY_CLEANUP_SWEEP_ENABLED ?? '').trim().toLowerCase();
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return env.NODE_ENV === 'production';
}

/** Clients whose cleanup is on and hasn't run in the last ~day. */
async function listDueCleanupClients() {
    const { rows } = await pool.query(
        `SELECT id, agency_id, slug, instantly_key
         FROM clients
         WHERE instantly_cleanup_enabled = TRUE
           AND instantly_key IS NOT NULL AND BTRIM(instantly_key) <> ''
           AND (instantly_cleanup_last_run_at IS NULL
                OR instantly_cleanup_last_run_at < NOW() - make_interval(secs => $1::float8))
           AND NOT EXISTS (
               SELECT 1 FROM instantly_cleanup_runs r
               WHERE r.client_id = clients.id AND r.status = 'running'
                 AND r.started_at > NOW() - INTERVAL '6 hours'
           )
         ORDER BY instantly_cleanup_last_run_at NULLS FIRST`,
        [CLEANUP_MIN_INTERVAL_MS / 1000]
    );
    return rows;
}

export async function runInstantlyCleanupSweep() {
    for (const client of await listDueCleanupClients()) {
        const label = `${client.agency_id}/${client.slug}`;
        try {
            await runInstantlyCleanup({
                agencyId: client.agency_id,
                clientSqlId: client.id,
                clientSlug: client.slug,
                instantlyKey: client.instantly_key,
                triggerSource: 'scheduled',
                logger: (m) => console.log(`[instantly-cleanup][${label}] ${m}`)
            });
        } catch (error) {
            // A failed run is logged in instantly_cleanup_runs; last_run_at stays, so it retries next tick.
            console.error(`[instantly-cleanup][${label}] failed:`, error?.message || error);
        }
    }
}

export function startInstantlyCleanupSweep() {
    if (!isInstantlyCleanupSweepEnabled()) {
        console.log('[instantly-cleanup] sweep disabled (INSTANTLY_CLEANUP_SWEEP_ENABLED / NODE_ENV)');
        return () => {};
    }
    let running = false;
    const tick = async () => {
        if (running) return;
        running = true;
        try {
            await runInstantlyCleanupSweep();
        } catch (error) {
            console.error('[instantly-cleanup] sweep failed:', error?.message || error);
        } finally {
            running = false;
        }
    };
    const initial = setTimeout(tick, 60_000);
    const interval = setInterval(tick, SWEEP_INTERVAL_MS);
    initial.unref?.();
    interval.unref?.();
    console.log(`[instantly-cleanup] sweep every ${Math.round(SWEEP_INTERVAL_MS / 60000)}m`);
    return () => {
        clearTimeout(initial);
        clearInterval(interval);
    };
}

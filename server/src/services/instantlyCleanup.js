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
 * Order per run — our copy must be complete before Instantly forgets the lead:
 *   1. select candidates, group by campaign
 *   2. sync those campaigns (statuses, labels, counters, timestamps)
 *   3. backfill their replies from /api/v2/emails (webhooks miss some)
 *   4. re-select from the fresh data; skip any lead whose stored replies don't
 *      cover Instantly's reply count
 *   5. DELETE /api/v2/leads/{id} one lead at a time, then mark our membership
 *      rows removed (kept for lead filters, analytics and Deal Flow)
 */

import crypto from 'crypto';
import { pool } from '../config/db.js';
import {
    instantlyRequest,
    listInstantlyLeadLabels,
    syncClientInstantlyState
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

/** GET /api/v2/emails allows 20 requests/minute. */
const EMAILS_REQUEST_SPACING_MS = 3200;
/** Membership rows are marked removed in batches of this size while deleting. */
const DELETE_CHUNK = 100;
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
 * Leads whose replies aren't all stored yet are counted, but a real run
 * backfills first and skips any it still can't reconcile.
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
 * Store the campaign's received emails we don't have yet (matched on Instantly's
 * email id, whichever source stored it). Returns how many were added.
 */
async function backfillCampaignReplies({ apiKey, agencyId, clientSqlId, campaign, since, logger }) {
    let added = 0;
    let cursor = null;
    for (let page = 0; page < 500; page += 1) {
        const params = new URLSearchParams({ campaign_id: campaign.instantly_campaign_id, email_type: 'received', limit: '100' });
        if (since) params.set('min_timestamp_created', new Date(since).toISOString());
        if (cursor) params.set('starting_after', cursor);
        const body = await instantlyRequest({ apiKey, path: `/api/v2/emails?${params.toString()}` });
        await wait(EMAILS_REQUEST_SPACING_MS);

        const items = Array.isArray(body?.items) ? body.items : [];
        if (items.length) {
            const ids = items.map((e) => String(e?.id || '')).filter(Boolean);
            const { rows: known } = await pool.query(
                `SELECT reply_to_uuid FROM contact_instantly_events WHERE reply_to_uuid = ANY($1::text[])`,
                [ids]
            );
            const knownIds = new Set(known.map((r) => r.reply_to_uuid));
            for (const email of items) {
                const emailId = String(email?.id || '');
                const leadEmail = String(email?.lead || '').trim().toLowerCase();
                if (!emailId || knownIds.has(emailId) || !leadEmail) continue;
                const { rows: [contact] } = await pool.query(
                    `SELECT id FROM contacts WHERE client_id = $1 AND LOWER(email) = $2 LIMIT 1`,
                    [clientSqlId, leadEmail]
                );
                const text = typeof email?.body?.text === 'string' ? email.body.text : null;
                const inserted = await pool.query(
                    `INSERT INTO contact_instantly_events (
                        agency_id, client_id, contact_id, campaign_id, instantly_campaign_id,
                        event_type, lead_email, email_account, step, message_text, reply_text_snippet,
                        reply_to_uuid, event_timestamp, fingerprint, source, payload
                     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'cleanup_backfill', $15::jsonb)
                     ON CONFLICT (source, fingerprint) DO NOTHING`,
                    [
                        agencyId,
                        clientSqlId,
                        contact?.id ?? null,
                        campaign.campaign_id,
                        campaign.instantly_campaign_id,
                        Number(email?.is_auto_reply) === 1 ? 'auto_reply_received' : 'reply_received',
                        leadEmail,
                        email?.eaccount || null,
                        // Webhook steps are plain numbers; the emails API sends e.g. "0_0_0".
                        /^\d+$/.test(String(email?.step ?? '')) ? Number(email.step) : null,
                        text,
                        text ? text.slice(0, 500) : null,
                        emailId,
                        email?.timestamp_email || email?.timestamp_created || null,
                        crypto.createHash('sha256').update(`cleanup_backfill|${emailId}`).digest('hex'),
                        JSON.stringify({
                            id: emailId,
                            subject: email?.subject ?? null,
                            thread_id: email?.thread_id ?? null,
                            i_status: email?.i_status ?? null,
                            timestamp_email: email?.timestamp_email ?? null
                        })
                    ]
                );
                added += inserted.rowCount;
            }
        }

        cursor = body?.next_starting_after || null;
        if (!cursor || !items.length) break;
    }
    if (added) logger(`backfilled ${added} reply event(s) for campaign ${campaign.instantly_campaign_id}`);
    return added;
}

/** Candidates whose stored replies (incl. auto-replies) cover Instantly's count. */
async function splitByReplyReconcile(candidates) {
    const withReplies = candidates.filter((c) => c.email_reply_count > 0);
    if (!withReplies.length) return { ready: candidates, unreconciled: [] };
    const { rows } = await pool.query(
        `SELECT i.contact_id, i.campaign_id, COUNT(e.id)::int AS stored
         FROM jsonb_to_recordset($1::jsonb) AS i(contact_id BIGINT, campaign_id BIGINT)
         LEFT JOIN contact_instantly_events e
           ON e.contact_id = i.contact_id AND e.campaign_id = i.campaign_id
          AND e.event_type IN ('reply_received', 'auto_reply_received')
         GROUP BY 1, 2`,
        [JSON.stringify(withReplies.map((c) => ({ contact_id: c.contact_id, campaign_id: c.campaign_id })))]
    );
    const stored = new Map(rows.map((r) => [`${r.contact_id}:${r.campaign_id}`, r.stored]));
    const ready = [];
    const unreconciled = [];
    for (const c of candidates) {
        if (c.email_reply_count > 0 && (stored.get(`${c.contact_id}:${c.campaign_id}`) || 0) < c.email_reply_count) {
            unreconciled.push(c);
        } else {
            ready.push(c);
        }
    }
    return { ready, unreconciled };
}

/**
 * Delete each lead by its own id (DELETE /api/v2/leads/{id}) — never a
 * campaign-wide bulk call, so nothing outside the candidate list can go. A 404
 * means Instantly no longer has it; either way our row is marked removed.
 */
async function deleteFromInstantly({ apiKey, rows, logger }) {
    let deleted = 0;
    let alreadyGone = 0;
    const removed = [];
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
            alreadyGone += 1;
        }
        removed.push(row);
        if (removed.length % DELETE_CHUNK === 0) {
            await markRemoved(removed.slice(-DELETE_CHUNK));
        }
    }
    const tail = removed.length % DELETE_CHUNK;
    if (tail) await markRemoved(removed.slice(-tail));
    if (alreadyGone) logger(`${alreadyGone} lead(s) were already gone from Instantly`);
    return { deleted, removed };
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
        repliesBackfilled: 0,
        deleted: 0,
        instantlyReportedDeleted: 0,
        skippedUnreconciled: 0,
        byCategory: {},
        badFitLabelFound: false
    };
    try {
        const badFitStatuses = badFitStatusesFromLabels(await listInstantlyLeadLabels(instantlyKey));
        summary.badFitLabelFound = badFitStatuses.length > 0;

        const initial = await selectCleanupCandidates(pool, clientSqlId, { days, badFitStatuses });
        const campaigns = [...new Map(initial.map((r) => [r.campaign_id, {
            campaign_id: r.campaign_id,
            instantly_campaign_id: r.instantly_campaign_id
        }])).values()];
        summary.campaigns = campaigns.length;
        logger(`${initial.length} candidate lead(s) across ${campaigns.length} campaign(s)`);

        const { rows: [previous] } = await pool.query(
            `SELECT started_at FROM instantly_cleanup_runs
             WHERE client_id = $1 AND status = 'completed' AND id <> $2
             ORDER BY started_at DESC LIMIT 1`,
            [clientSqlId, run.id]
        );
        // Incremental after the first full pass; a day of overlap for late arrivals.
        const since = previous ? new Date(new Date(previous.started_at).getTime() - 24 * 3600 * 1000) : null;

        for (const campaign of campaigns) {
            // 1. Statuses, labels, counters and timestamps straight from Instantly.
            await syncClientInstantlyState({
                agencyId,
                clientSlug,
                instantlyKey,
                instantlyCampaignId: campaign.instantly_campaign_id,
                logger: (m) => logger(`[sync] ${m}`)
            });
            // 2. Replies the webhooks never delivered.
            summary.repliesBackfilled += await backfillCampaignReplies({
                apiKey: instantlyKey, agencyId, clientSqlId, campaign, since, logger
            });

            // 3. Decide from the fresh data only.
            const fresh = await selectCleanupCandidates(pool, clientSqlId, {
                days, badFitStatuses, campaignIds: [campaign.campaign_id]
            });
            const { ready, unreconciled } = await splitByReplyReconcile(fresh);
            summary.candidates += fresh.length;
            summary.skippedUnreconciled += unreconciled.length;
            if (unreconciled.length) {
                logger(`campaign ${campaign.instantly_campaign_id}: kept ${unreconciled.length} lead(s) whose replies aren't all stored`);
            }
            if (!ready.length) continue;

            // 4. Delete by exact lead id and keep our record.
            const { deleted, removed } = await deleteFromInstantly({ apiKey: instantlyKey, rows: ready, logger });
            summary.instantlyReportedDeleted += deleted;
            summary.deleted += removed.length;
            for (const r of removed) summary.byCategory[r.category] = (summary.byCategory[r.category] || 0) + 1;
        }

        await pool.query(
            `UPDATE instantly_cleanup_runs SET status = 'completed', summary = $2::jsonb, completed_at = NOW() WHERE id = $1`,
            [run.id, JSON.stringify(summary)]
        );
        await pool.query(`UPDATE clients SET instantly_cleanup_last_run_at = NOW() WHERE id = $1`, [clientSqlId]);
        logger(`deleted ${summary.deleted} lead(s); kept ${summary.skippedUnreconciled} unreconciled`);
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

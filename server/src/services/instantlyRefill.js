/**
 * Automatic refill of one Instantly campaign from the lead bank, per client
 * (opt-in on the client Info tab), so inboxes never sit idle because the
 * campaign ran out of new prospects.
 *
 * Each run:
 *   1. syncs the target campaign, so the never-contacted backlog is current
 *   2. target backlog = backlog_days × the new prospects/day the campaign's
 *      inboxes can start (sendingRunway.loadCampaignNewLeadCapacity)
 *   3. picks leads to cover the shortfall, longest-untouched first (never
 *      emailed counts as longest):
 *        - email status valid, has a name and a usable first line
 *        - the person was never bounced, unsubscribed, labelled (any label but
 *          out of office) and never replied (auto-replies aside)
 *        - nobody at the company had any of those outcomes either
 *        - nobody at the company was emailed or added to a campaign in the last
 *          cooldown_days
 *        - never in the target campaign before (same copy)
 *        - one person per company
 *   4. re-verifies emails last verified more than REVERIFY_AFTER_DAYS ago with
 *      TryKitt and writes the verdicts back to the contact; only still-valid
 *      leads are added
 *   5. adds them with the same fields as the pipeline auto-add (email, first /
 *      last name, website, personalization) and records them in
 *      contact_instantly_campaigns as upload_source 'auto_refill'
 */

import { pool } from '../config/db.js';
import { createRateLimitHooks } from '../enrichment/rateLimit.js';
import { DEFAULT_PRICING } from '../utils/pricing.js';
import { getAgencySettings, rateLimitsFromSettings } from './db/agencySettings.js';
import { runEmailVerifier } from './emailVerifier.js';
import { runInstantlySyncAndWait } from './instantlyState.js';
import {
    INSTANTLY_UPLOAD_BATCH_SIZE,
    addLeadsToInstantlyCampaign,
    getSqlCampaignId,
    trackContactsInCampaign
} from './instantlyUpload.js';
import { normalizeEmailStatus } from './leads.js';
import { refreshProviderCreditsAfterBatch } from './providerCredits.js';
import { loadCampaignNewLeadCapacity } from './sendingRunway.js';

/** Emails verified longer ago than this are checked again before re-use. */
export const REVERIFY_AFTER_DAYS = 90;
/** Scheduled runs happen at most this often per client. */
export const REFILL_MIN_INTERVAL_MS = 3 * 60 * 60 * 1000;
/** Shortfalls smaller than this wait for the next run. */
const MIN_TOP_UP = 50;
/** Upper bound per run, whatever the capacity math says. */
const MAX_ADD_PER_RUN = 6000;
/**
 * Extra candidates picked to cover emails that fail re-verification (first ER
 * run, 2026-10-28: only 560 of 1,218 stale "valid" emails came back valid).
 * Verified leads left over are fresh for the next run, so little is wasted.
 */
const REVERIFY_HEADROOM = 2;

/**
 * Instantly events that say nothing about the person's interest; any other
 * event (a reply, a label, a bounce, an unsubscribe, a meeting…) rules the
 * person and their company out.
 */
const NEUTRAL_EVENT_TYPES = [
    'email_sent',
    'email_opened',
    'email_link_clicked',
    'campaign_completed',
    'campaign_completed_for_lead_without_reply',
    'auto_reply_received',
    'lead_out_of_office',
    'account_error',
    'pop_up_lead_magnet_viewed'
];

/** How many leads a run should add. Pure; exported for tests. */
export function planRefill({ newLeadsPerDay, backlogDays, backlog }) {
    const target = Math.max(0, Math.round((Number(newLeadsPerDay) || 0) * backlogDays));
    const shortfall = Math.max(0, target - (Number(backlog) || 0));
    const need = shortfall < MIN_TOP_UP ? 0 : Math.min(shortfall, MAX_ADD_PER_RUN);
    return { target, shortfall, need };
}

/** Whether a contact's "valid" verdict is too old to trust. Pure; exported for tests. */
export function needsReverify(verifiedAt, now = new Date()) {
    if (!verifiedAt) return true;
    const at = new Date(verifiedAt).getTime();
    return !Number.isFinite(at) || now.getTime() - at > REVERIFY_AFTER_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Candidates in order, keeping those whose email is (still) valid, up to
 * `need`. `verdicts` maps lowercased email → status for re-verified ones.
 * Pure; exported for tests.
 */
export function pickLeadsToAdd(candidates, verdicts, need, now = new Date()) {
    const out = [];
    for (const row of candidates) {
        if (out.length >= need) break;
        if (!needsReverify(row.email_verify_completed_at, now)) {
            out.push(row);
        } else if (verdicts.get(String(row.email).toLowerCase()) === 'valid') {
            out.push(row);
        }
    }
    return out;
}

/** Instantly lead fields, matching the pipeline auto-add mapping. Pure; exported for tests. */
export function buildRefillLead(row) {
    const parts = String(row.full_name || '').trim().split(/\s+/);
    return {
        email: row.email,
        first_name: parts[0] || '',
        last_name: parts.length > 1 ? parts.slice(1).join(' ') : '',
        website: row.domain || '',
        personalization: row.personalization_first_line || ''
    };
}

/**
 * Eligible leads, longest-untouched first, or just their count.
 *
 * @param {import('pg').Pool | import('pg').PoolClient} db
 * @param {{ agencyId: string, clientSqlId: number, targetSqlCampaignId: number | null,
 *           cooldownDays: number, limit?: number, countOnly?: boolean }} opts
 */
export async function selectRefillCandidates(db, { agencyId, clientSqlId, targetSqlCampaignId, cooldownDays, limit = 0, countOnly = false }) {
    const params = [agencyId, clientSqlId, targetSqlCampaignId ?? null, cooldownDays, NEUTRAL_EVENT_TYPES];
    const eligible = `
        WITH membership AS (
            SELECT cic.contact_id,
                   MAX(GREATEST(cic.added_at, cic.timestamp_last_contact)) AS touched_at,
                   BOOL_OR($3::bigint IS NOT NULL AND cic.campaign_id = $3::bigint) AS in_target,
                   BOOL_OR(
                       cic.lead_status IN (-1, -2, -3)
                       OR cic.last_bounce_at IS NOT NULL
                       OR cic.last_unsubscribe_at IS NOT NULL
                       OR (cic.interest_status IS NOT NULL AND cic.interest_status <> 0)
                       OR (COALESCE(cic.email_reply_count, 0) > 0 AND cic.interest_status IS DISTINCT FROM 0)
                   ) AS bad
            FROM contact_instantly_campaigns cic
            JOIN contacts c ON c.id = cic.contact_id
            WHERE c.agency_id = $1 AND c.client_id = $2
            GROUP BY cic.contact_id
        ),
        bad_events AS (
            SELECT DISTINCT e.contact_id
            FROM contact_instantly_events e
            WHERE e.client_id = $2 AND e.contact_id IS NOT NULL
              AND e.event_type <> ALL($5::text[])
        ),
        person AS (
            SELECT c.id, c.company_id, c.email, c.email_status, c.full_name,
                   c.personalization_first_line, c.email_verify_completed_at,
                   GREATEST(c.last_contacted_at, m.touched_at) AS touched_at,
                   COALESCE(m.bad, FALSE) OR be.contact_id IS NOT NULL AS bad,
                   COALESCE(m.in_target, FALSE) AS in_target
            FROM contacts c
            LEFT JOIN membership m ON m.contact_id = c.id
            LEFT JOIN bad_events be ON be.contact_id = c.id
            WHERE c.agency_id = $1 AND c.client_id = $2
              AND c.email IS NOT NULL AND BTRIM(c.email) <> ''
        ),
        company AS (
            SELECT company_id, BOOL_OR(bad) AS bad, MAX(touched_at) AS touched_at
            FROM person
            WHERE company_id IS NOT NULL
            GROUP BY company_id
        ),
        eligible AS (
            SELECT DISTINCT ON (p.company_id)
                   p.id AS contact_id, p.email, p.full_name, p.personalization_first_line,
                   p.email_verify_completed_at, p.touched_at, co.domain_normalized AS domain
            FROM person p
            JOIN company cp ON cp.company_id = p.company_id
            JOIN companies co ON co.id = p.company_id
            WHERE p.email_status = 'valid'
              AND NOT p.bad AND NOT cp.bad AND NOT p.in_target
              AND (cp.touched_at IS NULL OR cp.touched_at < NOW() - make_interval(days => $4::int))
              AND p.full_name IS NOT NULL AND BTRIM(p.full_name) <> ''
              AND p.personalization_first_line IS NOT NULL
              AND BTRIM(p.personalization_first_line) <> ''
              AND LOWER(BTRIM(p.personalization_first_line)) <> 'invalid'
            ORDER BY p.company_id, p.touched_at ASC NULLS FIRST, p.id
        )`;
    if (countOnly) {
        const { rows: [row] } = await db.query(
            `${eligible}
             SELECT COUNT(*)::int AS total,
                    COUNT(*) FILTER (WHERE touched_at IS NULL)::int AS never_emailed,
                    MIN(touched_at) AS oldest_touch
             FROM eligible`,
            params
        );
        return row;
    }
    params.push(limit);
    const { rows } = await db.query(
        `${eligible}
         SELECT * FROM eligible
         ORDER BY touched_at ASC NULLS FIRST, contact_id
         LIMIT $6`,
        params
    );
    return rows;
}

/** Never-contacted leads currently in the campaign (what Instantly will start next). */
async function countCampaignBacklog(sqlCampaignId) {
    if (!sqlCampaignId) return 0;
    const { rows: [row] } = await pool.query(
        `SELECT COUNT(*)::int AS n
         FROM contact_instantly_campaigns
         WHERE campaign_id = $1 AND active = TRUE
           AND timestamp_last_contact IS NULL AND COALESCE(lead_status, 1) = 1`,
        [sqlCampaignId]
    );
    return row?.n || 0;
}

export async function getRefillSettings(clientSqlId) {
    const { rows: [row] } = await pool.query(
        `SELECT instantly_refill_enabled AS enabled,
                instantly_refill_campaign_id AS campaign_id,
                instantly_refill_cooldown_days AS cooldown_days,
                instantly_refill_backlog_days AS backlog_days,
                instantly_refill_last_run_at AS last_run_at
         FROM clients WHERE id = $1`,
        [clientSqlId]
    );
    return row || null;
}

export async function updateRefillSettings(clientSqlId, { enabled, campaignId, cooldownDays, backlogDays }) {
    const { rows: [row] } = await pool.query(
        `UPDATE clients SET
            instantly_refill_enabled = COALESCE($2, instantly_refill_enabled),
            instantly_refill_campaign_id = CASE WHEN $3::boolean THEN $4 ELSE instantly_refill_campaign_id END,
            instantly_refill_cooldown_days = COALESCE($5, instantly_refill_cooldown_days),
            instantly_refill_backlog_days = COALESCE($6, instantly_refill_backlog_days)
         WHERE id = $1
         RETURNING instantly_refill_enabled AS enabled,
                   instantly_refill_campaign_id AS campaign_id,
                   instantly_refill_cooldown_days AS cooldown_days,
                   instantly_refill_backlog_days AS backlog_days,
                   instantly_refill_last_run_at AS last_run_at`,
        [
            clientSqlId,
            typeof enabled === 'boolean' ? enabled : null,
            campaignId !== undefined,
            campaignId || null,
            Number.isInteger(cooldownDays) ? cooldownDays : null,
            Number.isInteger(backlogDays) ? backlogDays : null
        ]
    );
    return row || null;
}

export async function getLatestRefillRun(clientSqlId) {
    const { rows: [row] } = await pool.query(
        `SELECT id, instantly_campaign_id, trigger_source, status, summary, error, started_at, completed_at
         FROM instantly_refill_runs WHERE client_id = $1
         ORDER BY started_at DESC LIMIT 1`,
        [clientSqlId]
    );
    return row || null;
}

/** Campaigns the refill can target, active first. */
export async function listRefillCampaigns(agencyId, clientSqlId) {
    const { rows } = await pool.query(
        `SELECT instantly_campaign_id AS id, name, status
         FROM instantly_campaigns
         WHERE agency_id = $1 AND client_id = $2
         ORDER BY (status = 1) DESC NULLS LAST, name`,
        [agencyId, clientSqlId]
    );
    return rows;
}

/**
 * What a run would do right now, from our database (no sync, so the backlog
 * may lag Instantly by up to the last sync) plus live campaign capacity.
 * The eligible-pool count scans the client's whole lead bank (tens of seconds).
 */
export async function previewRefill({ agencyId, clientSqlId, instantlyKey }) {
    const settings = await getRefillSettings(clientSqlId);
    if (!settings?.campaign_id) return { settings, capacity: null, backlog: 0, plan: null, pool: null };
    const sqlCampaignId = await getSqlCampaignId(agencyId, settings.campaign_id);
    const [capacity, backlog, poolStats] = await Promise.all([
        loadCampaignNewLeadCapacity({ instantlyKey, instantlyCampaignId: settings.campaign_id }),
        countCampaignBacklog(sqlCampaignId),
        selectRefillCandidates(pool, {
            agencyId,
            clientSqlId,
            targetSqlCampaignId: sqlCampaignId,
            cooldownDays: settings.cooldown_days,
            countOnly: true
        })
    ]);
    return {
        settings,
        capacity: capacity ? summarizeCapacity(capacity) : null,
        backlog,
        plan: capacity
            ? planRefill({ newLeadsPerDay: capacity.newLeadsPerDay, backlogDays: settings.backlog_days, backlog })
            : null,
        pool: poolStats
    };
}

function summarizeCapacity(row) {
    return {
        newLeadsPerDay: row.newLeadsPerDay,
        sendsPerDay: row.sendsPerDay,
        inboxes: row.inboxes,
        steps: row.steps,
        limitedBy: row.limitedBy
    };
}

/**
 * Re-verify stale emails with TryKitt (same rate limits as the pipeline) and
 * write each verdict to the contact. Throttling or running out of credits
 * keeps what was verified so far; the rest just aren't added this run.
 */
async function reverifyEmails({ agencyId, rows, logger }) {
    const verdicts = new Map();
    const stats = { checked: 0, valid: 0, invalid: 0, risky: 0, unknown: 0, cost: 0, error: null };
    if (!rows.length) return { verdicts, stats };

    const settings = await getAgencySettings(agencyId);
    const trykittKey = String(settings?.trykitt_key || '').trim();
    if (!trykittKey) {
        stats.error = 'No TryKitt key in agency settings, so stale emails were not re-verified or added.';
        return { verdicts, stats };
    }
    const contactByEmail = new Map(rows.map((r) => [String(r.email).toLowerCase(), r.contact_id]));

    try {
        const summary = await runEmailVerifier({
            candidates: rows.map((r) => ({ domain: r.domain, founder_name: r.full_name, email: r.email })),
            apiKeys: { kitt: trykittKey },
            provider: 'trykitt',
            rateLimitHooks: createRateLimitHooks({ agencyId, options: { rateLimits: rateLimitsFromSettings(settings) } }),
            pricing: DEFAULT_PRICING.stages.verification,
            onBatch: async (batch) => {
                const updates = [];
                for (const item of batch) {
                    const email = String(item.email || '').toLowerCase();
                    const status = normalizeEmailStatus(item.email_status);
                    const contactId = contactByEmail.get(email);
                    if (!contactId || !status) continue;
                    verdicts.set(email, status);
                    stats.checked += 1;
                    stats[status] = (stats[status] || 0) + 1;
                    updates.push({ id: contactId, status });
                }
                if (!updates.length) return;
                await pool.query(
                    `UPDATE contacts c
                     SET email_status = u.status,
                         email_verify_completed_at = NOW(),
                         email_verify_source = 'trykitt',
                         updated_at = NOW()
                     FROM jsonb_to_recordset($1::jsonb) AS u(id BIGINT, status TEXT)
                     WHERE c.id = u.id`,
                    [JSON.stringify(updates)]
                );
            }
        });
        stats.cost = Number(summary?.cost) || 0;
    } catch (error) {
        stats.error = String(error?.message || error).slice(0, 300);
        logger(`re-verification stopped early: ${stats.error}`);
    }
    await refreshProviderCreditsAfterBatch(agencyId, { force: Boolean(stats.error) }).catch(() => {});
    return { verdicts, stats };
}

/** Add in batches of 100; every lead sent is recorded, so it isn't picked again. */
async function addToInstantly({ instantlyKey, instantlyCampaignId, sqlCampaignId, leads, logger }) {
    const result = { sent: 0, uploaded: 0, uploadedKnown: false, failed: 0, lastError: null };
    for (let i = 0; i < leads.length; i += INSTANTLY_UPLOAD_BATCH_SIZE) {
        const chunk = leads.slice(i, i + INSTANTLY_UPLOAD_BATCH_SIZE);
        try {
            const body = await addLeadsToInstantlyCampaign({
                instantlyKey,
                campaignId: instantlyCampaignId,
                leads: chunk.map(buildRefillLead),
                skipOptions: { skip_if_in_campaign: true }
            });
            result.sent += chunk.length;
            if (Number.isFinite(Number(body?.leads_uploaded))) {
                result.uploaded += Number(body.leads_uploaded);
                result.uploadedKnown = true;
            }
            await trackContactsInCampaign({
                contactIds: chunk.map((row) => row.contact_id),
                sqlCampaignId,
                jobId: null,
                uploadSource: 'auto_refill'
            });
        } catch (error) {
            result.failed += chunk.length;
            result.lastError = error?.code === 'INSTANTLY_UNAUTHORIZED'
                ? 'Instantly rejected the API key'
                : String(error?.message || error).slice(0, 300);
            logger(`add failed: ${result.lastError}`);
            if (error?.code === 'INSTANTLY_UNAUTHORIZED') {
                result.failed += leads.length - (i + chunk.length);
                break;
            }
        }
    }
    return result;
}

/**
 * Run the refill for one client. Scheduled runs require the client to be
 * enabled; `force` (manual/scripts) ignores the toggle. `dryRun` syncs and
 * plans, re-verifies nothing, adds nothing and records no run.
 */
export async function runInstantlyRefill({
    agencyId,
    clientSqlId,
    clientSlug,
    instantlyKey,
    triggerSource = 'scheduled',
    force = false,
    dryRun = false,
    logger = () => {}
}) {
    const settings = await getRefillSettings(clientSqlId);
    if (!settings) throw new Error(`Client ${clientSqlId} not found`);
    if (!settings.enabled && !force) return { skipped: 'disabled' };
    const instantlyCampaignId = settings.campaign_id;
    if (!instantlyCampaignId) return { skipped: 'no campaign selected' };

    let run = null;
    if (!dryRun) {
        ({ rows: [run] } = await pool.query(
            `INSERT INTO instantly_refill_runs (agency_id, client_id, instantly_campaign_id, trigger_source)
             VALUES ($1, $2, $3, $4) RETURNING id, started_at`,
            [agencyId, clientSqlId, instantlyCampaignId, triggerSource]
        ));
        // Attempt time, so a failing run waits for the next interval instead of retrying hourly.
        await pool.query(`UPDATE clients SET instantly_refill_last_run_at = NOW() WHERE id = $1`, [clientSqlId]);
    }

    const summary = { campaignId: instantlyCampaignId, cooldownDays: settings.cooldown_days, backlogDays: settings.backlog_days };
    const finish = async (status, error = null) => {
        if (!run) return;
        await pool.query(
            `UPDATE instantly_refill_runs SET status = $2, summary = $3::jsonb, error = $4, completed_at = NOW() WHERE id = $1`,
            [run.id, status, JSON.stringify(summary), error]
        );
    };

    try {
        // 1. Current backlog.
        await runInstantlySyncAndWait({ agencyId, clientSlug, instantlyKey, instantlyCampaignId, logger });
        const sqlCampaignId = await getSqlCampaignId(agencyId, instantlyCampaignId);
        if (!sqlCampaignId) throw new Error(`Campaign ${instantlyCampaignId} is not synced`);

        // 2. How many to add.
        const capacity = await loadCampaignNewLeadCapacity({ instantlyKey, instantlyCampaignId });
        if (!capacity) {
            summary.skipped = 'campaign is not active';
            logger('campaign is not active; nothing to do');
            await finish('completed');
            return { runId: run?.id ?? null, summary };
        }
        Object.assign(summary, { capacity: summarizeCapacity(capacity), backlog: await countCampaignBacklog(sqlCampaignId) });
        Object.assign(summary, planRefill({
            newLeadsPerDay: capacity.newLeadsPerDay,
            backlogDays: settings.backlog_days,
            backlog: summary.backlog
        }));
        logger(`capacity ${capacity.newLeadsPerDay} new/day, backlog ${summary.backlog}, target ${summary.target}, adding ${summary.need}`);
        if (!summary.need) {
            summary.added = 0;
            await finish('completed');
            return { runId: run?.id ?? null, summary };
        }

        // 3. Who.
        const candidates = await selectRefillCandidates(pool, {
            agencyId,
            clientSqlId,
            targetSqlCampaignId: sqlCampaignId,
            cooldownDays: settings.cooldown_days,
            limit: Math.ceil(summary.need * REVERIFY_HEADROOM)
        });
        const now = new Date();
        const stale = candidates.filter((row) => needsReverify(row.email_verify_completed_at, now));
        summary.candidates = candidates.length;
        summary.staleEmails = stale.length;
        logger(`${candidates.length} candidate(s), ${stale.length} need re-verification`);
        if (dryRun) {
            summary.sample = candidates.slice(0, 10).map((row) => ({
                email: row.email,
                domain: row.domain,
                lastTouch: row.touched_at,
                verifiedAt: row.email_verify_completed_at
            }));
            return { runId: null, summary };
        }

        // 4. Re-verify stale emails.
        const { verdicts, stats } = await reverifyEmails({ agencyId, rows: stale, logger });
        summary.reverify = stats;
        const leads = pickLeadsToAdd(candidates, verdicts, summary.need, now);

        // 5. Add.
        const added = await addToInstantly({ instantlyKey, instantlyCampaignId, sqlCampaignId, leads, logger });
        summary.added = added.sent;
        summary.instantlyUploaded = added.uploadedKnown ? added.uploaded : null;
        summary.failed = added.failed;
        summary.lastError = added.lastError;
        const touches = leads.map((row) => row.touched_at).filter(Boolean).map((t) => new Date(t).getTime());
        summary.neverEmailed = leads.length - touches.length;
        summary.lastTouchRange = touches.length
            ? [new Date(Math.min(...touches)).toISOString(), new Date(Math.max(...touches)).toISOString()]
            : null;
        logger(`added ${added.sent}${added.failed ? `, ${added.failed} failed (${added.lastError})` : ''}`);

        await finish(added.failed && !added.sent ? 'failed' : 'completed', added.failed && !added.sent ? added.lastError : null);
        return { runId: run?.id ?? null, summary };
    } catch (error) {
        await finish('failed', String(error?.message || error).slice(0, 2000));
        throw error;
    }
}

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Adds leads in Instantly — local dev servers share the prod DB, so prod host only by default. */
export function isInstantlyRefillSweepEnabled(env = process.env) {
    const raw = String(env.INSTANTLY_REFILL_SWEEP_ENABLED ?? '').trim().toLowerCase();
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return env.NODE_ENV === 'production';
}

/** Clients whose refill is on, has a campaign, and is due. */
async function listDueRefillClients() {
    const { rows } = await pool.query(
        `SELECT id, agency_id, slug, instantly_key
         FROM clients
         WHERE instantly_refill_enabled = TRUE
           AND instantly_refill_campaign_id IS NOT NULL
           AND instantly_key IS NOT NULL AND BTRIM(instantly_key) <> ''
           AND (instantly_refill_last_run_at IS NULL
                OR instantly_refill_last_run_at < NOW() - make_interval(secs => $1::float8))
           AND NOT EXISTS (
               SELECT 1 FROM instantly_refill_runs r
               WHERE r.client_id = clients.id AND r.status = 'running'
                 AND r.started_at > NOW() - INTERVAL '6 hours'
           )
         ORDER BY instantly_refill_last_run_at NULLS FIRST`,
        [REFILL_MIN_INTERVAL_MS / 1000]
    );
    return rows;
}

export async function runInstantlyRefillSweep() {
    for (const client of await listDueRefillClients()) {
        const label = `${client.agency_id}/${client.slug}`;
        try {
            await runInstantlyRefill({
                agencyId: client.agency_id,
                clientSqlId: client.id,
                clientSlug: client.slug,
                instantlyKey: client.instantly_key,
                triggerSource: 'scheduled',
                logger: (m) => console.log(`[instantly-refill][${label}] ${m}`)
            });
        } catch (error) {
            // Logged in instantly_refill_runs; retried after the interval.
            console.error(`[instantly-refill][${label}] failed:`, error?.message || error);
        }
    }
}

export function startInstantlyRefillSweep() {
    if (!isInstantlyRefillSweepEnabled()) {
        console.log('[instantly-refill] sweep disabled (INSTANTLY_REFILL_SWEEP_ENABLED / NODE_ENV)');
        return () => {};
    }
    let running = false;
    const tick = async () => {
        if (running) return;
        running = true;
        try {
            await runInstantlyRefillSweep();
        } catch (error) {
            console.error('[instantly-refill] sweep failed:', error?.message || error);
        } finally {
            running = false;
        }
    };
    const initial = setTimeout(tick, 90_000);
    const interval = setInterval(tick, SWEEP_INTERVAL_MS);
    initial.unref?.();
    interval.unref?.();
    console.log(`[instantly-refill] sweep every ${Math.round(SWEEP_INTERVAL_MS / 60000)}m`);
    return () => {
        clearTimeout(initial);
        clearInterval(interval);
    };
}

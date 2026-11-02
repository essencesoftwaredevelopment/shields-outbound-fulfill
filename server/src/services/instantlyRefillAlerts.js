/**
 * ntfy alerts for the automatic Instantly refill, on the client's ntfy topic.
 *
 * After every recorded run (services/instantlyRefill.js) the outcome is turned
 * into issues — the known failure modes below, plus a catch-all for any failed
 * run or error that matches none of them — and an hourly watchdog catches runs
 * that hang or stop happening at all.
 *
 *   run issues (re-evaluated, and cleared, by every run)
 *     lead_limit           Instantly workspace lead allowance is full
 *     instantly_auth       Instantly rejected the client's API key
 *     instantly_rate_limit Instantly kept answering 429
 *     sync_failed          the Instantly sync before the run failed
 *     campaign_missing     the target campaign isn't in our synced data
 *     campaign_inactive    the target campaign isn't active in Instantly
 *     trykitt_credits      TryKitt out of credits, stale emails not re-verified
 *     trykitt_key          no TryKitt key, stale emails not re-verified
 *     reverify_failed      re-verification stopped for another reason
 *     pool_exhausted       not enough eligible leads to cover the shortfall
 *     low_backlog          under LOW_BACKLOG_DAYS of new prospects left after the run
 *     pool_low             eligible lead bank covers under POOL_LOW_DAYS of sending
 *     cleanup_off          lead cleanup is off, so the workspace will fill up
 *     unknown              catch-all: anything else that failed
 *   watchdog issues (re-evaluated, and cleared, by the hourly sweep)
 *     run_stuck            a run has been "running" for over STUCK_AFTER_MS
 *     not_running          no run started for over SILENT_AFTER_MS
 *
 * An issue is sent when it first appears, re-sent while it persists every
 * REPEAT_MS[severity], and a "resolved" message goes out when it clears. State
 * lives in clients.instantly_refill_alerts (migration 0074). Alerting is best
 * effort: it never fails or delays a refill.
 */

import { pool } from '../config/db.js';
import { getPublicAppBaseUrl } from './interestedAutoResponder.js';

export const LOW_BACKLOG_DAYS = 1;
export const POOL_LOW_DAYS = 3;
export const STUCK_AFTER_MS = 60 * 60 * 1000;
export const SILENT_AFTER_MS = 8 * 60 * 60 * 1000;
export const REPEAT_MS = { critical: 12 * 60 * 60 * 1000, warning: 24 * 60 * 60 * 1000 };

const n = (value) => Math.round(Number(value) || 0).toLocaleString('en-US');
const days = (value) => (value < 10 ? value.toFixed(1) : String(Math.round(value)));

/** One issue: key, severity, headline (title), detail and fix (body). */
function issue(key, severity, headline, detail, fix) {
    return { key, severity, headline, detail, fix };
}

/**
 * Known failure mode of an error message, or the catch-all. `partial` = some
 * leads were still added. Pure; exported for tests.
 */
export function classifyRefillError(message, { partial = false } = {}) {
    const text = String(message || '').trim();
    const raw = text.slice(0, 300) || 'no error message';
    const lead = partial ? 'Some leads could not be added. ' : '';
    const limit = text.match(/lead limit reached[^0-9]*(\d+)/i);
    if (/lead limit reached/i.test(text)) {
        return issue(
            'lead_limit',
            'critical',
            'Instantly workspace is full',
            `${lead}Instantly refused new leads: lead limit reached${limit ? ` (remaining uploads: ${limit[1]})` : ''}.`,
            'Make sure Instantly lead cleanup is on for this client (Info tab) so finished leads are deleted, or raise the Instantly plan\'s lead limit.'
        );
    }
    if (/rejected the API key|unauthori[sz]ed|\b401\b/i.test(text)) {
        return issue(
            'instantly_auth',
            'critical',
            'Instantly rejected the API key',
            `${lead}${raw}`,
            'Update the client\'s Instantly API key on the Info tab.'
        );
    }
    if (/\b429\b|rate.?limit|too many requests/i.test(text)) {
        return issue(
            'instantly_rate_limit',
            'warning',
            'Instantly is rate-limiting the refill',
            `${lead}${raw}`,
            'Usually clears by itself on the next run; if it keeps happening, check other jobs using this Instantly key.'
        );
    }
    if (/sync did not complete|instantly sync/i.test(text)) {
        return issue(
            'sync_failed',
            'critical',
            'Instantly sync failed, refill skipped',
            raw,
            'Run a sync from the Info tab; if it fails too, check the Instantly API key and the server logs.'
        );
    }
    if (/is not synced/i.test(text)) {
        return issue(
            'campaign_missing',
            'critical',
            'Refill campaign not found',
            raw,
            'The campaign may have been deleted or moved in Instantly. Pick the campaign again on the Info tab.'
        );
    }
    return issue(
        'unknown',
        'critical',
        partial ? 'Refill could not add every lead' : 'Refill failed',
        `${lead}${raw}`,
        'Check the refill card on the Info tab and the server logs ([instantly-refill]).'
    );
}

/**
 * Issues for one recorded run. `summary` is instantly_refill_runs.summary;
 * `error` its error column (failed runs). Pure; exported for tests.
 */
export function detectRefillIssues({ status, error = null, summary = {}, cleanupEnabled = true }) {
    const issues = [];
    const s = summary || {};
    const need = Number(s.need) || 0;
    const added = Number(s.added) || 0;
    const perDay = Number(s.capacity?.newLeadsPerDay) || 0;

    if (status === 'failed' || error) {
        issues.push(classifyRefillError(error || s.lastError));
    } else if (Number(s.failed) > 0) {
        issues.push(classifyRefillError(s.lastError, { partial: added > 0 }));
    }

    if (s.skipped === 'campaign is not active') {
        issues.push(issue(
            'campaign_inactive',
            'critical',
            'Refill campaign is not active',
            'The target campaign is paused, completed or a draft in Instantly, so it is not starting new prospects and nothing was added.',
            'Resume the campaign in Instantly, or pick the active campaign on the Info tab.'
        ));
    }

    const reverifyError = String(s.reverify?.error || '');
    if (reverifyError && !/timed out on \d+ of/i.test(reverifyError)) {
        if (/credit/i.test(reverifyError)) {
            issues.push(issue(
                'trykitt_credits',
                'critical',
                'TryKitt is out of credits',
                'Emails last verified over 90 days ago could not be re-verified, so they were not added.',
                'Top up TryKitt credits; the next run re-verifies the rest.'
            ));
        } else if (/no trykitt key/i.test(reverifyError)) {
            issues.push(issue(
                'trykitt_key',
                'critical',
                'No TryKitt key for re-verification',
                reverifyError,
                'Add the TryKitt key in the agency API Vault.'
            ));
        } else {
            issues.push(issue('reverify_failed', 'warning', 'Email re-verification stopped early', reverifyError.slice(0, 300),
                'Usually clears on the next run; check TryKitt if it repeats.'));
        }
    }

    const blamed = issues.some((i) => i.severity === 'critical');
    // 10% slack: a few re-verified emails failing within the 2x headroom is normal.
    if (status !== 'failed' && need > 0 && added < need * 0.9 && !blamed && !(Number(s.failed) > 0)) {
        issues.push(issue(
            'pool_exhausted',
            'critical',
            'Lead bank ran out of eligible leads',
            `Needed ${n(need)} new leads but only ${n(added)} could be added (${n(s.candidates)} eligible candidates).`,
            'Import or enrich fresh leads for this client, or shorten the cooldown on the Info tab.'
        ));
    }

    if (perDay > 0 && s.backlog != null) {
        const uploaded = s.instantlyUploaded ?? added;
        const left = ((Number(s.backlog) || 0) + (Number(uploaded) || 0)) / perDay;
        if (left < LOW_BACKLOG_DAYS) {
            issues.push(issue(
                'low_backlog',
                'critical',
                `Under ${LOW_BACKLOG_DAYS} sending day of new prospects left`,
                `The campaign has ${n((Number(s.backlog) || 0) + (Number(uploaded) || 0))} not-yet-contacted leads, ${days(left)} days at ${n(perDay)} new prospects/day.`,
                'See the other alerts for why the refill could not top it up.'
            ));
        }
    }

    if (perDay > 0 && Number.isFinite(Number(s.poolLeft))) {
        const poolDays = Number(s.poolLeft) / perDay;
        if (poolDays < POOL_LOW_DAYS) {
            issues.push(issue(
                'pool_low',
                'warning',
                `Lead bank down to ${days(poolDays)} sending days`,
                `${n(s.poolLeft)} eligible leads left for the refill at ${n(perDay)} new prospects/day.`,
                'Import or enrich fresh leads for this client soon, or shorten the cooldown on the Info tab.'
            ));
        }
    }

    if (!cleanupEnabled) {
        issues.push(issue(
            'cleanup_off',
            'warning',
            'Instantly lead cleanup is off',
            'Finished leads stay in Instantly and use up the workspace lead allowance; when it is full the refill stops (this happened 29 Oct to 2 Nov 2026).',
            'Turn on Instantly lead cleanup on the Info tab.'
        ));
    }

    return dedupeByKey(issues);
}

/**
 * Watchdog issues for one enabled client. `latestRun` = newest
 * instantly_refill_runs row (or null). Pure; exported for tests.
 */
export function detectWatchdogIssues({ latestRun, enabledSince = null, now = new Date() }) {
    const issues = [];
    const startedAt = latestRun?.started_at ? new Date(latestRun.started_at).getTime() : null;
    const t = now.getTime();
    if (latestRun?.status === 'running' && startedAt && t - startedAt > STUCK_AFTER_MS) {
        issues.push(issue(
            'run_stuck',
            'critical',
            'Refill run is stuck',
            `Run #${latestRun.id} has been running since ${new Date(startedAt).toISOString()} (normally 2-10 minutes). The server may have restarted mid-run; no new run starts until 6 hours after it began.`,
            'Check the server logs ([instantly-refill]); the next run starts automatically after the 6-hour guard.'
        ));
    }
    const since = startedAt ?? (enabledSince ? new Date(enabledSince).getTime() : null);
    if (since && t - since > SILENT_AFTER_MS) {
        issues.push(issue(
            'not_running',
            'critical',
            'Refill has not run for over 8 hours',
            `Last run started ${startedAt ? new Date(startedAt).toISOString() : 'never'}; runs normally start every 3-4 hours.`,
            'Check that the API server is up and the refill sweep is enabled (INSTANTLY_REFILL_SWEEP_ENABLED / NODE_ENV).'
        ));
    }
    return issues;
}

function dedupeByKey(issues) {
    const seen = new Set();
    return issues.filter((i) => (seen.has(i.key) ? false : seen.add(i.key)));
}

/**
 * Which alerts to send given the stored state. `scope` limits which stored
 * issues this evaluation can resolve ("run" or "watchdog"). Pure; exported for tests.
 */
export function planAlerts({ state = {}, issues, scope, now = new Date() }) {
    const t = now.getTime();
    const nextState = {};
    const send = [];
    const resolved = [];

    for (const [key, entry] of Object.entries(state || {})) {
        if ((entry?.scope || 'run') !== scope) nextState[key] = entry;
    }
    for (const item of issues) {
        const prev = state?.[item.key];
        const repeatMs = REPEAT_MS[item.severity] ?? REPEAT_MS.critical;
        const lastSent = prev?.notifiedAt ? new Date(prev.notifiedAt).getTime() : 0;
        const due = !prev || t - lastSent >= repeatMs;
        if (due) send.push({ ...item, repeat: Boolean(prev), since: prev?.since || now.toISOString() });
        nextState[item.key] = {
            since: prev?.since || now.toISOString(),
            notifiedAt: due ? now.toISOString() : prev.notifiedAt,
            headline: item.headline,
            severity: item.severity,
            scope
        };
    }
    for (const [key, entry] of Object.entries(state || {})) {
        if ((entry?.scope || 'run') === scope && !issues.some((i) => i.key === key)) {
            resolved.push({ key, headline: entry?.headline || key, since: entry?.since || null });
        }
    }
    return { send, resolved, nextState };
}

function clientInfoUrl(slug) {
    return `${getPublicAppBaseUrl()}/clients/${encodeURIComponent(String(slug))}?tab=info`;
}

/** ntfy titles go in an HTTP header, which must be Latin-1. */
const headerSafe = (text) => String(text).replace(/[^\x20-\xFF]/g, '-');

async function postNtfy(topic, { title, body, priority, tags, click }) {
    const response = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Title': headerSafe(title),
            'Tags': tags,
            'Priority': priority,
            ...(click ? { 'Click': click } : {})
        },
        body
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`ntfy refill alert failed (${response.status}): ${text || response.statusText}`);
    }
}

function formatRunLine(summary) {
    const s = summary || {};
    if (s.need == null) return null;
    const parts = [`backlog ${n(s.backlog)} of ${n(s.target)} target`, `added ${n(s.added)} of ${n(s.need)} needed`];
    if (Number.isFinite(Number(s.poolLeft))) parts.push(`${n(s.poolLeft)} eligible left in the lead bank`);
    return `Last run: ${parts.join(', ')}.`;
}

/**
 * Evaluate and send. Returns what was sent; never throws (alert failures are
 * logged and the state is left as it was, so the alert is retried next time).
 */
async function processAlerts({ clientSqlId, issues, scope, summary = null, logger = () => {} }) {
    try {
        const { rows: [client] } = await pool.query(
            `SELECT id, name, slug, ntfy_topic, instantly_refill_alerts AS state FROM clients WHERE id = $1`,
            [clientSqlId]
        );
        if (!client) return { sent: 0, resolved: 0 };
        const topic = String(client.ntfy_topic || '').trim();
        const { send, resolved, nextState } = planAlerts({ state: client.state || {}, issues, scope });
        if (!topic) {
            if (send.length) logger(`refill alerts not sent (client has no ntfy topic): ${send.map((i) => i.key).join(', ')}`);
            await saveState(clientSqlId, nextState);
            return { sent: 0, resolved: 0 };
        }
        const click = clientInfoUrl(client.slug);
        const runLine = formatRunLine(summary);
        for (const item of send) {
            await postNtfy(topic, {
                title: `${item.repeat ? 'Still: ' : ''}${item.headline} - ${client.name} refill`,
                body: [
                    item.detail,
                    `Fix: ${item.fix}`,
                    runLine,
                    item.repeat ? `Ongoing since ${item.since}.` : null,
                    `Info tab: ${click}`
                ].filter(Boolean).join('\n'),
                priority: item.severity === 'critical' ? 'high' : 'default',
                tags: item.severity === 'critical' ? 'rotating_light,inbox_tray' : 'warning,inbox_tray',
                click
            });
            logger(`ntfy alert sent: ${item.key}${item.repeat ? ' (repeat)' : ''}`);
        }
        for (const item of resolved) {
            await postNtfy(topic, {
                title: `Resolved: ${item.headline} - ${client.name} refill`,
                body: [runLine || 'The refill is no longer reporting this issue.', `Info tab: ${click}`].filter(Boolean).join('\n'),
                priority: 'low',
                tags: 'white_check_mark,inbox_tray',
                click
            });
            logger(`ntfy resolved sent: ${item.key}`);
        }
        await saveState(clientSqlId, nextState);
        return { sent: send.length, resolved: resolved.length };
    } catch (error) {
        logger(`refill alerting failed: ${error?.message || error}`);
        return { sent: 0, resolved: 0, error: String(error?.message || error) };
    }
}

async function saveState(clientSqlId, state) {
    await pool.query(`UPDATE clients SET instantly_refill_alerts = $2::jsonb WHERE id = $1`, [clientSqlId, JSON.stringify(state)]);
}

/** After a recorded run (completed or failed). */
export async function reportRefillRun({ clientSqlId, status, error = null, summary, logger }) {
    let cleanupEnabled = true;
    try {
        const { rows: [row] } = await pool.query(`SELECT instantly_cleanup_enabled FROM clients WHERE id = $1`, [clientSqlId]);
        cleanupEnabled = row?.instantly_cleanup_enabled !== false;
    } catch {
        // Unknown: don't raise cleanup_off on a failed read.
    }
    const issues = detectRefillIssues({ status, error, summary, cleanupEnabled });
    return processAlerts({ clientSqlId, issues, scope: 'run', summary, logger });
}

/** Hourly, from the refill sweep: stuck or missing runs for every enabled client. */
export async function runRefillWatchdog({ logger = () => {} } = {}) {
    const { rows } = await pool.query(
        `SELECT c.id, c.slug, c.instantly_refill_last_run_at,
                r.id AS run_id, r.status, r.started_at
         FROM clients c
         LEFT JOIN LATERAL (
             SELECT id, status, started_at FROM instantly_refill_runs
             WHERE client_id = c.id ORDER BY started_at DESC LIMIT 1
         ) r ON TRUE
         WHERE c.instantly_refill_enabled = TRUE AND c.instantly_refill_campaign_id IS NOT NULL`
    );
    for (const row of rows) {
        const latestRun = row.run_id ? { id: row.run_id, status: row.status, started_at: row.started_at } : null;
        const issues = detectWatchdogIssues({ latestRun, enabledSince: row.instantly_refill_last_run_at });
        await processAlerts({
            clientSqlId: row.id,
            issues,
            scope: 'watchdog',
            logger: (m) => logger(`[${row.slug}] ${m}`)
        });
    }
}

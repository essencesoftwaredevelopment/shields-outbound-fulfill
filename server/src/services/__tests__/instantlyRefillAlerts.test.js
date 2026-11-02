import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    REPEAT_MS,
    classifyRefillError,
    detectRefillIssues,
    detectWatchdogIssues,
    planAlerts
} from '../instantlyRefillAlerts.js';

const capacity = { steps: 3, inboxes: 405, limitedBy: 'inboxes', sendsPerDay: 7200, newLeadsPerDay: 2400 };
const LIMIT_ERROR = 'Instantly v2 API error: 403 {"statusCode":403,"error":"Forbidden","message":"Lead limit reached. Reamining uploads: 0."}';
const keys = (issues) => issues.map((i) => i.key).sort();

describe('classifyRefillError', () => {
    it('recognises the known failure modes', () => {
        assert.equal(classifyRefillError(LIMIT_ERROR).key, 'lead_limit');
        assert.match(classifyRefillError(LIMIT_ERROR).detail, /remaining uploads: 0/);
        assert.equal(classifyRefillError('Instantly rejected the API key').key, 'instantly_auth');
        assert.equal(classifyRefillError('Instantly v2 API error: 429 Too Many Requests').key, 'instantly_rate_limit');
        assert.equal(classifyRefillError('Instantly sync did not complete (failed: timeout)').key, 'sync_failed');
        assert.equal(classifyRefillError('Campaign 55dc is not synced').key, 'campaign_missing');
    });

    it('falls back to the catch-all with the raw message', () => {
        const result = classifyRefillError('relation "contacts" does not exist');
        assert.equal(result.key, 'unknown');
        assert.equal(result.severity, 'critical');
        assert.match(result.detail, /relation "contacts" does not exist/);
        assert.equal(classifyRefillError('').key, 'unknown');
    });
});

describe('detectRefillIssues', () => {
    it('flags the 29 Oct - 2 Nov outage: workspace full, backlog low, cleanup off', () => {
        const summary = { need: 3800, added: 0, failed: 3800, target: 4800, backlog: 1000, capacity, lastError: LIMIT_ERROR, reverify: { error: null } };
        const issues = detectRefillIssues({ status: 'failed', error: LIMIT_ERROR, summary, cleanupEnabled: false });
        assert.deepEqual(keys(issues), ['cleanup_off', 'lead_limit', 'low_backlog']);
    });

    it('stays quiet on a healthy run with a deep lead bank', () => {
        const summary = { need: 3800, added: 3800, failed: 0, target: 4800, backlog: 1000, capacity, instantlyUploaded: 3797, poolLeft: 20000, reverify: { error: null } };
        assert.deepEqual(detectRefillIssues({ status: 'completed', summary }), []);
    });

    it('warns when the lead bank covers under three sending days', () => {
        const summary = { need: 3800, added: 3800, backlog: 1000, capacity, poolLeft: 6700 };
        const issues = detectRefillIssues({ status: 'completed', summary });
        assert.deepEqual(keys(issues), ['pool_low']);
        assert.match(issues[0].headline, /2\.8 sending days/);
    });

    it('a partial lead-limit failure is still the lead-limit issue', () => {
        const summary = { need: 3835, added: 35, failed: 3800, backlog: 965, capacity, lastError: LIMIT_ERROR.replace('0.', '35.') };
        const issues = detectRefillIssues({ status: 'completed', summary });
        assert.ok(keys(issues).includes('lead_limit'));
        assert.ok(!keys(issues).includes('pool_exhausted'));
    });

    it('blames TryKitt, not the lead bank, when credits ran out', () => {
        const summary = {
            need: 3800, added: 900, failed: 0, backlog: 2000, capacity,
            reverify: { error: 'TryKitt is out of credits — add credits and resume the job to finish email verification.' }
        };
        assert.deepEqual(keys(detectRefillIssues({ status: 'completed', summary })), ['trykitt_credits']);
    });

    it('ignores single TryKitt timeouts', () => {
        const summary = {
            need: 2176, added: 2176, backlog: 2624, capacity, poolLeft: 50000,
            reverify: { error: 'TryKitt timed out on 1 of 899 email verification requests (the recipients\' mail servers did not answer in time) — they were left unprocessed; resume the job to retry them.' }
        };
        assert.deepEqual(detectRefillIssues({ status: 'completed', summary }), []);
    });

    it('flags an exhausted lead bank', () => {
        const summary = { need: 3800, added: 1200, failed: 0, candidates: 1300, backlog: 4000, capacity, poolLeft: 0 };
        assert.deepEqual(keys(detectRefillIssues({ status: 'completed', summary })), ['pool_exhausted', 'pool_low']);
    });

    it('flags a paused campaign', () => {
        const issues = detectRefillIssues({ status: 'completed', summary: { skipped: 'campaign is not active' } });
        assert.deepEqual(keys(issues), ['campaign_inactive']);
    });

    it('catches any failed run, even without an error message', () => {
        assert.deepEqual(keys(detectRefillIssues({ status: 'failed', summary: {} })), ['unknown']);
    });
});

describe('detectWatchdogIssues', () => {
    const now = new Date('2026-11-02T15:00:00Z');
    it('flags a run that hangs', () => {
        const run = { id: 31, status: 'running', started_at: '2026-11-02T13:30:00Z' };
        assert.deepEqual(keys(detectWatchdogIssues({ latestRun: run, now })), ['run_stuck']);
    });

    it('flags a refill that stopped running', () => {
        const run = { id: 30, status: 'completed', started_at: '2026-11-02T05:00:00Z' };
        assert.deepEqual(keys(detectWatchdogIssues({ latestRun: run, now })), ['not_running']);
    });

    it('is quiet while runs keep coming', () => {
        const run = { id: 31, status: 'running', started_at: '2026-11-02T14:50:00Z' };
        assert.deepEqual(detectWatchdogIssues({ latestRun: run, now }), []);
    });
});

describe('planAlerts', () => {
    const now = new Date('2026-11-02T15:00:00Z');
    const leadLimit = classifyRefillError(LIMIT_ERROR);

    it('sends a new issue once, then waits for the repeat interval', () => {
        const first = planAlerts({ state: {}, issues: [leadLimit], scope: 'run', now });
        assert.equal(first.send.length, 1);
        assert.equal(first.send[0].repeat, false);

        const soon = planAlerts({ state: first.nextState, issues: [leadLimit], scope: 'run', now: new Date(now.getTime() + 4 * 3600e3) });
        assert.equal(soon.send.length, 0);

        const later = planAlerts({ state: first.nextState, issues: [leadLimit], scope: 'run', now: new Date(now.getTime() + REPEAT_MS.critical) });
        assert.equal(later.send.length, 1);
        assert.equal(later.send[0].repeat, true);
        assert.equal(later.nextState.lead_limit.since, now.toISOString());
    });

    it('resolves cleared issues of its own scope only', () => {
        const state = {
            lead_limit: { since: now.toISOString(), notifiedAt: now.toISOString(), headline: 'Instantly workspace is full', severity: 'critical', scope: 'run' },
            run_stuck: { since: now.toISOString(), notifiedAt: now.toISOString(), headline: 'Refill run is stuck', severity: 'critical', scope: 'watchdog' }
        };
        const result = planAlerts({ state, issues: [], scope: 'run', now });
        assert.deepEqual(result.resolved.map((r) => r.key), ['lead_limit']);
        assert.deepEqual(Object.keys(result.nextState), ['run_stuck']);
    });
});

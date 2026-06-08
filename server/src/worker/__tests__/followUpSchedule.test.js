/**
 * followUpSchedule.test.js
 *
 * Run: node --test src/worker/__tests__/followUpSchedule.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    parseScheduleTimes,
    msUntilNextRun,
    zonedTimeToUtcMs
} from '../followUpSchedule.js';

const DEFAULT_SCHEDULE = parseScheduleTimes('09:00,14:00');

test('parseScheduleTimes parses comma-separated HH:MM values', () => {
    assert.deepEqual(parseScheduleTimes('09:00,14:00'), [
        { hour: 9, minute: 0 },
        { hour: 14, minute: 0 }
    ]);
});

test('parseScheduleTimes rejects invalid entries', () => {
    assert.throws(() => parseScheduleTimes('09:00,bad'), /Invalid FOLLOWUP_SCHEDULE_TIMES/);
});

test('zonedTimeToUtcMs maps UTC wall clock to the same instant', () => {
    const ms = zonedTimeToUtcMs(2026, 6, 8, 9, 0, 'UTC');
    assert.equal(new Date(ms).toISOString(), '2026-06-08T09:00:00.000Z');
});

test('msUntilNextRun after worker restart waits until 09:00 UTC, not 1 hour', () => {
    const now = new Date('2026-06-08T00:51:32.977Z');
    const waitMs = msUntilNextRun(now, DEFAULT_SCHEDULE, 'UTC');
    const next = new Date(now.getTime() + waitMs);

    assert.equal(next.toISOString(), '2026-06-08T09:00:00.000Z');
    assert.notEqual(Math.round(waitMs / 1000), 3600);
});

test('msUntilNextRun before first slot picks the earlier slot today', () => {
    const now = new Date('2026-06-08T08:30:00.000Z');
    const waitMs = msUntilNextRun(now, DEFAULT_SCHEDULE, 'UTC');
    const next = new Date(now.getTime() + waitMs);

    assert.equal(next.toISOString(), '2026-06-08T09:00:00.000Z');
});

test('msUntilNextRun between slots picks the later slot today', () => {
    const now = new Date('2026-06-08T10:00:00.000Z');
    const waitMs = msUntilNextRun(now, DEFAULT_SCHEDULE, 'UTC');
    const next = new Date(now.getTime() + waitMs);

    assert.equal(next.toISOString(), '2026-06-08T14:00:00.000Z');
});

test('msUntilNextRun after last slot today picks first slot tomorrow', () => {
    const now = new Date('2026-06-08T15:00:00.000Z');
    const waitMs = msUntilNextRun(now, DEFAULT_SCHEDULE, 'UTC');
    const next = new Date(now.getTime() + waitMs);

    assert.equal(next.toISOString(), '2026-06-09T09:00:00.000Z');
});

test('msUntilNextRun respects non-UTC timezone', () => {
    const now = new Date('2026-06-08T07:00:00.000Z'); // 09:00 in Europe/Berlin (CEST)
    const waitMs = msUntilNextRun(now, DEFAULT_SCHEDULE, 'Europe/Berlin');
    const next = new Date(now.getTime() + waitMs);

    assert.equal(next.toISOString(), '2026-06-08T12:00:00.000Z'); // 14:00 Berlin
});

test('msUntilNextRun is stable regardless of server local timezone', () => {
    const now = new Date('2026-06-08T00:51:32.977Z');
    const waitMs = msUntilNextRun(now, DEFAULT_SCHEDULE, 'UTC');
    const next = new Date(now.getTime() + waitMs);

    assert.equal(next.toISOString(), '2026-06-08T09:00:00.000Z');
});

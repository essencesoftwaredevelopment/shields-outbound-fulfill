import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    deriveStageStatus,
    resolveStageDenominators,
    applyMonotonicStageCounts
} from '../reconcileStageCounts.js';

const baseStats = {
    domainPrep: { checked: 1000, processable: 1000, skipped: 0, domainCheckSkipped: false },
    founders: { processed: 500, excluded: 0, found: 400, skipped: false },
    emailDiscovery: { processed: 320, found: 280, notFound: 40, errors: 0, skipped: false },
    verification: { verified: 280, valid: 12, invalid: 8, unknown: 30, validRisky: 230, skipped: false },
    personalization: { processed: 95, personalized: 95, skipped: false }
};

describe('resolveStageDenominators', () => {
    it('chains cohort totals through the pipeline', () => {
        const d = resolveStageDenominators(baseStats, {});
        assert.equal(d.founders.total, 1000);
        assert.equal(d.emailDiscovery.total, 400);
        assert.equal(d.verification.total, 280);
        assert.equal(d.personalization.total, 242);
    });
});

describe('deriveStageStatus', () => {
    const denominators = resolveStageDenominators(baseStats, {});

    it('allows multiple running stages during a job', () => {
        assert.equal(
            deriveStageStatus('founders', baseStats, denominators, { jobRunning: true }),
            'running'
        );
        assert.equal(
            deriveStageStatus('emailDiscovery', baseStats, denominators, { jobRunning: true }),
            'running'
        );
        assert.equal(
            deriveStageStatus('verification', baseStats, denominators, { jobRunning: true }),
            'completed'
        );
        assert.equal(
            deriveStageStatus('personalization', baseStats, denominators, { jobRunning: true }),
            'running'
        );
    });

    it('marks all completed on finalize', () => {
        assert.equal(
            deriveStageStatus('founders', baseStats, denominators, { finalize: true }),
            'completed'
        );
    });

    it('treats skipped email import as completed when counts present', () => {
        const stats = {
            ...baseStats,
            emailDiscovery: { processed: 1000, found: 1000, notFound: 0, errors: 0, skipped: true }
        };
        const d = resolveStageDenominators(stats, { skipEmailFinder: true });
        assert.equal(
            deriveStageStatus('emailDiscovery', stats, d, { jobRunning: true }),
            'completed'
        );
    });
});

describe('applyMonotonicStageCounts', () => {
    it('keeps higher prior progress when a stale count would rewind', () => {
        const prior = {
            founders: {
                status: 'running',
                progress: { processed: 80 },
                summary: { processed: 80, Found: 40 }
            }
        };
        const next = {
            founders: {
                status: 'running',
                progress: { processed: 40 },
                summary: { processed: 40, Found: 20 }
            }
        };
        const merged = applyMonotonicStageCounts(prior, next);
        assert.equal(merged.founders.progress.processed, 80);
        assert.equal(merged.founders.summary.Found, 40);
    });

    it('accepts fresher higher counts', () => {
        const prior = {
            founders: {
                status: 'running',
                progress: { processed: 40 },
                summary: { processed: 40 }
            }
        };
        const next = {
            founders: {
                status: 'running',
                progress: { processed: 90 },
                summary: { processed: 90 }
            }
        };
        const merged = applyMonotonicStageCounts(prior, next);
        assert.equal(merged.founders.progress.processed, 90);
    });
});

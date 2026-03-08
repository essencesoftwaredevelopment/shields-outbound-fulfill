import test from 'node:test';
import assert from 'node:assert/strict';
import {
    choosePreferredCampaign,
    mapCsvEmailStatus,
    normalizeCampaignName,
    shouldBackfillEmailStatus
} from '../instantlyImportMerge.js';

test('normalizeCampaignName applies normalized exact matching shape', () => {
    assert.equal(
        normalizeCampaignName(' AA | Klaviyo 3,4,5 Key Places (Jan 2026) '),
        'aa klaviyo 3 4 5 key places jan 2026'
    );
});

test('choosePreferredCampaign prefers active campaign first', () => {
    const result = choosePreferredCampaign([
        { id: 'old-active', status: 1, createdAt: '2025-01-01T00:00:00.000Z' },
        { id: 'new-paused', status: 0, createdAt: '2026-01-01T00:00:00.000Z' }
    ]);
    assert.equal(result.selected?.id, 'old-active');
    assert.equal(result.resolutionReason, 'duplicate_name_resolved_active_then_newest');
});

test('choosePreferredCampaign falls back to newest when active state ties', () => {
    const result = choosePreferredCampaign([
        { id: 'older', status: 0, createdAt: '2025-01-01T00:00:00.000Z' },
        { id: 'newer', status: 0, createdAt: '2026-01-01T00:00:00.000Z' }
    ]);
    assert.equal(result.selected?.id, 'newer');
});

test('mapCsvEmailStatus maps common CSV variants to SQL-safe enum', () => {
    assert.equal(mapCsvEmailStatus('Valid'), 'valid');
    assert.equal(mapCsvEmailStatus('valid-risky'), 'risky');
    assert.equal(mapCsvEmailStatus('Undeliverable'), 'invalid');
    assert.equal(mapCsvEmailStatus('Unknown'), 'unknown');
    assert.equal(mapCsvEmailStatus('Completely custom status'), null);
});

test('shouldBackfillEmailStatus only updates empty or unknown existing status', () => {
    assert.equal(shouldBackfillEmailStatus('', 'valid'), true);
    assert.equal(shouldBackfillEmailStatus(null, 'valid'), true);
    assert.equal(shouldBackfillEmailStatus('unknown', 'valid'), true);
    assert.equal(shouldBackfillEmailStatus('valid', 'risky'), false);
    assert.equal(shouldBackfillEmailStatus('risky', null), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    computeInterestStatusChanges,
    mapInterestStatusToEventType
} from '../instantlyState.js';

test('mapInterestStatusToEventType maps interested to lead_interested', () => {
    assert.equal(mapInterestStatusToEventType(1), 'lead_interested');
    assert.equal(mapInterestStatusToEventType(-1), 'lead_not_interested');
    assert.equal(mapInterestStatusToEventType(99), null);
});

test('computeInterestStatusChanges detects transitions only', () => {
    const priorByKey = new Map([
        ['10::20', { interest_status: null }],
        ['11::20', { interest_status: 1 }],
        ['12::20', { interest_status: -1 }]
    ]);
    const snapshots = [
        { contact_id: 10, campaign_id: 20, interest_status: 1, instantly_lead_id: 'a' },
        { contact_id: 11, campaign_id: 20, interest_status: 1, instantly_lead_id: 'b' },
        { contact_id: 12, campaign_id: 20, interest_status: -1, instantly_lead_id: 'c' }
    ];

    const changes = computeInterestStatusChanges(priorByKey, snapshots);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].contact_id, 10);
    assert.equal(changes[0].previous_interest_status, null);
    assert.equal(changes[0].next_interest_status, 1);
});

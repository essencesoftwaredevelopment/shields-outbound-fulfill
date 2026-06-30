import test from 'node:test';
import assert from 'node:assert/strict';
import {
    isEligiblePostAutoresponderReplyCategory,
    leadReplyMessageAsksOrEngages
} from '../interestedAutoResponder.js';

test('isEligiblePostAutoresponderReplyCategory accepts positive and neutral while interested', () => {
    assert.equal(isEligiblePostAutoresponderReplyCategory('positive', 1), true);
    assert.equal(isEligiblePostAutoresponderReplyCategory('neutral', 1), true);
    assert.equal(isEligiblePostAutoresponderReplyCategory('other', 1), true);
});

test('isEligiblePostAutoresponderReplyCategory rejects negative or non-interested leads', () => {
    assert.equal(isEligiblePostAutoresponderReplyCategory('negative', 1), false);
    assert.equal(isEligiblePostAutoresponderReplyCategory('positive', -1), false);
    assert.equal(isEligiblePostAutoresponderReplyCategory('positive', null), false);
});

test('leadReplyMessageAsksOrEngages detects questions and substantive follow-ups', () => {
    const billFollowUp = [
        'She will not be on the call. We get these at least 30 times per week for',
        'every aspect of marketing. I cannot get her involved in this until I have',
        'an idea what it does then she decides if we wants a follow up'
    ].join('\n');

    assert.equal(leadReplyMessageAsksOrEngages('Can you send more details?'), true);
    assert.equal(leadReplyMessageAsksOrEngages(billFollowUp), true);
    assert.equal(leadReplyMessageAsksOrEngages('Thanks!'), false);
    assert.equal(leadReplyMessageAsksOrEngages('ok'), false);
});

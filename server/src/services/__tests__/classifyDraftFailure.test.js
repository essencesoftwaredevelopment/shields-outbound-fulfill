import test from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { classifyDraftFailure } from '../interestedAutoResponder.js';

const PROD_429 = '429 You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.';

test('classifies the stored OpenAI out-of-credits reason (historical rows, no error object)', () => {
    const failure = classifyDraftFailure({ status: 'generation_failed', reason: PROD_429 });
    assert.equal(failure.service, 'OpenAI');
    assert.equal(failure.kind, 'out_of_credits');
    assert.equal(failure.headline, 'OpenAI is out of credits');
    assert.match(failure.hint, /platform\.openai\.com/);
    assert.equal(failure.raw, PROD_429);
});

test('uses the SDK error code when the live error object is available', () => {
    const error = new OpenAI.APIError(429, { error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } }, 'quota', {});
    const failure = classifyDraftFailure({ status: 'generation_failed', error });
    assert.equal(failure.service, 'OpenAI');
    assert.equal(failure.kind, 'out_of_credits');
});

test('distinguishes OpenAI key, rate-limit, model and outage failures', () => {
    assert.equal(classifyDraftFailure({ reason: '401 Incorrect API key provided: sk-abc' }).kind, 'invalid_key');
    assert.equal(classifyDraftFailure({ reason: '429 Rate limit reached for gpt-5.5 in organization org-x' }).kind, 'rate_limited');
    assert.equal(classifyDraftFailure({ reason: '404 The model `gpt-9` does not exist or you do not have access to it.' }).kind, 'model_unavailable');
    assert.equal(classifyDraftFailure({ reason: '503 OpenAI service unavailable' }).kind, 'upstream_error');
    for (const reason of ['401 Incorrect API key provided: sk-abc', '503 OpenAI service unavailable']) {
        assert.equal(classifyDraftFailure({ reason }).service, 'OpenAI');
    }
});

test('names the missing OpenAI key and Instantly thread cases', () => {
    const missingKey = classifyDraftFailure({ reason: 'No OpenAI API key configured for this agency' });
    assert.equal(missingKey.service, 'OpenAI');
    assert.equal(missingKey.kind, 'missing_key');

    const thread = classifyDraftFailure({ status: 'blocked_missing_thread', reason: 'missing_thread_metadata' });
    assert.equal(thread.service, 'Instantly');
    assert.equal(thread.kind, 'missing_thread');
});

test('falls back to a generic headline for unknown errors without inventing a service', () => {
    const failure = classifyDraftFailure({ reason: 'relation "contacts" does not exist' });
    assert.equal(failure.service, null);
    assert.equal(failure.kind, 'error');
    assert.equal(failure.headline, 'Draft generation failed');
    assert.equal(classifyDraftFailure({}).raw, 'Unknown error');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFeaturesPatch, FEATURE_FLAGS, featureFlagRegistryForClient } from '../db/featureFlagRegistry.js';

test('accepts booleans, enums, numbers and nulls (unset)', () => {
    const result = validateFeaturesPatch({
        dealFlow: true,
        enrichmentRunner: 'vercel',
        headlessMinPrice: '120',
        shoppingAudit: null
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.patch, { dealFlow: true, enrichmentRunner: 'vercel', headlessMinPrice: 120, shoppingAudit: null });
});

test('rejects wrong types and unknown enum values', () => {
    const result = validateFeaturesPatch({ dealFlow: 'yes', enrichmentRunner: 'lambda', headlessMinPrice: -1 });
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 3);
});

test('object flags: coerces numbers, drops blanks, unsets when empty', () => {
    const ok = validateFeaturesPatch({ rateLimits: { serper: '30', openai: '', trykittConcurrency: 2 } });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.patch.rateLimits, { serper: 30, trykittConcurrency: 2 });

    const empty = validateFeaturesPatch({ rateLimits: { serper: '' } });
    assert.equal(empty.ok, true);
    assert.equal(empty.patch.rateLimits, null);

    const bad = validateFeaturesPatch({ rateLimits: { serper: 'lots' } });
    assert.equal(bad.ok, false);
});

test('unknown keys pass through when allowed, rejected otherwise; bad key names rejected', () => {
    assert.deepEqual(validateFeaturesPatch({ somethingNew: { a: 1 } }).patch, { somethingNew: { a: 1 } });
    assert.equal(validateFeaturesPatch({ somethingNew: 1 }, { allowUnknown: false }).ok, false);
    assert.equal(validateFeaturesPatch({ 'bad key': 1 }).ok, false);
    assert.equal(validateFeaturesPatch([]).ok, false);
});

test('registry keys are unique and every flag has a group in the client payload', () => {
    const keys = FEATURE_FLAGS.map((f) => f.key);
    assert.equal(new Set(keys).size, keys.length);
    const client = featureFlagRegistryForClient();
    const groupIds = new Set(client.groups.map((g) => g.id));
    for (const flag of client.flags) assert.ok(groupIds.has(flag.group), `${flag.key} has unknown group`);
});

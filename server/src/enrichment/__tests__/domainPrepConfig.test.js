import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldUpsertInitialDomains } from '../domainPrepConfig.js';

describe('shouldUpsertInitialDomains', () => {
    it('skips a large include-mode rerun where every domain already exists', () => {
        assert.equal(shouldUpsertInitialDomains({ total: 10996, new: 0 }, 5000), false);
    });

    it('still upserts when any domain is new, so the company row gets created', () => {
        assert.equal(shouldUpsertInitialDomains({ total: 10996, new: 12 }, 5000), true);
    });

    it('still upserts a small all-existing run so placeholder contacts can be created', () => {
        assert.equal(shouldUpsertInitialDomains({ total: 2595, new: 0 }, 5000), true);
    });

    it('skips an empty upload', () => {
        assert.equal(shouldUpsertInitialDomains({ total: 0, new: 0 }, 5000), false);
    });
});

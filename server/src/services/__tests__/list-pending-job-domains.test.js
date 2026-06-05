import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const jobsModulePath = fileURLToPath(new URL('../db/jobs.js', import.meta.url));

describe('listPendingJobDomains (large upload contract)', () => {
    it('does not cap pending domains by default', () => {
        const source = readFileSync(jobsModulePath, 'utf8');
        assert.match(
            source,
            /export async function listPendingJobDomains\(jobId, limit\)/,
            'limit must be optional with no default cap'
        );
        assert.doesNotMatch(
            source,
            /listPendingJobDomains\(jobId, limit = 10000\)/,
            'default 10k cap breaks uploads above 10,000 leads'
        );
        assert.ok(
            source.includes('Omit to return all pending domains'),
            'documents that callers must omit limit for full job cohort'
        );
    });
});

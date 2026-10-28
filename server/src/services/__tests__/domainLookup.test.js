import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    DOMAIN_ENRICHMENT_SQL,
    DOMAIN_LOOKUP_CHUNK,
    NOT_RUN_DOMAINS_SQL,
    addDomainStats,
    chunkList,
    collectExistingDomains,
    collectNotRunDomains,
    emptyDomainStats,
    existingDomainsSql,
    summarizeDomains
} from '../domainLookup.js';

describe('domain lookup chunks', () => {
    it('splits a large upload into bounded chunks without dropping rows', () => {
        const domains = Array.from({ length: 2500 }, (_, i) => `d${i}.com`);
        const chunks = chunkList(domains);
        assert.deepEqual(chunks.map((chunk) => chunk.length), [1000, 1000, 500]);
        assert.equal(chunks.flat().length, domains.length);
        assert.equal(DOMAIN_LOOKUP_CHUNK, 1000);
        assert.deepEqual(chunkList([]), []);
    });

    it('sums enrichment stats across chunks', async () => {
        const seen = [];
        const query = async (_sql, params) => {
            seen.push(params[1].length);
            return {
                rows: [{
                    existing: 2,
                    run_count: 1,
                    with_founders_count: 1,
                    with_emails_count: 0,
                    with_personalization_count: 0
                }]
            };
        };
        const domains = Array.from({ length: 1001 }, (_, i) => `d${i}.com`);
        const stats = await summarizeDomains(query, 7, domains);
        assert.deepEqual(seen, [1000, 1]);
        assert.deepEqual(stats, {
            existing: 4,
            run: 2,
            withFounders: 2,
            withEmails: 0,
            withPersonalization: 0
        });
    });

    it('unions existing domains across chunks and keeps the reaudit predicate off the modal query', async () => {
        const sqls = [];
        const query = async (sql, params) => {
            sqls.push(sql);
            return { rows: params[1].map((domain) => ({ domain_normalized: domain })) };
        };
        const existing = await collectExistingDomains(query, 3, ['a.com', 'b.com']);
        assert.deepEqual([...existing], ['a.com', 'b.com']);
        assert.equal(sqls.length, 1);
        assert.match(sqls[0], /unnest\(\$2::text\[\]\)/);
        assert.match(sqls[0], /LIMIT 1/);
        assert.doesNotMatch(sqls[0], /last_audit_at/);

        const reauditSql = existingDomainsSql({ reaudit: true });
        assert.match(reauditSql, /last_audit_at/);
        assert.match(reauditSql, /\$3::text/);
    });

    it('uses one indexed company lookup and one contact aggregate, not four EXISTS scans', () => {
        assert.match(DOMAIN_ENRICHMENT_SQL, /JOIN LATERAL/);
        assert.match(DOMAIN_ENRICHMENT_SQL, /LIMIT 1/);
        assert.match(DOMAIN_ENRICHMENT_SQL, /bool_or\(ct\.job_id IS NOT NULL\)/);
        assert.doesNotMatch(DOMAIN_ENRICHMENT_SQL, /EXISTS/);
        const totals = addDomainStats(emptyDomainStats(), null);
        assert.equal(totals.existing, 0);
    });

    it('collects not-run domains across chunks with the same company lookup as the stats', async () => {
        const seen = [];
        const query = async (sql, params) => {
            seen.push(params[1].length);
            return { rows: [{ domain_normalized: params[1][0] }] };
        };
        const domains = Array.from({ length: 1001 }, (_, i) => `d${i}.com`);
        const notRun = await collectNotRunDomains(query, 5, domains);
        assert.deepEqual(seen, [1000, 1]);
        assert.deepEqual(notRun, ['d0.com', 'd1000.com']);
        assert.match(NOT_RUN_DOMAINS_SQL, /JOIN LATERAL/);
        assert.match(NOT_RUN_DOMAINS_SQL, /LIMIT 1/);
        assert.match(NOT_RUN_DOMAINS_SQL, /ct\.job_id IS NOT NULL/);
    });
});

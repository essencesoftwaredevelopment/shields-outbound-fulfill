import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { enrichmentQueueFromJoinSql } from '../jobs.js';

const jobsModulePath = fileURLToPath(new URL('../jobs.js', import.meta.url));

describe('enrichmentQueueFromJoinSql', () => {
    it('drives from unnest(domains) when a domains param index is provided', () => {
        const sql = enrichmentQueueFromJoinSql(5);
        assert.match(sql, /FROM unnest\(\$5::text\[\]\) AS batch\(domain_normalized\)/);
        assert.match(
            sql,
            /JOIN companies co ON co\.agency_id = \$1 AND co\.domain_normalized = batch\.domain_normalized/
        );
        assert.match(
            sql,
            /JOIN job_domains jd ON jd\.job_id = \$3 AND jd\.domain_normalized = co\.domain_normalized/
        );
        assert.match(sql, /JOIN contacts c ON c\.company_id = co\.id AND c\.agency_id = \$1/);
        assert.doesNotMatch(
            sql,
            /FROM contacts c/,
            'batch-scoped path must not start at contacts (bad join order)'
        );
        assert.doesNotMatch(sql, /domain_normalized = ANY\(/);
    });

    it('keeps the legacy join order when domains are not scoped', () => {
        const sql = enrichmentQueueFromJoinSql(null);
        assert.match(sql, /^FROM contacts c/);
        assert.match(sql, /JOIN companies co ON co\.id = c\.company_id AND co\.agency_id = \$1/);
        assert.match(
            sql,
            /JOIN job_domains jd ON jd\.job_id = \$3 AND jd\.domain_normalized = co\.domain_normalized/
        );
        assert.doesNotMatch(sql, /unnest\(/);
    });

    it('uses the provided param index for unnest', () => {
        assert.match(enrichmentQueueFromJoinSql(6), /unnest\(\$6::text\[\]\)/);
        assert.match(enrichmentQueueFromJoinSql(7), /unnest\(\$7::text\[\]\)/);
    });
});

describe('enrichment queue functions (batch join-order contract)', () => {
    const source = readFileSync(jobsModulePath, 'utf8');

    for (const fn of ['getEmailFindQueue', 'getVerifyQueue', 'getPersonalizeQueue']) {
        it(`${fn} uses enrichmentQueueFromJoinSql for the FROM clause`, () => {
            // Each queue must call the shared helper (not inline FROM contacts…).
            const fnStart = source.indexOf(`export async function ${fn}(`);
            assert.ok(fnStart >= 0, `${fn} must exist`);
            const nextExport = source.indexOf('\nexport async function ', fnStart + 1);
            const body = source.slice(fnStart, nextExport === -1 ? undefined : nextExport);
            assert.match(
                body,
                /enrichmentQueueFromJoinSql\(domainsParamIndex\)/,
                `${fn} must drive FROM via enrichmentQueueFromJoinSql`
            );
            assert.doesNotMatch(
                body,
                /domain_normalized = ANY\(/,
                `${fn} must not re-add ANY() on top of unnest (duplicate filter)`
            );
            assert.match(
                body,
                /domainsParamIndex = params\.length/,
                `${fn} must pass the domains array param index into the helper`
            );
        });
    }
});

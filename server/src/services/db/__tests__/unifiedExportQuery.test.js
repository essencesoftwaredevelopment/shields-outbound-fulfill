import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { formatUnifiedCsvLine, formatMetaActiveAds, getUnifiedRowHeaders, SHOPPING_AUDIT_UNIFIED_HEADERS, STANDARD_UNIFIED_HEADERS } from '../jobs.js';

const jobsModulePath = fileURLToPath(new URL('../jobs.js', import.meta.url));
const migrationPath = fileURLToPath(
    new URL('../../../../migrations/0052_shopify_snapshots_job_domain_index.sql', import.meta.url)
);

describe('shopping-audit unified export SQL', () => {
    const source = readFileSync(jobsModulePath, 'utf8');

    it('probes shopify_snapshots with LATERAL LIMIT 1, not a correlated EXISTS', () => {
        assert.match(source, /LEFT JOIN LATERAL \(\s*SELECT true AS has_snapshot/);
        assert.match(source, /FROM shopify_snapshots ss/);
        assert.match(source, /LIMIT 1\s*\) snap_any ON true/);
        assert.doesNotMatch(
            source,
            /WHEN EXISTS \(\s*SELECT 1 FROM shopify_snapshots/
        );
        assert.match(source, /idx_shopify_snapshots_job_domain/);
    });

    it('ships the (job_id, domain_normalized) index migration', () => {
        const sql = readFileSync(migrationPath, 'utf8');
        assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_shopify_snapshots_job_domain/);
        assert.match(sql, /ON shopify_snapshots \(job_id, domain_normalized\)/);
    });

    it('joins the Meta ad count only through the agency+domain key', () => {
        assert.match(source, /LEFT JOIN domain_meta_ads dma/);
        assert.match(source, /dma\.agency_id = c\.agency_id/);
        assert.match(source, /dma\.active_ads AS meta_active_ads/);
        assert.match(source, /jd\.meta_ads_status IS NOT NULL/);
    });
});

describe('formatUnifiedCsvLine', () => {
    it('quotes cells and doubles embedded quotes', () => {
        const line = formatUnifiedCsvLine(['domain', 'personalization'], {
            domain: 'example.com',
            personalization: 'She said "hi"'
        });
        assert.equal(line, '"example.com","She said ""hi"""');
    });

    it('emits empty quoted cells for missing keys', () => {
        const line = formatUnifiedCsvLine(SHOPPING_AUDIT_UNIFIED_HEADERS.slice(0, 3), {
            domain: 'a.com'
        });
        assert.equal(line, '"a.com","",""');
    });

    it('keeps a zero Meta ad count', () => {
        const headers = getUnifiedRowHeaders(false, true);
        assert.equal(headers.at(-1), 'meta_active_ads');
        assert.equal(headers.length, STANDARD_UNIFIED_HEADERS.length + 1);
        const line = formatUnifiedCsvLine(headers.slice(-1), {
            meta_active_ads: formatMetaActiveAds(0)
        });
        assert.equal(line, '"0"');
        assert.equal(formatMetaActiveAds(null), '');
        assert.equal(formatMetaActiveAds(12), '12');
    });

    it('leaves the standard headers unchanged when Meta ads did not run', () => {
        assert.deepEqual(getUnifiedRowHeaders(false, false), STANDARD_UNIFIED_HEADERS);
        assert.equal(getUnifiedRowHeaders(true, true).at(-1), 'meta_active_ads');
    });
});

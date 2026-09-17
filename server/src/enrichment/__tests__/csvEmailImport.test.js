import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCsvEmailRows } from '../stages/emailsBatch.js';

describe('buildCsvEmailRows (upload included email)', () => {
    const mapping = { domain: 'domain', founder: 'First Name', email: 'Email' };

    it('maps the configured email + founder columns onto emails upsert rows', () => {
        const rows = buildCsvEmailRows(
            [
                { domain_normalized: 'acme.com', raw_row: { Email: ' Jane@Acme.com ', 'First Name': 'Jane' } },
                { domain_normalized: 'beta.io', raw_row: { Email: 'bob@beta.io', 'First Name': 'Bob' } }
            ],
            mapping
        );
        assert.deepEqual(rows, [
            { domain: 'acme.com', founder_name: 'Jane', email: 'Jane@Acme.com', email_status: null },
            { domain: 'beta.io', founder_name: 'Bob', email: 'bob@beta.io', email_status: null }
        ]);
    });

    it('drops rows whose email cell is empty or "Not Found"', () => {
        const rows = buildCsvEmailRows(
            [
                { domain_normalized: 'a.com', raw_row: { Email: '', 'First Name': 'A' } },
                { domain_normalized: 'b.com', raw_row: { Email: 'not found', 'First Name': 'B' } },
                { domain_normalized: 'c.com', raw_row: null },
                { domain_normalized: 'd.com', raw_row: { Email: 'd@d.com', 'First Name': 'D' } }
            ],
            mapping
        );
        assert.deepEqual(rows, [{ domain: 'd.com', founder_name: 'D', email: 'd@d.com', email_status: null }]);
    });

    it('passes null founder_name for empty / "Not Found" founders so the upsert keeps the existing name', () => {
        const rows = buildCsvEmailRows(
            [
                { domain_normalized: 'a.com', raw_row: { Email: 'a@a.com', 'First Name': 'Not Found' } },
                { domain_normalized: 'b.com', raw_row: { Email: 'b@b.com' } }
            ],
            mapping
        );
        assert.deepEqual(rows, [
            { domain: 'a.com', founder_name: null, email: 'a@a.com', email_status: null },
            { domain: 'b.com', founder_name: null, email: 'b@b.com', email_status: null }
        ]);
    });

    it('falls back to literal email / founder_name keys when columns are unmapped (lead_filter seeds)', () => {
        const rows = buildCsvEmailRows(
            [{ domain_normalized: 'seed.com', raw_row: { domain: 'seed.com', founder_name: 'Sam', email: 'sam@seed.com', email_status: null } }],
            { domain: 'domain', founder: '', email: '' }
        );
        assert.deepEqual(rows, [{ domain: 'seed.com', founder_name: 'Sam', email: 'sam@seed.com', email_status: null }]);
        assert.deepEqual(buildCsvEmailRows([{ domain_normalized: 'x.com', raw_row: { email: 'x@x.com' } }], null), [
            { domain: 'x.com', founder_name: null, email: 'x@x.com', email_status: null }
        ]);
    });

    it('does not fall back to a stray `email` key when a different column is mapped', () => {
        const rows = buildCsvEmailRows(
            [{ domain_normalized: 'a.com', raw_row: { Email: 'mapped@a.com', email: 'stray@a.com' } }],
            mapping
        );
        assert.equal(rows[0].email, 'mapped@a.com');
    });
});

describe('buildCsvEmailRows with an email-status column', () => {
    const mapping = { domain: 'domain', founder: 'First Name', email: 'Email', emailStatus: 'Email Status' };

    it('normalizes provider labels onto contacts.email_status values', () => {
        const rows = buildCsvEmailRows(
            [
                { domain_normalized: 'a.com', raw_row: { Email: 'a@a.com', 'Email Status': 'Verified' } },
                { domain_normalized: 'b.com', raw_row: { Email: 'b@b.com', 'Email Status': 'catch-all' } },
                { domain_normalized: 'c.com', raw_row: { Email: 'c@c.com', 'Email Status': 'VALID-RISKY' } },
                { domain_normalized: 'd.com', raw_row: { Email: 'd@d.com', 'Email Status': 'bounced' } },
                { domain_normalized: 'e.com', raw_row: { Email: 'e@e.com', 'Email Status': 'something-else' } }
            ],
            mapping
        );
        assert.deepEqual(rows.map((r) => r.email_status), ['valid', 'risky', 'risky', 'invalid', 'unknown']);
    });

    it('leaves email_status null for empty cells and when no status column is mapped', () => {
        const [empty] = buildCsvEmailRows(
            [{ domain_normalized: 'a.com', raw_row: { Email: 'a@a.com', 'Email Status': '  ' } }],
            mapping
        );
        assert.equal(empty.email_status, null);
        const [unmapped] = buildCsvEmailRows(
            [{ domain_normalized: 'a.com', raw_row: { Email: 'a@a.com', 'Email Status': 'valid' } }],
            { domain: 'domain', founder: '', email: 'Email' }
        );
        assert.equal(unmapped.email_status, null);
    });
});

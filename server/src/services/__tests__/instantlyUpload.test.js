import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildInstantlyLead, normalizeSkipOptions } from '../instantlyUpload.js';

describe('buildInstantlyLead', () => {
    const row = {
        domain: 'acme.com',
        email: 'jane@acme.com',
        first_name: 'Jane',
        last_name: 'Doe',
        personalization: 'Loved the new range.',
        product_short: 'Blue Mug'
    };

    it('maps standard fields and defaults website to the domain', () => {
        const lead = buildInstantlyLead(row, {
            email: { column: 'email' },
            firstName: { column: 'first_name' },
            lastName: { column: 'last_name' },
            personalization: { column: 'personalization' }
        });
        assert.deepEqual(lead, {
            email: 'jane@acme.com',
            first_name: 'Jane',
            last_name: 'Doe',
            personalization: 'Loved the new range.',
            website: 'acme.com'
        });
    });

    it('adds custom variables and skips unmapped fields', () => {
        const lead = buildInstantlyLead(
            row,
            { email: { column: 'email' }, companyName: { column: '' } },
            [{ name: 'product', column: 'product_short' }, { name: '', column: 'domain' }]
        );
        assert.deepEqual(lead, {
            email: 'jane@acme.com',
            website: 'acme.com',
            custom_variables: { product: 'Blue Mug' }
        });
    });
});

describe('normalizeSkipOptions', () => {
    it('coerces to booleans', () => {
        assert.deepEqual(normalizeSkipOptions({ skip_if_in_workspace: 1 }), {
            skip_if_in_workspace: true,
            skip_if_in_campaign: false,
            skip_if_in_list: false
        });
    });
});

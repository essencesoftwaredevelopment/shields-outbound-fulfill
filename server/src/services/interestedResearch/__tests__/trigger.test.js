import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWorkflowStartBaseUrl } from '../trigger.js';

test('WORKFLOW_START_URL wins so local Next can stamp steps', () => {
    assert.equal(
        resolveWorkflowStartBaseUrl({
            WORKFLOW_START_URL: 'http://localhost:3000/',
            APP_URL: 'https://shields-outbound-fulfill.vercel.app'
        }),
        'http://localhost:3000'
    );
});

test('falls back to APP_URL when no start override is set', () => {
    assert.equal(
        resolveWorkflowStartBaseUrl({
            APP_URL: 'https://shields-outbound-fulfill.vercel.app/'
        }),
        'https://shields-outbound-fulfill.vercel.app'
    );
});

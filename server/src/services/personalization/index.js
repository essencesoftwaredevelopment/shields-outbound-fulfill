import fs from 'fs';
import os from 'os';
import path from 'path';
import { runPersonalization as runEcom } from './strategies/ecom.js';
import { runPersonalization as runSaas } from './strategies/saas.js';
import { runPersonalization as runAgency } from './strategies/agency.js';
import { runPersonalization as runLocal } from './strategies/local.js';
import { runPersonalization as runDefault } from './strategies/default.js';
import { runPersonalization as runShoppingAudit } from './strategies/shoppingAudit.js';

const strategies = {
    ecom: runEcom,
    saas: runSaas,
    agency: runAgency,
    local: runLocal,
    shopping_audit: runShoppingAudit,
};

function resolveStrategyKey(options) {
    return (options.industry || options.nicheId || '').toLowerCase();
}

export function runPersonalization(options) {
    const key = resolveStrategyKey(options);
    const handler = strategies[key] || runDefault;
    return handler(options);
}

/**
 * Row-based personalization entry (Vercel workflow batches).
 * Writes a short-lived temp CSV then delegates to the strategy handler.
 */
export async function runPersonalizationFromRows(options) {
    const { rows = [], ...rest } = options;
    if (!rows.length) {
        return { processed: 0, personalized: 0, skipped: true };
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'personalize-rows-'));
    const inputCsv = path.join(tmpDir, 'input.csv');
    const outputCsv = path.join(tmpDir, 'output.csv');
    const writer = fs.createWriteStream(inputCsv);
    writer.write('domain,founder_name,email,email_status\n');
    for (const row of rows) {
        const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
        writer.write(
            `${esc(row.domain)},${esc(row.founder_name)},${esc(row.email)},${esc(row.email_status)}\n`
        );
    }
    writer.end();
    await new Promise((resolve) => writer.on('finish', resolve));

    const key = resolveStrategyKey(rest);
    const handler = strategies[key] || runDefault;

    try {
        return await handler({ ...rest, inputCsv, outputCsv });
    } finally {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
            // ignore
        }
    }
}

/**
 * Backfill signal_emissions.export_vars.product_short for one job.
 *
 * For jobs that ran before product_short was built inline (or with the
 * personalization stage disabled), computes humanizeProductShort() from the
 * stored export_vars.product and merges ONLY that key into export_vars.
 * Rows that already have a product_short are left untouched.
 *
 * Usage:
 *   node --env-file=../.env.local src/scripts/backfill-product-short.js <jobId>          (dry run)
 *   node --env-file=../.env.local src/scripts/backfill-product-short.js <jobId> --apply  (write)
 */

import { pool } from '../config/db.js';
import { humanizeProductShort } from '../services/shoppingAudit/utils.js';
import { updateSignalEmissionExportVars } from '../services/shoppingAudit/db.js';

const args = process.argv.slice(2);
const jobId = args.find((a) => !a.startsWith('--'));
const apply = args.includes('--apply');

if (!jobId) {
    console.error('Usage: node src/scripts/backfill-product-short.js <jobId> [--apply]');
    process.exit(1);
}

const result = await pool.query(
    `SELECT id,
            export_vars->>'product' AS product,
            export_vars->>'product_short' AS existing
     FROM signal_emissions
     WHERE job_id = $1
     ORDER BY id`,
    [jobId]
);

const rows = result.rows;
const alreadySet = rows.filter((r) => (r.existing || '').trim() !== '');
const patches = [];
let emptyProduct = 0;

for (const row of rows) {
    if ((row.existing || '').trim() !== '') continue;
    const product_short = humanizeProductShort(row.product);
    if (!product_short) {
        emptyProduct += 1;
        continue;
    }
    patches.push({ id: row.id, vars: { product_short } });
}

console.log(`Job ${jobId}: ${rows.length} signal emissions`);
console.log(`  already have product_short (untouched): ${alreadySet.length}`);
console.log(`  no product title to derive from:        ${emptyProduct}`);
console.log(`  to backfill:                            ${patches.length}`);

const overLimit = patches.filter((p) => p.vars.product_short.length >= 35);
if (overLimit.length) {
    console.error(`ABORT: ${overLimit.length} computed values are >= 35 chars`);
    process.exit(1);
}

console.log('\nSample:');
for (const p of patches.slice(0, 10)) {
    const source = rows.find((r) => r.id === p.id);
    console.log(`  ${JSON.stringify(source.product?.slice(0, 60))} -> ${JSON.stringify(p.vars.product_short)}`);
}

if (!apply) {
    console.log('\nDry run — nothing written. Re-run with --apply to backfill.');
} else {
    await updateSignalEmissionExportVars(patches);
    console.log(`\nBackfilled product_short on ${patches.length} rows.`);
}

await pool.end();

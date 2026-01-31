/**
 * Backfill Job IDs for Contacts
 * 
 * Retroactively updates job_id for contacts based on a CSV mapping.
 * CSV format: email,job_id
 * or: domain,job_id
 * 
 * Usage: 
 *   node src/scripts/backfill-job-ids.js <csv-path> <mapping-type>
 * 
 * Examples:
 *   node src/scripts/backfill-job-ids.js contacts-jobs.csv email
 *   node src/scripts/backfill-job-ids.js domains-jobs.csv domain
 */

import fs from 'fs';
import { parse as csvParse } from 'csv-parse';
import { pool } from '../config/db.js';

const csvPath = process.argv[2];
const mappingType = process.argv[3] || 'email'; // 'email' or 'domain'

if (!csvPath) {
    console.error('Usage: node src/scripts/backfill-job-ids.js <csv-path> <mapping-type>');
    console.error('');
    console.error('mapping-type can be:');
    console.error('  email  - Map by email address (default)');
    console.error('  domain - Map by company domain');
    console.error('');
    console.error('CSV format for email mapping: email,job_id');
    console.error('CSV format for domain mapping: domain,job_id');
    process.exit(1);
}

if (!fs.existsSync(csvPath)) {
    console.error(`❌ File not found: ${csvPath}`);
    process.exit(1);
}

if (!['email', 'domain'].includes(mappingType)) {
    console.error(`❌ Invalid mapping type: ${mappingType}`);
    console.error('Must be "email" or "domain"');
    process.exit(1);
}

async function backfillJobIds() {
    console.log(`\n🔧 Backfilling job_id for contacts`);
    console.log(`   CSV: ${csvPath}`);
    console.log(`   Mapping by: ${mappingType}\n`);

    const rows = [];
    
    try {
        // Read CSV
        await new Promise((resolve, reject) => {
            fs.createReadStream(csvPath)
                .pipe(csvParse({ columns: true, trim: true, skip_empty_lines: true }))
                .on('data', (row) => rows.push(row))
                .on('end', resolve)
                .on('error', reject);
        });

        console.log(`📊 Found ${rows.length} rows in CSV\n`);

        if (rows.length === 0) {
            console.log('No rows to process');
            process.exit(0);
        }

        // Validate CSV format
        const firstRow = rows[0];
        const expectedKey = mappingType === 'email' ? 'email' : 'domain';
        
        if (!firstRow[expectedKey] || !firstRow.job_id) {
            console.error(`❌ Invalid CSV format. Expected columns: ${expectedKey}, job_id`);
            console.error(`   Found columns: ${Object.keys(firstRow).join(', ')}`);
            process.exit(1);
        }

        let updated = 0;
        let notFound = 0;
        let errors = 0;
        const batchSize = 100;

        // Process in batches
        for (let i = 0; i < rows.length; i += batchSize) {
            const batch = rows.slice(i, i + batchSize);
            
            console.log(`Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(rows.length / batchSize)}...`);

            for (const row of batch) {
                const identifier = row[expectedKey];
                const jobId = row.job_id;

                if (!identifier || !jobId) {
                    console.warn(`⚠️  Skipping row with missing data: ${JSON.stringify(row)}`);
                    errors++;
                    continue;
                }

                try {
                    let result;
                    
                    if (mappingType === 'email') {
                        // Update by email
                        result = await pool.query(
                            `UPDATE contacts 
                             SET job_id = $1, updated_at = now()
                             WHERE email = $2 AND job_id IS NULL
                             RETURNING id`,
                            [jobId, identifier]
                        );
                    } else {
                        // Update by domain (via company relationship)
                        result = await pool.query(
                            `UPDATE contacts 
                             SET job_id = $1, updated_at = now()
                             FROM companies
                             WHERE contacts.company_id = companies.id 
                             AND companies.domain_normalized = $2
                             AND contacts.job_id IS NULL
                             RETURNING contacts.id`,
                            [jobId, identifier.toLowerCase()]
                        );
                    }

                    if (result.rowCount > 0) {
                        updated += result.rowCount;
                    } else {
                        notFound++;
                        if (notFound <= 10) {
                            console.log(`   ℹ️  No match found for: ${identifier}`);
                        }
                    }
                } catch (err) {
                    console.error(`   ❌ Error updating ${identifier}:`, err.message);
                    errors++;
                }
            }
        }

        console.log('\n✅ Backfill complete!\n');
        console.log(`📊 Results:`);
        console.log(`   Updated: ${updated} contacts`);
        console.log(`   Not found: ${notFound} (already had job_id or don't exist)`);
        console.log(`   Errors: ${errors}\n`);

        await pool.end();
    } catch (err) {
        console.error('❌ Error:', err);
        await pool.end();
        process.exit(1);
    }
}

backfillJobIds();

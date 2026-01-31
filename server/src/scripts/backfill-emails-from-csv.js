/**
 * Backfill Emails from CSV to Database
 * 
 * Updates contacts with email and email_status from upload.csv.
 * Matches contacts by domain (via companies table).
 * 
 * Usage:
 *   node src/scripts/backfill-emails-from-csv.js <job-id>
 * 
 * Examples:
 *   node src/scripts/backfill-emails-from-csv.js 1769805274347-klzudk
 */

import fs from 'fs';
import path from 'path';
import { parse as csvParse } from 'csv-parse';
import { pool } from '../config/db.js';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const jobId = process.argv[2];

if (!jobId) {
    console.error('Usage: node src/scripts/backfill-emails-from-csv.js <job-id>');
    console.error('');
    console.error('Example:');
    console.error('  node src/scripts/backfill-emails-from-csv.js 1769805274347-klzudk');
    process.exit(1);
}

// Automatically construct path to upload.csv
const csvPath = path.join(__dirname, '../../tmp/jobs', jobId, 'upload.csv');

if (!fs.existsSync(csvPath)) {
    console.error(`❌ File not found: ${csvPath}`);
    console.error(`Make sure the job folder exists with upload.csv`);
    process.exit(1);
}

async function backfillEmails() {
    console.log(`\n🔧 Backfilling emails from CSV to database`);
    console.log(`   CSV: ${csvPath}`);
    console.log(`   Job ID: ${jobId}\n`);

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
            await pool.end();
            process.exit(0);
        }

        // Show sample of first row to verify format
        console.log('Sample first row:');
        console.log(JSON.stringify(rows[0], null, 2));
        console.log('');

        let updated = 0;
        let notFound = 0;
        let alreadySet = 0;
        let noEmail = 0;
        let errors = 0;

        // Normalize email status to match database constraints
        function normalizeEmailStatus(status) {
            if (!status) return null;
            const normalized = String(status).toLowerCase().trim();
            
            // Map to valid values: 'valid', 'invalid', 'risky', 'unknown'
            if (normalized === 'valid') return 'valid';
            if (normalized === 'invalid') return 'invalid';
            if (normalized === 'risky' || normalized === 'valid-risky') return 'risky';
            if (normalized === 'unknown') return 'unknown';
            
            // Default unknown for anything else
            return 'unknown';
        }

        // Process each row
        for (const row of rows) {
            const domain = String(row.domain || '').trim().toLowerCase();
            const email = String(row.email || '').trim();
            const rawEmailStatus = String(row.email_status || row.lookup_status || '').trim();
            const emailStatus = normalizeEmailStatus(rawEmailStatus);

            if (!domain) {
                console.warn(`⚠️  Skipping row with no domain`);
                errors++;
                continue;
            }

            if (!email || !email.includes('@')) {
                noEmail++;
                continue;
            }

            try {
                // Update contact by matching company domain
                // Use DO NOTHING on email conflict to skip duplicates
                const result = await pool.query(
                    `WITH company_match AS (
                        SELECT id FROM companies WHERE domain_normalized = $4
                     )
                     UPDATE contacts 
                     SET 
                        email = $1,
                        email_status = $2,
                        job_id = COALESCE(job_id, $3),
                        updated_at = now()
                     FROM company_match
                     WHERE contacts.company_id = company_match.id 
                     AND contacts.email IS NULL
                     AND NOT EXISTS (
                        SELECT 1 FROM contacts c2 
                        WHERE c2.client_id = contacts.client_id 
                        AND c2.email = $1
                     )
                     RETURNING contacts.id, contacts.email, contacts.email_status`,
                    [email, emailStatus, jobId, domain]
                );

                if (result.rowCount > 0) {
                    updated += result.rowCount;
                    if (updated <= 10) {
                        console.log(`✅ Updated ${domain}: ${email} (${emailStatus})`);
                    } else if (updated === 11) {
                        console.log(`... (showing first 10 only)\n`);
                    }
                } else {
                    // Check if contact exists but already has email
                    const checkResult = await pool.query(
                        `SELECT contacts.id, contacts.email 
                         FROM contacts
                         JOIN companies ON companies.id = contacts.company_id
                         WHERE companies.domain_normalized = $1`,
                        [domain]
                    );
                    
                    if (checkResult.rows.length > 0 && checkResult.rows[0].email) {
                        alreadySet++;
                    } else {
                        notFound++;
                        if (notFound <= 10) {
                            console.log(`   ℹ️  No match for: ${domain}`);
                        }
                    }
                }
            } catch (err) {
                console.error(`   ❌ Error updating ${domain}:`, err.message);
                errors++;
            }
        }

        console.log('\n✅ Backfill complete!\n');
        console.log(`📊 Results:`);
        console.log(`   Updated: ${updated} contacts`);
        console.log(`   Already had email: ${alreadySet}`);
        console.log(`   No matching contact: ${notFound}`);
        console.log(`   No email in CSV: ${noEmail}`);
        console.log(`   Errors: ${errors}\n`);

        await pool.end();
    } catch (err) {
        console.error('❌ Error:', err);
        await pool.end();
        process.exit(1);
    }
}

backfillEmails();

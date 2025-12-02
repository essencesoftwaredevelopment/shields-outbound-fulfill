import dotenv from 'dotenv';
import fs from 'fs';
import { parse } from 'csv-parse';
import fetch from 'node-fetch';
import pLimit from 'p-limit';

dotenv.config();

const API_KEY = process.env.KITT_API_KEY;

if (!API_KEY) {
    throw new Error('Missing KITT_API_KEY');
}

const CONCURRENCY = 15;
const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 1000;

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const shouldRetry = status => status === 402 || status === 429 || status >= 500;

function normalize(value) {
    return (value || '').trim();
}

async function readEmailCandidates(filePath) {
    const rows = [];
    return new Promise((resolve, reject) => {
        fs.createReadStream(filePath)
            .pipe(parse({ columns: true, trim: true }))
            .on('data', row => {
                rows.push({
                    domain: normalize(row.domain),
                    founder_name: normalize(row.founder_name),
                    email: normalize(row.email),
                    lookup_status: normalize(row.lookup_status)
                });
            })
            .on('end', () => resolve(rows))
            .on('error', reject);
    });
}

async function verifyEmail(email) {
    let attempt = 0;
    let backoff = INITIAL_BACKOFF_MS;

    while (attempt < MAX_RETRIES) {
        attempt += 1;

        try {
            const res = await fetch('https://api.trykitt.ai/job/verify_email', {
                method: 'POST',
                headers: {
                    'x-api-key': API_KEY,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    email,
                    realtime: true
                })
            });

            const text = await res.text();
            let parsed;

            try {
                parsed = JSON.parse(text);
            } catch {
                parsed = null;
            }

            const validity = parsed?.validity ?? null;

            if (!res.ok && shouldRetry(res.status) && attempt < MAX_RETRIES) {
                await wait(backoff);
                backoff *= 2;
                continue;
            }

            return {
                email,
                status: res.status,
                validity: validity ?? 'unknown',
                raw: parsed
            };
        } catch (error) {
            if (attempt >= MAX_RETRIES) {
                return {
                    email,
                    status: 'ERROR',
                    validity: `error: ${error.message}`
                };
            }
        }

        await wait(backoff);
        backoff *= 2;
    }

    return {
        email,
        status: 'ERROR',
        validity: 'max_retries_exceeded'
    };
}

function toCsvValue(value) {
    return `"${(value ?? '').toString().replace(/"/g, '""')}"`;
}

export async function runEmailVerifier({ inputCsv, outputCsv, log = () => {} }) {
    log('Verify: loading email candidates...');
    const candidates = await readEmailCandidates(inputCsv);
    log(`Verify: ${candidates.length} rows loaded.`);

    const rows = candidates.map(row => ({
        ...row,
        email_status: row.lookup_status || (row.email ? 'pending_verification' : 'email_not_found')
    }));

    const toVerify = rows
        .map((row, index) => ({ row, index }))
        .filter(item => !!item.row.email);

    const limit = pLimit(Math.min(CONCURRENCY, Math.max(1, toVerify.length)));
    const stats = { valid: 0, invalid: 0, 'valid-risky': 0, unknown: 0 };
    let completed = 0;

    if (toVerify.length === 0) {
        log('Verify: no emails to verify, skipping API calls.');
    } else {
        log(`Verify: verifying ${toVerify.length} emails with concurrency ${CONCURRENCY}...`);
    }

    const tasks = toVerify.map(item =>
        limit(async () => {
            const result = await verifyEmail(item.row.email);
            const status = result.validity || 'unknown';
            rows[item.index].email_status = status;

            if (Object.prototype.hasOwnProperty.call(stats, status)) {
                stats[status] += 1;
            } else {
                stats.unknown += 1;
            }

            completed += 1;
            const percent = toVerify.length ? ((completed / toVerify.length) * 100).toFixed(1) : '0.0';
            const progressPayload = {
                progress: {
                    stage: 'verification',
                    processed: completed,
                    total: toVerify.length,
                    stats
                }
            };
            if (completed % 10 === 0 || completed <= 5 || completed === toVerify.length) {
                log(`Verify: processed ${completed}/${toVerify.length} (${percent}%) | valid: ${stats.valid} | invalid: ${stats.invalid} | valid-risky: ${stats['valid-risky']} | unknown: ${stats.unknown}`, progressPayload);
            } else {
                log(null, progressPayload);
            }
        })
    );

    await Promise.all(tasks);

    const writer = fs.createWriteStream(outputCsv, { flags: 'w' });
    writer.write('domain,founder_name,email,email_status\n');
    rows.forEach(row => {
        writer.write(
            [
                toCsvValue(row.domain),
                toCsvValue(row.founder_name),
                toCsvValue(row.email),
                toCsvValue(row.email_status)
            ].join(',') + '\n'
        );
    });
    writer.end();
    await new Promise(res => writer.on('finish', res));

    log(`Verify: verification complete. Results written to ${outputCsv}`);

    return {
        total: rows.length,
        verified: toVerify.length,
        valid: stats.valid,
        invalid: stats.invalid,
        'valid-risky': stats['valid-risky'],
        unknown: stats.unknown,
        stats
    };
}

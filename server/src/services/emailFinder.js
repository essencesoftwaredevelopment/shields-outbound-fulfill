import dotenv from 'dotenv';
import fs from 'fs';
import { parse } from 'csv-parse';
import fetch from 'node-fetch';
import pLimit from 'p-limit';

dotenv.config();

const CONCURRENCY = 10;
const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 1000;

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const shouldRetry = status => status === 402 || status === 429 || status >= 500;

function normalize(value) {
    return (value || '').trim();
}

function needsSkip(name) {
    const lower = (name || '').toLowerCase();
    return !lower || lower === 'not found';
}

async function readFounders(filePath) {
    const founders = [];
    return new Promise((resolve, reject) => {
        fs.createReadStream(filePath)
            .pipe(parse({ columns: true, trim: true }))
            .on('data', row => {
                founders.push({
                    domain: normalize(row.domain),
                    founder_name: normalize(row.founder_name)
                });
            })
            .on('end', () => resolve(founders))
            .on('error', reject);
    });
}

function extractEmail(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const sanitize = v => {
        if (typeof v !== 'string') return null;
        const trimmed = v.trim();
        if (!trimmed) return null;
        // Treat known sentinel strings or non-address values as no email
        if (trimmed.toLowerCase() === 'no-results-found') return null;
        if (!trimmed.includes('@')) return null;
        return trimmed;
    };

    const directEmail = sanitize(payload.email) || sanitize(payload.emailAddress);
    if (directEmail) return directEmail;
    if (payload.data) {
        const de = sanitize(payload.data.email);
        if (de) return de;
        if (Array.isArray(payload.data.emails) && payload.data.emails.length) {
            const first = payload.data.emails.map(sanitize).find(e => !!e);
            if (first) return first;
        }
    }
    if (Array.isArray(payload.emails) && payload.emails.length) {
        const first = payload.emails.map(sanitize).find(e => !!e);
        if (first) return first;
    }
    if (payload.result) {
        const re = sanitize(payload.result.email);
        if (re) return re;
    }
    return null;
}

async function lookupEmail(fullName, domain, apiKey) {
    let attempt = 0;
    let backoff = INITIAL_BACKOFF_MS;
    const body = {
        fullName,
        domain,
        website: domain,
        realtime: true,
        strictNameMatches: false
    };

    while (attempt < MAX_RETRIES) {
        attempt += 1;
        try {
            const res = await fetch('https://api.trykitt.ai/job/find_email', {
                method: 'POST',
                headers: {
                    'x-api-key': apiKey,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body)
            });

            const text = await res.text();
            let parsed = null;
            try {
                parsed = text ? JSON.parse(text) : null;
            } catch {
                parsed = null;
            }

            if (!res.ok && shouldRetry(res.status) && attempt < MAX_RETRIES) {
                await wait(backoff);
                backoff *= 2;
                continue;
            }

            const email = extractEmail(parsed);
            if (!res.ok) {
                const errMsg = parsed?.message || res.statusText || 'unknown error';
                return {
                    email,
                    status: `error: ${res.status} ${errMsg}`.trim(),
                    raw: parsed
                };
            }

            const payloadStatus = parsed?.status || parsed?.result || (email ? 'found' : 'not_found');
            return {
                email,
                status: typeof payloadStatus === 'string' ? payloadStatus : (email ? 'found' : 'not_found'),
                raw: parsed
            };
        } catch (error) {
            if (attempt >= MAX_RETRIES) {
                return {
                    email: null,
                    status: `error: ${error.message}`
                };
            }
        }

        await wait(backoff);
        backoff *= 2;
    }

    return {
        email: null,
        status: 'error: max_retries_exceeded'
    };
}

function toCsvValue(value) {
    return `"${(value ?? '').toString().replace(/"/g, '""')}"`;
}

export async function runEmailFinder({ inputCsv, outputCsv, apiKeys, log = () => { } }) {
    const API_KEY = apiKeys.kitt;

    if (!API_KEY) {
        throw new Error('Missing Kitt API key');
    }
    const founders = await readFounders(inputCsv);
    const totalRows = founders.length;

    const indexedFounders = founders.map((row, index) => ({ ...row, index }));
    const eligibleFounders = indexedFounders.filter(
        row => !!row.domain && !needsSkip(row.founder_name)
    );
    const eligibleTotal = eligibleFounders.length;

    log(`Emails: ${totalRows} founders loaded | ${eligibleTotal} eligible for lookup.`);

    const limit = pLimit(CONCURRENCY);
    let completedEligible = 0;
    const stats = { Found: 0, 'Not Found': 0, Skipped: 0, errors: 0 };
    const results = new Array(totalRows);

    // Pre-fill rows that should be skipped or error out without hitting the API
    indexedFounders.forEach(row => {
        if (!row.domain) {
            stats.errors += 1;
            results[row.index] = {
                domain: row.domain,
                founder_name: row.founder_name,
                email: '',
                status: 'error: missing_domain'
            };
            return;
        }
        if (needsSkip(row.founder_name)) {
            stats.Skipped += 1;
            results[row.index] = {
                domain: row.domain,
                founder_name: row.founder_name,
                email: '',
                status: 'skipped_no_founder'
            };
        }
    });

    const tasks = eligibleFounders.map(row =>
        limit(async () => {
            const domain = row.domain;
            const founderName = row.founder_name;

            let email = '';
            let status = 'not_started';

            const lookup = await lookupEmail(founderName, domain, API_KEY);
            email = lookup.email || '';
            status = lookup.status || (email ? 'found' : 'not_found');

            // Normalize external "no-results-found" to our canonical not_found
            if (status === 'no-results-found') {
                status = 'not_found';
            }

            if (email) {
                stats['Found'] += 1;
            } else if (String(status).startsWith('error')) {
                stats.errors += 1;
            } else {
                stats['Not Found'] += 1;
            }

            completedEligible += 1;
            const progressPayload = {
                progress: {
                    stage: 'emailDiscovery',
                    processed: completedEligible,
                    total: eligibleTotal,
                    stats
                }
            };
            if (completedEligible % 10 === 0 || completedEligible <= 5 || completedEligible === eligibleTotal) {
                log(`Emails: processed ${completedEligible}/${eligibleTotal} eligible founders`, progressPayload);
            } else {
                log(null, progressPayload);
            }

            results[row.index] = {
                domain,
                founder_name: founderName,
                email,
                status
            };
        })
    );

    if (eligibleTotal === 0) {
        log('Emails: no eligible founders to process, skipping lookups.', {
            progress: {
                stage: 'emailDiscovery',
                processed: 0,
                total: 0,
                stats
            }
        });
    } else {
        await Promise.all(tasks);
    }

    const writer = fs.createWriteStream(outputCsv, { flags: 'w' });
    writer.write('domain,founder_name,email,lookup_status\n');
    results.forEach((row, index) => {
        const safeRow = row || {
            domain: founders[index]?.domain,
            founder_name: founders[index]?.founder_name,
            email: '',
            status: 'not_processed'
        };
        const rowCsv = [
            toCsvValue(safeRow.domain),
            toCsvValue(safeRow.founder_name),
            toCsvValue(safeRow.email),
            toCsvValue(safeRow.status)
        ].join(',');
        writer.write(`${rowCsv}\n`);
    });

    writer.end();
    await new Promise(res => writer.on('finish', res));

    log(`Emails: lookup finished. Results written to ${outputCsv}`);

    return {
        totalRows,
        eligible: eligibleTotal,
        processed: completedEligible,
        ...stats
    };
}

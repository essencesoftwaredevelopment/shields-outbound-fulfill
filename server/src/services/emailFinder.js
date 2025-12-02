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
    if (typeof payload.email === 'string') return payload.email;
    if (typeof payload.emailAddress === 'string') return payload.emailAddress;
    if (payload.data) {
        if (typeof payload.data.email === 'string') return payload.data.email;
        if (Array.isArray(payload.data.emails) && payload.data.emails.length) {
            const first = payload.data.emails.find(e => typeof e === 'string' && e.includes('@'));
            if (first) return first;
        }
    }
    if (Array.isArray(payload.emails) && payload.emails.length) {
        const first = payload.emails.find(e => typeof e === 'string' && e.includes('@'));
        if (first) return first;
    }
    if (payload.result && typeof payload.result.email === 'string') {
        return payload.result.email;
    }
    return null;
}

async function lookupEmail(fullName, domain) {
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
                    'x-api-key': API_KEY,
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

export async function runEmailFinder({ inputCsv, outputCsv, log = () => {} }) {
    log('Emails: loading founder results...');
    const founders = await readFounders(inputCsv);
    log(`Emails: ${founders.length} founders ready for lookup.`);

    const writer = fs.createWriteStream(outputCsv, { flags: 'w' });
    writer.write('domain,founder_name,email,lookup_status\n');

    const limit = pLimit(CONCURRENCY);
    let completed = 0;
    const stats = { found: 0, notFound: 0, skipped: 0, errors: 0 };

    const tasks = founders.map((row, idx) =>
        limit(async () => {
            const domain = row.domain;
            const founderName = row.founder_name;

            let email = '';
            let status = 'not_started';

            if (!domain) {
                status = 'error: missing_domain';
                stats.errors += 1;
            } else if (needsSkip(founderName)) {
                status = 'skipped_no_founder';
                stats.skipped += 1;
            } else {
                const lookup = await lookupEmail(founderName, domain);
                email = lookup.email || '';
                status = lookup.status || (email ? 'found' : 'not_found');

                if (email) {
                    stats.found += 1;
                } else if (String(status).startsWith('error')) {
                    stats.errors += 1;
                } else {
                    stats.notFound += 1;
                }
            }

            completed += 1;
            const progressPayload = {
                progress: {
                    stage: 'emailDiscovery',
                    processed: completed,
                    total: founders.length,
                    stats
                }
            };
            if (completed % 10 === 0 || completed <= 5) {
                log(`Emails: processed ${completed}/${founders.length}`, progressPayload);
            } else {
                log(null, progressPayload);
            }

            const rowCsv = [
                toCsvValue(domain),
                toCsvValue(founderName),
                toCsvValue(email),
                toCsvValue(status)
            ].join(',');
            writer.write(`${rowCsv}\n`);
        })
    );

    await Promise.all(tasks);

    writer.end();
    await new Promise(res => writer.on('finish', res));

    log(`Emails: lookup finished. Results written to ${outputCsv}`);

    return {
        total: founders.length,
        ...stats
    };
}

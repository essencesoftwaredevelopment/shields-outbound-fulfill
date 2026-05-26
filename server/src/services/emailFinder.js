import dotenv from 'dotenv';
import fs from 'fs';
import { parse } from 'csv-parse';
import fetch from 'node-fetch';
import pLimit from 'p-limit';
import http from 'http';
import { refreshJobControlFlags, throwIfJobStopped } from './jobControlGate.js';

dotenv.config();

const CONCURRENCY = 15;
const MAX_RETRIES = 3;
const RATE_LIMIT_MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 1000;
const RATE_LIMIT_BACKOFF_MS = 3000;
const REQUEST_TIMEOUT = 30000; // 30 second timeout

// Create HTTP agent with keep-alive to prevent ECONNRESET
const httpAgent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 10,
    timeout: REQUEST_TIMEOUT
});

// Email finding providers
const PROVIDERS = {
    TRYKITT: 'trykitt',
    SELF_HOSTED: 'self_hosted'
};

const SELF_HOSTED_VERIFY_URL = 'http://193.181.209.186:8080/v0/check_email';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const shouldRetry = status => status === 429 || status >= 500;

function normalize(value) {
    return (value || '').trim();
}

function needsSkip(name) {
    const lower = (name || '').toLowerCase();
    return !lower || lower === 'not found';
}

/**
 * Generate common email pattern variations
 * @param {string} firstName - e.g., "John"
 * @param {string} lastName - e.g., "Doe"
 * @param {string} domain - e.g., "example.com"
 * @returns {string[]} - Array of email variations to try
 */
function generateEmailVariations(firstName, lastName, domain) {
    const f = firstName.toLowerCase().trim();
    const l = lastName.toLowerCase().trim();
    const fInitial = f.charAt(0);
    const lInitial = l.charAt(0);
    
    // Common patterns from most to least common
    return [
        `${f}.${l}@${domain}`,           // john.doe@example.com (most common)
        `${f}${l}@${domain}`,             // johndoe@example.com
        `${fInitial}${l}@${domain}`,      // jdoe@example.com
        `${f}@${domain}`,                 // john@example.com
        `${l}@${domain}`,                 // doe@example.com
        `${f}_${l}@${domain}`,            // john_doe@example.com
        `${f}-${l}@${domain}`,            // john-doe@example.com
        `${l}.${f}@${domain}`,            // doe.john@example.com
        `${fInitial}.${l}@${domain}`,     // j.doe@example.com
        `${f}${lInitial}@${domain}`,      // johnd@example.com
    ].filter(email => email.includes('@')); // Safety check
}

/**
 * Parse full name into first and last name
 */
function parseFullName(fullName) {
    const parts = (fullName || '').trim().split(/\s+/);
    if (parts.length === 0) return { firstName: '', lastName: '' };
    if (parts.length === 1) return { firstName: parts[0], lastName: parts[0] };
    
    const firstName = parts[0];
    const lastName = parts[parts.length - 1];
    return { firstName, lastName };
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
    let rateLimitHits = 0;
    let backoff = INITIAL_BACKOFF_MS;
    const body = {
        fullName,
        domain,
        website: domain,
        realtime: true,
        strictNameMatches: false
    };

    const maxAttempts = MAX_RETRIES + RATE_LIMIT_MAX_RETRIES; // total ceiling

    while (attempt < maxAttempts) {
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

            // Handle 402 (rate limit) with dedicated backoff
            if (res.status === 402) {
                rateLimitHits += 1;
                if (rateLimitHits >= RATE_LIMIT_MAX_RETRIES) {
                    console.warn(`[EMAIL_FINDER] 402 rate-limited ${rateLimitHits} times for ${domain}, giving up on this row`);
                    return {
                        email: null,
                        status: 'error: rate_limited'
                    };
                }
                const rlBackoff = RATE_LIMIT_BACKOFF_MS * rateLimitHits;
                console.warn(`[EMAIL_FINDER] 402 rate-limited for ${domain}, retry ${rateLimitHits}/${RATE_LIMIT_MAX_RETRIES} in ${rlBackoff}ms`);
                await wait(rlBackoff);
                continue;
            }

            if (!res.ok && shouldRetry(res.status) && attempt < maxAttempts) {
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
            if (attempt >= maxAttempts) {
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

/**
 * Verify email using self-hosted service
 * Used for pattern enumeration approach
 */
async function verifyEmailWithSelfHosted(email) {
    const startTime = Date.now();
    let attempt = 0;
    let backoff = INITIAL_BACKOFF_MS;

    while (attempt < MAX_RETRIES) {
        attempt += 1;
        const attemptStart = Date.now();

        try {
            console.log(`[VERIFY] Email: ${email}, Attempt: ${attempt}/${MAX_RETRIES}, Elapsed: ${Date.now() - startTime}ms`);
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
            
            const res = await fetch(SELF_HOSTED_VERIFY_URL, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Connection': 'keep-alive'
                },
                body: JSON.stringify({ to_email: email }),
                agent: httpAgent,
                signal: controller.signal
            });
            
            clearTimeout(timeoutId);
            const fetchTime = Date.now() - attemptStart;
            // console.log(`[VERIFY] Request completed for ${email} in ${fetchTime}ms, status: ${res.status}`);
            // console.log(`[EMAIL FINDER DEBUG] Self-hosted verify response headers:`, Object.fromEntries(res.headers.entries()));

            if (!res.ok && shouldRetry(res.status) && attempt < MAX_RETRIES) {
                console.log(`[VERIFY] Retryable error ${res.status} for ${email}, backing off ${backoff}ms`);
                await wait(backoff);
                backoff *= 2;
                continue;
            }

            const data = await res.json();
            // console.log(`[EMAIL FINDER DEBUG] Self-hosted verify response body:`, JSON.stringify(data));
            
            const { is_reachable, smtp, misc } = data;

            const isValid = (is_reachable === 'safe' || is_reachable === 'risky') && smtp?.is_deliverable;
            const isDisposable = misc?.is_disposable;

            console.log(`[VERIFY] Result for ${email}: valid=${isValid}, reachable=${is_reachable}, disposable=${isDisposable}, totalTime=${Date.now() - startTime}ms`);
            return {
                isValid: isValid && !isDisposable,
                isReachable: is_reachable,
                isDeliverable: smtp?.is_deliverable
            };
        } catch (error) {
            const errorType = error.name === 'AbortError' ? 'timeout' : error.code || 'unknown';
            console.log(`[VERIFY] Exception on attempt ${attempt} for ${email}: ${error.message} (${errorType}), elapsed=${Date.now() - startTime}ms`);
            
            // Always retry on connection errors
            if (attempt < MAX_RETRIES && (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.name === 'AbortError' || error.code === 'ECONNREFUSED')) {
                console.log(`[VERIFY] Connection error for ${email}, retrying after ${backoff}ms`);
                await wait(backoff);
                backoff *= 2;
                continue;
            }
            
            if (attempt >= MAX_RETRIES) {
                console.log(`[VERIFY] Max retries exceeded for ${email}`);
                return { isValid: false, error: error.message };
            }
        }

        await wait(backoff);
        backoff *= 2;
    }

    console.log(`[VERIFY] Complete failure for ${email} after max retries, totalTime=${Date.now() - startTime}ms`);
    return { isValid: false, error: 'max_retries_exceeded' };
}

/**
 * Find email using self-hosted pattern enumeration + verification
 */
async function findEmailSelfHosted(fullName, domain) {
    const { firstName, lastName } = parseFullName(fullName);
    
    if (!firstName || !lastName) {
        return {
            email: null,
            status: 'error: invalid_name_format'
        };
    }

    const variations = generateEmailVariations(firstName, lastName, domain);
    
    // Try each pattern and verify
    for (const emailCandidate of variations) {
        const varStart = Date.now();
        const verification = await verifyEmailWithSelfHosted(emailCandidate);
        console.log(`[FIND] Tried ${emailCandidate} (${Date.now() - varStart}ms): ${verification.isValid ? 'FOUND' : verification.error || 'not_found'}`);
        
        if (verification.isValid) {
            return {
                email: emailCandidate,
                status: 'found'
            };
        }
    }
    
    return {
        email: null,
        status: 'not_found'
    };
}

function toCsvValue(value) {
    return `"${(value ?? '').toString().replace(/"/g, '""')}"`;
}

export async function runEmailFinder({
    inputCsv,
    outputCsv,
    founders: foundersInput = null,
    apiKeys,
    provider = PROVIDERS.TRYKITT,
    log = () => {},
    job = null,
    checkpoint = null,
    checkPaused = null,
    refreshControl = null,
    onBatch = null,
    pricing = null,
    /** Job-wide progress: already-finished lookups before this run segment. */
    progressOffset = 0,
    /** Job-wide progress: total eligible founders for the job. */
    progressTotal = null
} = {}) {
    const API_KEY = apiKeys.kitt;
    const requestCost = Number(pricing?.request_cost) || 0;

    // Validate based on provider
    if (provider === PROVIDERS.TRYKITT && !API_KEY) {
        throw new Error('Missing Kitt API key for TryKitt provider');
    }

    log(`Using email finding provider: ${provider}`);
    const founders = foundersInput || (inputCsv ? await readFounders(inputCsv) : []);
    const totalRows = founders.length;

    const indexedFounders = founders.map((row, index) => ({ ...row, index }));
    const eligibleFounders = indexedFounders.filter(
        row => !!row.domain && !needsSkip(row.founder_name)
    );
    const eligibleTotal = eligibleFounders.length;
    const jobTotal = Number.isFinite(progressTotal) && progressTotal > 0
        ? progressTotal
        : progressOffset + eligibleTotal;
    const displayProcessed = (n) => progressOffset + n;
    const displayProcessedCapped = (n) => Math.min(displayProcessed(n), jobTotal);

    log(
        progressOffset > 0
            ? `Emails: ${eligibleTotal} remaining lookup(s) (${displayProcessed(0)}/${jobTotal} done so far).`
            : eligibleTotal === totalRows
                ? `Emails: ${eligibleTotal} eligible for lookup.`
                : `Emails: ${eligibleTotal} eligible for lookup (${totalRows - eligibleTotal} skipped in batch).`
    );

    const limit = pLimit(CONCURRENCY);
    let completedEligible = 0;
    let stageCost = 0;
    const stats = { Found: 0, 'Not Found': 0, Skipped: 0, errors: 0 };
    const results = new Array(totalRows);
    const controller = new AbortController();

    // In-flight batch for incremental upserts
    const pendingBatch = [];
    let flushPromise = Promise.resolve();
    // Flush often so pause/resume can rely on email_find_completed_at in SQL.
    const BATCH_SIZE = 10;

    const flushBatch = async (force = false) => {
        if (!onBatch) return;
        if (!force && pendingBatch.length < BATCH_SIZE) return;
        const batch = pendingBatch.splice(0, pendingBatch.length);
        if (batch.length === 0) return;
        flushPromise = flushPromise.then(() => onBatch(batch));
        try {
            await flushPromise;
        } catch (err) {
            if (controller.signal.aborted) {
                log(`Emails: batch upsert after stop (${err?.message || err})`);
                return;
            }
            controller.abort();
            throw new Error(`Email batch upsert failed: ${err?.message || err}`);
        }
    };

    const flushAllPending = async () => {
        try {
            await flushBatch(true);
            await flushPromise;
        } catch (err) {
            if (controller.signal.aborted) {
                log(`Emails: final flush after stop (${err?.message || err})`);
                return;
            }
            throw err;
        }
    };

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
            // Check if already aborted
            if (controller.signal.aborted) {
                return;
            }
            // Check if paused and abort if so
            if (checkpoint) {
                try {
                    await checkpoint();
                } catch (err) {
                    if (err?.code === 'JOB_PAUSED' || err?.code === 'JOB_CANCELLED') {
                        controller.abort();
                        return;
                    }
                    throw err;
                }
            } else if (checkPaused && checkPaused()) {
                log(`Emails: paused by user at ${displayProcessed(completedEligible)}/${jobTotal}`);
                controller.abort();
                return;
            }

            const domain = row.domain;
            const founderName = row.founder_name;

            let email = '';
            let status = 'not_started';

            try {
                // Use appropriate provider
                const lookupStart = Date.now();
                let lookup;
                if (provider === PROVIDERS.SELF_HOSTED) {
                    console.log(`[EMAIL_FINDER] Starting self-hosted lookup for ${founderName} @ ${domain}`);
                    lookup = await findEmailSelfHosted(founderName, domain);
                    console.log(`[EMAIL_FINDER] Self-hosted lookup completed for ${founderName} @ ${domain} in ${Date.now() - lookupStart}ms, result: ${lookup.status}`);
                } else {
                    lookup = await lookupEmail(founderName, domain, API_KEY);
                }
                
                email = lookup.email || '';
                status = lookup.status || (email ? 'found' : 'not_found');

                // Normalize external "no-results-found" to our canonical not_found
                if (status === 'no-results-found') {
                    status = 'not_found';
                }
            } catch (error) {
                console.error(`[EMAIL_FINDER] Lookup failed for ${domain}: ${error?.message || error}`);
                status = `error: ${error?.message || 'unknown'}`;
            }

            if (controller.signal.aborted) {
                return;
            }

            if (await refreshJobControlFlags(job, refreshControl, checkPaused)) {
                controller.abort();
                return;
            }

            if (email) {
                stats['Found'] += 1;
                stageCost += requestCost;
            } else if (String(status).startsWith('error')) {
                stats.errors += 1;
            } else {
                stats['Not Found'] += 1;
            }

            completedEligible += 1;
            const costNumber = Number(stageCost.toFixed(6));
            const processedJobWide = displayProcessed(completedEligible);
            const processedForUi = displayProcessedCapped(completedEligible);
            const segmentDone = completedEligible >= eligibleTotal;
            const progressPayload = {
                progress: {
                    stage: 'emailDiscovery',
                    processed: processedForUi,
                    total: jobTotal,
                    found: stats['Found'],
                    cost: costNumber,
                    stats: {
                        ...stats,
                        Cost: `$${costNumber.toFixed(2)}`
                    }
                }
            };
            const shouldLogLine =
                completedEligible % 10 === 0
                || completedEligible <= 5
                || segmentDone;
            const cappedBeforeDone = processedForUi >= jobTotal && !segmentDone;
            if (shouldLogLine && !cappedBeforeDone) {
                log(`Emails: processed ${processedForUi}/${jobTotal} eligible founders`, progressPayload);
            } else if (!cappedBeforeDone) {
                log(null, progressPayload);
            }

            results[row.index] = {
                domain,
                founder_name: founderName,
                email,
                status
            };

            // Queue incremental upsert batch
            if (onBatch) {
                pendingBatch.push({ domain, founder_name: founderName, email, lookup_status: status, confidence: row.confidence });
                await flushBatch(false);
            }
        })
    );

    if (eligibleTotal === 0) {
        log('Emails: no eligible founders to process, skipping lookups.', {
            progress: {
                stage: 'emailDiscovery',
                processed: displayProcessed(0),
                total: jobTotal,
                found: 0,
                stats
            }
        });
    } else {
        const pauseCheckInterval = setInterval(() => {
            void (async () => {
                try {
                    const stopped = await refreshJobControlFlags(job, refreshControl, checkPaused);
                    if (stopped && !controller.signal.aborted) {
                        const reason = job?.cancelled ? 'cancelled' : 'paused';
                        log(`Emails: aborting (${reason}) at ${displayProcessedCapped(completedEligible)}/${jobTotal}`);
                        controller.abort();
                        await flushBatch(true);
                    }
                } catch (err) {
                    console.warn(`[emailFinder] pause poll failed: ${err?.message || err}`);
                }
            })();
        }, 100);

        try {
            await Promise.all(tasks);
            await flushAllPending();
            const stopped = await refreshJobControlFlags(job, refreshControl, checkPaused);
            if (stopped || controller.signal.aborted) {
                await flushAllPending();
                await throwIfJobStopped(job, refreshControl, {
                    cancelledMessage: 'Job cancelled during email discovery',
                    pausedMessage: 'Job paused during email discovery'
                });
            }
        } catch (error) {
            if (controller.signal.aborted) {
                await flushAllPending();
                await throwIfJobStopped(job, refreshControl, {
                    cancelledMessage: 'Job cancelled during email discovery',
                    pausedMessage: 'Job paused during email discovery'
                });
            }
            if (error?.code === 'JOB_PAUSED' || error?.code === 'JOB_CANCELLED') {
                await flushAllPending();
            }
            // If credit exhausted, write partial results and re-throw
            if (error.code === 'CREDIT_EXHAUSTED') {
                console.log(`[EMAIL_FINDER] Writing partial results before pausing...`);
                await flushAllPending();
                throw error; // Re-throw to propagate to runStage
            }
            throw error; // Re-throw other errors
        } finally {
            clearInterval(pauseCheckInterval);
        }
    }

    if (outputCsv) {
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
    } else {
        log('Emails: lookup finished.');
    }

    const cost = Number(stageCost.toFixed(6));
    return {
        totalRows,
        eligible: eligibleTotal,
        processed: displayProcessed(completedEligible),
        cost,
        Found: stats.Found,
        'Not Found': stats['Not Found'],
        Skipped: stats.Skipped,
        errors: stats.errors
    };
}

// Export providers for use in other modules
export { PROVIDERS };

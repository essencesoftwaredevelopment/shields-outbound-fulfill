import dotenv from 'dotenv';
import fs from 'fs';
import { parse } from 'csv-parse';
import { createConcurrencyLimit } from '../lib/concurrency.js';
import http from 'http';
import { refreshJobControlFlags, throwIfJobStopped } from './jobControlGate.js';

dotenv.config();

const CONCURRENCY = 15;
const MAX_RETRIES = 3;
const RATE_LIMIT_MAX_RETRIES = 5;
const RATE_LIMIT_BACKOFF_MS = 3000;
const INITIAL_BACKOFF_MS = 1000;
const REQUEST_TIMEOUT = 30000; // 30 second timeout
const REQUEST_TIMEOUT_MS = 20000; // 20s hard timeout per verification request

// Create HTTP agent with keep-alive to prevent ECONNRESET
const httpAgent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 10,
    timeout: REQUEST_TIMEOUT
});

// Email verification providers
const PROVIDERS = {
    TRYKITT: 'trykitt',
    SELF_HOSTED: 'self_hosted'
};

const SELF_HOSTED_URL = 'http://193.181.209.186:8080/v0/check_email';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const shouldRetry = status => status === 429 || status >= 500;

function normalize(value) {
    return (value || '').trim();
}

/**
 * Fetch with AbortController timeout to prevent hanging requests
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } catch (err) {
        if (err.name === 'AbortError') {
            throw new Error('timeout');
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
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

/**
 * Verify email using TryKitt API
 */
async function verifyEmailWithTryKitt(email, apiKey) {
    let attempt = 0;
    let rateLimitHits = 0;
    let backoff = INITIAL_BACKOFF_MS;

    const maxAttempts = MAX_RETRIES + RATE_LIMIT_MAX_RETRIES;

    while (attempt < maxAttempts) {
        attempt += 1;

        try {
            const res = await fetchWithTimeout('https://api.trykitt.ai/job/verify_email', {
                method: 'POST',
                headers: {
                    'x-api-key': apiKey,
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

            // Handle 402 (rate limit) with dedicated backoff
            if (res.status === 402) {
                rateLimitHits += 1;
                if (rateLimitHits >= RATE_LIMIT_MAX_RETRIES) {
                    console.warn(`[EMAIL_VERIFIER] 402 rate-limited ${rateLimitHits} times for ${email}, giving up on this row`);
                    return {
                        email,
                        status: 'ERROR',
                        validity: 'error: rate_limited'
                    };
                }
                const rlBackoff = RATE_LIMIT_BACKOFF_MS * rateLimitHits;
                console.warn(`[EMAIL_VERIFIER] 402 rate-limited for ${email}, retry ${rateLimitHits}/${RATE_LIMIT_MAX_RETRIES} in ${rlBackoff}ms`);
                await wait(rlBackoff);
                continue;
            }

            const validity = parsed?.validity ?? null;

            if (!res.ok && shouldRetry(res.status) && attempt < maxAttempts) {
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
            if (error.message === 'timeout') {
                return {
                    email,
                    status: 'ERROR',
                    validity: 'timeout'
                };
            }
            if (attempt >= maxAttempts) {
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

/**
 * Verify email using self-hosted service
 * Maps response format to match TryKitt format for consistency
 */
async function verifyEmailWithSelfHosted(email) {
    let attempt = 0;
    let backoff = INITIAL_BACKOFF_MS;

    while (attempt < MAX_RETRIES) {
        attempt += 1;

        try {
            const res = await fetchWithTimeout(SELF_HOSTED_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Connection': 'keep-alive'
                },
                body: JSON.stringify({
                    to_email: email
                }),
                agent: httpAgent
            });

            // Debug logging
            console.log(`[EMAIL VERIFIER DEBUG] Self-hosted verify for email: ${email}`);
            console.log(`[EMAIL VERIFIER DEBUG] Response Status: ${res.status}`);
            console.log(`[EMAIL VERIFIER DEBUG] Response Headers:`, Object.fromEntries(res.headers.entries()));

            if (!res.ok && shouldRetry(res.status) && attempt < MAX_RETRIES) {
                await wait(backoff);
                backoff *= 2;
                continue;
            }

            const data = await res.json();
            console.log(`[EMAIL VERIFIER DEBUG] Response Body:`, JSON.stringify(data));
            
            const { is_reachable, smtp, misc } = data;

            // Map self-hosted response to TryKitt format
            let validity = 'unknown';
            
            if (is_reachable === 'safe' && smtp?.is_deliverable) {
                validity = 'valid';
            } else if (is_reachable === 'risky' && smtp?.is_deliverable) {
                validity = 'valid-risky';
            } else if (smtp?.is_deliverable === false || misc?.is_disposable) {
                validity = 'invalid';
            }

            return {
                email,
                status: res.status,
                validity,
                raw: data
            };
        } catch (error) {
            const errorType = error.name === 'AbortError' ? 'timeout' : error.code || 'unknown';
            console.log(`[VERIFY] Exception on attempt ${attempt} for ${email}: ${error.message} (${errorType})`);
            
            if (error.message === 'timeout') {
                return {
                    email,
                    status: 'ERROR',
                    validity: 'timeout'
                };
            }            
            // Always retry on connection errors
            if (attempt < MAX_RETRIES && (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.name === 'AbortError' || error.code === 'ECONNREFUSED')) {
                console.log(`[VERIFY] Connection error for ${email}, retrying after ${backoff}ms`);
                await wait(backoff);
                backoff *= 2;
                continue;
            }
            
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

/**
 * Verify email using the selected provider
 */
async function verifyEmail(email, provider, apiKey = null) {
    if (provider === PROVIDERS.SELF_HOSTED) {
        return verifyEmailWithSelfHosted(email);
    } else {
        // Default to TryKitt
        if (!apiKey) {
            throw new Error('TryKitt API key required for trykitt provider');
        }
        return verifyEmailWithTryKitt(email, apiKey);
    }
}

function toCsvValue(value) {
    return `"${(value ?? '').toString().replace(/"/g, '""')}"`;
}

export async function runEmailVerifier({ inputCsv, outputCsv, candidates: candidatesInput = null, apiKeys, provider = PROVIDERS.TRYKITT, log = () => { }, job = null, checkpoint = null, checkPaused = null, refreshControl = null, onBatch = null, pricing = null } = {}) {
    const API_KEY = apiKeys.kitt;
    const requestCost = Number(pricing?.request_cost) || 0;

    // Validate based on provider
    if (provider === PROVIDERS.TRYKITT && !API_KEY) {
        throw new Error('Missing Kitt API key for TryKitt provider');
    }

    log(`Using email verification provider: ${provider}`);
    const candidates = candidatesInput || (inputCsv ? await readEmailCandidates(inputCsv) : []);

    const rows = candidates.map(row => ({
        ...row,
        email_status: row.lookup_status || (row.email ? 'pending_verification' : 'email_not_found')
    }));

    const toVerify = rows
        .map((row, index) => ({ row, index }))
        .filter(item => !!item.row.email);

    const limit = createConcurrencyLimit(Math.min(CONCURRENCY, Math.max(1, toVerify.length)));
    const stats = { valid: 0, invalid: 0, 'valid-risky': 0, unknown: 0 };
    let completed = 0;
    let stageCost = 0;
    const controller = new AbortController();

    // In-flight batch for incremental upserts
    const pendingBatch = [];
    let flushPromise = Promise.resolve();
    const BATCH_SIZE = 50;

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
                log(`Verify: batch upsert after stop (${err?.message || err})`);
                return;
            }
            controller.abort();
            throw err;
        }
    };

    const flushAllPending = async () => {
        try {
            await flushBatch(true);
            await flushPromise;
        } catch (err) {
            if (controller.signal.aborted) {
                log(`Verify: final flush after stop (${err?.message || err})`);
                return;
            }
            throw err;
        }
    };

    log(`Verify: ${candidates.length} rows loaded | ${toVerify.length} eligible emails.`);

    if (toVerify.length === 0) {
        log('Verify: no emails to verify, skipping API calls.', {
            progress: {
                stage: 'verification',
                processed: 0,
                total: 0,
                stats
            }
        });
    } else {
        log(`Verify: verifying ${toVerify.length} emails with concurrency ${CONCURRENCY}...`);
    }

    const tasks = toVerify.map(item =>
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
                log(`Verify: paused by user at ${completed}/${toVerify.length}`);
                controller.abort();
                return;
            }

            try {
                const result = await verifyEmail(item.row.email, provider, API_KEY);
                const status = result.validity || 'unknown';
                rows[item.index].email_status = status;

                if (Object.prototype.hasOwnProperty.call(stats, status)) {
                    stats[status] += 1;
                } else {
                    stats.unknown += 1;
                }
            } catch (error) {
                console.error(`[EMAIL_VERIFIER] Verification failed for ${item.row.email}: ${error?.message || error}`);
                rows[item.index].email_status = `error: ${error?.message || 'unknown'}`;
                stats.unknown += 1;
            }

            stageCost += requestCost;
            completed += 1;

            // Queue incremental upsert batch
            if (onBatch) {
                const row = rows[item.index];
                pendingBatch.push({
                    domain: row.domain,
                    founder_name: row.founder_name,
                    email: row.email,
                    email_status: row.email_status
                });
                await flushBatch(false);
            }

            const percent = toVerify.length ? ((completed / toVerify.length) * 100).toFixed(1) : '0.0';
            const costNumber = Number(stageCost.toFixed(6));
            const progressPayload = {
                progress: {
                    stage: 'verification',
                    processed: completed,
                    total: toVerify.length,
                    cost: costNumber,
                    stats: {
                        ...stats,
                        Cost: `$${costNumber.toFixed(2)}`
                    }
                }
            };
            if (completed % 10 === 0 || completed <= 5 || completed === toVerify.length) {
                log(`Verify: processed ${completed}/${toVerify.length} (${percent}%) | valid: ${stats.valid} | invalid: ${stats.invalid} | valid-risky: ${stats['valid-risky']} | unknown: ${stats.unknown}`, progressPayload);
            } else {
                log(null, progressPayload);
            }
        })
    );

    const pauseCheckInterval = setInterval(() => {
        void (async () => {
            try {
                const stopped = await refreshJobControlFlags(job, refreshControl, checkPaused);
                if (stopped && !controller.signal.aborted) {
                    const reason = job?.cancelled ? 'cancelled' : 'paused';
                    log(`Verify: aborting (${reason}) at ${completed}/${toVerify.length}`);
                    controller.abort();
                    await flushAllPending();
                }
            } catch (err) {
                console.warn(`[emailVerifier] pause poll failed: ${err?.message || err}`);
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
                cancelledMessage: 'Job cancelled during verification',
                pausedMessage: 'Job paused during verification'
            });
        }
    } catch (error) {
        if (controller.signal.aborted) {
            await flushAllPending();
            await throwIfJobStopped(job, refreshControl, {
                cancelledMessage: 'Job cancelled during verification',
                pausedMessage: 'Job paused during verification'
            });
        }
        if (error?.code === 'JOB_PAUSED' || error?.code === 'JOB_CANCELLED') {
            await flushAllPending();
        }
        throw error;
    } finally {
        clearInterval(pauseCheckInterval);
        if (onBatch && !controller.signal.aborted) {
            await flushAllPending();
        }
    }

    if (outputCsv) {
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
    } else {
        log('Verify: verification complete.');
    }

    const cost = Number(stageCost.toFixed(6));
    return {
        'Total Rows': rows.length,
        'Eligible': toVerify.length,
        'Verified': completed,
        'Valid': stats.valid,
        'Invalid': stats.invalid,
        'Valid-Risky': stats['valid-risky'],
        'Unknown': stats.unknown,
        valid: stats.valid,
        invalid: stats.invalid,
        cost
    };
}

// Export providers for use in other modules
export { PROVIDERS };

import dotenv from 'dotenv';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import csv from 'csv-parser';
import { OpenAI } from 'openai';
import { createConcurrencyLimit } from '../lib/concurrency.js';

dotenv.config();

function parsePositiveInt(value, fallback) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return fallback;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

const FOUNDER_MODEL = process.env.OPENAI_FOUNDER_MODEL || 'gpt-4o-mini';

const SERPER_URL = 'https://google.serper.dev/search';
const SERPER_BATCH_SIZE = 25;
const SERPER_CONCURRENCY = 8;

const AI_CONCURRENCY_LIMIT = parsePositiveInt(process.env.FOUNDER_AI_CONCURRENCY, 15);
const AI_MIN_RPM = parsePositiveInt(process.env.FOUNDER_AI_MIN_RPM, 120);
const AI_MAX_RPM = Math.max(AI_MIN_RPM, parsePositiveInt(process.env.FOUNDER_AI_MAX_RPM, 900));
const AI_SUCCESS_THRESHOLD = parsePositiveInt(process.env.FOUNDER_AI_RECOVERY_SUCCESS_THRESHOLD, 25);
const AI_RESET_RPM_ON_RESUME = parseBoolean(process.env.FOUNDER_RESET_RPM_ON_RESUME, true);
const AI_TRUNCATE_CHARS = 900;
const AI_TOP_ORGANIC = 10;

const MAX_RETRIES = 2;
const BASE_DELAY_MS = 500;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function jitter(ms) {
    return ms + Math.floor(Math.random() * 250);
}

function truncateForLog(value, maxLen = 320) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (!text) return '';
    return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

function getHttpErrorStatus(err) {
    return err?.response?.status ?? err?.status ?? err?.statusCode ?? null;
}

function isRecoverableLookupFailure(err) {
    const status = getHttpErrorStatus(err);
    if (status === 401 || status === 403) {
        return false;
    }
    if (status === null || status === undefined) {
        return true;
    }
    if (status === 429) {
        return true;
    }
    if (status >= 500) {
        return true;
    }
    return status >= 400 && status < 500;
}

function formatRequestError(err, { includePayload = true, payloadMaxLen = 320 } = {}) {
    const status = getHttpErrorStatus(err);
    const payload = err?.response?.data;
    const payloadErr = payload?.error || err?.error;
    const message = payload?.message || payloadErr?.message || err?.message || String(err);
    const type = payloadErr?.type || err?.type;
    const code = payloadErr?.code || err?.code;
    const pieces = [];

    if (status) pieces.push(`HTTP ${status}`);
    if (message) pieces.push(String(message).trim());
    if (type) pieces.push(`type=${type}`);
    if (code) pieces.push(`code=${code}`);
    if (includePayload && payload) {
        pieces.push(`payload=${truncateForLog(payload, payloadMaxLen)}`);
    }

    return pieces.join(' | ');
}

function chunkWithIndex(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push({ start: i, items: arr.slice(i, i + size) });
    }
    return chunks;
}

class AdaptiveRateLimiter {
    constructor(minRpm, maxRpm, initialRpm = null, options = {}) {
        this.minRpm = minRpm;
        this.maxRpm = maxRpm;
        this.currentRpm = clamp(initialRpm || maxRpm, minRpm, maxRpm);
        this.timestamps = [];
        this.recentSuccesses = 0;
        this.successThreshold = options.successThreshold || 50; // successful requests before trying to increase
        this.backoffFactor = 0.7; // reduce to 70% on 429
        this.recoveryFactor = 1.1; // increase to 110% on success streak
    }

    getCurrentRpm() {
        return Math.round(this.currentRpm);
    }

    async acquire() {
        while (true) {
            const now = Date.now();
            // Clean old timestamps (older than 1 minute)
            this.timestamps = this.timestamps.filter(t => now - t < 60000);

            const allowedInLastMinute = Math.floor(this.currentRpm);

            if (this.timestamps.length < allowedInLastMinute) {
                this.timestamps.push(now);
                return;
            }

            // Calculate wait time based on oldest timestamp
            const oldestInWindow = this.timestamps[0];
            const timeToWait = 60000 - (now - oldestInWindow) + 10; // +10ms buffer
            await sleep(Math.max(10, timeToWait));
        }
    }

    onRateLimitHit() {
        const oldRpm = this.currentRpm;
        this.currentRpm = Math.max(this.minRpm, this.currentRpm * this.backoffFactor);
        this.recentSuccesses = 0;
        return {
            reduced: true,
            oldRpm: Math.round(oldRpm),
            newRpm: Math.round(this.currentRpm)
        };
    }

    onSuccess() {
        this.recentSuccesses++;
        if (this.recentSuccesses >= this.successThreshold && this.currentRpm < this.maxRpm) {
            const oldRpm = this.currentRpm;
            this.currentRpm = Math.min(this.maxRpm, this.currentRpm * this.recoveryFactor);
            this.recentSuccesses = 0;
            return {
                increased: true,
                oldRpm: Math.round(oldRpm),
                newRpm: Math.round(this.currentRpm)
            };
        }
        return null;
    }
}

async function withRetry(fn, label, shouldBackoff = () => true, logger = () => { }) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const status = getHttpErrorStatus(err);
            const payload = err?.response?.data;
            const payloadErr = payload?.error || err?.error;
            const dataMsg = payload?.message || payloadErr?.message;
            const msg = dataMsg || err?.message || String(err);
            const inferredType = payloadErr?.type;
            const insufficientQuota =
                (status === 429 && /quota/i.test(msg || '')) ||
                inferredType === 'insufficient_quota';

            if (insufficientQuota) {
                err.isQuotaExceeded = true;
                logger(`${label} aborted: ${formatRequestError(err)}`);
                throw err;
            }

            if (attempt === MAX_RETRIES || !shouldBackoff(status, err)) {
                const detailed = formatRequestError(err);
                logger(`${label} failed after ${attempt} attempts: ${detailed}`);
                err.message = `${label} failed: ${formatRequestError(err, { includePayload: false })}`;
                throw err;
            }

            const backoff = jitter(BASE_DELAY_MS * Math.pow(2, attempt - 1));
            logger(`${label} error, retry ${attempt} in ${backoff}ms: ${formatRequestError(err, { includePayload: false })}`);
            await sleep(backoff);
        }
    }
}

async function readDomains(filePath) {
    const domains = [];
    await new Promise((resolve, reject) => {
        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', row => {
                const d = (row.domain || '').trim();
                if (d) domains.push(d);
            })
            .on('end', resolve)
            .on('error', reject);
    });
    return domains;
}

async function aiFindFounder(searchResults, companyDomain, logger, openai, rateLimiter, rateLimitHooks) {
    const slim = searchResults.slice(0, AI_TOP_ORGANIC).map(r => ({
        t: r.title || '',
        u: r.link || '',
        s: r.snippet || ''
    }));
    let searchString = JSON.stringify(slim);
    if (searchString.length > AI_TRUNCATE_CHARS) {
        searchString = searchString.slice(0, AI_TRUNCATE_CHARS) + '\n[TRUNCATED]';
    }

    const promptInput = `
You are a precise extraction AI. You will receive a list of search results about a company, along with the company name. Your task is to return the full name (first and last) of the founder or CEO, based only on the provided information.

Rules:

Return only the person's full name.
The name must be exactly two words: first name and last name.
Do not return the company name, social handles, or extra words.
If multiple names are mentioned, choose the most consistently associated with the role of founder or CEO.
If a viable founder can't be determined, return "Not Found".
If only a first name can be found, and you are sure it is the founder/CEO, return the first name as found, and the second name as "NoLast". Eg: "John NoLast"
Never return anything other than the name or "Not Found". No explanation. No formatting.
If it comes to an edge case or error outside of what is described, never give an explanation, just say "Not Found".
Input will look like:
Search results: [ { title: "...", snippet: "...", ... }, { ... } ]
Company Domain: example.com

Your only output should be like this:
John Smith

Search results (compressed JSON): ${searchString}
Company Domain: ${companyDomain}`;

    if (rateLimitHooks?.openai) await rateLimitHooks.openai();
    await rateLimiter.acquire();

    let res;
    let hit429 = false;
    try {
        res = await withRetry(
            () =>
                openai.responses.create({
                    model: FOUNDER_MODEL,
                    input: promptInput,
                    text: { format: { type: 'text' } }
                }),
            `OpenAI for ${companyDomain}`,
            status => status === 429 || (status >= 500 && status < 600),
            logger
        );
    } catch (err) {
        // Check if we hit a 429 rate limit
        const status = err?.response?.status ?? err?.status ?? err?.statusCode;
        if (status === 429) {
            hit429 = true;
            const adjustment = rateLimiter.onRateLimitHit();
            if (adjustment.reduced) {
                logger(`Rate limit hit! Reduced RPM: ${adjustment.oldRpm} → ${adjustment.newRpm}`);
            }
        }
        throw err;
    }

    // Track success
    if (!hit429) {
        const adjustment = rateLimiter.onSuccess();
        if (adjustment?.increased) {
            logger(`Performance optimized! Increased RPM: ${adjustment.oldRpm} → ${adjustment.newRpm}`);
        }
    }

    const usage = res?.usage || {};
    const inputTokens = usage.input_tokens ?? usage.input_tokens_text ?? usage.prompt_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? usage.output_tokens_text ?? usage.completion_tokens ?? 0;

    const name = (res && res.output_text) ? res.output_text.trim() : 'Not Found';
    return { name, tokensIn: inputTokens, tokensOut: outputTokens };
}

function computeFounderCost({ tokensIn = 0, tokensOut = 0, pricing }) {
    const serperCost = pricing?.serper_request_cost || 0;
    const inputRate = pricing?.openai_per_million_input || 0;
    const outputRate = pricing?.openai_per_million_output || 0;
    const openaiCost = ((tokensIn / 1_000_000) * inputRate) + ((tokensOut / 1_000_000) * outputRate);
    const leadCost = serperCost + openaiCost;
    return { serperCost, openaiCost, leadCost };
}

async function assertNotStopped({ checkpoint, checkPaused }) {
    if (checkpoint) {
        await checkpoint();
        return;
    }
    if (checkPaused && checkPaused()) {
        const err = new Error('Job paused');
        err.code = 'JOB_PAUSED';
        throw err;
    }
}

const FOUNDER_CONTACT_UPSERT_BATCH_SIZE = 50;
const FOUNDER_DONE_BATCH_SIZE = 50;

export async function runFounderFinder({
    domains: domainsInput = null,
    listPendingDomains = null,
    loadSerperCache = null,
    saveSerperCache = null,
    markDomainDone = null,
    markDomainsDone = null,
    checkpoint = null,
    checkPaused = null,
    apiKeys,
    pricing,
    log = () => {},
    onBatch = null,
    totalDomainCount = null,
    rateLimitHooks = null
}) {
    const OPENAI_API_KEY = apiKeys.openai;
    const SERPER_API_KEY = apiKeys.serper;

    if (!OPENAI_API_KEY) {
        throw new Error('Missing OpenAI API key');
    }
    if (!SERPER_API_KEY) {
        throw new Error('Missing Serper API key');
    }

    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

    let serperCache = {};
    if (loadSerperCache) {
        serperCache = await loadSerperCache();
        log(`Founders: loaded ${Object.keys(serperCache).length} cached Serper results from database`);
    }

    const processedDomains = new Set();
    const aiRateLimiter = new AdaptiveRateLimiter(AI_MIN_RPM, AI_MAX_RPM, AI_MAX_RPM, {
        successThreshold: AI_SUCCESS_THRESHOLD
    });
    log(`Founders: initialized adaptive rate limiter at ${aiRateLimiter.getCurrentRpm()} RPM`);

    let pendingRows = [];
    if (Array.isArray(domainsInput) && domainsInput.length) {
        pendingRows = domainsInput.map((d, i) => ({
            domain_normalized: typeof d === 'string' ? d : d.domain,
            sort_order: i
        }));
    } else if (listPendingDomains) {
        pendingRows = await listPendingDomains();
    }

    const domains = pendingRows.map((r) => r.domain_normalized).filter(Boolean);
    const totalDomains = Number.isFinite(totalDomainCount) && totalDomainCount > 0
        ? totalDomainCount
        : domains.length + processedDomains.size;

    log(`Founders: ${domains.length} pending domains (${totalDomains} total for job)`);

    if (!domains.length) {
        return {
            total: totalDomains,
            processed: 0,
            Found: 0,
            'Not Found': 0,
            Errors: 0,
            Cost: '$0.00'
        };
    }

    const serperLimit = createConcurrencyLimit(SERPER_CONCURRENCY);
    const aiLimit = createConcurrencyLimit(AI_CONCURRENCY_LIMIT);

    const persistSerperBatch = async (batchEntries) => {
        if (!saveSerperCache || !batchEntries.length) return;
        await saveSerperCache(batchEntries);
    };

    let processed = 0;
    let fatalQuotaError = null;
    let fatalTaskError = null;

    const queries = domains.map(d => `${d} founder`);
    const chunks = chunkWithIndex(queries, SERPER_BATCH_SIZE);

    log(`Founders: dispatching ${chunks.length} Serper batches (size ${SERPER_BATCH_SIZE}, concurrency ${SERPER_CONCURRENCY})...`);

    const aiTasks = [];
    let notFoundCount = 0;
    let foundCount = 0;
    let errorCount = 0;
    let stageCost = 0;
    let serperCostTotal = 0;
    let openaiCostTotal = 0;
    const pendingBatch = [];
    let flushPromise = Promise.resolve();
    const doneDomainsBuffer = [];

    const flushDomainsDone = async (force = false) => {
        const flushFn = markDomainsDone
            || (markDomainDone
                ? async (domains) => {
                    for (const domain of domains) {
                        await markDomainDone(domain);
                    }
                }
                : null);
        if (!flushFn) return;
        if (!force && doneDomainsBuffer.length < FOUNDER_DONE_BATCH_SIZE) return;
        const batch = doneDomainsBuffer.splice(0, doneDomainsBuffer.length);
        if (!batch.length) return;
        await flushFn(batch);
    };

    const flushBatch = async (force = false) => {
        if (!onBatch) return;
        if (!force && pendingBatch.length < FOUNDER_CONTACT_UPSERT_BATCH_SIZE) return;
        const batch = pendingBatch.splice(0, pendingBatch.length);
        if (batch.length === 0) return;
        flushPromise = flushPromise.then(() => onBatch(batch));
        await flushPromise;
        log(`Founders: upserted ${batch.length} contacts to database`);
    };

    const control = { checkpoint, checkPaused };

    const serperTasks = chunks.map((chunk, batchIdx) =>
        serperLimit(async () => {
            await assertNotStopped(control);
            if (fatalQuotaError || fatalTaskError) {
                return;
            }

            const payload = chunk.items.map(q => ({ q }));
            const config = {
                method: 'post',
                maxBodyLength: Infinity,
                url: SERPER_URL,
                headers: {
                    'X-API-KEY': SERPER_API_KEY,
                    'Content-Type': 'application/json'
                },
                data: JSON.stringify(payload)
            };

            // Check which domains in this batch need Serper requests
            const domainsToFetch = [];
            const domainIndices = [];
            
            for (let k = 0; k < chunk.items.length; k++) {
                const absoluteIndex = chunk.start + k;
                const domain = domains[absoluteIndex];
                
                if (!serperCache[domain]) {
                    domainsToFetch.push(chunk.items[k]);
                    domainIndices.push(absoluteIndex);
                }
            }
            
            let rows = [];
            
            // Only make Serper request if we have uncached domains
            if (domainsToFetch.length > 0) {
                await assertNotStopped(control);
                const fetchPayload = domainsToFetch.map(q => ({ q, num: 10 }));
                const fetchConfig = {
                    method: 'post',
                    maxBodyLength: Infinity,
                    url: SERPER_URL,
                    headers: {
                        'X-API-KEY': SERPER_API_KEY,
                        'Content-Type': 'application/json'
                    },
                    data: JSON.stringify(fetchPayload)
                };
                
                const res = await withRetry(
                    async () => {
                        if (rateLimitHooks?.serper) await rateLimitHooks.serper();
                        return axios.request(fetchConfig);
                    },
                    `Serper batch ${batchIdx + 1}`,
                    status => status === 429 || (status >= 500 && status < 600),
                    log
                );
                
                rows = Array.isArray(res.data) ? res.data : [];
                
                // Cache the results
                for (let i = 0; i < domainsToFetch.length; i++) {
                    const domain = domains[domainIndices[i]];
                    serperCache[domain] = rows[i] || {};
                }
                
                const cacheWrites = domainsToFetch.map((_, i) => ({
                    domain: domains[domainIndices[i]],
                    payload: rows[i] || {}
                }));
                await persistSerperBatch(cacheWrites);
                await assertNotStopped(control);
                log(`Founders: fetched and cached Serper batch ${batchIdx + 1}/${chunks.length} with ${domainsToFetch.length} new queries`);
            } else {
                log(`Founders: using cached results for batch ${batchIdx + 1}/${chunks.length}`);
            }

            if ((batchIdx + 1) % 10 === 0 || batchIdx + 1 === chunks.length) {
                // Log-only: do NOT write progress.processed/total here — those keys
                // represent domain-level progress (consumed by the UI hero stats).
                // Serper batches are an internal sub-step, not the user-facing total.
                log(`Founders: Serper ${batchIdx + 1} / ${chunks.length}`);
            }

            for (let k = 0; k < chunk.items.length; k++) {
                const absoluteIndex = chunk.start + k;
                const domain = domains[absoluteIndex];
                
                // Skip if already processed
                if (processedDomains.has(domain)) {
                    continue;
                }
                
                const row = serperCache[domain] || {};
                const organic = Array.isArray(row.organic) ? row.organic : [];
                const searchResults = organic.map((item, idx) => ({
                    position: idx + 1,
                    title: item?.title || '',
                    link: item?.link || '',
                    snippet: item?.snippet || ''
                }));

                const task = aiLimit(async () => {
                    await assertNotStopped(control);
                    if (fatalQuotaError || fatalTaskError) {
                        return;
                    }

                    let name = 'Not Found';
                    let tokensIn = 0;
                    let tokensOut = 0;

                    if (searchResults.length > 0) {
                        try {
                            await assertNotStopped(control);
                            const result = await aiFindFounder(
                                searchResults,
                                domain,
                                log,
                                openai,
                                aiRateLimiter,
                                rateLimitHooks
                            );
                            await assertNotStopped(control);
                            name = result?.name || 'Not Found';
                            tokensIn = result?.tokensIn || 0;
                            tokensOut = result?.tokensOut || 0;
                        } catch (err) {
                            if (err?.isQuotaExceeded) {
                                fatalQuotaError = fatalQuotaError || err;
                                throw err;
                            }
                            const recoverableClientError = isRecoverableLookupFailure(err);

                            if (recoverableClientError) {
                                errorCount++;
                                log(`Founders: ${domain} lookup failed, defaulting to Not Found (${formatRequestError(err)})`);
                                name = 'Not Found';
                                tokensIn = 0;
                                tokensOut = 0;
                            } else {
                                throw new Error(`Founder lookup failed for ${domain}: ${formatRequestError(err)}`);
                            }
                        }
                    }

                    if (name === 'Not Found') {
                        notFoundCount++;
                    } else {
                        foundCount++;
                    }

                    const { serperCost, openaiCost, leadCost } = computeFounderCost({
                        tokensIn,
                        tokensOut,
                        pricing
                    });
                    serperCostTotal += serperCost;
                    openaiCostTotal += openaiCost;
                    stageCost += leadCost;

                    processed++;
                    const costNumber = Number(stageCost.toFixed(6));
                    const currentRpm = aiRateLimiter ? aiRateLimiter.getCurrentRpm() : AI_MAX_RPM;
                    const progressPayload = {
                        progress: {
                            stage: 'founders',
                            processed,
                            total: totalDomains,
                            found: foundCount,
                            cost: costNumber,
                            stats: {
                                'Total': totalDomains,
                                'Processed': processed,
                                'Found': foundCount,
                                'Not Found': notFoundCount,
                                'Errors': errorCount,
                                'RPM': currentRpm,
                                'Cost': `$${costNumber.toFixed(2)}`
                            }
                        }
                    };
                    if (processed % 5 === 0 || processed <= 10 || processed === totalDomains) {
                        const rate = foundCount + notFoundCount > 0 ? ((foundCount / (foundCount + notFoundCount)) * 100).toFixed(2) : '0.00';
                        log(`Founders: processed ${processed}/${totalDomains} | find rate ${rate}%`, progressPayload);
                    } else {
                        log(null, progressPayload);
                    }

                    if (onBatch) {
                        pendingBatch.push({
                            domain,
                            founder_name: name,
                            confidence: null
                        });
                        await flushBatch(false);
                    }
                    
                    processedDomains.add(domain);
                    doneDomainsBuffer.push(domain);
                    await flushDomainsDone(false);
                }).catch((err) => {
                    fatalTaskError = fatalTaskError || err;
                });

                aiTasks.push(task);
            }
        })
    );

    try {
        await Promise.all(serperTasks);
        await Promise.all(aiTasks);
        if (fatalTaskError) {
            throw fatalTaskError;
        }
        await flushBatch(true);
        await flushPromise;
        await flushDomainsDone(true);
    } catch (err) {
        try {
            await flushBatch(true);
            await flushPromise;
            await flushDomainsDone(true);
        } catch {
            // If flush also fails, preserve original error cause.
        }
        throw err;
    }

    if (fatalQuotaError) {
        throw fatalQuotaError;
    }

    const summary = {
        total: totalDomains,
        processed: foundCount + notFoundCount,
        'Found': foundCount,
        'Not Found': notFoundCount,
        'Errors': errorCount,
        cost: Number(stageCost.toFixed(6)),
        'Cost': `$${stageCost.toFixed(2)}`
    };

    log('Founders: done.');
    return summary;
}

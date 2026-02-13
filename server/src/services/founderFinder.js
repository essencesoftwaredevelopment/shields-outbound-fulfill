import dotenv from 'dotenv';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import csv from 'csv-parser';
import { OpenAI } from 'openai';
import pLimit from 'p-limit';

dotenv.config();

const FOUNDER_MODEL = process.env.OPENAI_FOUNDER_MODEL || 'gpt-5-nano';

const SERPER_URL = 'https://google.serper.dev/search';
const SERPER_BATCH_SIZE = 25;
const SERPER_CONCURRENCY = 8;

const AI_CONCURRENCY_LIMIT = 8;
const AI_MAX_RPS = 8;
const AI_MAX_RPM = 480;
const AI_TRUNCATE_CHARS = 900;
const AI_TOP_ORGANIC = 10;

const MAX_RETRIES = 2;
const BASE_DELAY_MS = 500;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function jitter(ms) {
    return ms + Math.floor(Math.random() * 250);
}

function chunkWithIndex(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push({ start: i, items: arr.slice(i, i + size) });
    }
    return chunks;
}

class AdaptiveRateLimiter {
    constructor(minRpm, maxRpm, initialRpm = null) {
        this.minRpm = minRpm;
        this.maxRpm = maxRpm;
        this.currentRpm = initialRpm || maxRpm;
        this.timestamps = [];
        this.recentSuccesses = 0;
        this.successThreshold = 50; // successful requests before trying to increase
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

            const currentRps = this.currentRpm / 60;
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

let aiRateLimiter = null; // Will be initialized in runFounderFinder

async function withRetry(fn, label, shouldBackoff = () => true, logger = () => { }) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const status = err?.response?.status ?? err?.status ?? err?.statusCode;
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
                logger(`${label} aborted: ${status || ''} ${msg}`);
                throw err;
            }

            if (attempt === MAX_RETRIES || !shouldBackoff(status, err)) {
                // Log detailed error information for debugging
                const errorDetails = payload ? JSON.stringify(payload) : msg;
                logger(`${label} failed after ${attempt} attempts: ${status || ''} ${msg}`);
                if (payload) {
                    logger(`${label} error details: ${errorDetails}`);
                }
                throw err;
            }

            const backoff = jitter(BASE_DELAY_MS * Math.pow(2, attempt - 1));
            logger(`${label} error, retry ${attempt} in ${backoff}ms: ${status || ''} ${msg}`);
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

async function aiFindFounder(searchResults, companyDomain, logger, openai, rateLimiter) {
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

export async function runFounderFinder({ inputCsv, outputCsv, apiKeys, pricing, log = () => { }, checkpointDir = null }) {
    const OPENAI_API_KEY = apiKeys.openai;
    const SERPER_API_KEY = apiKeys.serper;

    if (!OPENAI_API_KEY) {
        throw new Error('Missing OpenAI API key');
    }
    if (!SERPER_API_KEY) {
        throw new Error('Missing Serper API key');
    }

    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

    // Setup checkpoint files
    const serperCheckpointFile = checkpointDir ? path.join(checkpointDir, 'serper-results.json') : null;
    const progressCheckpointFile = checkpointDir ? path.join(checkpointDir, 'founders-progress.json') : null;
    
    // Load existing checkpoint data if resuming
    let serperCache = {};
    let processedDomains = new Set();
    let savedRpm = null;
    
    if (serperCheckpointFile && fs.existsSync(serperCheckpointFile)) {
        try {
            serperCache = JSON.parse(fs.readFileSync(serperCheckpointFile, 'utf-8'));
            log(`Founders: loaded ${Object.keys(serperCache).length} cached Serper results`);
        } catch (err) {
            log(`Founders: failed to load Serper cache: ${err.message}`);
        }
    }
    
    if (progressCheckpointFile && fs.existsSync(progressCheckpointFile)) {
        try {
            const progress = JSON.parse(fs.readFileSync(progressCheckpointFile, 'utf-8'));
            processedDomains = new Set(progress.processedDomains || []);
            savedRpm = progress.currentRpm;
            log(`Founders: resuming from checkpoint with ${processedDomains.size} already processed${savedRpm ? ` at ${savedRpm} RPM` : ''}`);
        } catch (err) {
            log(`Founders: failed to load progress checkpoint: ${err.message}`);
        }
    }
    
    // Initialize adaptive rate limiter with saved RPM if available
    aiRateLimiter = new AdaptiveRateLimiter(120, AI_MAX_RPM, savedRpm);
    log(`Founders: initialized adaptive rate limiter at ${aiRateLimiter.getCurrentRpm()} RPM`);

    // Only delete output if starting fresh
    if (fs.existsSync(outputCsv) && processedDomains.size === 0) {
        fs.unlinkSync(outputCsv);
        log('Founders: existing output file deleted.');
    }

    log(`Founders: reading domains from ${inputCsv}`);
    const domains = await readDomains(inputCsv);
    log(`Founders: total domains to process: ${domains.length}`);

    if (!domains.length) {
        throw new Error('No domains found in uploaded CSV.');
    }

    const writer = fs.createWriteStream(outputCsv, { flags: 'a' });
    if (processedDomains.size === 0) {
        writer.write('domain,founder_name\n');
    }

    const serperLimit = pLimit(SERPER_CONCURRENCY);
    const aiLimit = pLimit(AI_CONCURRENCY_LIMIT);
    
    // Helper to save Serper results to checkpoint
    const saveSerperCheckpoint = () => {
        if (serperCheckpointFile) {
            try {
                fs.writeFileSync(serperCheckpointFile, JSON.stringify(serperCache, null, 2));
            } catch (err) {
                log(`Failed to save Serper checkpoint: ${err.message}`);
            }
        }
    };
    
    // Helper to save progress checkpoint
    const saveProgressCheckpoint = () => {
        if (progressCheckpointFile) {
            try {
                fs.writeFileSync(progressCheckpointFile, JSON.stringify({
                    processedDomains: Array.from(processedDomains),
                    currentRpm: aiRateLimiter ? aiRateLimiter.getCurrentRpm() : AI_MAX_RPM,
                    timestamp: new Date().toISOString()
                }));
            } catch (err) {
                log(`Failed to save progress checkpoint: ${err.message}`);
            }
        }
    };

    let processed = 0;
    let fatalQuotaError = null;

    const queries = domains.map(d => `${d} founder`);
    const chunks = chunkWithIndex(queries, SERPER_BATCH_SIZE);

    log(`Founders: dispatching ${chunks.length} Serper batches (size ${SERPER_BATCH_SIZE}, concurrency ${SERPER_CONCURRENCY})...`);

    const aiTasks = [];
    let notFoundCount = 0;
    let foundCount = 0;
    let stageCost = 0;
    let serperCostTotal = 0;
    let openaiCostTotal = 0;

    const serperTasks = chunks.map((chunk, batchIdx) =>
        serperLimit(async () => {
            if (fatalQuotaError) {
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
                    () => axios.request(fetchConfig),
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
                
                saveSerperCheckpoint();
                log(`Founders: fetched and cached Serper batch ${batchIdx + 1}/${chunks.length} with ${domainsToFetch.length} new queries`);
            } else {
                log(`Founders: using cached results for batch ${batchIdx + 1}/${chunks.length}`);
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
                    if (fatalQuotaError) {
                        return;
                    }

                    let name = 'Not Found';
                    let tokensIn = 0;
                    let tokensOut = 0;

                    if (searchResults.length > 0) {
                        try {
                            const result = await aiFindFounder(searchResults, domain, log, openai, aiRateLimiter);
                            name = result?.name || 'Not Found';
                            tokensIn = result?.tokensIn || 0;
                            tokensOut = result?.tokensOut || 0;
                        } catch (err) {
                            if (err?.isQuotaExceeded) {
                                fatalQuotaError = fatalQuotaError || err;
                                throw err;
                            }
                            throw new Error(`Founder lookup failed for ${domain}: ${err?.message || err}`);
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
                            stats: {
                                'Total': domains.length,
                                'Processed': processed,
                                'Found': foundCount,
                                'Not Found': notFoundCount,
                                'RPM': currentRpm,
                                'Cost': `$${costNumber}`
                            }
                        }
                    };
                    if (processed % 25 === 0 || processed <= 10) {
                        const rate = foundCount + notFoundCount > 0 ? ((foundCount / (foundCount + notFoundCount)) * 100).toFixed(2) : '0.00';
                        log(`Founders: processed ${processed}/${domains.length} | find rate ${rate}%`, progressPayload);
                    } else {
                        log(null, progressPayload);
                    }

                    const safe = (name || '').replace(/"/g, '""');
                    writer.write(`${domain},"${safe}"\n`);
                    
                    // Mark as processed and save checkpoint
                    processedDomains.add(domain);
                    if (processed % 10 === 0) {
                        saveProgressCheckpoint();
                    }
                });

                aiTasks.push(task);
            }
        })
    );

    await Promise.all(serperTasks);
    await Promise.all(aiTasks);

    writer.end();
    await new Promise(res => writer.on('finish', res));
    
    // Save final checkpoint
    saveProgressCheckpoint();
    saveSerperCheckpoint();

    if (fatalQuotaError) {
        throw fatalQuotaError;
    }

    const summary = {
        total: domains.length,
        processed: foundCount,
        'Found': foundCount,
        'Not Found': notFoundCount,
        'Cost': `$${stageCost.toFixed(2)}`
    };

    log(`Founders: done. Results written to ${outputCsv}`);
    return summary;
}

import dotenv from 'dotenv';
import axios from 'axios';
import fs from 'fs';
import csv from 'csv-parser';
import { OpenAI } from 'openai';
import pLimit from 'p-limit';

dotenv.config();

const FOUNDER_MODEL = process.env.OPENAI_FOUNDER_MODEL || 'gpt-5-mini-2025-08-07';

const SERPER_URL = 'https://google.serper.dev/search';
const SERPER_BATCH_SIZE = 25;
const SERPER_CONCURRENCY = 8;

const AI_CONCURRENCY_LIMIT = 10;
const AI_MAX_RPS = 3;
const AI_MAX_RPM = 180;
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

class RateLimiter {
    constructor(maxRps, maxRpm) {
        this.maxRps = maxRps;
        this.maxRpm = maxRpm;
        this.secTimestamps = [];
        this.minTimestamps = [];
    }
    async acquire() {
        while (true) {
            const now = Date.now();
            this.secTimestamps = this.secTimestamps.filter(t => now - t < 1000);
            this.minTimestamps = this.minTimestamps.filter(t => now - t < 60000);

            if (this.secTimestamps.length < this.maxRps && this.minTimestamps.length < this.maxRpm) {
                this.secTimestamps.push(now);
                this.minTimestamps.push(now);
                return;
            }

            const nextSec = this.secTimestamps.length ? 1000 - (now - this.secTimestamps[0]) : 0;
            const nextMin = this.minTimestamps.length ? 60000 - (now - this.minTimestamps[0]) : 0;
            const waitMs = Math.max(10, Math.min(nextSec || 0, nextMin || 0));
            await sleep(waitMs);
        }
    }
}

const aiRateLimiter = new RateLimiter(AI_MAX_RPS, AI_MAX_RPM);

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
                logger(`${label} failed after ${attempt} attempts: ${status || ''} ${msg}`);
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

async function aiFindFounder(searchResults, companyDomain, logger, openai) {
    const slim = searchResults.slice(0, AI_TOP_ORGANIC).map(r => ({
        t: r.title || '',
        u: r.link || '',
        s: r.snippet || ''
    }));
    let searchString = JSON.stringify(slim);
    if (searchString.length > AI_TRUNCATE_CHARS) {
        searchString = searchString.slice(0, AI_TRUNCATE_CHARS) + '\n[TRUNCATED]';
    }

    const promptInput = `Use only these first-page snippets to identify the founder, CEO, or owner full name and current title for the domain below. If unclear, return \"Not Found\".\nSearch results (compressed JSON): ${searchString}\nCompany Domain: ${companyDomain}`;

    await aiRateLimiter.acquire();

    const res = await withRetry(
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

    return (res && res.output_text) ? res.output_text.trim() : 'Not Found';
}

export async function runFounderFinder({ inputCsv, outputCsv, apiKeys, log = () => { } }) {
    const OPENAI_API_KEY = apiKeys.openai;
    const SERPER_API_KEY = apiKeys.serper;

    if (!OPENAI_API_KEY) {
        throw new Error('Missing OpenAI API key');
    }
    if (!SERPER_API_KEY) {
        throw new Error('Missing Serper API key');
    }

    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

    if (fs.existsSync(outputCsv)) {
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
    writer.write('domain,founder_name\n');

    const serperLimit = pLimit(SERPER_CONCURRENCY);
    const aiLimit = pLimit(AI_CONCURRENCY_LIMIT);

    let processed = 0;
    let fatalQuotaError = null;

    const queries = domains.map(d => `${d} founder`);
    const chunks = chunkWithIndex(queries, SERPER_BATCH_SIZE);

    log(`Founders: dispatching ${chunks.length} Serper batches (size ${SERPER_BATCH_SIZE}, concurrency ${SERPER_CONCURRENCY})...`);

    const aiTasks = [];
    let notFoundCount = 0;
    let foundCount = 0;

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

            const res = await withRetry(
                () => axios.request(config),
                `Serper batch ${batchIdx + 1}`,
                status => status === 429 || (status >= 500 && status < 600),
                log
            );

            const rows = Array.isArray(res.data) ? res.data : [];
            log(`Founders: fetched Serper batch ${batchIdx + 1}/${chunks.length} with ${chunk.items.length} queries`);

            for (let k = 0; k < chunk.items.length; k++) {
                const absoluteIndex = chunk.start + k;
                const domain = domains[absoluteIndex];
                const row = rows[k] || {};
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

                    if (searchResults.length > 0) {
                        try {
                            name = await aiFindFounder(searchResults, domain, log, openai);
                        } catch (err) {
                            if (err?.isQuotaExceeded) {
                                fatalQuotaError = fatalQuotaError || err;
                                throw err;
                            }
                            name = 'Not Found';
                        }
                    }

                    if (name === 'Not Found') {
                        notFoundCount++;
                    } else {
                        foundCount++;
                    }

                    processed++;
                    const progressPayload = {
                        progress: {
                            stage: 'founders',
                            processed,
                            total: domains.length,
                            found: foundCount,
                            notFound: notFoundCount
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
                });

                aiTasks.push(task);
            }
        })
    );

    await Promise.all(serperTasks);
    await Promise.all(aiTasks);

    writer.end();
    await new Promise(res => writer.on('finish', res));

    if (fatalQuotaError) {
        throw fatalQuotaError;
    }

    const summary = {
        total: domains.length,
        processed,
        found: foundCount,
        notFound: notFoundCount
    };

    log(`Founders: done. Results written to ${outputCsv}`);
    return summary;
}

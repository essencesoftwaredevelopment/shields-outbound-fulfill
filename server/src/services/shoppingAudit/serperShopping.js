import axios from 'axios';
import { shouldRetryHttpOrNetwork } from '../../utils/transientNetwork.js';
import { createConcurrencyLimit } from '../../lib/concurrency.js';
import {
    DEFAULT_SERPER_GEO,
    SERPER_SHOPPING_URL
} from './constants.js';
import {
    buildSerperShoppingQuery,
    extractCardFields,
    matchShoppingCard,
    normalizeProductTitle,
    slimCardFields,
    slimCardsForStorage
} from './utils.js';

function parsePositiveInt(raw, fallback) {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

const SERPER_BATCH_SIZE = parsePositiveInt(process.env.SHOPPING_SERPER_BATCH_SIZE, 25);
const SERPER_CONCURRENCY = parsePositiveInt(process.env.SHOPPING_SERPER_CONCURRENCY, 8);
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function jitter(ms) {
    return ms + Math.floor(Math.random() * 250);
}

function chunkArray(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
}

function getHttpErrorStatus(err) {
    return err?.response?.status ?? err?.status ?? err?.statusCode ?? null;
}

async function withRetry(fn, label, shouldBackoff = () => true, logger = () => {}) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const status = getHttpErrorStatus(err);
            const msg = err?.response?.data?.message || err?.message || String(err);

            if (attempt === MAX_RETRIES || !shouldBackoff(status, err)) {
                logger?.(`${label} failed after ${attempt} attempt(s): ${msg}`);
                throw err;
            }

            const backoff = jitter(BASE_DELAY_MS * Math.pow(2, attempt - 1));
            logger?.(`${label} retry ${attempt}/${MAX_RETRIES} in ${backoff}ms: ${msg}`);
            await sleep(backoff);
        }
    }
}

async function postSerperShopping(queries, apiKey, geo) {
    const response = await axios.post(
        SERPER_SHOPPING_URL,
        queries.map((q) => ({
            q: q.query,
            gl: geo.gl || DEFAULT_SERPER_GEO.gl,
            hl: geo.hl || DEFAULT_SERPER_GEO.hl,
            location: geo.location || DEFAULT_SERPER_GEO.location,
            num: 20
        })),
        {
            headers: {
                'X-API-KEY': apiKey,
                'Content-Type': 'application/json'
            },
            timeout: 30000
        }
    );
    return response.data;
}

function feedPriceForSelection(sel) {
    const snap = sel.snapshot;
    return snap?.variants?.[0]?.price ? parseFloat(snap.variants[0].price) : null;
}

function heroProductTitle(sel) {
    return normalizeProductTitle(sel.snapshot?.title || '');
}

function observationFromResult(sel, query, cards, geo) {
    const feedPrice = feedPriceForSelection(sel);
    const productTitle = heroProductTitle(sel);
    const { match, branch } = matchShoppingCard(cards, { domain: sel.domain, productTitle, feedPrice });
    return {
        domain: sel.domain,
        selection: sel,
        query,
        branch,
        matched_card: match,
        all_cards: cards,
        source: 'serper',
        geo,
        observed_at: new Date().toISOString()
    };
}

function errorObservation(sel, geo, message) {
    return {
        domain: sel.domain,
        selection: sel,
        branch: 'none',
        matched_card: null,
        all_cards: [],
        source: 'serper',
        geo,
        error: message,
        observed_at: new Date().toISOString()
    };
}

function cacheEntryFromObservation(obs) {
    return {
        domain: obs.domain,
        payload: {
            query: obs.query,
            branch: obs.branch,
            matched_card: obs.matched_card ? slimCardFields(obs.matched_card) : null,
            all_cards: slimCardsForStorage(obs.all_cards),
            source: obs.source,
            geo: obs.geo,
            observed_at: obs.observed_at
        }
    };
}

/** Single-domain helper — used by spike script and tests. */
export async function searchShoppingForHero({
    domain,
    productTitle,
    feedPrice,
    apiKey,
    geo = DEFAULT_SERPER_GEO
}) {
    const title = normalizeProductTitle(productTitle);
    const query = buildSerperShoppingQuery(domain, productTitle);
    const payload = await postSerperShopping([{ query }], apiKey, geo);
    const result = Array.isArray(payload) ? payload[0] : payload;
    const cards = result?.shopping || [];
    const { match, branch, score } = matchShoppingCard(cards, { domain, productTitle: title, feedPrice });
    return {
        query,
        branch,
        match,
        matchScore: score,
        all_cards: cards,
        raw: result
    };
}

export async function runSerperShoppingBatch({
    selections,
    apiKey,
    geo,
    loadCache,
    saveCache,
    log,
    checkpoint,
    onProgress,
    pricing,
    rateLimitHooks = null
}) {
    const serperLimit = createConcurrencyLimit(SERPER_CONCURRENCY);
    const observations = [];
    const cachePending = [];
    let serperRequests = 0;
    const costPerRequest = pricing?.request_cost ?? 0.001;
    const pending = [];

    for (const sel of selections) {
        const cached = loadCache ? await loadCache(sel.domain) : null;
        if (cached) {
            observations.push({ domain: sel.domain, selection: sel, ...cached, fromCache: true });
            continue;
        }
        pending.push(sel);
    }

    const chunks = chunkArray(pending, SERPER_BATCH_SIZE);
    if (chunks.length) {
        log?.(`Serper Shopping: dispatching ${chunks.length} batch(es) (size ${SERPER_BATCH_SIZE}, concurrency ${SERPER_CONCURRENCY})…`);
    }

    const batchTasks = chunks.map((chunk, batchIdx) =>
        serperLimit(async () => {
            if (checkpoint) await checkpoint();

            const items = chunk.map((sel) => ({
                sel,
                query: buildSerperShoppingQuery(sel.domain, sel.snapshot?.title || '')
            }));

            let batchResults;
            try {
                const payload = await withRetry(
                    async () => {
                        const request = () =>
                            postSerperShopping(
                                items.map((item) => ({ query: item.query })),
                                apiKey,
                                geo
                            );
                        return rateLimitHooks?.serper
                            ? rateLimitHooks.serper(request)
                            : request();
                    },
                    `Serper Shopping batch ${batchIdx + 1}`,
                    shouldRetryHttpOrNetwork,
                    log
                );
                const rows = Array.isArray(payload) ? payload : [payload];

                batchResults = items.map((item, i) => {
                    const cards = rows[i]?.shopping || [];
                    serperRequests += 1;
                    return observationFromResult(item.sel, item.query, cards, geo);
                });

                log?.(`Serper Shopping: fetched batch ${batchIdx + 1}/${chunks.length} (${chunk.length} queries)`);
            } catch (err) {
                const message = err?.message || 'Serper request failed';
                log?.(`Serper Shopping batch ${batchIdx + 1} failed: ${message}`);
                batchResults = chunk.map((sel) => errorObservation(sel, geo, message));
            }

            observations.push(...batchResults);

            if (saveCache) {
                for (const obs of batchResults) {
                    if (!obs.error) {
                        cachePending.push(cacheEntryFromObservation(obs));
                    }
                }
            }

            onProgress?.({
                processed: observations.length,
                total: selections.length,
                serperRequests
            });
        })
    );

    await Promise.all(batchTasks);

    if (saveCache && cachePending.length) {
        await saveCache(cachePending);
    }

    const cost = serperRequests * costPerRequest;
    return {
        observations,
        serperRequests,
        cost,
        clean: observations.filter((o) => o.branch === 'clean').length,
        ambiguous: observations.filter((o) => o.branch === 'ambiguous').length,
        none: observations.filter((o) => o.branch === 'none').length
    };
}

export {
    buildSerperShoppingQuery,
    extractCardFields,
    matchShoppingCard,
    normalizeProductTitle,
    SERPER_BATCH_SIZE,
    SERPER_CONCURRENCY
};

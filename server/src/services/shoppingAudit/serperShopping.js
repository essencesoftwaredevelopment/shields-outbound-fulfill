import axios from 'axios';
import { shouldRetryHttpOrNetwork } from '../../utils/transientNetwork.js';
import { createConcurrencyLimit } from '../../lib/concurrency.js';
import {
    CATALOG_PAGINATION_CONCURRENCY,
    DEFAULT_SERPER_GEO,
    MAX_SELLER_CARDS,
    MIN_CARD_PRODUCT_SIMILARITY,
    SERPER_SHOPPING_NUM,
    SERPER_SHOPPING_URL,
    SHOPIFY_CATALOG_LIMIT,
    SHOPPING_CATALOG_MAX_PAGES,
    STRONG_MATCH_STRICT
} from './constants.js';
import {
    bestCatalogMatch,
    brandRootLabel,
    buildSerperShoppingQuery,
    classifyCard,
    extractCardFields,
    matchSellerToBrand,
    matchShoppingCard,
    normalizeHostname,
    normalizeProductTitle,
    slimCardFields,
    slimCardsForStorage
} from './utils.js';
import { fetchShopifyCatalogSample, productToSnapshotRow } from './shopifyCatalog.js';

function parsePositiveInt(raw, fallback) {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

const SERPER_BATCH_SIZE = parsePositiveInt(process.env.SHOPPING_SERPER_BATCH_SIZE, 25);
const SERPER_CONCURRENCY = parsePositiveInt(process.env.SHOPPING_SERPER_CONCURRENCY, 8);
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 500;
/** Pagination happens off the hot path — allow slower stores more time than the stage-1 sample. */
const CATALOG_PAGINATION_TIMEOUT_MS = parsePositiveInt(process.env.SHOPPING_CATALOG_PAGINATION_TIMEOUT_MS, 8000);

/**
 * Cache payload schema version. v1 entries are hero-first observations
 * (branch/matched_card only) — treated as a miss so in-flight jobs re-query
 * with the domain-first flow instead of mixing match semantics.
 */
export const SERPER_CACHE_VERSION = 2;

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
            num: SERPER_SHOPPING_NUM
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

/**
 * Serper-first reverse match: keep seller-matched cards, then fetch the store
 * catalog ON DEMAND (starting at page 1) and match card titles against it,
 * paginating /products.json until every candidate settles or the catalog runs
 * out. Domains with no seller-matched cards never touch the catalog.
 *
 * `fetchCatalogPage(page) => snapshotRow[]` is injectable for tests. Every
 * fetched row is returned in `fetchedSnapshots` for persistence — they are
 * scored here and must not be carried in workflow state.
 */
export async function matchDomainCards({
    domain,
    cards,
    fetchCatalogPage = null,
    minSimilarity = MIN_CARD_PRODUCT_SIMILARITY,
    strongStrict = STRONG_MATCH_STRICT,
    maxPages = SHOPPING_CATALOG_MAX_PAGES,
    pageLimit = SHOPIFY_CATALOG_LIMIT,
    maxSellerCards = MAX_SELLER_CARDS
}) {
    const host = normalizeHostname(domain);
    const root = brandRootLabel(host);

    const sellerCards = [];
    for (const card of cards || []) {
        const fields = extractCardFields(card);
        if (!fields.title) continue;
        const { matched, method } = matchSellerToBrand(fields.seller, host);
        if (matched) sellerCards.push({ fields, method });
    }
    const candidates = sellerCards.slice(0, maxSellerCards);

    const entries = candidates.map(({ fields, method }) => ({
        fields,
        method,
        match: null
    }));
    const entryMatched = (entry) => entry.match && entry.match.similarity_lenient >= minSimilarity;
    // Stop searching only on a near-exact match: a passable sibling variant
    // ("… LH", "5-String") must not freeze out the advertised product on a
    // later page — the ad comes from the merchant's feed, so it's in there.
    const entrySettled = (entry) => entryMatched(entry) && entry.match.similarity_strict >= strongStrict;
    const betterMatch = (a, b) => !b
        || a.similarity_lenient > b.similarity_lenient
        || (a.similarity_lenient === b.similarity_lenient && a.similarity_strict > b.similarity_strict);

    const fetchedSnapshots = [];
    let pagesFetched = 0;

    if (candidates.length && fetchCatalogPage) {
        let page = 0;
        let lastPageSize = pageLimit;
        while (
            entries.some((entry) => !entrySettled(entry))
            && lastPageSize >= pageLimit
            && page < maxPages
        ) {
            page += 1;
            const pageSnapshots = await fetchCatalogPage(page);
            pagesFetched = page;
            lastPageSize = pageSnapshots.length;
            if (!pageSnapshots.length) break;
            fetchedSnapshots.push(...pageSnapshots);

            for (const entry of entries) {
                if (entrySettled(entry)) continue;
                const pageBest = bestCatalogMatch(entry.fields, pageSnapshots, root);
                if (pageBest && betterMatch(pageBest, entry.match)) {
                    entry.match = pageBest;
                }
            }
        }
    }

    const best = entries
        .filter(entryMatched)
        .sort((a, b) => b.match.similarity_lenient - a.match.similarity_lenient)[0] || null;

    return {
        matched: !!best,
        best,
        sellerCards: sellerCards.length,
        candidates: candidates.length,
        pagesFetched,
        fetchedSnapshots
    };
}

function domainFirstObservation(domain, query, cards, geo, reverse) {
    return {
        domain,
        query,
        matched: reverse.matched,
        matched_card: reverse.best?.fields ?? null,
        matched_product: reverse.best?.match.snapshot ?? null,
        matched_snapshot_id: reverse.best?.match.snapshot?.id ?? null,
        seller_match_method: reverse.best?.method ?? null,
        match_similarity: reverse.best?.match.similarity_lenient ?? null,
        seller_cards: reverse.sellerCards,
        catalog_pages_fetched: reverse.pagesFetched,
        branch: reverse.matched ? classifyCard(reverse.best.fields) : 'none',
        // Slim immediately — observations cross workflow step boundaries and
        // raw Serper cards carry nested payloads the waterfall never reads.
        all_cards: slimCardsForStorage(cards),
        source: 'serper',
        geo,
        observed_at: new Date().toISOString()
    };
}

function errorObservation(domain, geo, message) {
    return {
        domain,
        matched: false,
        matched_card: null,
        matched_product: null,
        matched_snapshot_id: null,
        seller_match_method: null,
        match_similarity: null,
        catalog_pages_fetched: null,
        branch: 'none',
        all_cards: [],
        source: 'serper',
        geo,
        error: message,
        observed_at: new Date().toISOString()
    };
}

export function cacheEntryFromObservation(obs) {
    return {
        domain: obs.domain,
        payload: {
            version: SERPER_CACHE_VERSION,
            query: obs.query,
            matched: obs.matched === true,
            branch: obs.branch,
            matched_card: obs.matched_card ? slimCardFields(obs.matched_card) : null,
            matched_product: obs.matched_product || null,
            matched_snapshot_id: obs.matched_snapshot_id ?? null,
            seller_match_method: obs.seller_match_method || null,
            match_similarity: obs.match_similarity ?? null,
            catalog_pages_fetched: obs.catalog_pages_fetched ?? null,
            all_cards: slimCardsForStorage(obs.all_cards),
            source: obs.source,
            geo: obs.geo,
            observed_at: obs.observed_at
        }
    };
}

/**
 * @deprecated Hero-first single-domain helper — removed from the production
 * path in favor of domain-first matching (2026-07). Retained for the spike
 * scripts' --compare mode; delete together with them once domain-first is
 * verified in production.
 */
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
    domains,
    apiKey,
    geo,
    loadCache,
    saveCache,
    persistSnapshots = null,
    log,
    checkpoint,
    onProgress,
    pricing,
    rateLimitHooks = null
}) {
    const serperLimit = createConcurrencyLimit(SERPER_CONCURRENCY);
    const paginationLimit = createConcurrencyLimit(CATALOG_PAGINATION_CONCURRENCY);
    const observations = [];
    const cachePending = [];
    let serperRequests = 0;
    const costPerRequest = pricing?.request_cost ?? 0.001;
    const pending = [];

    for (const rawDomain of domains) {
        const domain = normalizeHostname(rawDomain);
        const cached = loadCache ? await loadCache(domain) : null;
        // Pre-domain-first payloads (no version) are a miss — re-query.
        if (cached && cached.version === SERPER_CACHE_VERSION) {
            observations.push({ domain, ...cached, fromCache: true });
            continue;
        }
        pending.push(domain);
    }

    const chunks = chunkArray(pending, SERPER_BATCH_SIZE);
    if (chunks.length) {
        log?.(`Serper Shopping: dispatching ${chunks.length} batch(es) (size ${SERPER_BATCH_SIZE}, concurrency ${SERPER_CONCURRENCY})…`);
    }

    const batchTasks = chunks.map((chunk, batchIdx) =>
        serperLimit(async () => {
            if (checkpoint) await checkpoint();

            let batchResults;
            try {
                const payload = await withRetry(
                    async () => {
                        const request = () =>
                            postSerperShopping(
                                chunk.map((domain) => ({ query: domain })),
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

                batchResults = await Promise.all(chunk.map((domain, i) => {
                    const cards = rows[i]?.shopping || [];
                    serperRequests += 1;
                    return paginationLimit(async () => {
                        const reverse = await matchDomainCards({
                            domain,
                            cards,
                            fetchCatalogPage: async (page) => {
                                const { products } = await fetchShopifyCatalogSample(domain, log, {
                                    page,
                                    timeoutMs: CATALOG_PAGINATION_TIMEOUT_MS
                                });
                                return products.map((p) => productToSnapshotRow(p, domain));
                            }
                        });
                        return { observation: domainFirstObservation(domain, domain, cards, geo, reverse), reverse };
                    });
                }));

                log?.(`Serper Shopping: fetched batch ${batchIdx + 1}/${chunks.length} (${chunk.length} queries)`);
            } catch (err) {
                const message = err?.message || 'Serper request failed';
                log?.(`Serper Shopping batch ${batchIdx + 1} failed: ${message}`);
                batchResults = chunk.map((domain) => ({ observation: errorObservation(domain, geo, message), reverse: null }));
            }

            // Persist fetched catalog rows so the matched product is
            // rehydratable from shopify_snapshots, then resolve snapshot ids.
            const catalogRows = batchResults.flatMap(({ reverse }) => reverse?.fetchedSnapshots || []);
            if (persistSnapshots && catalogRows.length) {
                try {
                    const idRows = await persistSnapshots(catalogRows);
                    const idByKey = new Map(
                        (idRows || []).map((row) => [`${row.domain}:${row.product_id}`, row.id])
                    );
                    for (const { observation } of batchResults) {
                        if (observation.matched_snapshot_id || !observation.matched_product) continue;
                        const key = `${observation.matched_product.domain_normalized}:${observation.matched_product.product_id}`;
                        observation.matched_snapshot_id = idByKey.get(key) ?? null;
                    }
                } catch (err) {
                    log?.(`Serper Shopping: persisting ${catalogRows.length} catalog snapshots failed: ${err.message}`);
                }
            }

            observations.push(...batchResults.map(({ observation }) => observation));

            if (saveCache) {
                for (const { observation } of batchResults) {
                    if (!observation.error) {
                        cachePending.push(cacheEntryFromObservation(observation));
                    }
                }
            }

            onProgress?.({
                processed: observations.length,
                total: domains.length,
                serperRequests
            });
        })
    );

    await Promise.all(batchTasks);

    if (saveCache && cachePending.length) {
        await saveCache(cachePending);
    }

    const matched = observations.filter((o) => o.matched).length;
    const cost = serperRequests * costPerRequest;
    return {
        observations,
        serperRequests,
        cost,
        matched,
        unmatched: observations.length - matched,
        // Legacy summary keys — stage summaries and the client "Ads Matched"
        // widget read clean/ambiguous/none; matched maps onto clean.
        clean: matched,
        ambiguous: 0,
        none: observations.length - matched
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

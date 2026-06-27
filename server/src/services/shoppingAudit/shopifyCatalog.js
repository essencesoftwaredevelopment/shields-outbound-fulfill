import { createConcurrencyLimit } from '../../lib/concurrency.js';
import { detectShopify } from '../personalization/strategies/ecom.js';
import { SHOPIFY_CATALOG_LIMIT } from './constants.js';
import {
    fetchJson,
    mapShopifyVariants,
    normalizeHostname
} from './utils.js';

function parsePositiveInt(raw, fallback) {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Fail fast — slow/dead stores should not block the whole stage. */
const CATALOG_TIMEOUT_MS = parsePositiveInt(process.env.SHOPIFY_CATALOG_TIMEOUT_MS, 3500);
const CATALOG_CONCURRENCY = parsePositiveInt(process.env.SHOPIFY_CATALOG_CONCURRENCY, 25);
/** Retries only apply to HTTP 429 rate limits, not timeouts. */
const CATALOG_RETRIES = parsePositiveInt(process.env.SHOPIFY_CATALOG_RETRIES, 1);

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableCatalogError(message) {
    return /HTTP 429/i.test(message);
}

export async function fetchShopifyCatalogSample(
    domain,
    log,
    { limit = SHOPIFY_CATALOG_LIMIT, retries = CATALOG_RETRIES, timeoutMs = CATALOG_TIMEOUT_MS } = {}
) {
    const host = normalizeHostname(domain);
    const url = `https://${host}/products.json?limit=${limit}`;
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            if (attempt > 0) {
                const backoffMs = 500 * attempt + Math.random() * 250;
                log?.(`Catalog fetch retry ${attempt}/${retries} for ${host} (${Math.round(backoffMs)}ms)`);
                await sleep(backoffMs);
            }
            const data = await fetchJson(url, timeoutMs);
            const products = Array.isArray(data?.products) ? data.products : [];
            return { products, error: null };
        } catch (err) {
            lastError = err.message;
            if (attempt < retries && isRetryableCatalogError(err.message)) {
                continue;
            }
            log?.(`Catalog fetch failed for ${host}: ${err.message}`);
            return { products: [], error: lastError };
        }
    }

    return { products: [], error: lastError };
}

export function productToSnapshotRow(product, domain) {
    const variants = mapShopifyVariants(product);
    return {
        domain_normalized: normalizeHostname(domain),
        handle: product.handle,
        product_id: product.id,
        title: product.title || '',
        variants,
        tags: Array.isArray(product.tags) ? product.tags.join(', ') : String(product.tags || ''),
        image_count: Array.isArray(product.images) ? product.images.length : 0,
        published_at: product.published_at || product.created_at || null,
        review_signals: {}
    };
}

export async function runShopifyCatalogStage({
    domains,
    log,
    checkpoint,
    onProgress,
    concurrency = CATALOG_CONCURRENCY
}) {
    const results = new Array(domains.length);
    let processed = 0;
    const total = domains.length;
    const limit = createConcurrencyLimit(concurrency);

    log?.(`Shopify catalog: fetching ${total} domains (concurrency ${concurrency}, timeout ${CATALOG_TIMEOUT_MS}ms)…`);

    await Promise.all(
        domains.map((domain, index) =>
            limit(async () => {
                if (checkpoint && processed % 10 === 0) await checkpoint();

                const host = normalizeHostname(domain);
                const isShopify = await detectShopify(host, log);
                if (!isShopify) {
                    results[index] = { domain: host, isShopify: false, products: [], snapshots: [] };
                } else {
                    const { products } = await fetchShopifyCatalogSample(host, log);
                    const snapshots = products.map((p) => productToSnapshotRow(p, host));
                    results[index] = { domain: host, isShopify: true, products, snapshots };
                }

                processed += 1;
                if (processed % 5 === 0 || processed === total) {
                    const shopify = results.filter(Boolean).filter((r) => r.isShopify).length;
                    onProgress?.({ processed, total, shopify });
                }
            })
        )
    );

    return {
        results,
        shopifyCount: results.filter((r) => r.isShopify).length,
        nonShopifyDomains: results.filter((r) => !r.isShopify).map((r) => r.domain)
    };
}

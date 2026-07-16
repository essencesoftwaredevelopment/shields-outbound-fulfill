import https from 'https';
import http from 'http';
import {
    DEFAULT_AUDIT_FEATURES,
    MIN_SHOPPING_MATCH_SCORE,
    MIN_SHOPPING_TITLE_SIMILARITY
} from './constants.js';

export function normalizeHostname(urlOrDomain) {
    let hostname = String(urlOrDomain || '').trim().toLowerCase();
    hostname = hostname.replace(/^www\./, '');
    try {
        if (hostname.includes('://')) {
            hostname = new URL(hostname).hostname.replace(/^www\./, '');
        }
    } catch {
        // domain string
    }
    return hostname;
}

export function domainRootLabel(domain) {
    const host = normalizeHostname(domain);
    const parts = host.split('.');
    if (parts.length >= 2) {
        return parts[parts.length - 2];
    }
    return host;
}

export function normalizeProductTitle(title) {
    return String(title || '')
        .replace(/\s+/g, ' ')
        .replace(/\b(size|sz|colour|color|uk|us|eu)\s*[:\-]?\s*\w+/gi, '')
        .replace(/\(\s*[^)]*\s*\)/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Serper Shopping search query: "{domain} {hero product title}".
 * @deprecated Hero-first path removed from production (2026-07) — the pipeline
 * now queries the bare domain. Retained for the spike scripts' --compare mode.
 */
export function buildSerperShoppingQuery(domain, productTitle) {
    const host = normalizeHostname(domain);
    const title = normalizeProductTitle(productTitle);
    if (!host && !title) return '';
    if (!title) return host;
    if (!host) return title;
    return `${host} ${title}`;
}

export function parsePriceValue(raw) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    const text = String(raw).trim();
    if (!text) return null;
    const cleaned = text.replace(/[^0-9.,]/g, '');
    if (!cleaned) return null;
    const normalized = cleaned.includes(',') && cleaned.includes('.')
        ? cleaned.replace(/,/g, '')
        : cleaned.replace(',', '.');
    const value = parseFloat(normalized);
    return Number.isFinite(value) ? value : null;
}

/** "$66.95" / "$80" — the exact form the cold-email {{ad_price}}/{{page_price}} variables render. */
export function formatPriceUsd(value) {
    const num = parsePriceValue(value);
    if (num == null) return '';
    return `$${num.toFixed(2).replace(/\.00$/, '')}`;
}

export function tokenize(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length > 2);
}

export function titleSimilarity(a, b) {
    const ta = new Set(tokenize(a));
    const tb = new Set(tokenize(b));
    if (!ta.size || !tb.size) return 0;
    let overlap = 0;
    for (const t of ta) {
        if (tb.has(t)) overlap += 1;
    }
    return overlap / Math.max(ta.size, tb.size);
}

export function sellerMatchesDomain(seller, domain) {
    const s = String(seller || '').toLowerCase();
    const d = normalizeHostname(domain);
    const root = domainRootLabel(d);
    if (!s || !d) return false;
    if (s.includes(d) || s.includes(root)) return true;
    return titleSimilarity(s, root) > 0.8;
}

/**
 * Brand root label that survives two-level ccTLDs — domainRootLabel() returns
 * "com" for silvershop.com.au, which breaks seller matching and false-positives
 * on any seller containing "com".
 */
export function brandRootLabel(host) {
    const parts = normalizeHostname(host).split('.');
    if (parts.length >= 3 && /^(com?|net|org)$/.test(parts[parts.length - 2]) && parts[parts.length - 1].length === 2) {
        return parts[parts.length - 3];
    }
    return domainRootLabel(host);
}

/**
 * Seller-vs-brand match, including the space-insensitive case the legacy
 * matcher misses ("Spicy Wear" → "spicywear"). Returns the method that hit so
 * observations record how the seller matched.
 */
export function matchSellerToBrand(seller, domain) {
    const s = String(seller || '').toLowerCase().trim();
    if (!s) return { matched: false, method: null };
    const host = normalizeHostname(domain);
    const root = brandRootLabel(host);
    const sConcat = s.replace(/[^a-z0-9]/g, '');
    if (s.includes(host) || s.includes(root)) return { matched: true, method: 'substring' };
    if (sConcat && (sConcat === root || sConcat.includes(root) || root.includes(sConcat))) {
        return { matched: true, method: 'concat' };
    }
    // Token similarity against the ccTLD-safe root — deliberately NOT
    // sellerMatchesDomain, whose domainRootLabel("x.com.au") === "com" makes
    // every seller containing "com" a false positive.
    if (titleSimilarity(s, root) > 0.8) return { matched: true, method: 'legacy_similarity' };
    return { matched: false, method: null };
}

/**
 * Tokens for card↔product title matching. Unlike tokenize(), keeps 2-char
 * tokens and single digits — short designators ("L3" vs "L5", "4-String" vs
 * "5-String") are often the only thing distinguishing sibling products, and
 * dropping them matched "…L3 P90" ads to "…L5 LH" catalog rows at 1.0.
 */
function productMatchTokens(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length >= 2 || /^\d$/.test(t));
}

function disjointNonEmpty(a, b) {
    return a.length > 0 && b.length > 0 && !a.some((t) => b.includes(t));
}

/** Token overlap between an ad-card title and a catalog product title, brand tokens stripped. */
export function cardToProductSimilarity(cardTitle, productTitle, root) {
    const strip = (tokens) => tokens.filter((t) => !root.includes(t));
    const ta = new Set(strip(productMatchTokens(cardTitle)));
    const tb = new Set(strip(productMatchTokens(productTitle)));
    if (!ta.size || !tb.size) return { lenient: 0, strict: 0 };

    // Sibling-product veto: same-series products ("…D5 Bass" vs "…P7 4-String",
    // "12-pack" vs "24-pack") share their wordy tokens and differ only in the
    // designators, so plain overlap scores them as matches. Compare model-like
    // tokens (letter+digit: d5, p90) and pure numbers (4, 24) as separate
    // families — if either family is present on both sides with no agreement,
    // these are different products.
    const models = (tokens) => [...tokens].filter((t) => /\d/.test(t) && /[a-z]/.test(t));
    const numbers = (tokens) => [...tokens].filter((t) => /^\d+$/.test(t));
    if (disjointNonEmpty(models(ta), models(tb)) || disjointNonEmpty(numbers(ta), numbers(tb))) {
        return { lenient: 0, strict: 0 };
    }

    let overlap = 0;
    for (const t of ta) {
        if (tb.has(t)) overlap += 1;
    }
    return {
        lenient: overlap / Math.min(ta.size, tb.size),
        strict: overlap / Math.max(ta.size, tb.size)
    };
}

/** Best catalog snapshot row for a card title by lenient similarity (strict tiebreak). */
export function bestCatalogMatch(cardFields, snapshots, root) {
    let best = null;
    for (const snapshot of snapshots || []) {
        const title = snapshot?.title || '';
        if (!title) continue;
        const sim = cardToProductSimilarity(cardFields.title, title, root);
        if (!best || sim.lenient > best.similarity_lenient
            || (sim.lenient === best.similarity_lenient && sim.strict > best.similarity_strict)) {
            best = {
                snapshot,
                similarity_lenient: Number(sim.lenient.toFixed(3)),
                similarity_strict: Number(sim.strict.toFixed(3))
            };
        }
    }
    return best;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_REDIRECTS = 5;

function resolveRedirectUrl(fromUrl, location) {
    if (!location) return null;
    try {
        return new URL(location, fromUrl).href;
    } catch {
        return null;
    }
}

function fetchUrlOnce(url, timeout, method) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        const timeoutId = setTimeout(() => {
            req.destroy();
            reject(new Error('Request timeout'));
        }, timeout);

        const req = protocol.request(url, {
            method,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                Accept: 'application/json, text/html, */*',
                'Accept-Language': 'en-US,en;q=0.9'
            },
            maxHeaderSize: 65536
        }, (res) => {
            clearTimeout(timeoutId);
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    body: data,
                    url
                });
            });
        });

        req.on('error', (err) => {
            clearTimeout(timeoutId);
            reject(err);
        });
        req.end();
    });
}

export function fetchUrl(url, timeout = 5000, method = 'GET', options = {}) {
    const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

    const follow = (currentUrl, redirectsLeft) => fetchUrlOnce(currentUrl, timeout, method).then((result) => {
        if (REDIRECT_STATUSES.has(result.statusCode) && redirectsLeft > 0) {
            const nextUrl = resolveRedirectUrl(currentUrl, result.headers?.location);
            if (!nextUrl) return result;
            return follow(nextUrl, redirectsLeft - 1);
        }
        return result;
    });

    return follow(url, maxRedirects);
}

export function fetchJson(url, timeout = 5000) {
    return fetchUrl(url, timeout).then(({ statusCode, body }) => {
        if (statusCode !== 200) {
            throw new Error(`HTTP ${statusCode}`);
        }
        return JSON.parse(body);
    });
}

export function extractCardFields(card = {}) {
    const price = card.price ?? card.extracted_price ?? card.priceValue ?? null;
    const seller = card.source ?? card.merchant ?? card.seller ?? card.store ?? null;
    const link = card.link ?? card.url ?? card.destination_url ?? card.productLink ?? null;
    const title = card.title ?? card.name ?? '';
    const rating = card.rating ?? card.stars ?? null;
    const ratingCount = card.ratingCount ?? card.reviews ?? card.reviewCount ?? null;
    const delivery = card.delivery ?? card.shipping ?? '';
    const priceTag = card.priceTag ?? card.tag ?? '';
    return {
        title: String(title || ''),
        price: price != null ? String(price) : null,
        priceValue: parsePriceValue(price),
        seller: seller != null ? String(seller) : null,
        link: link != null ? String(link) : null,
        rating: rating != null ? Number(rating) : null,
        ratingCount: ratingCount != null ? Number(ratingCount) : null,
        delivery: String(delivery || ''),
        priceTag: String(priceTag || ''),
        raw: card
    };
}

/** Compact card for JSONB storage — omits nested Serper raw payloads. */
export function slimCardFields(card = {}) {
    const fields = extractCardFields(card);
    return {
        title: fields.title,
        price: fields.price,
        priceValue: fields.priceValue,
        seller: fields.seller,
        link: fields.link,
        rating: fields.rating,
        ratingCount: fields.ratingCount,
        delivery: fields.delivery,
        priceTag: fields.priceTag
    };
}

export function slimCardsForStorage(cards) {
    return (cards || []).map((card) => slimCardFields(card));
}

export function classifyCard(cardFields) {
    const hasPrice = cardFields.priceValue != null || !!cardFields.price;
    const hasSeller = !!cardFields.seller;
    const hasLink = !!cardFields.link;
    if (hasPrice && hasSeller && hasLink) return 'clean';
    if (cardFields.title) return 'ambiguous';
    return 'none';
}

/**
 * @deprecated Hero-first matcher — removed from production (2026-07) in favor
 * of domain-first matching (matchSellerToBrand + bestCatalogMatch). Retained
 * for the spike scripts' --compare mode; delete together with them.
 */
export function matchShoppingCard(cards, { domain, productTitle, feedPrice }) {
    const normalizedTitle = normalizeProductTitle(productTitle);
    let best = null;
    let bestScore = 0;

    for (const card of cards || []) {
        const fields = extractCardFields(card);
        if (!fields.title) continue;

        if (!sellerMatchesDomain(fields.seller, domain)) continue;

        const titleSim = titleSimilarity(normalizedTitle, fields.title);
        if (titleSim < MIN_SHOPPING_TITLE_SIMILARITY) continue;

        let score = 0.5;
        score += titleSim * 0.35;
        if (feedPrice != null && fields.priceValue != null) {
            const ratio = Math.min(feedPrice, fields.priceValue) / Math.max(feedPrice, fields.priceValue);
            if (ratio > 0.85) score += 0.15;
        }
        if (score > bestScore) {
            bestScore = score;
            best = fields;
        }
    }

    if (!best || bestScore < MIN_SHOPPING_MATCH_SCORE) {
        return { match: null, branch: 'none', score: bestScore };
    }

    const branch = classifyCard(best);
    return { match: best, branch, score: bestScore };
}

export function heroVariantPrice(variants = []) {
    const inStock = variants.filter((v) => v.available !== false);
    const pool = inStock.length ? inStock : variants;
    if (!pool.length) return null;
    return Math.max(...pool.map((v) => parsePriceValue(v.price)).filter((p) => p != null));
}

export function lowestInStockPrice(variants = []) {
    const inStock = variants.filter((v) => v.available !== false);
    const pool = inStock.length ? inStock : variants;
    const prices = pool.map((v) => parsePriceValue(v.price)).filter((p) => p != null);
    return prices.length ? Math.min(...prices) : null;
}

export function mapShopifyVariants(product) {
    return (product.variants || []).map((v) => ({
        variant_id: v.id,
        title: v.title,
        price: v.price,
        compare_at_price: v.compare_at_price,
        available: v.available,
        option1: v.option1,
        option2: v.option2,
        option3: v.option3,
        sku: v.sku
    }));
}

export function evaluateTitleQuality(title, brandHint = '') {
    const text = String(title || '').trim();
    if (!text) {
        return { fires: true, issues: ['empty_title'] };
    }
    const issues = [];
    const brand = String(brandHint || domainRootLabel(brandHint)).toLowerCase();
    const words = text.split(/\s+/);
    if (brand && words[0]?.toLowerCase() === brand) {
        issues.push('brand_front_loaded');
    }
    if (text.length > 70) {
        issues.push('truncation_risk');
    }
    const hasSizeOrColor = /\b(size|colour|color|ml|oz|cm|mm|inch|ft)\b/i.test(text);
    if (!hasSizeOrColor && words.length < 4) {
        issues.push('missing_attributes');
    }
    return { fires: issues.length > 0, issues };
}

/**
 * Shopping card links are usually Google redirect URLs — checking them probes
 * Google (which rate-limits with 429s), not the merchant's page, so a broken
 * verdict there is meaningless.
 */
export function isCheckableDestination(url) {
    try {
        const host = new URL(url).hostname.toLowerCase();
        return !/(^|\.)google\.[a-z.]+$|(^|\.)googleadservices\.com$/.test(host);
    } catch {
        return false;
    }
}

export async function checkDestinationPage(url, timeout = 8000) {
    if (!url) return { broken: true, reason: 'missing_url', statusCode: null };
    try {
        const res = await fetchUrl(url, timeout, 'GET');
        const status = res.statusCode || 0;
        // Rate limiting / bot blocking says nothing about the page itself.
        if (status === 429 || status === 403) {
            return { broken: false, reason: 'inconclusive_blocked', statusCode: status };
        }
        if (status >= 400) {
            return { broken: true, reason: 'http_error', statusCode: status };
        }
        const body = String(res.body || '').toLowerCase();
        if (body.includes('page not found') || body.includes('404') && body.length < 50000) {
            return { broken: true, reason: 'soft_404', statusCode: status };
        }
        if (body.includes('collection') && !body.includes('product')) {
            return { broken: true, reason: 'redirect_to_category', statusCode: status };
        }
        return { broken: false, reason: null, statusCode: status };
    } catch (err) {
        return { broken: true, reason: err.message, statusCode: null };
    }
}

export function mergeAuditFeatures(settingsFeatures = {}) {
    const base = { ...DEFAULT_AUDIT_FEATURES };
    return { ...base, ...(settingsFeatures || {}) };
}

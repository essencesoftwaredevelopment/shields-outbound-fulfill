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

/** Serper Shopping search query: "{domain} {hero product title}". */
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

export async function checkDestinationPage(url, timeout = 8000) {
    if (!url) return { broken: true, reason: 'missing_url', statusCode: null };
    try {
        const res = await fetchUrl(url, timeout, 'GET');
        const status = res.statusCode || 0;
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

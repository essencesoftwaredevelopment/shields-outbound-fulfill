import { extractCardFields, fetchUrl, parsePriceValue } from './utils.js';

const HEADLESS_TIMEOUT_MS = Math.max(
    Number(process.env.HEADLESS_RESCUE_TIMEOUT_MS || 45000) || 45000,
    5000
);

let playwrightModule = null;

async function loadPlaywright() {
    if (playwrightModule) return playwrightModule;
    try {
        playwrightModule = await import('playwright');
        return playwrightModule;
    } catch {
        throw new Error('Playwright is not installed. Run: npm install playwright');
    }
}

function buildProxyOption() {
    const proxyUrl = process.env.HEADLESS_PROXY_URL || '';
    if (!proxyUrl) return undefined;
    try {
        const parsed = new URL(proxyUrl);
        return {
            server: `${parsed.protocol}//${parsed.host}`,
            username: parsed.username || undefined,
            password: parsed.password || undefined
        };
    } catch {
        return { server: proxyUrl };
    }
}

/**
 * Headless rescue for ambiguous Serper results — loads Shopping SERP and reads card + PDP price.
 */
export async function rescueAmbiguousAd({
    domain,
    productTitle,
    geo,
    log
}) {
    const pw = await loadPlaywright();
    const browser = await pw.chromium.launch({ headless: true });
    const context = await browser.newContext({
        locale: geo?.hl || 'en-US',
        geolocation: { latitude: 37.7749, longitude: -122.4194 },
        proxy: buildProxyOption(),
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    const query = encodeURIComponent(productTitle);
    const searchUrl = `https://www.google.com/search?tbm=shop&q=${query}&gl=${geo?.gl || 'us'}&hl=${geo?.hl || 'en'}`;

    try {
        const page = await context.newPage();
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: HEADLESS_TIMEOUT_MS });
        await page.waitForTimeout(2000);

        const cards = await page.evaluate((storeDomain) => {
            const results = [];
            const nodes = document.querySelectorAll('[data-docid], .sh-dgr__grid-result, .i0Xkdf');
            nodes.forEach((node) => {
                const titleEl = node.querySelector('h3, h4, .tAxDx');
                const priceEl = node.querySelector('[aria-label*="price"], .a8Pemb, .KZmu8e');
                const linkEl = node.querySelector('a[href]');
                const sellerEl = node.querySelector('.E5ocAb, .IuHnof');
                const title = titleEl?.textContent?.trim() || '';
                const price = priceEl?.textContent?.trim() || priceEl?.getAttribute('aria-label') || '';
                const link = linkEl?.href || '';
                const seller = sellerEl?.textContent?.trim() || '';
                if (title) {
                    results.push({ title, price, link, source: seller, domainHint: storeDomain });
                }
            });
            return results;
        }, domain);

        let matched = cards.find((c) =>
            c.source?.toLowerCase().includes(domain.split('.')[0]?.toLowerCase())
            || c.title?.toLowerCase().includes(productTitle.toLowerCase().slice(0, 20))
        ) || cards[0];

        if (!matched) {
            return { branch: 'none', matched_card: null, all_cards: cards, source: 'headless' };
        }

        let pdpPrice = parsePriceValue(matched.price);
        if (matched.link) {
            try {
                const pdp = await fetchUrl(matched.link, 8000);
                const priceMatch = String(pdp.body || '').match(/\$[\d,]+(?:\.\d{2})?|£[\d,]+(?:\.\d{2})?|€[\d,]+(?:\.\d{2})?/);
                if (priceMatch) {
                    pdpPrice = parsePriceValue(priceMatch[0]);
                }
            } catch (err) {
                log?.(`Headless PDP fetch failed for ${domain}: ${err.message}`);
            }
        }

        const fields = extractCardFields({
            title: matched.title,
            price: matched.price,
            link: matched.link,
            source: matched.source
        });
        if (pdpPrice != null) {
            fields.priceValue = pdpPrice;
        }

        const branch = fields.price && fields.link && fields.seller ? 'clean' : 'ambiguous';
        return {
            branch,
            matched_card: fields,
            all_cards: cards,
            source: 'headless',
            observed_at: new Date().toISOString()
        };
    } finally {
        await browser.close().catch(() => {});
    }
}

export async function runHeadlessRescueBatch({
    observations,
    features,
    log,
    checkpoint,
    concurrency = Math.max(1, parseInt(process.env.HEADLESS_RESCUE_CONCURRENCY || '2', 10))
}) {
    const rescued = [];
    let processed = 0;
    const geo = features?.serperGeo || { gl: 'us', hl: 'en' };
    const costPerRescue = Number(process.env.HEADLESS_RESCUE_COST || 0.05);

    const candidates = observations.filter((o) => {
        if (o.branch !== 'ambiguous') return false;
        const snap = o.selection?.snapshot;
        return snap && passesHeadlessGate(snap, features);
    });

    for (let i = 0; i < candidates.length; i += concurrency) {
        if (checkpoint) await checkpoint();
        const batch = candidates.slice(i, i + concurrency);
        const batchResults = await Promise.all(
            batch.map(async (obs) => {
                try {
                    const result = await rescueAmbiguousAd({
                        domain: obs.domain,
                        productTitle: obs.selection.snapshot.title,
                        geo,
                        log
                    });
                    return { ...obs, ...result, headlessRescued: true };
                } catch (err) {
                    log?.(`Headless rescue failed for ${obs.domain}: ${err.message}`);
                    return obs;
                }
            })
        );
        rescued.push(...batchResults);
        processed += batch.length;
    }

    const merged = observations.map((obs) => {
        const updated = rescued.find((r) => r.domain === obs.domain && r.headlessRescued);
        return updated || obs;
    });

    return {
        observations: merged,
        headlessCount: rescued.filter((r) => r.headlessRescued).length,
        cost: rescued.filter((r) => r.headlessRescued).length * costPerRescue
    };
}

function passesHeadlessGate(snapshot, features) {
    const minPrice = Number(features?.headlessMinPrice ?? 75);
    const variants = snapshot?.variants || [];
    const prices = variants.map((v) => parsePriceValue(v.price)).filter((p) => p != null);
    const maxPrice = prices.length ? Math.max(...prices) : 0;
    const reviews = snapshot?.review_signals?.review_count || 0;
    return maxPrice >= minPrice || reviews > 0;
}

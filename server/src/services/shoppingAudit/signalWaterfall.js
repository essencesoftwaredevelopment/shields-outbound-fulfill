import {
    SIGNAL_ISSUE_LABELS,
    SIGNAL_TYPES,
    SIGNAL_WATERFALL
} from './constants.js';
import {
    checkDestinationPage,
    domainRootLabel,
    evaluateTitleQuality,
    extractCardFields,
    formatPriceUsd,
    lowestInStockPrice,
    parsePriceValue,
    sellerMatchesDomain
} from './utils.js';
import { createConcurrencyLimit } from '../../lib/concurrency.js';

const DESTINATION_CHECK_TIMEOUT_MS = 6000;
const DESTINATION_CHECK_CONCURRENCY = 8;

function finiteOr(raw, fallback) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
}

function detectPriceMismatch(snapshot, adCard, features) {
    const pagePrice = lowestInStockPrice(snapshot.variants);
    const adPrice = adCard?.priceValue ?? parsePriceValue(adCard?.price);
    if (pagePrice == null || adPrice == null) return { fires: false };
    const delta = Math.abs(pagePrice - adPrice);

    // The emails quote both numbers, so trivial deltas would undercut the
    // loss-aversion premise. Floor of $0.01 keeps identical prices from firing
    // even if both thresholds are configured to 0.
    const minPct = finiteOr(features?.priceMismatchMinDeltaPct, 2.5);
    const minUsd = finiteOr(features?.priceMismatchMinDeltaUsd, 0.75);
    const threshold = Math.max(0.01, minUsd, pagePrice * (minPct / 100));
    if (delta < threshold) return { fires: false };

    return {
        fires: true,
        observed: { ad_price: adPrice, currency: 'USD' },
        expected: { page_price: pagePrice, currency: 'USD' }
    };
}

function detectStockMismatch(snapshot, adCard) {
    if (!adCard) return { fires: false };
    const anyInStock = (snapshot.variants || []).some((v) => v.available !== false);
    if (anyInStock) return { fires: false };
    return {
        fires: true,
        observed: { ad_buyable: true },
        expected: { page_in_stock: false }
    };
}

function detectReviewGap(snapshot, adCard) {
    const reviews = snapshot.review_signals || {};
    const reviewCount = reviews.review_count || 0;
    if (reviewCount < 1) return { fires: false };
    const adRating = adCard?.rating;
    if (adRating != null && adRating > 0) return { fires: false };
    return {
        fires: true,
        observed: { ad_stars: adRating ?? null },
        expected: { page_review_count: reviewCount, page_rating: reviews.rating_value ?? null }
    };
}

function detectCompetitorStars(targetCard, allCards, domain) {
    const target = extractCardFields(targetCard?.raw || targetCard || {});
    if (target.rating != null && target.rating > 0) return { fires: false };
    const competitors = (allCards || [])
        .map((c) => extractCardFields(c))
        .filter((c) => c.title && !sellerMatchesDomain(c.seller, domain));
    const rival = competitors.find((c) => c.rating != null && c.rating >= 4);
    if (!rival) return { fires: false };
    return {
        fires: true,
        observed: { ad_stars: null },
        expected: { competitor_stars: rival.rating },
        competitor_ref: { seller: rival.seller, title: rival.title, rating: rival.rating }
    };
}

function detectCompetitorSale(targetCard, allCards, domain) {
    const target = extractCardFields(targetCard?.raw || targetCard || {});
    const targetOnSale = /sale|was|save|%/i.test(target.priceTag || target.price || '');
    if (targetOnSale) return { fires: false };
    const competitors = (allCards || [])
        .map((c) => extractCardFields(c))
        .filter((c) => c.title && !sellerMatchesDomain(c.seller, domain));
    const rival = competitors.find((c) => /sale|was|save|%/i.test(`${c.priceTag} ${c.price}`));
    if (!rival) return { fires: false };
    return {
        fires: true,
        observed: { ad_sale_annotation: false },
        expected: { competitor_sale: true },
        competitor_ref: { seller: rival.seller, title: rival.title, price: rival.price }
    };
}

function detectCompetitorShipping(targetCard, allCards, domain) {
    const target = extractCardFields(targetCard?.raw || targetCard || {});
    const targetFree = /free shipping|free delivery/i.test(target.delivery || '');
    if (targetFree) return { fires: false };
    const competitors = (allCards || [])
        .map((c) => extractCardFields(c))
        .filter((c) => c.title && !sellerMatchesDomain(c.seller, domain));
    const rival = competitors.find((c) => /free shipping|free delivery/i.test(c.delivery || ''));
    if (!rival) return { fires: false };
    return {
        fires: true,
        observed: { ad_shipping_annotation: false },
        expected: { competitor_free_shipping: true },
        competitor_ref: { seller: rival.seller, title: rival.title, delivery: rival.delivery }
    };
}

function detectTitleQuality(snapshot) {
    const brand = domainRootLabel(snapshot.domain_normalized);
    const result = evaluateTitleQuality(snapshot.title, brand);
    if (!result.fires) return { fires: false };
    return {
        fires: true,
        observed: { feed_title: snapshot.title, issues: result.issues },
        expected: { title_best_practice: 'category_first_attributes_mid_brand_last' }
    };
}

async function detectBrokenPage(adCard, destinationChecks) {
    const link = adCard?.link;
    if (!link) return { fires: false };
    const check = destinationChecks?.get?.(link)
        || await checkDestinationPage(link, DESTINATION_CHECK_TIMEOUT_MS);
    if (!check.broken) return { fires: false };
    return {
        fires: true,
        observed: { destination_url: link, page_status: check.statusCode, reason: check.reason },
        expected: { live_product_page: true }
    };
}

const DETECTORS = {
    [SIGNAL_TYPES.PRICE_MISMATCH]: ({ snapshot, adCard, features }) =>
        detectPriceMismatch(snapshot, adCard, features),
    [SIGNAL_TYPES.STOCK_MISMATCH]: ({ snapshot, adCard }) => detectStockMismatch(snapshot, adCard),
    [SIGNAL_TYPES.REVIEW_GAP]: ({ snapshot, adCard }) => detectReviewGap(snapshot, adCard),
    [SIGNAL_TYPES.TITLE_QUALITY]: ({ snapshot }) => detectTitleQuality(snapshot),
    [SIGNAL_TYPES.BROKEN_PAGE]: async ({ adCard, destinationChecks }) =>
        detectBrokenPage(adCard, destinationChecks),
    [SIGNAL_TYPES.NO_STARS_VS_COMPETITOR]: ({ adCard, allCards, domain }) =>
        detectCompetitorStars(adCard, allCards, domain),
    [SIGNAL_TYPES.NO_SALE_VS_COMPETITOR]: ({ adCard, allCards, domain }) =>
        detectCompetitorSale(adCard, allCards, domain),
    [SIGNAL_TYPES.NO_SHIPPING_VS_COMPETITOR]: ({ adCard, allCards, domain }) =>
        detectCompetitorShipping(adCard, allCards, domain)
};

/**
 * Cold-email variables for the results CSV / Instantly upload.
 * product_short is patched in later by the personalization stage (LLM).
 */
export function buildSignalExportVars({ signalType, observed = {}, expected = {}, snapshot, adCard }) {
    const card = adCard ? extractCardFields(adCard.raw || adCard) : null;
    const adPriceValue = observed.ad_price ?? card?.priceValue ?? parsePriceValue(card?.price);
    const pagePriceValue = expected.page_price ?? lowestInStockPrice(snapshot?.variants || []);
    const product = snapshot?.title || observed.ad_title || observed.feed_title || card?.title || '';
    return {
        product,
        issue: SIGNAL_ISSUE_LABELS[signalType] ?? '',
        ad_price: formatPriceUsd(adPriceValue),
        page_price: formatPriceUsd(pagePriceValue),
        ad_price_value: adPriceValue ?? null,
        page_price_value: pagePriceValue ?? null
    };
}

function compactSignal(type, tier, result) {
    return {
        signal_type: type,
        tier,
        observed: result.observed || {},
        expected: result.expected || {},
        competitor_ref: result.competitor_ref || null
    };
}

/**
 * Evaluate ALL eligible detectors. The first match in waterfall order becomes the
 * primary signal (drives {{issue}}); every other match is kept in secondary_signals
 * so leads researched via Serper are never wasted — the CSV carries everything and
 * campaign routing happens manually in Instantly.
 */
export async function runSignalWaterfall({
    snapshot,
    observation,
    domain,
    features,
    enableTier2 = true,
    enableBrokenPage = true,
    destinationChecks = null
}) {
    const adCard = observation?.matched_card;
    const allCards = observation?.all_cards || [];
    const hasAd = observation?.branch === 'clean' || observation?.branch === 'ambiguous';
    const context = { snapshot, adCard, allCards, domain, destinationChecks, features };
    const observedAt = observation?.observed_at || new Date().toISOString();

    const fired = [];
    for (const step of SIGNAL_WATERFALL) {
        if (step.requiresAd && !hasAd) continue;
        if (step.tier === 2 && !enableTier2) continue;
        if (step.type === SIGNAL_TYPES.BROKEN_PAGE && !enableBrokenPage) continue;
        if (step.type === SIGNAL_TYPES.TITLE_QUALITY && features?.titleQualityFallback === false) continue;

        const detector = DETECTORS[step.type];
        if (!detector) continue;
        const result = await detector(context);
        if (result?.fires) {
            fired.push(compactSignal(step.type, step.tier, result));
        }
    }

    let primary = fired[0] || null;
    const secondary = fired.slice(1);

    if (!primary && hasAd) {
        const adFields = extractCardFields(adCard?.raw || adCard || {});
        primary = {
            signal_type: SIGNAL_TYPES.AD_MATCH,
            tier: 3,
            observed: {
                ad_title: adFields.title || snapshot?.title || null,
                feed_title: snapshot?.title || null,
                branch: observation?.branch || null
            },
            expected: {},
            competitor_ref: null
        };
    }

    if (!primary) return null;

    return {
        ...primary,
        observed_at: observedAt,
        secondary_signals: secondary,
        export_vars: buildSignalExportVars({
            signalType: primary.signal_type,
            observed: primary.observed,
            expected: primary.expected,
            snapshot,
            adCard
        })
    };
}

/**
 * Destination-page health checks for every matched ad link, run concurrently up
 * front so the per-domain waterfall loop stays synchronous and a slow site can't
 * serialize the whole batch.
 */
export async function precomputeDestinationChecks(rows, {
    concurrency = DESTINATION_CHECK_CONCURRENCY,
    timeoutMs = DESTINATION_CHECK_TIMEOUT_MS,
    log
} = {}) {
    const links = new Set();
    for (const row of rows || []) {
        const hasAd = row?.branch === 'clean' || row?.branch === 'ambiguous';
        const link = row?.matched_card?.link;
        if (hasAd && link) links.add(link);
    }

    const map = new Map();
    if (!links.size) return map;

    const limit = createConcurrencyLimit(concurrency);
    await Promise.all(
        [...links].map((link) =>
            limit(async () => {
                map.set(link, await checkDestinationPage(link, timeoutMs));
            })
        )
    );
    const broken = [...map.values()].filter((c) => c.broken).length;
    log?.(`Destination checks: ${map.size} ad links checked (${broken} broken)`);
    return map;
}

export async function runSignalWaterfallStage({
    selectionsWithObservations,
    features,
    log,
    enableTier2 = true,
    enableBrokenPage = false
}) {
    const destinationChecks = enableBrokenPage
        ? await precomputeDestinationChecks(selectionsWithObservations, { log })
        : null;

    const emissions = [];
    for (const row of selectionsWithObservations) {
        const snap = row.selection?.snapshot;
        if (!snap) continue;
        const signal = await runSignalWaterfall({
            snapshot: snap,
            observation: row,
            domain: row.domain,
            features,
            enableTier2,
            enableBrokenPage,
            destinationChecks
        });
        if (signal) {
            emissions.push({ domain: row.domain, selection: row.selection, observation: row, signal });
        }
    }
    log?.(`Signal waterfall: ${emissions.length} signals emitted`);
    return emissions;
}

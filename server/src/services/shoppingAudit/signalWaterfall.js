import {
    SIGNAL_TYPES,
    SIGNAL_WATERFALL
} from './constants.js';
import {
    checkDestinationPage,
    domainRootLabel,
    evaluateTitleQuality,
    extractCardFields,
    lowestInStockPrice,
    parsePriceValue,
    sellerMatchesDomain
} from './utils.js';

function detectPriceMismatch(snapshot, adCard) {
    const pagePrice = lowestInStockPrice(snapshot.variants);
    const adPrice = adCard?.priceValue ?? parsePriceValue(adCard?.price);
    if (pagePrice == null || adPrice == null) return { fires: false };
    const delta = Math.abs(pagePrice - adPrice);
    if (delta < 0.01) return { fires: false };
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

async function detectBrokenPage(adCard) {
    const link = adCard?.link;
    if (!link) return { fires: false };
    const check = await checkDestinationPage(link);
    if (!check.broken) return { fires: false };
    return {
        fires: true,
        observed: { destination_url: link, page_status: check.statusCode, reason: check.reason },
        expected: { live_product_page: true }
    };
}

const DETECTORS = {
    [SIGNAL_TYPES.PRICE_MISMATCH]: ({ snapshot, adCard }) => detectPriceMismatch(snapshot, adCard),
    [SIGNAL_TYPES.STOCK_MISMATCH]: ({ snapshot, adCard }) => detectStockMismatch(snapshot, adCard),
    [SIGNAL_TYPES.REVIEW_GAP]: ({ snapshot, adCard }) => detectReviewGap(snapshot, adCard),
    [SIGNAL_TYPES.TITLE_QUALITY]: ({ snapshot }) => detectTitleQuality(snapshot),
    [SIGNAL_TYPES.BROKEN_PAGE]: async ({ adCard }) => detectBrokenPage(adCard),
    [SIGNAL_TYPES.NO_STARS_VS_COMPETITOR]: ({ adCard, allCards, domain }) =>
        detectCompetitorStars(adCard, allCards, domain),
    [SIGNAL_TYPES.NO_SALE_VS_COMPETITOR]: ({ adCard, allCards, domain }) =>
        detectCompetitorSale(adCard, allCards, domain),
    [SIGNAL_TYPES.NO_SHIPPING_VS_COMPETITOR]: ({ adCard, allCards, domain }) =>
        detectCompetitorShipping(adCard, allCards, domain)
};

export async function runSignalWaterfall({
    snapshot,
    observation,
    domain,
    features,
    enableTier2 = true,
    enableBrokenPage = true
}) {
    const adCard = observation?.matched_card;
    const allCards = observation?.all_cards || [];
    const hasAd = observation?.branch === 'clean' || observation?.branch === 'ambiguous';
    const context = { snapshot, adCard, allCards, domain };

    for (const step of SIGNAL_WATERFALL) {
        if (step.requiresAd && !hasAd) continue;
        if (step.tier === 2 && !enableTier2) continue;
        if (step.type === SIGNAL_TYPES.BROKEN_PAGE && !enableBrokenPage) continue;
        if (step.type === SIGNAL_TYPES.TITLE_QUALITY && hasAd && observation?.branch === 'clean') {
            // title quality is fallback when no ad or as last resort
        }

        const detector = DETECTORS[step.type];
        if (!detector) continue;
        const result = await detector(context);
        if (result?.fires) {
            return {
                signal_type: step.type,
                tier: step.tier,
                observed: result.observed || {},
                expected: result.expected || {},
                competitor_ref: result.competitor_ref || null,
                observed_at: observation?.observed_at || new Date().toISOString()
            };
        }
    }

    if (hasAd) {
        const adFields = extractCardFields(adCard?.raw || adCard || {});
        return {
            signal_type: SIGNAL_TYPES.AD_MATCH,
            tier: 3,
            observed: {
                ad_title: adFields.title || snapshot?.title || null,
                feed_title: snapshot?.title || null,
                branch: observation?.branch || null
            },
            expected: {},
            competitor_ref: null,
            observed_at: observation?.observed_at || new Date().toISOString()
        };
    }

    if (features?.titleQualityFallback !== false) {
        const titleResult = detectTitleQuality(snapshot);
        if (titleResult.fires) {
            return {
                signal_type: SIGNAL_TYPES.TITLE_QUALITY,
                tier: 3,
                observed: titleResult.observed || {},
                expected: titleResult.expected || {},
                competitor_ref: null,
                observed_at: new Date().toISOString()
            };
        }
    }

    return null;
}

export async function runSignalWaterfallStage({
    selectionsWithObservations,
    features,
    log,
    enableTier2 = true,
    enableBrokenPage = false
}) {
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
            enableBrokenPage
        });
        if (signal) {
            emissions.push({ domain: row.domain, selection: row.selection, observation: row, signal });
        }
    }
    log?.(`Signal waterfall: ${emissions.length} signals emitted`);
    return emissions;
}

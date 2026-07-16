export const SERPER_SHOPPING_URL = 'https://google.serper.dev/shopping';

export const DEFAULT_SERPER_GEO = {
    gl: 'us',
    hl: 'en',
    location: 'United States'
};

function envInt(name, fallback) {
    const n = parseInt(process.env[name], 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envFloat(name, fallback) {
    const n = parseFloat(process.env[name]);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Max products pulled from /products.json per store, per page. */
export const SHOPIFY_CATALOG_LIMIT = envInt('SHOPPING_CATALOG_PAGE_LIMIT', 50);

/** Max /products.json pages fetched per store during reverse card→catalog matching. */
export const SHOPPING_CATALOG_MAX_PAGES = envInt('SHOPPING_CATALOG_MAX_PAGES', 10);

/** Minimum lenient card-title vs product-title token overlap to count as matched. */
export const MIN_CARD_PRODUCT_SIMILARITY = envFloat('SHOPPING_MIN_CARD_PRODUCT_SIM', 0.6);

/** Max seller-matched Shopping cards reverse-matched against the catalog per domain. */
export const MAX_SELLER_CARDS = envInt('SHOPPING_MAX_SELLER_CARDS', 5);

/**
 * Strict similarity at which a card→product match is near-exact and catalog
 * pagination can stop searching for a better product. Below this, keep
 * scanning: sibling variants ("… LH", "5-String") pass the lenient threshold
 * while the advertised product sits on a later page.
 */
export const STRONG_MATCH_STRICT = envFloat('SHOPPING_STRONG_MATCH_STRICT', 0.9);

/** Serper Shopping results requested per query. */
export const SERPER_SHOPPING_NUM = envInt('SHOPPING_SERPER_NUM', 20);

/** Cross-domain concurrency for catalog pagination during reverse matching. */
export const CATALOG_PAGINATION_CONCURRENCY = envInt('SHOPPING_CATALOG_PAGINATION_CONCURRENCY', 4);

/**
 * @deprecated Hero-first matching only (matchShoppingCard) — removed from the
 * production path in favor of domain-first matching (2026-07).
 */
export const MIN_SHOPPING_MATCH_SCORE = 0.4;

/**
 * @deprecated Hero-first matching only (matchShoppingCard) — removed from the
 * production path in favor of domain-first matching (2026-07).
 */
export const MIN_SHOPPING_TITLE_SIMILARITY = 0.15;

export const SIGNAL_TYPES = {
    PRICE_MISMATCH: 'price_mismatch',
    STOCK_MISMATCH: 'stock_mismatch',
    BROKEN_PAGE: 'broken_page',
    REVIEW_GAP: 'review_syndication_gap',
    NO_STARS_VS_COMPETITOR: 'no_stars_vs_competitor',
    NO_SALE_VS_COMPETITOR: 'no_sale_vs_competitor',
    NO_SHIPPING_VS_COMPETITOR: 'no_shipping_vs_competitor',
    TITLE_QUALITY: 'title_quality',
    /** Matched Shopping ad but no specific issue detected — still qualify for outreach. */
    AD_MATCH: 'ad_match'
};

/**
 * Customer-style {{issue}} phrasing per signal, used verbatim in cold emails
 * ("the {{issue}} on your ad"). ad_match intentionally maps to '' so leads with
 * no detected issue surface as missing-variable rows in Instantly instead of
 * rendering a nonsense sentence.
 */
export const SIGNAL_ISSUE_LABELS = {
    [SIGNAL_TYPES.PRICE_MISMATCH]: 'price mismatch',
    [SIGNAL_TYPES.STOCK_MISMATCH]: 'stock issue',
    [SIGNAL_TYPES.BROKEN_PAGE]: 'broken link',
    [SIGNAL_TYPES.REVIEW_GAP]: 'missing reviews',
    [SIGNAL_TYPES.NO_STARS_VS_COMPETITOR]: 'missing star ratings',
    [SIGNAL_TYPES.NO_SALE_VS_COMPETITOR]: 'missing sale price',
    [SIGNAL_TYPES.NO_SHIPPING_VS_COMPETITOR]: 'missing shipping info',
    [SIGNAL_TYPES.TITLE_QUALITY]: 'weak product title',
    [SIGNAL_TYPES.AD_MATCH]: ''
};

/** Waterfall order — determines the PRIMARY signal; later matches are kept as secondary. */
export const SIGNAL_WATERFALL = [
    { type: SIGNAL_TYPES.PRICE_MISMATCH, tier: 1, requiresAd: true },
    { type: SIGNAL_TYPES.STOCK_MISMATCH, tier: 1, requiresAd: true },
    { type: SIGNAL_TYPES.BROKEN_PAGE, tier: 1, requiresAd: true },
    { type: SIGNAL_TYPES.REVIEW_GAP, tier: 1, requiresAd: true },
    { type: SIGNAL_TYPES.NO_STARS_VS_COMPETITOR, tier: 2, requiresAd: true },
    { type: SIGNAL_TYPES.NO_SALE_VS_COMPETITOR, tier: 2, requiresAd: true },
    { type: SIGNAL_TYPES.NO_SHIPPING_VS_COMPETITOR, tier: 2, requiresAd: true },
    { type: SIGNAL_TYPES.TITLE_QUALITY, tier: 3, requiresAd: false }
];

/**
 * Serper-first: the bare-domain Serper query runs first and the catalog is
 * fetched on demand only for domains with seller-matched cards. The old
 * shopifyCatalog/heroSelection stages are gone — only matched domains move
 * forward to enrichment.
 */
export const SHOPPING_AUDIT_STAGE_KEYS = [
    'serperShopping',
    'signalWaterfall'
];

export const DEFAULT_SIGNAL_TEMPLATES = {
    price_mismatch: 'I noticed your Google Shopping ad for {{product}} shows {{ad_price}}, but the live product page shows {{page_price}} — every click on that ad sends shoppers to a price they did not expect.',
    stock_mismatch: 'Your Google Shopping ad for {{product}} still shows as buyable, but that variant is sold out on your site.',
    broken_page: 'The destination URL on your Google Shopping ad for {{product}} does not land on a live product page.',
    review_syndication_gap: 'Your product page for {{product}} has {{review_count}} reviews, but your Shopping ad is not showing star ratings.',
    no_stars_vs_competitor: 'On the same Shopping search, {{competitor}} shows {{competitor_rating}} stars while your listing for {{product}} shows none.',
    no_sale_vs_competitor: 'Competitors on the same Shopping search show sale pricing for similar products, but your {{product}} listing does not.',
    no_shipping_vs_competitor: 'Competitors show free shipping on the same Shopping search, but your {{product}} listing does not.',
    title_quality: 'Your Shopping feed title for {{product}} front-loads the brand name and buries key attributes Google uses to match intent.',
    ad_match: 'Saw your Google Shopping ad for {{product}} — the listing checks out against your live product page.'
};

export const DEFAULT_AUDIT_FEATURES = {
    shoppingAudit: false,
    heroHeuristic: 'price_reviews_age',
    reauditMonths: 4,
    headlessMinPrice: 75,
    titleQualityFallback: true,
    serperGeo: DEFAULT_SERPER_GEO,
    /** price_mismatch fires only when |ad - page| >= max(minDeltaUsd, page * minDeltaPct/100). */
    priceMismatchMinDeltaPct: 2.5,
    priceMismatchMinDeltaUsd: 0.75
};

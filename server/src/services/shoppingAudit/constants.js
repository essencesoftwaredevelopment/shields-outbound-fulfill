export const SERPER_SHOPPING_URL = 'https://google.serper.dev/shopping';

export const DEFAULT_SERPER_GEO = {
    gl: 'us',
    hl: 'en',
    location: 'United States'
};

/** Max products pulled from /products.json per store (single request). */
export const SHOPIFY_CATALOG_LIMIT = 10;

/** Minimum matchShoppingCard score to treat a Serper card as this merchant's ad. */
export const MIN_SHOPPING_MATCH_SCORE = 0.4;

/** Minimum title token overlap when seller already matches the domain. */
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

/** Waterfall order — first match wins. */
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

export const SHOPPING_AUDIT_STAGE_KEYS = [
    'shopifyCatalog',
    'heroSelection',
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
    ad_match: 'Saw your ad about {{product}}, and saw 2 areas we can improve it — mind if we send over an improved version?'
};

export const DEFAULT_AUDIT_FEATURES = {
    shoppingAudit: false,
    heroHeuristic: 'price_reviews_age',
    reauditMonths: 4,
    headlessMinPrice: 75,
    titleQualityFallback: true,
    serperGeo: DEFAULT_SERPER_GEO
};

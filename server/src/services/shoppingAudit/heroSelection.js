import { heroVariantPrice, lowestInStockPrice } from './utils.js';

function parseDate(value) {
    if (!value) return 0;
    const ts = Date.parse(value);
    return Number.isFinite(ts) ? ts : 0;
}

/**
 * Select one hero product per store.
 * Heuristic: highest in-stock price → review count proxy (image_count) → oldest published_at.
 */
export function selectHeroProduct(snapshots, { heuristic = 'price_reviews_age' } = {}) {
    if (!snapshots?.length) return null;

    const scored = snapshots.map((snap) => {
        const price = heroVariantPrice(snap.variants) ?? lowestInStockPrice(snap.variants) ?? 0;
        const reviewProxy = snap.review_signals?.review_count
            ?? snap.image_count
            ?? 0;
        const publishedTs = parseDate(snap.published_at);
        return {
            snapshot: snap,
            price,
            reviewProxy,
            publishedTs
        };
    });

    scored.sort((a, b) => {
        if (b.price !== a.price) return b.price - a.price;
        if (b.reviewProxy !== a.reviewProxy) return b.reviewProxy - a.reviewProxy;
        return a.publishedTs - b.publishedTs;
    });

    const winner = scored[0];
    return {
        snapshot: winner.snapshot,
        selection_reason: {
            heuristic,
            price: winner.price,
            review_proxy: winner.reviewProxy,
            published_at: winner.snapshot.published_at,
            candidate_count: snapshots.length
        }
    };
}

export function runHeroSelectionStage(catalogResults, features, log) {
    const selections = [];
    for (const row of catalogResults) {
        if (!row.isShopify || !row.snapshots?.length) continue;
        const picked = selectHeroProduct(row.snapshots, { heuristic: features.heroHeuristic });
        if (picked) {
            selections.push({
                domain: row.domain,
                ...picked
            });
        }
    }
    log?.(`Hero selection: ${selections.length} stores`);
    return selections;
}

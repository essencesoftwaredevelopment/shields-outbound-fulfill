/** Shopify /products.json fetch tuning for ecom personalization. */
export const PRODUCT_FETCH_TIMEOUT_MS = Math.max(
    1000,
    parseInt(process.env.PRODUCT_FETCH_TIMEOUT_MS || '8000', 10)
);

export const PRODUCT_FETCH_CONCURRENCY = Math.max(
    1,
    parseInt(process.env.PRODUCT_FETCH_CONCURRENCY || '40', 10)
);

export const PERSONALIZATION_LLM_CONCURRENCY = Math.max(
    1,
    parseInt(process.env.PERSONALIZATION_LLM_CONCURRENCY || '50', 10)
);

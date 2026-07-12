-- Shopping audit: cold-email export variables + non-primary signals per domain.
-- export_vars: {product, product_short, issue, ad_price, page_price} used as
-- Instantly custom variables in the results CSV.
-- secondary_signals: signals that also fired beyond the primary (waterfall order),
-- so no researched lead is wasted when the primary signal is parked.
ALTER TABLE signal_emissions
    ADD COLUMN IF NOT EXISTS export_vars jsonb,
    ADD COLUMN IF NOT EXISTS secondary_signals jsonb;

COMMENT ON COLUMN signal_emissions.export_vars IS
    'Cold-email variables derived at emission/personalization time: product, product_short, issue, ad_price, page_price.';
COMMENT ON COLUMN signal_emissions.secondary_signals IS
    'Additional fired signals beyond the primary, in waterfall order: [{signal_type, tier, observed, expected, competitor_ref}].';

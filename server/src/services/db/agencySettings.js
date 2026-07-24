import { pool } from '../../config/db.js';

export async function getAgencySettings(agencyId) {
    const result = await pool.query(
        `SELECT * FROM agency_settings WHERE agency_id = $1`,
        [agencyId]
    );
    return result.rows[0] || null;
}

/**
 * @param {object} patch
 * @param {object} [patch.features]      Replaces the whole features object.
 * @param {object} [patch.featuresPatch] Shallow-merges into existing features. Prefer
 *        this when toggling one flag — a full `features` write from a caller that only
 *        knows about one key silently drops the others (e.g. shoppingAudit).
 */
export async function upsertAgencySettings(agencyId, patch = {}) {
    const featuresJson = patch.features != null ? JSON.stringify(patch.features) : null;
    const featuresPatchJson = patch.featuresPatch != null ? JSON.stringify(patch.featuresPatch) : null;
    await pool.query(
        `INSERT INTO agency_settings (
            agency_id, openai_key, serper_key, trykitt_key, openai_founder_model,
            email_verification_provider, pricing_overrides, features, vault_updated_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb,
            COALESCE($8::jsonb, $9::jsonb, '{}'::jsonb), NOW(), NOW())
        ON CONFLICT (agency_id) DO UPDATE SET
            openai_key = COALESCE(EXCLUDED.openai_key, agency_settings.openai_key),
            serper_key = COALESCE(EXCLUDED.serper_key, agency_settings.serper_key),
            trykitt_key = COALESCE(EXCLUDED.trykitt_key, agency_settings.trykitt_key),
            openai_founder_model = COALESCE(EXCLUDED.openai_founder_model, agency_settings.openai_founder_model),
            email_verification_provider = COALESCE(EXCLUDED.email_verification_provider, agency_settings.email_verification_provider),
            pricing_overrides = COALESCE(EXCLUDED.pricing_overrides, agency_settings.pricing_overrides),
            features = CASE
                WHEN $8::jsonb IS NOT NULL THEN EXCLUDED.features
                WHEN $9::jsonb IS NOT NULL
                    THEN COALESCE(agency_settings.features, '{}'::jsonb) || $9::jsonb
                ELSE agency_settings.features
            END,
            vault_updated_at = NOW(),
            updated_at = NOW()`,
        [
            agencyId,
            patch.openai_key ?? null,
            patch.serper_key ?? null,
            patch.trykitt_key ?? null,
            patch.openai_founder_model ?? null,
            patch.email_verification_provider ?? null,
            JSON.stringify(patch.pricing_overrides ?? {}),
            featuresJson,
            featuresPatchJson
        ]
    );
}

export function apiKeysFromSettings(settings) {
    if (!settings) return { openai: '', serper: '', trykitt: '' };
    return {
        openai: settings.openai_key || '',
        serper: settings.serper_key || '',
        trykitt: settings.trykitt_key || ''
    };
}

export function agencyFeaturesFromSettings(settings) {
    const raw = settings?.features;
    if (!raw || typeof raw !== 'object') return {};
    return raw;
}

export function hasShoppingAuditFeature(settings) {
    if (String(process.env.SHOPPING_AUDIT_ENABLED || '').toLowerCase() === 'true') {
        return true;
    }
    return agencyFeaturesFromSettings(settings).shoppingAudit === true;
}

/**
 * Whether the interested autoresponder builds the Vulcan shopping-audit
 * preview for this agency's replies. Deliberately per-agency ONLY:
 * - independent of `features.shoppingAudit` (which gates running the audit
 *   PIPELINE and is enabled for several agencies) — reply behavior must not
 *   piggyback on pipeline access;
 * - never overridden by the global SHOPPING_AUDIT_ENABLED env, which would
 *   silently flip every agency's replies to audit previews (the bug that sent
 *   audit previews for Essence/Active Fungi leads). Agencies without this
 *   flag get the legacy Essence list-growth popup preview.
 */
export function hasInterestedReplyShoppingAuditFeature(settings) {
    return agencyFeaturesFromSettings(settings).autoresponderShoppingAudit === true;
}

/**
 * Caps applied to an agency whose TryKitt key is on the free tier. Free keys throttle
 * far below the paid ~15-concurrent allowance; without these the pipeline hammers
 * TryKitt, every request retries through its backoff, and the stage crawls.
 * Deliberately conservative — raise per agency via `features.rateLimits` if a given
 * free key tolerates more.
 */
export const TRYKITT_FREE_TIER_LIMITS = Object.freeze({
    trykitt: 20,            // requests/minute
    trykittConcurrency: 2   // simultaneous calls
});

/**
 * Whether the agency's TryKitt key is on a paid plan. Absent flag = paid, which
 * preserves the behavior every existing agency already had (concurrency-only gating
 * at 15, no RPM window). A mislabeled free key is no longer silently destructive:
 * the stage now pauses with TRYKITT_THROTTLED instead of writing 'unknown' verdicts.
 */
export function isTryKittPaidAccount(settings) {
    return agencyFeaturesFromSettings(settings).trykittPaidAccount !== false;
}

/**
 * Per-agency API rate limits. TryKitt limits follow the agency's own key/plan, so
 * they live per tenant rather than in host env. Free-tier agencies get
 * TRYKITT_FREE_TIER_LIMITS; an explicit `features.rateLimits` entry overrides either
 * way, for hand-tuning a specific key. Keys mirror what createRateLimitHooks reads:
 * serper/openai/trykitt are RPM, trykittConcurrency is max simultaneous calls.
 * When nothing applies the env defaults in postgresRateLimit.js take over.
 */
export function rateLimitsFromSettings(settings) {
    const base = isTryKittPaidAccount(settings) ? {} : { ...TRYKITT_FREE_TIER_LIMITS };

    const raw = agencyFeaturesFromSettings(settings).rateLimits;
    if (!raw || typeof raw !== 'object') return base;

    const out = { ...base };
    for (const key of ['serper', 'openai', 'trykitt', 'trykittConcurrency']) {
        const parsed = Number.parseInt(String(raw[key] ?? ''), 10);
        if (Number.isFinite(parsed) && parsed > 0) out[key] = parsed;
    }
    return out;
}

export function hasVercelEnrichmentRunner(settings) {
    return agencyFeaturesFromSettings(settings).enrichmentRunner === 'vercel';
}

export async function getPricingDefaults() {
    const result = await pool.query(`SELECT data FROM pricing_defaults WHERE id = 'global'`);
    return result.rows[0]?.data || {};
}

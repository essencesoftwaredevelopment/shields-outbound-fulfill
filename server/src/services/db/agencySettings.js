import { pool } from '../../config/db.js';

export async function getAgencySettings(agencyId) {
    const result = await pool.query(
        `SELECT * FROM agency_settings WHERE agency_id = $1`,
        [agencyId]
    );
    return result.rows[0] || null;
}

export async function upsertAgencySettings(agencyId, patch = {}) {
    const featuresJson = patch.features != null ? JSON.stringify(patch.features) : null;
    await pool.query(
        `INSERT INTO agency_settings (
            agency_id, openai_key, serper_key, trykitt_key, openai_founder_model,
            email_verification_provider, pricing_overrides, features, vault_updated_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, COALESCE($8::jsonb, '{}'::jsonb), NOW(), NOW())
        ON CONFLICT (agency_id) DO UPDATE SET
            openai_key = COALESCE(EXCLUDED.openai_key, agency_settings.openai_key),
            serper_key = COALESCE(EXCLUDED.serper_key, agency_settings.serper_key),
            trykitt_key = COALESCE(EXCLUDED.trykitt_key, agency_settings.trykitt_key),
            openai_founder_model = COALESCE(EXCLUDED.openai_founder_model, agency_settings.openai_founder_model),
            email_verification_provider = COALESCE(EXCLUDED.email_verification_provider, agency_settings.email_verification_provider),
            pricing_overrides = COALESCE(EXCLUDED.pricing_overrides, agency_settings.pricing_overrides),
            features = CASE
                WHEN $8::jsonb IS NOT NULL THEN EXCLUDED.features
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
            featuresJson
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
 * Per-agency API rate limits from `features.rateLimits`. TryKitt limits follow the
 * agency's own API key/plan (a free-tier key throttles far below the paid ~15
 * concurrent), so the caps live per tenant here — the env defaults in
 * postgresRateLimit.js only apply when an agency has no override. Example:
 *   features.rateLimits = { "trykitt": 20, "trykittConcurrency": 2 }
 * Keys mirror what createRateLimitHooks reads: serper/openai/trykitt are RPM,
 * trykittConcurrency is max simultaneous calls.
 */
export function rateLimitsFromSettings(settings) {
    const raw = agencyFeaturesFromSettings(settings).rateLimits;
    if (!raw || typeof raw !== 'object') return {};
    const out = {};
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

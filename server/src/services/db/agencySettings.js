import { pool } from '../../config/db.js';

export async function getAgencySettings(agencyId) {
    const result = await pool.query(
        `SELECT * FROM agency_settings WHERE agency_id = $1`,
        [agencyId]
    );
    return result.rows[0] || null;
}

export async function upsertAgencySettings(agencyId, patch = {}) {
    await pool.query(
        `INSERT INTO agency_settings (
            agency_id, openai_key, serper_key, trykitt_key, openai_founder_model,
            email_verification_provider, pricing_overrides, vault_updated_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW(), NOW())
        ON CONFLICT (agency_id) DO UPDATE SET
            openai_key = COALESCE(EXCLUDED.openai_key, agency_settings.openai_key),
            serper_key = COALESCE(EXCLUDED.serper_key, agency_settings.serper_key),
            trykitt_key = COALESCE(EXCLUDED.trykitt_key, agency_settings.trykitt_key),
            openai_founder_model = COALESCE(EXCLUDED.openai_founder_model, agency_settings.openai_founder_model),
            email_verification_provider = COALESCE(EXCLUDED.email_verification_provider, agency_settings.email_verification_provider),
            pricing_overrides = COALESCE(EXCLUDED.pricing_overrides, agency_settings.pricing_overrides),
            vault_updated_at = NOW(),
            updated_at = NOW()`,
        [
            agencyId,
            patch.openai_key ?? null,
            patch.serper_key ?? null,
            patch.trykitt_key ?? null,
            patch.openai_founder_model ?? null,
            patch.email_verification_provider ?? null,
            JSON.stringify(patch.pricing_overrides ?? {})
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

export async function getPricingDefaults() {
    const result = await pool.query(`SELECT data FROM pricing_defaults WHERE id = 'global'`);
    return result.rows[0]?.data || {};
}

import express from 'express';
import { verifySupabaseToken } from '../middleware/auth.js';
import {
    getAgencySettings,
    upsertAgencySettings,
    agencyFeaturesFromSettings,
    isTryKittPaidAccount, mergeAgencyFeatures } from '../services/db/agencySettings.js';
import { validateFeaturesPatch, featureFlagRegistryForClient } from '../services/db/featureFlagRegistry.js';

const router = express.Router();

router.get('/me', verifySupabaseToken, async (req, res) => {
    res.json({
        agencyId: req.agencyId,
        supabaseUserId: req.auth?.supabaseUserId ?? null,
        email: req.auth?.email ?? null
    });
});

router.get('/agency/settings', verifySupabaseToken, async (req, res) => {
    try {
        const settings = await getAgencySettings(req.agencyId);
        const features = agencyFeaturesFromSettings(settings);
        if (String(process.env.SHOPPING_AUDIT_ENABLED || '').toLowerCase() === 'true') {
            features.shoppingAudit = true;
        }
        res.json({
            openai_key: settings?.openai_key || '',
            serper_key: settings?.serper_key || '',
            trykitt_key: settings?.trykitt_key || '',
            openai_founder_model: settings?.openai_founder_model || '',
            email_verification_provider: settings?.email_verification_provider || 'trykitt',
            trykitt_paid_account: isTryKittPaidAccount(settings),
            vault_updated_at: settings?.vault_updated_at || null,
            features
        });
    } catch (error) {
        console.error('GET agency settings error:', error);
        res.status(500).json({ error: 'Failed to load settings' });
    }
});

// Feature flags for the caller's own agency. Anyone signed into the agency
// account can view and change them.
router.get('/agency/features', verifySupabaseToken, async (req, res) => {
    try {
        const settings = await getAgencySettings(req.agencyId);
        res.json({
            agencyId: req.agencyId,
            features: agencyFeaturesFromSettings(settings),
            registry: featureFlagRegistryForClient(),
            canEdit: true
        });
    } catch (error) {
        console.error('GET agency features error:', error);
        res.status(500).json({ error: 'Failed to load features' });
    }
});

router.patch('/agency/features', verifySupabaseToken, async (req, res) => {
    try {
        const validated = validateFeaturesPatch(req.body?.patch);
        if (!validated.ok) return res.status(400).json({ error: validated.errors.join('; ') });
        const features = await mergeAgencyFeatures(req.agencyId, validated.patch);
        res.json({ agencyId: req.agencyId, features });
    } catch (error) {
        console.error('PATCH agency features error:', error);
        res.status(500).json({ error: 'Failed to save features' });
    }
});

router.patch('/agency/settings', verifySupabaseToken, async (req, res) => {
    try {
        const body = req.body || {};
        // Merge the single flag rather than writing `features` wholesale — the vault
        // modal doesn't know about shoppingAudit/enrichmentRunner and would drop them.
        const featuresPatch = typeof body.trykitt_paid_account === 'boolean'
            ? { trykittPaidAccount: body.trykitt_paid_account }
            : null;

        await upsertAgencySettings(req.agencyId, {
            openai_key: body.openai_key,
            serper_key: body.serper_key,
            trykitt_key: body.trykitt_key,
            openai_founder_model: body.openai_founder_model,
            email_verification_provider: body.email_verification_provider,
            ...(body.features != null ? { features: body.features } : {}),
            ...(featuresPatch ? { featuresPatch } : {})
        });
        res.json({ ok: true });
    } catch (error) {
        console.error('PATCH agency settings error:', error);
        res.status(500).json({ error: 'Failed to save settings' });
    }
});

export default router;

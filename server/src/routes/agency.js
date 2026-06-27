import express from 'express';
import { verifySupabaseToken } from '../middleware/auth.js';
import { getAgencySettings, upsertAgencySettings, agencyFeaturesFromSettings } from '../services/db/agencySettings.js';

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
            vault_updated_at: settings?.vault_updated_at || null,
            features
        });
    } catch (error) {
        console.error('GET agency settings error:', error);
        res.status(500).json({ error: 'Failed to load settings' });
    }
});

router.patch('/agency/settings', verifySupabaseToken, async (req, res) => {
    try {
        const body = req.body || {};
        await upsertAgencySettings(req.agencyId, {
            openai_key: body.openai_key,
            serper_key: body.serper_key,
            trykitt_key: body.trykitt_key,
            openai_founder_model: body.openai_founder_model,
            email_verification_provider: body.email_verification_provider,
            ...(body.features != null ? { features: body.features } : {})
        });
        res.json({ ok: true });
    } catch (error) {
        console.error('PATCH agency settings error:', error);
        res.status(500).json({ error: 'Failed to save settings' });
    }
});

export default router;

import express from 'express';
import { verifySupabaseToken } from '../middleware/auth.js';
import { requirePlatformAdmin, isPlatformAdminEmail } from '../middleware/platformAdmin.js';
import { getSupabaseAdmin } from '../config/supabase.js';
import { upsertAgencyAuthMap, listAgencyAuthMaps } from '../services/db/agencyAuthMap.js';
import { upsertAgencySettings } from '../services/db/agencySettings.js';
import { pool } from '../config/db.js';

const router = express.Router();
const MIN_PASSWORD_LENGTH = 8;

router.get('/admin/me', verifySupabaseToken, (req, res) => {
    res.json({
        isAdmin: isPlatformAdminEmail(req.auth?.email),
        email: req.auth?.email ?? null
    });
});

router.get('/admin/agencies', verifySupabaseToken, requirePlatformAdmin, async (req, res) => {
    try {
        const admin = getSupabaseAdmin();
        const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
        if (error) throw error;

        const maps = await listAgencyAuthMaps();
        const mapByUserId = new Map(maps.map((row) => [String(row.supabase_user_id), row]));

        const agencyIds = new Set();
        for (const user of data.users) {
            const mapped = mapByUserId.get(user.id);
            agencyIds.add(mapped?.agency_id ?? user.id);
        }

        const clientCounts = new Map();
        if (agencyIds.size > 0) {
            const ids = [...agencyIds];
            const countResult = await pool.query(
                `SELECT agency_id, COUNT(*)::int AS client_count
                 FROM clients
                 WHERE agency_id = ANY($1::text[])
                 GROUP BY agency_id`,
                [ids]
            );
            for (const row of countResult.rows) {
                clientCounts.set(row.agency_id, row.client_count);
            }
        }

        const agencies = data.users.map((user) => {
            const mapped = mapByUserId.get(user.id);
            const agencyId = mapped?.agency_id ?? user.id;
            return {
                supabaseUserId: user.id,
                email: user.email ?? null,
                agencyId,
                emailConfirmed: !!user.email_confirmed_at,
                createdAt: user.created_at ?? null,
                lastSignInAt: user.last_sign_in_at ?? null,
                note: mapped?.note ?? null,
                clientCount: clientCounts.get(agencyId) ?? 0
            };
        });

        res.json({ agencies });
    } catch (error) {
        console.error('GET /admin/agencies error:', error);
        res.status(500).json({ error: error.message || 'Failed to list agencies' });
    }
});

router.post('/admin/agencies', verifySupabaseToken, requirePlatformAdmin, async (req, res) => {
    try {
        const body = req.body || {};
        const email = String(body.email || '').trim().toLowerCase();
        const password = String(body.password || '');
        const legacyAgencyId = body.legacyAgencyId ? String(body.legacyAgencyId).trim() : null;
        const note = body.note ? String(body.note).trim() : null;
        const skipEmailConfirmation = body.skipEmailConfirmation !== false;

        if (!email || !email.includes('@')) {
            return res.status(400).json({ error: 'A valid email is required' });
        }
        if (password.length < MIN_PASSWORD_LENGTH) {
            return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
        }

        const admin = getSupabaseAdmin();
        const { data, error } = await admin.auth.admin.createUser({
            email,
            password,
            email_confirm: skipEmailConfirmation
        });
        if (error) {
            return res.status(400).json({ error: error.message || 'Failed to create user' });
        }

        const supabaseUserId = data.user.id;
        const agencyId = legacyAgencyId || supabaseUserId;

        if (legacyAgencyId) {
            await upsertAgencyAuthMap(supabaseUserId, legacyAgencyId, note);
        }

        await upsertAgencySettings(agencyId, {});

        res.status(201).json({
            supabaseUserId,
            email,
            agencyId,
            emailConfirmed: skipEmailConfirmation,
            legacyMapped: !!legacyAgencyId
        });
    } catch (error) {
        console.error('POST /admin/agencies error:', error);
        res.status(500).json({ error: error.message || 'Failed to create agency account' });
    }
});

export default router;

/**
 * Clients/Agency API endpoints (Firestore-based orchestration layer)
 *
 * CANONICAL AGENCY IDENTIFIER RULE:
 * The Firestore users/{uid} document ID is the canonical agency identifier.
 * This same Firebase Auth uid is used directly as agency_id in all Cloud SQL tables.
 * No reconciliation or mapping is required.
 *
 * Note: This route manages Firestore collections (orchestration and UI state).
 * Cloud SQL tables are managed by the jobs service and are scoped by agency_id derived from
 * the verified Firebase token.
 */

import express from 'express';
import { admin, firestore } from '../config/firebase.js';

const router = express.Router();

async function deleteAllDocs(ref) {
    const batchSize = 300;
    let lastDoc = null;
    while (true) {
        let query = ref.orderBy('__name__').limit(batchSize);
        if (lastDoc) query = query.startAfter(lastDoc);
        const snap = await query.get();
        if (snap.empty) break;
        const batch = firestore.batch();
        snap.docs.forEach((d) => batch.delete(d.ref));
        await batch.commit();
        lastDoc = snap.docs[snap.docs.length - 1];
        if (snap.size < batchSize) break;
    }
}

// Create client via server (uses Admin SDK; bypasses client-side rules)
router.post('/clients', async (req, res) => {
    try {
        const { idToken, name, industry, instantly_key } = req.body || {};
        if (!idToken) return res.status(400).json({ error: 'Missing ID token.' });
        if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Client name is required.' });
        const allowedIndustries = new Set(['ecom', 'saas', 'agency', 'local']);
        const industryVal = typeof industry === 'string' ? industry : '';
        if (!allowedIndustries.has(industryVal)) return res.status(400).json({ error: 'Invalid industry.' });

        const decoded = await admin.auth().verifyIdToken(idToken);
        const uid = decoded.uid;

        const slug = name.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 60);
        const clientRef = firestore.collection('users').doc(uid).collection('clients').doc(slug);
        await clientRef.set({
            id: slug,
            name: name.trim(),
            industry: industryVal,
            instantly_key: (instantly_key || '').toString().trim(),
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        res.status(201).json({ id: slug });
    } catch (error) {
        console.error('Client creation error:', error);
        res.status(500).json({ error: 'Failed to create client.' });
    }
});

// Delete a client and cascade delete known subcollections
router.post('/clients/:id/delete', async (req, res) => {
    try {
        const { idToken } = req.body || {};
        const clientId = req.params.id;
        if (!idToken) return res.status(400).json({ error: 'Missing ID token.' });
        if (!clientId) return res.status(400).json({ error: 'Missing client id.' });

        const decoded = await admin.auth().verifyIdToken(idToken);
        const uid = decoded.uid;

        const clientRef = firestore.collection('users').doc(uid).collection('clients').doc(clientId);
        const subs = ['processed-domains', 'leads'];
        for (const sub of subs) {
            const colRef = clientRef.collection(sub);
            await deleteAllDocs(colRef);
        }
        await clientRef.delete();
        res.json({ ok: true });
    } catch (error) {
        console.error('Client cascade delete error:', error);
        res.status(500).json({ error: 'Failed to delete client.' });
    }
});

// Fetch Instantly campaigns for a client and store as subcollection 'campaigns'
router.post('/clients/:id/campaigns', async (req, res) => {
    try {
        console.log('[campaigns] incoming request', {
            path: req.path,
            params: req.params,
            hasBody: !!req.body,
        });
        const { idToken } = req.body || {};
        const clientId = req.params.id;
        if (!idToken) return res.status(400).json({ error: 'Missing ID token.' });
        if (!clientId) return res.status(400).json({ error: 'Missing client id.' });

        const decoded = await admin.auth().verifyIdToken(idToken);
        const uid = decoded.uid;
        console.log('[campaigns] verified user', { uid, clientId });

        const clientRef = firestore.collection('users').doc(uid).collection('clients').doc(clientId);
        const clientSnap = await clientRef.get();
        if (!clientSnap.exists) return res.status(404).json({ error: 'Client not found.' });
        const instantlyKey = (clientSnap.data()?.instantly_key || '').toString().trim();
        if (!instantlyKey) return res.status(400).json({ error: 'Client is missing Instantly API key.' });

        // Fetch campaigns from Instantly API (prefer v2) for last N days
        const daysStr = (req.query?.days || '').toString();
        const days = Number.isFinite(Number(daysStr)) && Number(daysStr) > 0 ? Number(daysStr) : 90;
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        console.log('[campaigns] window', { days, since: since.toISOString() });
        let campaigns = [];
        async function fetchInstantlyCampaignsV2(key) {
            console.log('[campaigns] calling Instantly v2');
            const resp = await fetch('https://api.instantly.ai/api/v2/campaigns', {
                method: 'GET',
                headers: {
                    // v2 expects Authorization Bearer
                    'Authorization': `Bearer ${key}`,
                    'Accept': 'application/json'
                }
            });
            console.log('[campaigns] v2 response', { status: resp.status });
            if (!resp.ok) {
                const msg = await resp.text().catch(() => '');
                throw new Error(`Instantly v2 error (${resp.status}): ${msg}`);
            }
            const data = await resp.json();
            // v2 returns { items: [...] } (observed), but support other shapes defensively
            const items = Array.isArray(data?.items)
                ? data.items
                : (Array.isArray(data?.data)
                    ? data.data
                    : (Array.isArray(data?.campaigns)
                        ? data.campaigns
                        : (Array.isArray(data) ? data : [])));
            if (Array.isArray(items) && items.length > 0) {
                const sample = items[0];
                console.log('[campaigns] v2 sample keys', Object.keys(sample || {}));
            }
            return items;
        }
        try {
            let items = [];
            try {
                items = await fetchInstantlyCampaignsV2(instantlyKey);
            } catch (e2) {
                console.warn('Instantly v2 failed:', e2?.message || e2);
                // Do not fallback to v1 since route may be deprecated; surface error
                throw e2;
            }
            console.log('[campaigns] fetched items', { count: Array.isArray(items) ? items.length : 0 });
            campaigns = items.filter(c => {
                const createdRaw = c.timestamp_created || c.createdAt || c.created_at || c.created || c.created_at_utc || null;
                const created = createdRaw ? new Date(createdRaw) : null;
                return created && created instanceof Date && !isNaN(created.getTime()) && created >= since;
            });
            console.log('[campaigns] filtered items (lastNd)', { count: campaigns.length });
        } catch (err) {
            console.error('Instantly fetch campaigns error:', err?.message);
            return res.status(502).json({ error: 'Failed to fetch campaigns from Instantly.' });
        }

        // Upsert campaigns into subcollection
        const colRef = clientRef.collection('campaigns');
        const batch = firestore.batch();
        campaigns.forEach((c) => {
            const id = (c.id || c.campaignId || c.uuid || c._id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`).toString();
            const ref = colRef.doc(id);
            const created = c.timestamp_created || c.createdAt || c.created_at || c.created || c.created_at_utc || null;
            batch.set(ref, {
                id,
                name: c.name || c.title || c.campaign_name || '',
                status: typeof c.status !== 'undefined' ? c.status : (c.state || ''),
                createdAt: created ? new Date(created).toISOString() : null,
                raw: c,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        });
        await batch.commit();
        console.log('[campaigns] upsert complete', { uid, clientId, wrote: campaigns.length });

        // Update client doc with active campaigns count (status === 1)
        try {
            const activeCount = campaigns.filter(c => {
                const statusVal = typeof c.status !== 'undefined' ? c.status : (c.state || null);
                return Number(statusVal) === 1;
            }).length;
            await clientRef.set({
                activeCampaigns: activeCount,
                campaignsLastSynced: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            console.log('[campaigns] client activeCampaigns updated', { clientId, activeCount });
        } catch (e) {
            console.warn('[campaigns] failed to set activeCampaigns', e?.message || e);
        }

        // Return count
        res.json({ count: campaigns.length });
    } catch (error) {
        console.error('Client campaigns sync error:', error);
        res.status(500).json({ error: 'Failed to sync campaigns.' });
    }
});

export default router;

/**
 * Store Leads imports into a client's lead bank (leads tab → "Import from
 * Store Leads"). Progress is polled through the existing
 * GET /leads/import/batches/:batchId route — runs are lead_import_batches rows.
 */

import express from 'express';
import { verifyFirebaseToken } from '../middleware/auth.js';
import * as queries from '../services/db/queries.js';
import { getAgencySettings } from '../services/db/agencySettings.js';
import {
    formatImportBatchLabel,
    getImportBatch,
    listImportBatches,
    serializeImportBatch
} from '../services/leadImport.js';
import {
    STORELEADS_MAX_SEGMENTS,
    countStoreLeadsDomains,
    normalizeStoreLeadsSegment
} from '../services/storeLeads.js';
import {
    STORELEADS_EXISTING_STRATEGIES,
    countBackfillCandidates,
    createStoreLeadsBatch,
    findActiveStoreLeadsBatch,
    runStoreLeadsBackfill,
    runStoreLeadsExportImport
} from '../services/storeLeadsImport.js';

const router = express.Router();

const DEFAULT_STALE_DAYS = 30;

async function loadStoreLeadsKey(agencyId) {
    const settings = await getAgencySettings(agencyId);
    return String(settings?.storeleads_key || '').trim();
}

function parseSegments(rawSegments) {
    if (!Array.isArray(rawSegments) || !rawSegments.length) {
        return { error: 'Add at least one filter segment.' };
    }
    if (rawSegments.length > STORELEADS_MAX_SEGMENTS) {
        return { error: `At most ${STORELEADS_MAX_SEGMENTS} segments per import.` };
    }
    const segments = [];
    for (let i = 0; i < rawSegments.length; i += 1) {
        const { segment, error } = normalizeStoreLeadsSegment(rawSegments[i]);
        if (error) return { error: rawSegments.length > 1 ? `Segment ${i + 1}: ${error}` : error };
        segments.push(segment);
    }
    return { segments };
}

function parseStaleDays(raw) {
    const parsed = Number.parseInt(raw, 10);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 3650 ? parsed : DEFAULT_STALE_DAYS;
}

/**
 * Optional backfill scope. Returns { importBatch } (null = whole lead bank) or
 * { error } when the id isn't one of this client's batches.
 */
async function resolveBackfillBatch(agencyId, clientId, raw) {
    const id = String(raw ?? '').trim();
    if (!id) return { importBatch: null };
    if (!/^\d+$/.test(id)) return { error: 'Invalid import batch.' };
    const importBatch = await getImportBatch(agencyId, clientId, id);
    return importBatch ? { importBatch } : { error: 'Import batch not found for this client.' };
}

function formatUsd(value) {
    return value >= 1000 ? `$${Math.round(value / 1000).toLocaleString('en-US')}k` : `$${value}`;
}

/** Short human label for the batch; shows up in the "Import Batch" lead filter. */
export function describeSegment(segment) {
    const parts = [];
    if (segment.countries.length) parts.push(segment.countries.join('/'));
    if (segment.minMonthlySales && segment.maxMonthlySales) {
        parts.push(`${formatUsd(segment.minMonthlySales)}–${formatUsd(segment.maxMonthlySales)}/mo`);
    } else if (segment.minMonthlySales) {
        parts.push(`≥${formatUsd(segment.minMonthlySales)}/mo`);
    } else if (segment.maxMonthlySales) {
        parts.push(`≤${formatUsd(segment.maxMonthlySales)}/mo`);
    }
    if (segment.platforms.length) parts.push(segment.platforms.join('/'));
    if (segment.technologies.length) {
        parts.push(segment.technologies.join(segment.technologiesMatch === 'all' ? ' + ' : ' or '));
    }
    if (segment.excludeTechnologies.length) parts.push(`no ${segment.excludeTechnologies.join('/')}`);
    if (segment.createdAfter) parts.push(`new since ${segment.createdAfter}`);
    return parts.join(' · ') || 'all stores';
}

function storeLeadsErrorStatus(error) {
    if (error?.code === 'STORELEADS_UNAUTHORIZED') return 400;
    return 502;
}

router.get('/storeleads/status', verifyFirebaseToken, async (req, res) => {
    try {
        const agencyId = req.agencyId;
        const clientSlug = typeof req.query.clientId === 'string' ? req.query.clientId.trim() : '';
        const [apiKey, active] = await Promise.all([
            loadStoreLeadsKey(agencyId),
            findActiveStoreLeadsBatch(agencyId)
        ]);
        let backfillCandidates = null;
        let importBatches = [];
        if (clientSlug) {
            const clientId = await queries.getOrCreateClient(agencyId, clientSlug);
            const { importBatch, error } = await resolveBackfillBatch(agencyId, clientId, req.query.importBatchId);
            if (error) return res.status(400).json({ error });
            const [count, batches] = await Promise.all([
                countBackfillCandidates(agencyId, clientId, parseStaleDays(req.query.staleDays), importBatch?.id ?? null),
                listImportBatches(agencyId, clientId, 100)
            ]);
            backfillCandidates = count;
            // Backfill runs stamp no contacts, so scoping to one would match nothing.
            importBatches = batches
                .filter((batch) => batch.options?.mode !== 'backfill')
                .map((batch) => ({ value: String(batch.id), label: formatImportBatchLabel(batch) }));
        }
        res.json({
            hasKey: Boolean(apiKey),
            activeBatchId: active ? String(active.id) : null,
            backfillCandidates,
            importBatches,
            maxSegments: STORELEADS_MAX_SEGMENTS
        });
    } catch (error) {
        console.error('Store Leads status error:', error);
        res.status(500).json({ error: 'Failed to load Store Leads status.' });
    }
});

/** Matching store counts per segment (before exclusions and de-dupe). */
router.post('/storeleads/preview', verifyFirebaseToken, async (req, res) => {
    try {
        const apiKey = await loadStoreLeadsKey(req.agencyId);
        if (!apiKey) return res.status(400).json({ error: 'Add your Store Leads API key in the vault first.' });
        const { segments, error } = parseSegments(req.body?.segments);
        if (error) return res.status(400).json({ error });

        const counts = [];
        for (const segment of segments) {
            counts.push(await countStoreLeadsDomains(apiKey, segment));
        }
        res.json({
            counts,
            labels: segments.map(describeSegment),
            total: counts.reduce((sum, count) => sum + count, 0)
        });
    } catch (error) {
        console.error('Store Leads preview error:', error);
        res.status(storeLeadsErrorStatus(error)).json({ error: error?.message || 'Store Leads preview failed.' });
    }
});

/**
 * Body: { clientId, mode: 'export' | 'backfill', segments?, existingStrategy?, staleDays?, importBatchId? }
 * Returns the batch immediately; the run continues in the background.
 */
router.post('/storeleads/import', verifyFirebaseToken, async (req, res) => {
    try {
        const agencyId = req.agencyId;
        const body = req.body || {};
        const clientSlug = typeof body.clientId === 'string' ? body.clientId.trim() : '';
        if (!clientSlug) return res.status(400).json({ error: 'clientId is required.' });
        const mode = body.mode === 'backfill' ? 'backfill' : 'export';

        const apiKey = await loadStoreLeadsKey(agencyId);
        if (!apiKey) return res.status(400).json({ error: 'Add your Store Leads API key in the vault first.' });

        const active = await findActiveStoreLeadsBatch(agencyId);
        if (active) {
            return res.status(409).json({
                error: 'A Store Leads import is already running for this agency. Wait for it to finish.',
                activeBatchId: String(active.id)
            });
        }

        const clientId = await queries.getOrCreateClient(agencyId, clientSlug);
        const dateLabel = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

        if (mode === 'backfill') {
            const staleDays = parseStaleDays(body.staleDays);
            const { importBatch, error: batchError } = await resolveBackfillBatch(agencyId, clientId, body.importBatchId);
            if (batchError) return res.status(400).json({ error: batchError });
            const importBatchId = importBatch?.id ?? null;
            const candidates = await countBackfillCandidates(agencyId, clientId, staleDays, importBatchId);
            if (!candidates) {
                return res.status(400).json({
                    error: importBatch
                        ? 'Every domain in this import batch was synced recently. Nothing to backfill.'
                        : 'Every domain in this lead bank was synced recently. Nothing to backfill.'
                });
            }
            const batch = await createStoreLeadsBatch({
                agencyId,
                clientId,
                label: importBatch
                    ? `Store Leads backfill: ${importBatch.file_name || `batch #${importBatch.id}`} (${dateLabel})`.slice(0, 300)
                    : `Store Leads backfill (${dateLabel})`,
                mode,
                existingStrategy: 'update',
                options: { staleDays, ...(importBatchId ? { importBatchId: String(importBatchId) } : {}) },
                totalRows: candidates
            });
            runStoreLeadsBackfill({ batchId: batch.id, agencyId, clientId, apiKey, staleDays, importBatchId });
            return res.status(202).json({ batch: serializeImportBatch(batch) });
        }

        const { segments, error } = parseSegments(body.segments);
        if (error) return res.status(400).json({ error });
        const existingStrategy = STORELEADS_EXISTING_STRATEGIES.has(body.existingStrategy)
            ? body.existingStrategy
            : 'update';

        const batch = await createStoreLeadsBatch({
            agencyId,
            clientId,
            label: `Store Leads: ${segments.map(describeSegment).join(' | ')} (${dateLabel})`.slice(0, 300),
            mode,
            existingStrategy,
            options: { segments }
        });
        runStoreLeadsExportImport({ batchId: batch.id, agencyId, clientId, apiKey, segments, existingStrategy });
        return res.status(202).json({ batch: serializeImportBatch(batch) });
    } catch (error) {
        console.error('Store Leads import error:', error);
        res.status(500).json({ error: error?.message || 'Failed to start Store Leads import.' });
    }
});

export default router;

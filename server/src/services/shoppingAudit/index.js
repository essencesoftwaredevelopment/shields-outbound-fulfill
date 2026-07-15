import { SHOPPING_AUDIT_STAGE_KEYS } from './constants.js';
import { mergeAuditFeatures, slimCardFields, slimCardsForStorage } from './utils.js';
import { runShopifyCatalogStage } from './shopifyCatalog.js';
import { runHeroSelectionStage } from './heroSelection.js';
import { runSerperShoppingBatch } from './serperShopping.js';
import { runSignalWaterfallStage } from './signalWaterfall.js';
import {
    upsertShopifySnapshotsBatch,
    insertHeroSelectionsBatch,
    insertAdObservationsBatch,
    insertSignalEmissionsBatch,
    loadSerperShoppingCacheMap,
    upsertSerperShoppingCacheBatch,
    loadShopifySnapshotsForDomains,
    updateCompanyLastAudit,
    snapshotKey
} from './db.js';
import { batchUpsertCompanies } from '../../lib/db.js';
import { pool } from '../../config/db.js';

const PROGRESS_EVERY = 5;

function shouldLogProgress(processed, total) {
    return processed % PROGRESS_EVERY === 0 || processed === total || processed <= 3;
}

async function persistCatalogSnapshots({
    catalogResults,
    agencyId,
    clientId,
    companyIdByDomain,
    jobId,
    log,
    setActivity,
    recordTiming
}) {
    const storeRows = catalogResults.filter((row) => row.snapshots?.length);
    const allSnapshots = storeRows.flatMap((row) => row.snapshots);
    if (!allSnapshots.length) return;

    setActivity?.(`Saving ${allSnapshots.length} catalog snapshots…`);
    log(`Shopify catalog: persisting ${allSnapshots.length} snapshots to DB…`);
    const start = Date.now();

    await upsertShopifySnapshotsBatch({
        agencyId,
        clientId,
        companyIdByDomain,
        jobId,
        rows: allSnapshots
    });

    recordTiming?.({
        label: 'upsert:shopifySnapshots',
        category: 'upsert',
        durationMs: Date.now() - start,
        rows: allSnapshots.length,
        stage: 'shopifyCatalog'
    });
    log(`Shopify catalog: persisted ${storeRows.length} stores (${allSnapshots.length} snapshots)`);
}

async function persistHeroSelections({
    selections,
    agencyId,
    clientId,
    companyIdByDomain,
    jobId,
    features,
    log,
    recordTiming
}) {
    if (!selections.length) return selections;

    log(`Hero selection: saving ${selections.length} selections to DB…`);
    const start = Date.now();

    const snapshots = selections.map((sel) => sel.snapshot);
    const snapshotRows = await upsertShopifySnapshotsBatch({
        agencyId,
        clientId,
        companyIdByDomain,
        jobId,
        rows: snapshots
    });

    const snapshotIdByKey = new Map(
        snapshotRows.map((row) => [snapshotKey(row.domain, row.product_id), row.id])
    );

    const heroRows = selections.map((sel) => ({
        domain: sel.domain,
        shopifySnapshotId: snapshotIdByKey.get(
            snapshotKey(sel.snapshot.domain_normalized, sel.snapshot.product_id)
        ),
        heuristicVersion: features.heroHeuristic,
        selectionReason: sel.selection_reason
    })).filter((row) => row.shopifySnapshotId);

    const heroIdByDomain = await insertHeroSelectionsBatch({
        agencyId,
        clientId,
        companyIdByDomain,
        jobId,
        rows: heroRows
    });

    for (const sel of selections) {
        const snapshotId = snapshotIdByKey.get(
            snapshotKey(sel.snapshot.domain_normalized, sel.snapshot.product_id)
        );
        if (snapshotId) sel.shopifySnapshotId = snapshotId;
        const heroSelectionId = heroIdByDomain.get(sel.domain);
        if (heroSelectionId) sel.heroSelectionId = heroSelectionId;
    }

    recordTiming?.({
        label: 'upsert:heroSelections',
        category: 'upsert',
        durationMs: Date.now() - start,
        rows: heroRows.length,
        stage: 'heroSelection'
    });
    log(`Hero selection: saved ${heroRows.length}/${selections.length} stores`);

    return selections;
}

async function persistAdObservations({
    observations,
    agencyId,
    clientId,
    jobId,
    features,
    log,
    setActivity,
    recordTiming
}) {
    if (!observations.length) return;

    setActivity?.(`Saving ${observations.length} shopping ad observations…`);
    log(`Serper Shopping: persisting ${observations.length} ad observations to DB…`);
    const start = Date.now();

    await insertAdObservationsBatch({
        agencyId,
        clientId,
        jobId,
        rows: observations.map((obs) => ({
            heroSelectionId: obs.selection?.heroSelectionId,
            branch: obs.branch || 'none',
            matchedCard: obs.matched_card ? slimCardFields(obs.matched_card) : null,
            allCards: slimCardsForStorage(obs.all_cards),
            source: obs.source || 'serper',
            geo: obs.geo || features.serperGeo,
            queryText: obs.query,
            observedAt: obs.observed_at
        }))
    });

    recordTiming?.({
        label: 'upsert:adObservations',
        category: 'upsert',
        durationMs: Date.now() - start,
        rows: observations.length,
        stage: 'serperShopping'
    });
    log(`Serper Shopping: persisted ${observations.length} observations`);
}

export function buildShoppingAuditStages(initialStageState) {
    const stages = {};
    for (const key of SHOPPING_AUDIT_STAGE_KEYS) {
        stages[key] = initialStageState();
    }
    return stages;
}

export function isShoppingAuditJob(job) {
    if (job?.pipelineMode === 'shopping_audit') return true;
    if (job?.nicheId === 'shopping_audit' || job?.industry === 'shopping_audit') return true;
    return Boolean(job?.stages?.shopifyCatalog);
}

export function createShoppingAuditBatchState() {
    return {
        stats: {
            shopify: 0,
            heroes: 0,
            serperClean: 0,
            serperAmbiguous: 0,
            serperNone: 0,
            signals: 0,
            headless: 0,
            cost: 0
        },
        companyIdByDomain: {},
        catalogResults: [],
        selections: [],
        observations: [],
        signalByDomain: {},
        qualifiedDomains: []
    };
}

function hydrateShoppingAuditBatchState(raw) {
    const base = createShoppingAuditBatchState();
    if (!raw || typeof raw !== 'object') return base;
    return {
        ...base,
        ...raw,
        stats: { ...base.stats, ...(raw.stats || {}) },
        companyIdByDomain: raw.companyIdByDomain || {},
        catalogResults: Array.isArray(raw.catalogResults) ? raw.catalogResults : [],
        selections: Array.isArray(raw.selections) ? raw.selections : [],
        observations: Array.isArray(raw.observations) ? raw.observations : [],
        signalByDomain: raw.signalByDomain || {},
        qualifiedDomains: Array.isArray(raw.qualifiedDomains) ? raw.qualifiedDomains : []
    };
}

/** Drop raw products.json + in-memory snapshot arrays before crossing a workflow step boundary. */
function slimCatalogResultsForWorkflow(catalogResults) {
    return (catalogResults || []).map((row) => ({
        domain: row.domain,
        isShopify: !!row.isShopify
    }));
}

async function hydrateCatalogSnapshotsFromDb(jobId, catalogResults) {
    const rows = catalogResults || [];
    const needsHydrate = rows.some((row) => row.isShopify && !row.snapshots?.length);
    if (!needsHydrate) return rows;

    const domains = rows.map((row) => row.domain).filter(Boolean);
    const byDomain = await loadShopifySnapshotsForDomains(jobId, domains);
    return rows.map((row) => ({
        domain: row.domain,
        isShopify: !!row.isShopify,
        snapshots: row.snapshots?.length ? row.snapshots : (byDomain.get(row.domain) || [])
    }));
}

function buildSkipDomains(state) {
    const nonShopifyDomains = state.catalogResults
        .filter((row) => !row.isShopify)
        .map((row) => row.domain);
    const shopifyNoSignal = state.selections
        .map((selection) => selection.domain)
        .filter((domain) => !state.signalByDomain[domain]);

    return {
        not_shopify: nonShopifyDomains,
        no_signal: shopifyNoSignal
    };
}

/**
 * Run one shopping-audit stage for a workflow batch.
 * Returns serializable state for the next step.
 */
export async function runShoppingAuditPipelineStage({
    stage,
    job,
    domains,
    state: rawState = null,
    features: rawFeatures,
    log,
    setActivity,
    checkpoint,
    updateStage,
    pricing,
    recordTiming,
    enableTier2 = true,
    enableBrokenPage = false,
    rateLimitHooks = null
}) {
    const features = mergeAuditFeatures(rawFeatures);
    const state = hydrateShoppingAuditBatchState(rawState);
    const companyIdByDomain = new Map(Object.entries(state.companyIdByDomain || {}));

    if (stage === 'shopifyCatalog') {
        if (domains.length) {
            const companyStart = Date.now();
            const companyMap = await batchUpsertCompanies(
                pool,
                job.uid,
                job.sqlClientId,
                domains.map((d) => ({ domain: d }))
            );
            for (const [domain, companyId] of companyMap.entries()) {
                companyIdByDomain.set(domain, companyId);
            }
            recordTiming?.({
                label: 'upsert:auditCompanies',
                category: 'upsert',
                durationMs: Date.now() - companyStart,
                rows: domains.length,
                stage: 'shopifyCatalog'
            });
        }

        await updateStage('shopifyCatalog', async () => {
            setActivity?.(`Fetching Shopify catalogs for ${domains.length} domains…`);
            const fetchStart = Date.now();
            const result = await runShopifyCatalogStage({
                domains,
                log,
                checkpoint,
                onProgress: ({ processed, total, shopify }) => {
                    log(`Shopify catalog: ${processed}/${total} (${shopify} Shopify)`, {
                        progress: { stage: 'shopifyCatalog', processed, total, stats: { shopify } }
                    });
                }
            });
            recordTiming?.({
                label: 'fetch:shopifyCatalog',
                category: 'fetch',
                durationMs: Date.now() - fetchStart,
                rows: domains.length,
                stage: 'shopifyCatalog'
            });

            state.catalogResults = result.results;
            state.stats.shopify = result.shopifyCount;

            await persistCatalogSnapshots({
                catalogResults: state.catalogResults,
                agencyId: job.uid,
                clientId: job.sqlClientId,
                companyIdByDomain,
                jobId: job.id,
                log,
                setActivity,
                recordTiming
            });

            // Snapshots are in DB now — keep workflow step payload tiny so the
            // catalog→hero handoff cannot hang serializing multi‑MB products.json blobs.
            state.catalogResults = slimCatalogResultsForWorkflow(state.catalogResults);

            return {
                processed: domains.length,
                shopify: result.shopifyCount,
                nonShopify: result.nonShopifyDomains.length,
                cost: 0
            };
        });
    }

    if (stage === 'heroSelection') {
        await updateStage('heroSelection', async () => {
            const catalogResults = await hydrateCatalogSnapshotsFromDb(job.id, state.catalogResults);
            state.catalogResults = slimCatalogResultsForWorkflow(catalogResults);

            let selections = runHeroSelectionStage(catalogResults, features, log);
            state.stats.heroes = selections.length;

            selections = await persistHeroSelections({
                selections,
                agencyId: job.uid,
                clientId: job.sqlClientId,
                companyIdByDomain,
                jobId: job.id,
                features,
                log,
                recordTiming
            });
            state.selections = selections;

            return { processed: selections.length, cost: 0 };
        });
    }

    if (stage === 'serperShopping') {
        const cacheMap = await loadSerperShoppingCacheMap(job.id);
        let serperCacheUpsertMs = 0;
        let serperCacheUpsertCount = 0;

        await updateStage('serperShopping', async () => {
            setActivity?.(`Running Serper Shopping for ${state.selections.length} products…`);
            const fetchStart = Date.now();
            const serperResult = await runSerperShoppingBatch({
                selections: state.selections,
                apiKey: job.apiKeys?.serper,
                geo: features.serperGeo,
                loadCache: async (domain) => cacheMap.get(domain) || null,
                saveCache: async (entries) => {
                    if (!entries?.length) return;
                    setActivity?.(`Caching ${entries.length} Serper Shopping results…`);
                    const cacheStart = Date.now();
                    await upsertSerperShoppingCacheBatch(job.id, entries);
                    serperCacheUpsertMs += Date.now() - cacheStart;
                    serperCacheUpsertCount += entries.length;
                },
                log,
                checkpoint,
                onProgress: ({ processed, total, serperRequests }) => {
                    setActivity?.(`Serper Shopping: ${processed}/${total}`);
                    log(`Serper Shopping: ${processed}/${total}`, {
                        progress: { stage: 'serperShopping', processed, total, stats: { serperRequests } }
                    });
                },
                pricing: pricing?.stages?.serperShopping,
                rateLimitHooks
            });
            recordTiming?.({
                label: 'fetch:serperShopping',
                category: 'fetch',
                durationMs: Date.now() - fetchStart - serperCacheUpsertMs,
                rows: state.selections.length,
                stage: 'serperShopping'
            });
            if (serperCacheUpsertMs > 0) {
                recordTiming?.({
                    label: 'upsert:serperShoppingCache',
                    category: 'upsert',
                    durationMs: serperCacheUpsertMs,
                    rows: serperCacheUpsertCount,
                    stage: 'serperShopping'
                });
            }

            state.observations = serperResult.observations;
            state.stats.serperClean = serperResult.clean;
            state.stats.serperAmbiguous = serperResult.ambiguous;
            state.stats.serperNone = serperResult.none;
            state.stats.cost += serperResult.cost;

            await persistAdObservations({
                observations: state.observations,
                agencyId: job.uid,
                clientId: job.sqlClientId,
                jobId: job.id,
                features,
                log,
                setActivity,
                recordTiming
            });

            return {
                processed: state.observations.length,
                clean: serperResult.clean,
                ambiguous: serperResult.ambiguous,
                none: serperResult.none,
                headless: state.stats.headless,
                cost: serperResult.cost
            };
        });
    }

    if (stage === 'signalWaterfall') {
        const signalByDomain = new Map(Object.entries(state.signalByDomain || {}));
        const qualifiedDomains = [...state.qualifiedDomains];

        await updateStage('signalWaterfall', async () => {
            const emissions = await runSignalWaterfallStage({
                selectionsWithObservations: state.observations,
                features,
                log,
                enableTier2,
                enableBrokenPage
            });

            if (emissions.length) {
                log(`Signal waterfall: persisting ${emissions.length} emissions to DB…`);
                const persistStart = Date.now();

                const idByDomain = await insertSignalEmissionsBatch({
                    agencyId: job.uid,
                    clientId: job.sqlClientId,
                    companyIdByDomain,
                    jobId: job.id,
                    rows: emissions.map((row) => ({
                        domain: row.domain,
                        signal: row.signal
                    }))
                });

                for (const row of emissions) {
                    const signalId = idByDomain.get(row.domain);
                    if (!signalId) continue;
                    signalByDomain.set(row.domain, {
                        signalId,
                        signal: row.signal,
                        selection: row.selection
                    });
                    qualifiedDomains.push(row.domain);
                }

                recordTiming?.({
                    label: 'upsert:signalEmissions',
                    category: 'upsert',
                    durationMs: Date.now() - persistStart,
                    rows: emissions.length,
                    stage: 'signalWaterfall'
                });
                log(`Signal waterfall: persisted ${emissions.length} emissions`);
            }

            state.stats.signals = emissions.length;
            state.signalByDomain = Object.fromEntries(signalByDomain.entries());
            state.qualifiedDomains = qualifiedDomains;
            await updateCompanyLastAudit(job.sqlClientId, qualifiedDomains);

            return {
                processed: emissions.length,
                totalCandidates: state.observations.length,
                cost: 0
            };
        });
    }

    state.companyIdByDomain = Object.fromEntries(companyIdByDomain.entries());
    return state;
}

export function finalizeShoppingAuditBatchState(rawState) {
    const state = hydrateShoppingAuditBatchState(rawState);
    const skipDomains = buildSkipDomains(state);

    return {
        stats: state.stats,
        signalByDomain: state.signalByDomain,
        qualifiedDomains: state.qualifiedDomains,
        skipDomains
    };
}

export async function runShoppingAuditPipeline({
    job,
    domains,
    features: rawFeatures,
    log,
    setActivity,
    checkpoint,
    updateStage,
    pricing,
    recordTiming,
    enableHeadless = false,
    enableTier2 = true,
    enableBrokenPage = false,
    rateLimitHooks = null
}) {
    const features = mergeAuditFeatures(rawFeatures);
    const stats = {
        shopify: 0,
        heroes: 0,
        serperClean: 0,
        serperAmbiguous: 0,
        serperNone: 0,
        signals: 0,
        headless: 0,
        cost: 0
    };

    const companyIdByDomain = new Map();
    if (domains.length) {
        const companyStart = Date.now();
        const companyMap = await batchUpsertCompanies(
            pool,
            job.uid,
            job.sqlClientId,
            domains.map((d) => ({ domain: d }))
        );
        for (const [domain, companyId] of companyMap.entries()) {
            companyIdByDomain.set(domain, companyId);
        }
        recordTiming?.({
            label: 'upsert:auditCompanies',
            category: 'upsert',
            durationMs: Date.now() - companyStart,
            rows: domains.length,
            stage: 'shopifyCatalog'
        });
    }

    let catalogResults = [];

    await updateStage('shopifyCatalog', async () => {
        setActivity?.(`Fetching Shopify catalogs for ${domains.length} domains…`);
        const fetchStart = Date.now();
        const result = await runShopifyCatalogStage({
            domains,
            log,
            checkpoint,
            onProgress: ({ processed, total, shopify }) => {
                log(`Shopify catalog: ${processed}/${total} (${shopify} Shopify)`, {
                    progress: { stage: 'shopifyCatalog', processed, total, stats: { shopify } }
                });
            }
        });
        recordTiming?.({
            label: 'fetch:shopifyCatalog',
            category: 'fetch',
            durationMs: Date.now() - fetchStart,
            rows: domains.length,
            stage: 'shopifyCatalog'
        });

        catalogResults = result.results;
        stats.shopify = result.shopifyCount;

        await persistCatalogSnapshots({
            catalogResults,
            agencyId: job.uid,
            clientId: job.sqlClientId,
            companyIdByDomain,
            jobId: job.id,
            log,
            setActivity,
            recordTiming
        });

        return {
            processed: domains.length,
            shopify: result.shopifyCount,
            nonShopify: result.nonShopifyDomains.length,
            cost: 0
        };
    });

    let selections = [];

    await updateStage('heroSelection', async () => {
        selections = runHeroSelectionStage(catalogResults, features, log);
        stats.heroes = selections.length;

        selections = await persistHeroSelections({
            selections,
            agencyId: job.uid,
            clientId: job.sqlClientId,
            companyIdByDomain,
            jobId: job.id,
            features,
            log,
            recordTiming
        });

        return { processed: selections.length, cost: 0 };
    });

    let observations = [];
    const cacheMap = await loadSerperShoppingCacheMap(job.id);
    let serperCacheUpsertMs = 0;
    let serperCacheUpsertCount = 0;

    await updateStage('serperShopping', async () => {
        setActivity?.(`Running Serper Shopping for ${selections.length} products…`);
        const fetchStart = Date.now();
        const serperResult = await runSerperShoppingBatch({
            selections,
            apiKey: job.apiKeys?.serper,
            geo: features.serperGeo,
            loadCache: async (domain) => cacheMap.get(domain) || null,
            saveCache: async (entries) => {
                if (!entries?.length) return;
                setActivity?.(`Caching ${entries.length} Serper Shopping results…`);
                const cacheStart = Date.now();
                await upsertSerperShoppingCacheBatch(job.id, entries);
                serperCacheUpsertMs += Date.now() - cacheStart;
                serperCacheUpsertCount += entries.length;
            },
            log,
            checkpoint,
            onProgress: ({ processed, total, serperRequests }) => {
                setActivity?.(`Serper Shopping: ${processed}/${total}`);
                log(`Serper Shopping: ${processed}/${total}`, {
                    progress: { stage: 'serperShopping', processed, total, stats: { serperRequests } }
                });
            },
            pricing: pricing?.stages?.serperShopping,
            rateLimitHooks
        });
        recordTiming?.({
            label: 'fetch:serperShopping',
            category: 'fetch',
            durationMs: Date.now() - fetchStart - serperCacheUpsertMs,
            rows: selections.length,
            stage: 'serperShopping'
        });
        if (serperCacheUpsertMs > 0) {
            recordTiming?.({
                label: 'upsert:serperShoppingCache',
                category: 'upsert',
                durationMs: serperCacheUpsertMs,
                rows: serperCacheUpsertCount,
                stage: 'serperShopping'
            });
        }

        observations = serperResult.observations;
        stats.serperClean = serperResult.clean;
        stats.serperAmbiguous = serperResult.ambiguous;
        stats.serperNone = serperResult.none;
        stats.cost += serperResult.cost;

        await persistAdObservations({
            observations,
            agencyId: job.uid,
            clientId: job.sqlClientId,
            jobId: job.id,
            features,
            log,
            setActivity,
            recordTiming
        });

        return {
            processed: observations.length,
            clean: serperResult.clean,
            ambiguous: serperResult.ambiguous,
            none: serperResult.none,
            headless: stats.headless,
            cost: serperResult.cost + (stats.headless ? stats.cost - serperResult.cost : 0)
        };
    });

    const signalByDomain = new Map();
    const qualifiedDomains = [];

    await updateStage('signalWaterfall', async () => {
        const emissions = await runSignalWaterfallStage({
            selectionsWithObservations: observations,
            features,
            log,
            enableTier2,
            enableBrokenPage
        });

        if (emissions.length) {
            log(`Signal waterfall: persisting ${emissions.length} emissions to DB…`);
            const persistStart = Date.now();

            const idByDomain = await insertSignalEmissionsBatch({
                agencyId: job.uid,
                clientId: job.sqlClientId,
                companyIdByDomain,
                jobId: job.id,
                rows: emissions.map((row) => ({
                    domain: row.domain,
                    signal: row.signal
                }))
            });

            for (const row of emissions) {
                const signalId = idByDomain.get(row.domain);
                if (!signalId) continue;
                signalByDomain.set(row.domain, {
                    signalId,
                    signal: row.signal,
                    selection: row.selection
                });
                qualifiedDomains.push(row.domain);
            }

            recordTiming?.({
                label: 'upsert:signalEmissions',
                category: 'upsert',
                durationMs: Date.now() - persistStart,
                rows: emissions.length,
                stage: 'signalWaterfall'
            });
            log(`Signal waterfall: persisted ${emissions.length} emissions`);
        }

        stats.signals = emissions.length;
        await updateCompanyLastAudit(job.sqlClientId, qualifiedDomains);

        return {
            processed: emissions.length,
            totalCandidates: observations.length,
            cost: 0
        };
    });

    const nonShopifyDomains = catalogResults.filter((r) => !r.isShopify).map((r) => r.domain);
    const shopifyNoSignal = selections
        .map((s) => s.domain)
        .filter((d) => !signalByDomain.has(d));

    return {
        stats,
        signalByDomain,
        qualifiedDomains,
        skipDomains: {
            not_shopify: nonShopifyDomains,
            no_signal: shopifyNoSignal
        }
    };
}

export { SHOPPING_AUDIT_STAGE_KEYS, mergeAuditFeatures };

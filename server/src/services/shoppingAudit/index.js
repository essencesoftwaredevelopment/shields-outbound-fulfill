import { SHOPPING_AUDIT_STAGE_KEYS } from './constants.js';
import { mergeAuditFeatures, slimCardFields, slimCardsForStorage } from './utils.js';
import { runSerperShoppingBatch } from './serperShopping.js';
import { runSignalWaterfallStage } from './signalWaterfall.js';
import {
    upsertShopifySnapshotsBatch,
    insertAdObservationsBatch,
    insertSignalEmissionsBatch,
    loadAdObservationsForDomains,
    loadSignalEmissionsForDomains,
    loadSerperShoppingCacheMap,
    upsertSerperShoppingCacheBatch,
    updateCompanyLastAudit,
    snapshotKey
} from './db.js';
import { batchUpsertCompanies } from '../../lib/db.js';
import { pool } from '../../config/db.js';

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
            domain: obs.domain,
            branch: obs.branch || 'none',
            matchedCard: obs.matched_card ? slimCardFields(obs.matched_card) : null,
            allCards: slimCardsForStorage(obs.all_cards),
            source: obs.source || 'serper',
            geo: obs.geo || features.serperGeo,
            queryText: obs.query,
            observedAt: obs.observed_at,
            matched: obs.matched === true,
            matchedProduct: obs.matched_product || null,
            matchedSnapshotId: obs.matched_snapshot_id ?? null,
            sellerMatchMethod: obs.seller_match_method ?? null,
            matchSimilarity: obs.match_similarity ?? null,
            catalogPagesFetched: obs.catalog_pages_fetched ?? null
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
    // stages.shopifyCatalog covers jobs created before the serper-first refactor.
    return Boolean(job?.stages?.serperShopping || job?.stages?.shopifyCatalog);
}

export function createShoppingAuditBatchState() {
    return {
        stats: {
            serperMatched: 0,
            serperClean: 0,
            serperAmbiguous: 0,
            serperNone: 0,
            signals: 0,
            headless: 0,
            cost: 0
        },
        companyIdByDomain: {},
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
        observations: Array.isArray(raw.observations) ? raw.observations : [],
        signalByDomain: raw.signalByDomain || {},
        qualifiedDomains: Array.isArray(raw.qualifiedDomains) ? raw.qualifiedDomains : []
    };
}

/**
 * Only matched domains move forward: everything the serper stage observed that
 * did not end up with a signal emission (matched domains always emit at least
 * ad_match) is skipped before enrichment.
 */
function buildSkipDomains(state) {
    const unqualified = state.observations
        .map((obs) => obs.domain)
        .filter((domain) => domain && !state.signalByDomain[domain]);
    return {
        not_shopify: [],
        no_signal: unqualified
    };
}

async function upsertAuditCompanies({ job, domains, companyIdByDomain, recordTiming }) {
    if (!domains.length) return;
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
        stage: 'serperShopping'
    });
}

async function runSerperStageBody({
    job,
    domains,
    features,
    companyIdByDomain,
    log,
    setActivity,
    checkpoint,
    pricing,
    recordTiming,
    rateLimitHooks
}) {
    const cacheMap = await loadSerperShoppingCacheMap(job.id);
    let serperCacheUpsertMs = 0;
    let serperCacheUpsertCount = 0;

    setActivity?.(`Running Serper Shopping for ${domains.length} domains…`);
    const fetchStart = Date.now();
    const serperResult = await runSerperShoppingBatch({
        domains,
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
        persistSnapshots: (rows) => upsertShopifySnapshotsBatch({
            agencyId: job.uid,
            clientId: job.sqlClientId,
            companyIdByDomain,
            jobId: job.id,
            rows
        }),
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
        rows: domains.length,
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

    await persistAdObservations({
        observations: serperResult.observations,
        agencyId: job.uid,
        clientId: job.sqlClientId,
        jobId: job.id,
        features,
        log,
        setActivity,
        recordTiming
    });

    return serperResult;
}

async function runWaterfallStageBody({
    job,
    observations,
    features,
    companyIdByDomain,
    log,
    recordTiming,
    enableTier2,
    enableBrokenPage
}) {
    const emissions = await runSignalWaterfallStage({
        selectionsWithObservations: observations,
        features,
        log,
        enableTier2,
        enableBrokenPage
    });

    const signalByDomain = new Map();
    const qualifiedDomains = [];

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

    await updateCompanyLastAudit(job.sqlClientId, qualifiedDomains);
    return { emissions, signalByDomain, qualifiedDomains };
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

    if (stage === 'serperShopping') {
        await upsertAuditCompanies({ job, domains, companyIdByDomain, recordTiming });

        // Idempotency (B3): domains that already have an ad_observations row for
        // this job were fully processed by an earlier attempt/run — reload their
        // observations from the DB and re-query Serper only for the missing ones,
        // so a step retry or job resume never re-charges Serper for done domains.
        const reloaded = await loadAdObservationsForDomains(job.id, domains);
        const observedDomains = new Set(reloaded.map((obs) => obs.domain));
        const missingDomains = domains.filter(
            (d) => !observedDomains.has(String(d || '').toLowerCase())
        );
        if (reloaded.length) {
            log(
                `Serper Shopping: skipping ${reloaded.length}/${domains.length} already-observed domains (idempotent re-run)`
            );
        }

        await updateStage('serperShopping', async () => {
            const serperResult = missingDomains.length
                ? await runSerperStageBody({
                    job,
                    domains: missingDomains,
                    features,
                    companyIdByDomain,
                    log,
                    setActivity,
                    checkpoint,
                    pricing,
                    recordTiming,
                    rateLimitHooks
                })
                : { observations: [], matched: 0, clean: 0, ambiguous: 0, none: 0, cost: 0 };

            state.observations = [...reloaded, ...serperResult.observations];
            // Stats cover the whole batch (reloaded + fresh); cost covers only the
            // fresh Serper calls — the reloaded domains' cost was recorded by the
            // attempt that originally processed them.
            const matched = state.observations.filter((obs) => obs.matched).length;
            state.stats.serperMatched = matched;
            state.stats.serperClean = matched;
            state.stats.serperAmbiguous = 0;
            state.stats.serperNone = state.observations.length - matched;
            state.stats.cost += serperResult.cost;

            return {
                processed: state.observations.length,
                matched,
                clean: matched,
                ambiguous: 0,
                none: state.observations.length - matched,
                headless: state.stats.headless,
                cost: serperResult.cost
            };
        });
    }

    if (stage === 'signalWaterfall') {
        const signalByDomain = new Map(Object.entries(state.signalByDomain || {}));
        const qualifiedDomains = [...state.qualifiedDomains];

        // Idempotency (B3): domains whose signal emission already exists for this
        // job are done — reload those emissions and run the waterfall only over the
        // remaining observations. Observed domains WITHOUT an emission re-run the
        // waterfall by design: "no emission" also means "did not qualify", which
        // only the waterfall itself can re-decide (it is local compute, no paid APIs).
        const emitted = await loadSignalEmissionsForDomains(
            job.id,
            state.observations.map((obs) => obs.domain)
        );
        const emittedDomains = new Set(emitted.map((row) => row.domain_normalized));
        const pendingObservations = state.observations.filter(
            (obs) => !emittedDomains.has(obs.domain)
        );
        if (emitted.length) {
            log(
                `Signal waterfall: skipping ${emitted.length}/${state.observations.length} already-emitted domains (idempotent re-run)`
            );
        }

        await updateStage('signalWaterfall', async () => {
            const result = pendingObservations.length
                ? await runWaterfallStageBody({
                    job,
                    observations: pendingObservations,
                    features,
                    companyIdByDomain,
                    log,
                    recordTiming,
                    enableTier2,
                    enableBrokenPage
                })
                : { emissions: [], signalByDomain: new Map(), qualifiedDomains: [] };

            for (const [domain, entry] of result.signalByDomain.entries()) {
                signalByDomain.set(domain, entry);
            }
            // Same shape personalization's buildSignalMap produces from a DB row.
            for (const row of emitted) {
                if (signalByDomain.has(row.domain_normalized)) continue;
                signalByDomain.set(row.domain_normalized, {
                    signalId: row.id,
                    signal: row,
                    selection: null
                });
            }

            const qualified = new Set(qualifiedDomains);
            for (const domain of result.qualifiedDomains) qualified.add(domain);
            for (const row of emitted) qualified.add(row.domain_normalized);

            state.stats.signals = signalByDomain.size;
            state.signalByDomain = Object.fromEntries(signalByDomain.entries());
            state.qualifiedDomains = [...qualified];

            return {
                processed: result.emissions.length + emitted.length,
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
        serperMatched: 0,
        serperClean: 0,
        serperAmbiguous: 0,
        serperNone: 0,
        signals: 0,
        headless: 0,
        cost: 0
    };

    const companyIdByDomain = new Map();
    await upsertAuditCompanies({ job, domains, companyIdByDomain, recordTiming });

    let observations = [];

    await updateStage('serperShopping', async () => {
        const serperResult = await runSerperStageBody({
            job,
            domains,
            features,
            companyIdByDomain,
            log,
            setActivity,
            checkpoint,
            pricing,
            recordTiming,
            rateLimitHooks
        });

        observations = serperResult.observations;
        stats.serperMatched = serperResult.matched;
        stats.serperClean = serperResult.clean;
        stats.serperAmbiguous = serperResult.ambiguous;
        stats.serperNone = serperResult.none;
        stats.cost += serperResult.cost;

        return {
            processed: observations.length,
            matched: serperResult.matched,
            clean: serperResult.clean,
            ambiguous: serperResult.ambiguous,
            none: serperResult.none,
            headless: stats.headless,
            cost: serperResult.cost
        };
    });

    let signalByDomain = new Map();
    let qualifiedDomains = [];

    await updateStage('signalWaterfall', async () => {
        const result = await runWaterfallStageBody({
            job,
            observations,
            features,
            companyIdByDomain,
            log,
            recordTiming,
            enableTier2,
            enableBrokenPage
        });

        signalByDomain = result.signalByDomain;
        qualifiedDomains = result.qualifiedDomains;
        stats.signals = result.emissions.length;

        return {
            processed: result.emissions.length,
            totalCandidates: observations.length,
            cost: 0
        };
    });

    const unqualified = observations
        .map((obs) => obs.domain)
        .filter((domain) => domain && !signalByDomain.has(domain));

    return {
        stats,
        signalByDomain,
        qualifiedDomains,
        skipDomains: {
            not_shopify: [],
            no_signal: unqualified
        }
    };
}

export { SHOPPING_AUDIT_STAGE_KEYS, mergeAuditFeatures, snapshotKey };

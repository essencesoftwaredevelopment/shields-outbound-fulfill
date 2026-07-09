import { countJobStageStats } from '../services/db/jobs.js';
import { buildCanonicalProgress, resolveJobTotal, updateJobStagesLocked } from './stageProgress.js';
import { extractStageCostAmount } from '../utils/pricing.js';

export const STANDARD_STAGE_KEYS = [
    'domainPrep',
    'founders',
    'emailDiscovery',
    'verification',
    'personalization'
];

function summaryFromStats(stageKey, stats, priorSummary = {}, denominators = {}) {
    const cost = extractStageCostAmount({ summary: priorSummary });
    const withCost = cost > 0
        ? { cost: Number(cost.toFixed(6)), Cost: priorSummary.Cost || `$${cost.toFixed(2)}` }
        : {};

    if (stageKey === 'domainPrep') {
        const s = stats.domainPrep;
        const dedupeSkipped = priorSummary.skippedExisting ?? priorSummary.skipped ?? 0;
        const dead = Math.max(0, (s.skipped ?? 0) - dedupeSkipped);
        return {
            ...withCost,
            checked: s.checked,
            processable: s.processable,
            live: priorSummary.live ?? Math.max(0, s.processable - dead),
            dead: priorSummary.dead ?? dead,
            unknown: priorSummary.unknown ?? 0,
            skippedExisting: dedupeSkipped,
            domainCheckSkipped: s.domainCheckSkipped
        };
    }

    if (stageKey === 'founders') {
        const s = stats.founders;
        const notFound = s.excluded ?? 0;
        return {
            ...withCost,
            processed: s.processed,
            Found: s.found,
            found: s.found,
            imported: s.skipped ? s.found : undefined,
            excluded: notFound,
            'Not Found': notFound,
            Errors: priorSummary.Errors ?? priorSummary.errors ?? 0,
            eligible: denominators.founders?.total ?? null
        };
    }

    if (stageKey === 'emailDiscovery') {
        const s = stats.emailDiscovery;
        if (s.skipped) {
            return {
                ...withCost,
                skipped: true,
                imported: s.found,
                Found: s.found,
                found: s.found,
                processed: s.found,
                eligible: denominators.emailDiscovery?.total ?? s.found
            };
        }
        return {
            ...withCost,
            processed: s.processed,
            Found: s.found,
            found: s.found,
            'Not Found': s.notFound,
            notFound: s.notFound,
            errors: s.errors,
            eligible: denominators.emailDiscovery?.total ?? null
        };
    }

    if (stageKey === 'verification') {
        const s = stats.verification;
        if (s.skipped) {
            return { ...withCost, skipped: true, processed: 0 };
        }
        return {
            ...withCost,
            Verified: s.verified,
            verified: s.verified,
            processed: s.verified,
            Valid: s.valid,
            valid: s.valid,
            Invalid: s.invalid,
            invalid: s.invalid,
            Unknown: s.unknown,
            unknown: s.unknown,
            'Valid-Risky': s.validRisky,
            'valid-risky': s.validRisky,
            eligible: denominators.verification?.total ?? null
        };
    }

    if (stageKey === 'personalization') {
        const s = stats.personalization;
        if (s.skipped) {
            return { ...withCost, skipped: true, personalized: 0, Personalized: 0, processed: 0 };
        }
        return {
            ...withCost,
            processed: s.personalized,
            personalized: s.personalized,
            Personalized: s.personalized,
            eligible: denominators.personalization?.total ?? null
        };
    }

    return { ...withCost, ...priorSummary };
}

/**
 * Per-stage denominators for spreadsheet column progress (processed / total).
 * @param {ReturnType<typeof countJobStageStats> extends Promise<infer T> ? T : never} stats
 * @param {Record<string, unknown>} options
 */
export function resolveStageDenominators(stats, options = {}) {
    const processable = stats.domainPrep?.processable ?? 0;
    const foundersFound = stats.founders?.found ?? 0;
    const emailsFound = stats.emailDiscovery?.found ?? 0;
    const verified = stats.verification?.verified ?? 0;
    const personalizeEligible =
        (stats.verification?.valid ?? 0) + (stats.verification?.validRisky ?? 0);

    const emailTotal = options.skipFounderFinder
        ? Math.max(emailsFound, processable)
        : foundersFound;

    const verifyTotal = options.skipEmailFinder
        ? Math.max(verified, emailsFound)
        : emailsFound;

    const personalizationTotal = options.skipVerification
        ? Math.max(personalizeEligible, verifyTotal)
        : Math.max(personalizeEligible, 0);

    return {
        domainPrep: { total: processable },
        founders: { total: processable },
        emailDiscovery: { total: emailTotal || processable },
        verification: { total: verifyTotal || emailTotal || processable },
        personalization: {
            total: personalizationTotal || verifyTotal || emailTotal || processable
        }
    };
}

function stageProcessedCount(stageKey, stats) {
    if (stageKey === 'domainPrep') {
        return stats.domainPrep?.processable ?? 0;
    }
    if (stageKey === 'founders') {
        return stats.founders?.processed ?? 0;
    }
    if (stageKey === 'emailDiscovery') {
        if (stats.emailDiscovery?.skipped) {
            return stats.emailDiscovery?.found ?? 0;
        }
        return stats.emailDiscovery?.processed ?? 0;
    }
    if (stageKey === 'verification') {
        if (stats.verification?.skipped) return 0;
        return stats.verification?.verified ?? 0;
    }
    if (stageKey === 'personalization') {
        if (stats.personalization?.skipped) return 0;
        return stats.personalization?.personalized ?? 0;
    }
    return 0;
}

function stageSkipped(stageKey, stats) {
    if (stageKey === 'founders') return !!stats.founders?.skipped;
    if (stageKey === 'emailDiscovery') return !!stats.emailDiscovery?.skipped;
    if (stageKey === 'verification') return !!stats.verification?.skipped;
    if (stageKey === 'personalization') return !!stats.personalization?.skipped;
    return false;
}

/**
 * Derive lifecycle status from spreadsheet fill rates (multiple stages may be `running`).
 */
export function deriveStageStatus(stageKey, stats, denominators, { jobRunning, finalize = false } = {}) {
    if (finalize) {
        return 'completed';
    }

    const total = denominators[stageKey]?.total ?? 0;
    const processed = stageProcessedCount(stageKey, stats);
    const skipped = stageSkipped(stageKey, stats);

    if (stageKey === 'domainPrep') {
        if (processed > 0 || total > 0) {
            return jobRunning && processed < total ? 'running' : 'completed';
        }
        return jobRunning ? 'pending' : 'completed';
    }

    if (skipped) {
        if (processed > 0 || total > 0) {
            return 'completed';
        }
        return jobRunning ? 'pending' : 'completed';
    }

    if (processed <= 0) {
        return jobRunning ? 'pending' : 'completed';
    }

    if (total > 0 && processed >= total) {
        return 'completed';
    }

    return 'running';
}

function buildStagesFromStats(row, stats, ctx, { finalize = false } = {}) {
    const options = ctx.options || {};
    const jobRunning = !finalize && (row.status === 'running' || row.status === 'queued');
    const denominators = resolveStageDenominators(stats, options);

    const ctxWithPrep = {
        ...ctx,
        stages: {
            ...(ctx.stages || row.stages || {}),
            domainPrep: {
                ...(ctx.stages?.domainPrep || row.stages?.domainPrep || {}),
                summary: {
                    ...(ctx.stages?.domainPrep?.summary || row.stages?.domainPrep?.summary || {}),
                    processable: stats.domainPrep.processable
                }
            }
        }
    };
    const jobTotal = resolveJobTotal(ctxWithPrep) ?? stats.domainPrep.processable ?? null;

    const stages = { ...(row.stages || {}) };
    const stageKeys = Object.keys(stages).filter((k) => STANDARD_STAGE_KEYS.includes(k));
    const ordered = STANDARD_STAGE_KEYS.filter((k) => stageKeys.includes(k));
    const now = new Date().toISOString();

    for (const stageKey of ordered) {
        const prior = stages[stageKey] || {};
        const priorSummary = prior.summary || {};
        const summary = summaryFromStats(stageKey, stats, priorSummary, denominators);
        const stageTotal = denominators[stageKey]?.total ?? jobTotal;
        const progress = buildCanonicalProgress(stageKey, summary, stageTotal ?? jobTotal, {});
        const status = deriveStageStatus(stageKey, stats, denominators, { jobRunning, finalize });
        const wasRunning = prior.status === 'running';
        const isActive = status === 'running' || status === 'completed';

        stages[stageKey] = {
            ...prior,
            status,
            error: prior.error ?? null,
            startedAt: prior.startedAt || (isActive && status !== 'pending' ? now : null),
            completedAt:
                status === 'completed'
                    ? prior.completedAt || now
                    : status === 'running'
                        ? null
                        : prior.completedAt ?? null,
            summary,
            progress
        };

        if (status === 'running' && !wasRunning && !stages[stageKey].startedAt) {
            stages[stageKey].startedAt = now;
        }
    }

    return stages;
}

async function countStatsForJob(ctx, runStartedAt = null) {
    const options = ctx.options || {};
    return countJobStageStats(ctx.agencyId, ctx.clientId, ctx.jobId, {
        skipFounderFinder: options.skipFounderFinder,
        skipEmailFinder: options.skipEmailFinder,
        skipVerification: options.skipVerification,
        personalizeFirstLine: options.personalizeFirstLine,
        domainCheckSkipped: options.skipDomainCheck === true,
        // Scope email/verify/personalization counts to this run (jobs.created_at),
        // matching the queue eligibility boundary, so reprocess runs don't show
        // prior-run completions as this run's progress.
        runStartedAt
    });
}

/**
 * Live reconcile during a run — spreadsheet counts drive summary/progress/status.
 * @param {import('./context.js').EnrichmentContext | { jobId: string, agencyId: string, clientId?: string, options?: object, stages?: object }} ctx
 */
export async function reconcileJobStagesLive(ctx) {
    // Counting happens under the stages lock so a stale count from one process can
    // never land after a fresher one — that's what made progress go backwards.
    let stages = {};
    await updateJobStagesLocked(ctx.jobId, ctx.agencyId, async (row) => {
        const stats = await countStatsForJob(ctx, row.created_at);
        stages = buildStagesFromStats(row, stats, ctx, { finalize: false });
        return stages;
    });
    return stages;
}

/**
 * Final reconcile — same spreadsheet counts, all stages marked completed.
 * @param {import('./context.js').EnrichmentContext} ctx
 */
export async function reconcileJobStagesFromDb(ctx) {
    let stages = {};
    await updateJobStagesLocked(ctx.jobId, ctx.agencyId, async (row) => {
        const stats = await countStatsForJob(ctx, row.created_at);
        stages = buildStagesFromStats(row, stats, ctx, { finalize: true });
        return stages;
    });
    return stages;
}

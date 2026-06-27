import { logTimestamp } from '../utils/logTimestamp.js';

/**
 * Pipeline timing — persisted on jobs.options.timingLog / timingTotals for post-run analysis.
 */

export function initJobTiming(job, options = {}) {
    if (!job) return;
    job.timingLog = job.timingLog || options.timingLog || [];
    job.timingTotals = job.timingTotals || options.timingTotals || {};
}

export function recordJobTiming(job, { label, category = 'misc', durationMs, rows, stage, meta, silent = false }) {
    if (!job?.id || !label || !Number.isFinite(durationMs)) return;

    initJobTiming(job);

    const entry = {
        at: new Date().toISOString(),
        label,
        category,
        ms: durationMs,
        ...(rows != null ? { rows } : {}),
        ...(stage ? { stage } : {}),
        ...(meta && Object.keys(meta).length ? { meta } : {})
    };

    job.timingLog.push(entry);

    const totals = job.timingTotals[label] || { count: 0, totalMs: 0, totalRows: 0, maxMs: 0 };
    totals.count += 1;
    totals.totalMs += durationMs;
    if (rows != null) totals.totalRows += rows;
    totals.maxMs = Math.max(totals.maxMs, durationMs);
    job.timingTotals[label] = totals;

    if (silent) return;

    const rowsSuffix = rows != null ? ` (${rows} rows)` : '';
    console.log(`[${job.id}] [${logTimestamp()}] [timing] ${label}: ${durationMs}ms${rowsSuffix}`);
}

/** Log aggregated totals for a label (after silent per-batch recordings). */
export function logTimingTotal(job, label, { stage } = {}) {
    const totals = job?.timingTotals?.[label];
    if (!totals?.count) return;
    recordJobTiming(job, {
        label: `${label}:total`,
        category: label.startsWith('upsert:') ? 'upsert' : 'misc',
        durationMs: totals.totalMs,
        rows: totals.totalRows || undefined,
        stage,
        meta: { batches: totals.count, maxMs: totals.maxMs }
    });
}

/**
 * Summarize recorded timings for a stage. Compares sub-timings against stage wall time.
 */
export function logStageBreakdown(job, stageKey, stageDurationMs, logFn) {
    if (!job?.timingLog?.length || !logFn) return;

    const byLabel = new Map();
    for (const entry of job.timingLog) {
        if (entry.stage !== stageKey) continue;
        if (entry.label === `stage:${stageKey}` || entry.label.endsWith(':total')) continue;
        byLabel.set(entry.label, (byLabel.get(entry.label) || 0) + (entry.ms || 0));
    }

    if (!byLabel.size) return;

    const parts = [...byLabel.entries()].sort((a, b) => b[1] - a[1]);
    const attributedMs = parts.reduce((sum, [, ms]) => sum + ms, 0);
    const unattributedMs = Math.max(0, stageDurationMs - attributedMs);
    const summary = parts.map(([label, ms]) => `${label} ${ms}ms`).join(', ');
    const unattributedSuffix = unattributedMs > 50 ? `, unattributed ${unattributedMs}ms` : '';

    logFn(
        `Stage ${stageKey} breakdown (${stageDurationMs}ms): ${summary}${unattributedSuffix}`
    );
}

export async function timeJobOp(job, spec, fn) {
    const start = Date.now();
    try {
        return await fn();
    } finally {
        recordJobTiming(job, { ...spec, durationMs: Date.now() - start });
    }
}

export function makeUpsertTiming(job, stage, { silent = false } = {}) {
    return (detail) => {
        recordJobTiming(job, {
            label: `upsert:${detail.type}`,
            category: 'upsert',
            durationMs: detail.totalMs,
            rows: detail.rows,
            stage,
            silent,
            meta: {
                companiesMs: detail.companiesMs,
                contactsMs: detail.contactsMs,
                ...(detail.signalMs ? { signalMs: detail.signalMs } : {})
            }
        });
    };
}

export function timingFromOptions(options = {}) {
    return {
        timingLog: Array.isArray(options.timingLog) ? options.timingLog : [],
        timingTotals: options.timingTotals && typeof options.timingTotals === 'object'
            ? options.timingTotals
            : {}
    };
}

/** Active CPU probe for Vercel Workflows cost modelling — see server/docs/cpu-probe-vercel.md */
export function startCpuProbe() {
    return {
        cpuStart: process.cpuUsage(),
        wallStart: Date.now()
    };
}

export function logCpuProbe({ cpuStart, wallStart, domainCount, jobId = null }) {
    if (!cpuStart || !wallStart || !Number.isFinite(domainCount) || domainCount <= 0) {
        return;
    }

    const cpu = process.cpuUsage(cpuStart);
    const wallMs = Date.now() - wallStart;
    const cpuSeconds = (cpu.user + cpu.system) / 1e6;
    const wallSeconds = wallMs / 1000;
    const prefix = jobId ? `[${jobId}] ` : '';

    console.log(
        `${prefix}[cpu-probe] domains=${domainCount} cpu_seconds=${cpuSeconds.toFixed(3)} wall_seconds=${wallSeconds.toFixed(1)} cpu_per_domain_ms=${((cpuSeconds / domainCount) * 1000).toFixed(1)} cpu_wall_ratio=${(cpuSeconds / wallSeconds).toFixed(3)}`
    );
}

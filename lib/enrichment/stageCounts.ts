import type { PipelineStageKey, PipelineStageState, PipelineStageStatus } from "@/lib/pipeline/types";

export type JobStageCounts = {
    jobId?: string;
    pipelineMode?: string;
    jobCost?: number;
    domainCheckSkipped?: boolean;
    domainPrep?: {
        total?: number;
        pending?: number;
        processing?: number;
        done?: number;
        skipped?: number;
        processable?: number;
        dns?: {
            checked?: number;
            live?: number;
            dead?: number;
            unknown?: number;
            skipped?: number;
        };
    };
    serperShopping?: { processed?: number; matched?: number; none?: number };
    signalWaterfall?: {
        signals?: number;
        done?: number;
        skipped?: number;
        pending?: number;
    };
    founders?: { processed?: number; found?: number };
    emailDiscovery?: { processed?: number; found?: number };
    verification?: {
        verified?: number;
        valid?: number;
        invalid?: number;
        unknown?: number;
        validRisky?: number;
    };
    personalization?: { processed?: number; personalized?: number };
    costs?: Record<string, number>;
};

function num(value: unknown): number {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : 0;
}

function deriveStatus(
    processed: number,
    total: number,
    opts: { skipped?: boolean; jobRunning?: boolean } = {}
): PipelineStageStatus {
    if (opts.skipped) return "completed";
    if (total > 0 && processed >= total) return "completed";
    if (processed > 0) return "running";
    if (opts.jobRunning) return "pending";
    return "pending";
}

function costSummary(stageKey: string, costs?: Record<string, number>) {
    const amount = num(costs?.[stageKey]);
    if (!(amount > 0)) return {};
    return { cost: Number(amount.toFixed(6)), Cost: `$${amount.toFixed(2)}` };
}

/**
 * Map get_job_stage_counts() RPC payload into jobs.stages-shaped progress for the UI.
 */
export function stageCountsToStages(
    counts: JobStageCounts | null | undefined,
    prior: Record<string, PipelineStageState> | null | undefined,
    opts: { jobRunning?: boolean } = {}
): Partial<Record<PipelineStageKey, PipelineStageState>> {
    if (!counts) return {};

    const jobRunning = opts.jobRunning === true;
    const totalDomains = num(counts.domainPrep?.total);
    const processable = num(counts.domainPrep?.processable) || totalDomains;
    const costs = counts.costs || {};
    const out: Partial<Record<PipelineStageKey, PipelineStageState>> = {};

    const dns = counts.domainPrep?.dns || {};
    const dnsChecked = num(dns.checked);
    const domainSkippedCheck = counts.domainCheckSkipped === true;
    const domainProcessed = domainSkippedCheck
        ? totalDomains
        : dnsChecked > 0
          ? dnsChecked
          : num(counts.domainPrep?.done) + num(counts.domainPrep?.skipped);
    const domainStatus = deriveStatus(domainProcessed, totalDomains, {
        skipped: domainSkippedCheck && totalDomains > 0,
        jobRunning,
    });
    out.domainPrep = {
        status: domainStatus,
        startedAt: prior?.domainPrep?.startedAt ?? null,
        completedAt: domainStatus === "completed" ? prior?.domainPrep?.completedAt ?? new Date().toISOString() : null,
        error: null,
        summary: {
            processable,
            checked: dnsChecked,
            live: num(dns.live),
            dead: num(dns.dead),
            unknown: num(dns.unknown),
            skippedExisting: num(counts.domainPrep?.skipped),
            domainCheckSkipped: domainSkippedCheck,
            processed: domainProcessed,
            ...costSummary("domainPrep", costs),
        },
        progress: {
            stage: "domainPrep",
            processed: domainProcessed,
            total: totalDomains || processable,
            stats: {
                live: num(dns.live),
                dead: num(dns.dead),
                unknown: num(dns.unknown),
            },
        },
    };

    if (counts.pipelineMode === "shopping_audit" || counts.serperShopping) {
        const processed = num(counts.serperShopping?.processed);
        const matched = num(counts.serperShopping?.matched);
        const none = num(counts.serperShopping?.none);
        const status = deriveStatus(processed, totalDomains, { jobRunning });
        out.serperShopping = {
            status,
            startedAt: prior?.serperShopping?.startedAt ?? null,
            completedAt: status === "completed" ? prior?.serperShopping?.completedAt ?? new Date().toISOString() : null,
            error: null,
            summary: {
                processed,
                matched,
                clean: matched,
                ambiguous: 0,
                none,
                ...costSummary("serperShopping", costs),
            },
            progress: {
                stage: "serperShopping",
                processed,
                total: totalDomains,
                stats: { matched, none },
            },
        };

        const signals = num(counts.signalWaterfall?.signals);
        const waterfallDone = num(counts.signalWaterfall?.done) + num(counts.signalWaterfall?.skipped);
        // Waterfall finishes when queue is drained (pending=0) after serper matched work.
        const waterfallTotal = Math.max(totalDomains, waterfallDone, signals);
        const waterfallProcessed = waterfallDone > 0 ? waterfallDone : signals;
        const wfStatus = deriveStatus(waterfallProcessed, waterfallTotal, {
            jobRunning,
            skipped: totalDomains > 0 && num(counts.signalWaterfall?.pending) === 0 && processed >= totalDomains,
        });
        out.signalWaterfall = {
            status: wfStatus,
            startedAt: prior?.signalWaterfall?.startedAt ?? null,
            completedAt: wfStatus === "completed" ? prior?.signalWaterfall?.completedAt ?? new Date().toISOString() : null,
            error: null,
            summary: {
                signals,
                processed: waterfallProcessed,
                totalCandidates: totalDomains,
                ...costSummary("signalWaterfall", costs),
            },
            progress: {
                stage: "signalWaterfall",
                processed: waterfallProcessed,
                total: totalDomains,
                stats: { signals },
            },
        };
    }

    const foundersProcessed = num(counts.founders?.processed);
    const foundersFound = num(counts.founders?.found);
    const foundersStatus = deriveStatus(foundersProcessed, processable || totalDomains, { jobRunning });
    out.founders = {
        status: foundersStatus,
        startedAt: prior?.founders?.startedAt ?? null,
        completedAt: foundersStatus === "completed" ? prior?.founders?.completedAt ?? new Date().toISOString() : null,
        error: null,
        summary: {
            processed: foundersProcessed,
            Found: foundersFound,
            found: foundersFound,
            ...costSummary("founders", costs),
        },
        progress: {
            stage: "founders",
            processed: foundersProcessed,
            total: processable || totalDomains,
            found: foundersFound,
            stats: { Found: foundersFound, Processed: foundersProcessed },
        },
    };

    const emailProcessed = num(counts.emailDiscovery?.processed);
    const emailFound = num(counts.emailDiscovery?.found);
    const emailStatus = deriveStatus(emailProcessed, processable || totalDomains, { jobRunning });
    out.emailDiscovery = {
        status: emailStatus,
        startedAt: prior?.emailDiscovery?.startedAt ?? null,
        completedAt: emailStatus === "completed" ? prior?.emailDiscovery?.completedAt ?? new Date().toISOString() : null,
        error: null,
        summary: {
            processed: emailProcessed,
            Found: emailFound,
            found: emailFound,
            ...costSummary("emailDiscovery", costs),
        },
        progress: {
            stage: "emailDiscovery",
            processed: emailProcessed,
            total: processable || totalDomains,
            found: emailFound,
            stats: { Found: emailFound },
        },
    };

    const verified = num(counts.verification?.verified);
    const verifyStatus = deriveStatus(verified, emailFound || processable || totalDomains, { jobRunning });
    out.verification = {
        status: verifyStatus,
        startedAt: prior?.verification?.startedAt ?? null,
        completedAt: verifyStatus === "completed" ? prior?.verification?.completedAt ?? new Date().toISOString() : null,
        error: null,
        summary: {
            verified,
            Verified: verified,
            valid: num(counts.verification?.valid),
            Valid: num(counts.verification?.valid),
            invalid: num(counts.verification?.invalid),
            Invalid: num(counts.verification?.invalid),
            unknown: num(counts.verification?.unknown),
            Unknown: num(counts.verification?.unknown),
            "valid-risky": num(counts.verification?.validRisky),
            "Valid-Risky": num(counts.verification?.validRisky),
            processed: verified,
            ...costSummary("verification", costs),
        },
        progress: {
            stage: "verification",
            processed: verified,
            total: emailFound || processable || totalDomains,
            stats: {
                valid: num(counts.verification?.valid),
                invalid: num(counts.verification?.invalid),
                unknown: num(counts.verification?.unknown),
                "valid-risky": num(counts.verification?.validRisky),
            },
        },
    };

    const personalized = num(counts.personalization?.personalized);
    const personalizeProcessed = num(counts.personalization?.processed);
    const personalizeTotal = Math.max(
        personalized,
        personalizeProcessed,
        num(counts.verification?.valid) + num(counts.verification?.validRisky)
    );
    const personalizeStatus = deriveStatus(personalizeProcessed, personalizeTotal || verified, { jobRunning });
    out.personalization = {
        status: personalizeStatus,
        startedAt: prior?.personalization?.startedAt ?? null,
        completedAt: personalizeStatus === "completed" ? prior?.personalization?.completedAt ?? new Date().toISOString() : null,
        error: null,
        summary: {
            processed: personalizeProcessed,
            personalized,
            Personalized: personalized,
            eligible: personalizeTotal,
            ...costSummary("personalization", costs),
        },
        progress: {
            stage: "personalization",
            processed: personalizeProcessed,
            total: personalizeTotal || verified,
            stats: { Personalized: personalized, personalized },
            candidates: personalizeTotal,
        },
    };

    return out;
}

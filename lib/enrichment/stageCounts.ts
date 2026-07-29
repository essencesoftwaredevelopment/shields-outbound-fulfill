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
        queueActive?: number;
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
    emailDiscovery?: { processed?: number; found?: number; notFound?: number; errors?: number };
    verification?: {
        verified?: number;
        valid?: number;
        invalid?: number;
        unknown?: number;
        validRisky?: number;
    };
    personalization?: { processed?: number; personalized?: number };
    costs?: Record<string, number>;
    contacts?: { total?: number };
};

function num(value: unknown): number {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : 0;
}

function deriveStatus(
    processed: number,
    total: number,
    opts: { skipped?: boolean; jobRunning?: boolean; jobCompleted?: boolean } = {}
): PipelineStageStatus {
    // A completed job has no in-flight stages: finalize only marks a job
    // completed once no pipeline work remains, so count-vs-denominator math
    // (whose denominators over-count for shopping audits, e.g. verification's
    // 110 eligible vs 500 contacts) must never resurrect a "running" badge
    // and its phantom ETA.
    if (opts.jobCompleted) return "completed";
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
    opts: {
        jobRunning?: boolean;
        jobCompleted?: boolean;
        /**
         * Job skip options. Without them, skipped stages read as forever-"pending"
         * (their processed count never moves), which breaks two things: the status
         * line announces "Preparing Email Discovery…" for a stage that will never
         * run, and verification's denominator falls back to emailFound — which on
         * skipEmailFinder jobs grows in lockstep with verified, pinning the card
         * at "Completed" from the first batch onward.
         */
        job?: {
            skipFounderFinder?: boolean;
            skipEmailFinder?: boolean;
            skipVerification?: boolean;
            personalizeFirstLine?: boolean;
        } | null;
    } = {}
): Partial<Record<PipelineStageKey, PipelineStageState>> {
    if (!counts) return {};

    const jobRunning = opts.jobRunning === true;
    const jobCompleted = opts.jobCompleted === true;
    const skipFounders = opts.job?.skipFounderFinder === true;
    const skipEmails = opts.job?.skipEmailFinder === true;
    const skipVerify = opts.job?.skipVerification === true;
    // Only meaningful when job options are provided at all.
    const skipPersonalize = opts.job ? opts.job.personalizeFirstLine !== true : false;
    const totalDomains = num(counts.domainPrep?.total);
    // Domain-prep "processable" = input cohort after DNS (not post-waterfall leftovers).
    // RPC returns dns-aware processable; fall back to total when DNS was skipped.
    const processable = num(counts.domainPrep?.processable) || totalDomains;
    const costs = counts.costs || {};
    const out: Partial<Record<PipelineStageKey, PipelineStageState>> = {};

    const dns = counts.domainPrep?.dns || {};
    const dnsChecked = num(dns.checked);
    const dnsDead = num(dns.dead);
    const domainSkippedCheck = counts.domainCheckSkipped === true;
    const domainProcessed = domainSkippedCheck
        ? totalDomains
        : dnsChecked > 0
          ? dnsChecked
          : totalDomains > 0 && num(counts.domainPrep?.pending) + num(counts.domainPrep?.done) + num(counts.domainPrep?.skipped) >= totalDomains
            ? totalDomains
            : dnsChecked;
    const domainStatus = deriveStatus(domainProcessed, totalDomains, {
        skipped: domainSkippedCheck && totalDomains > 0,
        jobRunning,
        jobCompleted,
    });
    out.domainPrep = {
        status: domainStatus,
        startedAt: prior?.domainPrep?.startedAt ?? null,
        completedAt: domainStatus === "completed" ? prior?.domainPrep?.completedAt ?? new Date().toISOString() : null,
        error: null,
        summary: {
            // Hero number: domains that entered the job after DNS (or all when DNS skipped).
            processable: domainSkippedCheck ? totalDomains : Math.max(processable, totalDomains - dnsDead),
            checked: domainSkippedCheck ? 0 : dnsChecked,
            live: domainSkippedCheck ? totalDomains : num(dns.live),
            dead: dnsDead,
            unknown: num(dns.unknown),
            skippedExisting: 0,
            domainCheckSkipped: domainSkippedCheck,
            processed: domainProcessed,
            total: totalDomains,
            ...costSummary("domainPrep", costs),
        },
        progress: {
            stage: "domainPrep",
            processed: domainProcessed,
            total: totalDomains || processable,
            stats: {
                live: domainSkippedCheck ? totalDomains : num(dns.live),
                dead: dnsDead,
                unknown: num(dns.unknown),
            },
        },
    };

    // Only emit shopping-audit stage shells for shopping_audit jobs.
    // get_job_stage_counts always returns serperShopping/signalWaterfall objects
    // (often zeros / domain-done mirrors) — treating those as truthy falsely flips
    // standard jobs into the shopping-audit card layout.
    if (counts.pipelineMode === "shopping_audit") {
        const processed = num(counts.serperShopping?.processed);
        const matched = num(counts.serperShopping?.matched);
        const none = num(counts.serperShopping?.none);
        const status = deriveStatus(processed, totalDomains, { jobRunning, jobCompleted });
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
            jobCompleted,
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

    // Contact enrichment denominators: contacts on this job (CSV/import size), not
    // post-waterfall queue leftovers.
    const contactTotal = num(counts.contacts?.total) || processable || totalDomains;

    const foundersProcessed = num(counts.founders?.processed);
    const foundersFound = num(counts.founders?.found);
    const foundersStatus = deriveStatus(foundersProcessed, contactTotal, { skipped: skipFounders, jobRunning, jobCompleted });
    out.founders = {
        status: foundersStatus,
        startedAt: prior?.founders?.startedAt ?? null,
        completedAt: foundersStatus === "completed" ? prior?.founders?.completedAt ?? new Date().toISOString() : null,
        error: null,
        summary: {
            processed: foundersProcessed,
            Found: foundersFound,
            found: foundersFound,
            ...(skipFounders ? { skipped: true } : {}),
            ...costSummary("founders", costs),
        },
        progress: {
            stage: "founders",
            processed: foundersProcessed,
            total: contactTotal,
            found: foundersFound,
            stats: { Found: foundersFound, Processed: foundersProcessed },
        },
    };

    const emailProcessed = num(counts.emailDiscovery?.processed);
    const emailFound = num(counts.emailDiscovery?.found);
    const emailNotFound = num(counts.emailDiscovery?.notFound);
    const emailErrors = num(counts.emailDiscovery?.errors);
    const emailStatus = deriveStatus(emailProcessed, contactTotal, { skipped: skipEmails, jobRunning, jobCompleted });
    out.emailDiscovery = {
        status: emailStatus,
        startedAt: prior?.emailDiscovery?.startedAt ?? null,
        completedAt: emailStatus === "completed" ? prior?.emailDiscovery?.completedAt ?? new Date().toISOString() : null,
        error: null,
        summary: {
            processed: emailProcessed,
            Found: emailFound,
            found: emailFound,
            "Not Found": emailNotFound,
            notFound: emailNotFound,
            errors: emailErrors,
            ...(skipEmails ? { skipped: true } : {}),
            ...costSummary("emailDiscovery", costs),
        },
        progress: {
            stage: "emailDiscovery",
            processed: emailProcessed,
            total: contactTotal,
            found: emailFound,
            notFound: emailNotFound,
            stats: {
                Found: emailFound,
                "Not Found": emailNotFound,
                errors: emailErrors,
            },
        },
    };

    const verified = num(counts.verification?.verified);
    // skipEmailFinder: emails came from the upload, so emailFound only counts
    // contacts from already-processed domains — it tracks `verified` in lockstep
    // and can never be a denominator. The stable cohort size is processable.
    const verifyTotal = skipEmails
        ? (processable || contactTotal)
        : (emailFound || contactTotal);
    const verifyStatus = deriveStatus(verified, verifyTotal, { skipped: skipVerify, jobRunning, jobCompleted });
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
            ...(skipVerify ? { skipped: true } : {}),
            ...costSummary("verification", costs),
        },
        progress: {
            stage: "verification",
            processed: verified,
            total: verifyTotal,
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
    const personalizeStatus = deriveStatus(personalizeProcessed, personalizeTotal || verified, {
        skipped: skipPersonalize,
        jobRunning,
        jobCompleted,
    });
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

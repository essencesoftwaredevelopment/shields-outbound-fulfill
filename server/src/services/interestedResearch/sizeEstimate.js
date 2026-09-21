/**
 * Pure helpers for store-size / 7-figure gating.
 * Used by the OpenAI web_search size agent and CTA branching (VSL vs Calendly).
 */

export const SEVEN_FIGURE_REVENUE_FLOOR = 1_000_000;

export const ESSENCE_BUILD_OFFER_URL = 'https://essenceretention.com/acq-build-offer';

const CONFIDENCE_LEVELS = new Set(['low', 'medium', 'high']);

function asText(value) {
    if (value === null || value === undefined) return '';
    return String(value).trim();
}

function asPositiveNumberOrNull(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.round(n);
}

/**
 * Normalize a model/DB sizeEstimate object. Returns null when unusable.
 *
 * @param {unknown} raw
 * @returns {{
 *   isSevenFigureLikely: boolean,
 *   estimatedAnnualRevenueMin: number | null,
 *   estimatedAnnualRevenueMax: number | null,
 *   confidence: 'low' | 'medium' | 'high',
 *   rationale: string,
 *   signals: string[],
 *   sources: { title: string, url: string }[],
 *   source: string
 * } | null}
 */
export function normalizeSizeEstimate(raw) {
    if (!raw || typeof raw !== 'object') return null;

    const confidenceRaw = asText(raw.confidence).toLowerCase();
    const confidence = CONFIDENCE_LEVELS.has(confidenceRaw) ? confidenceRaw : 'low';

    const min = asPositiveNumberOrNull(raw.estimatedAnnualRevenueMin);
    const max = asPositiveNumberOrNull(raw.estimatedAnnualRevenueMax);

    const signals = (Array.isArray(raw.signals) ? raw.signals : [])
        .map((entry) => asText(entry))
        .filter(Boolean)
        .slice(0, 12);

    const sources = (Array.isArray(raw.sources) ? raw.sources : [])
        .map((entry) => {
            if (!entry || typeof entry !== 'object') return null;
            const url = asText(entry.url || entry.link);
            if (!url) return null;
            const title = asText(entry.title) || url;
            return { title: title.slice(0, 200), url: url.slice(0, 500) };
        })
        .filter(Boolean)
        .slice(0, 12);

    const rationale = asText(raw.rationale).slice(0, 2_000);
    const source = asText(raw.source) || 'openai_web_search';

    // Explicit boolean wins; otherwise infer from min when present.
    let isSevenFigureLikely = Boolean(raw.isSevenFigureLikely);
    if (raw.isSevenFigureLikely === undefined || raw.isSevenFigureLikely === null) {
        isSevenFigureLikely = min !== null && min >= SEVEN_FIGURE_REVENUE_FLOOR;
    }

    return {
        isSevenFigureLikely,
        estimatedAnnualRevenueMin: min,
        estimatedAnnualRevenueMax: max,
        confidence,
        rationale,
        signals,
        sources,
        source
    };
}

/**
 * Hard gate for the free build VSL path. Low/medium confidence never qualifies.
 */
export function shouldOfferBuildCta(sizeEstimate) {
    const normalized = normalizeSizeEstimate(sizeEstimate);
    if (!normalized) return false;
    return normalized.isSevenFigureLikely === true && normalized.confidence === 'high';
}

/**
 * Prefer imported contact_insights revenue when it clearly answers the gate.
 * Returns a sizeEstimate, or null when insights are missing / ambiguous (run the agent).
 *
 * @param {{ annual_revenue_min?: unknown, annual_revenue_max?: unknown, annual_revenue_text?: unknown } | null | undefined} insights
 */
export function sizeEstimateFromContactInsights(insights) {
    if (!insights || typeof insights !== 'object') return null;

    const min = Number(insights.annual_revenue_min);
    const max = Number(insights.annual_revenue_max);
    const hasMin = Number.isFinite(min) && min > 0;
    const hasMax = Number.isFinite(max) && max > 0;
    const text = asText(insights.annual_revenue_text);

    if (hasMin && min >= SEVEN_FIGURE_REVENUE_FLOOR) {
        return normalizeSizeEstimate({
            isSevenFigureLikely: true,
            estimatedAnnualRevenueMin: min,
            estimatedAnnualRevenueMax: hasMax ? max : null,
            confidence: 'high',
            rationale: text
                ? `Imported annual revenue (${text}) is at or above $1M.`
                : `Imported annual_revenue_min (${min}) is at or above $1M.`,
            signals: ['contact_insights.annual_revenue_min'],
            sources: [],
            source: 'contact_insights'
        });
    }

    // Clearly under $1M when the ceiling is known and below the floor.
    if (hasMax && max < SEVEN_FIGURE_REVENUE_FLOOR) {
        return normalizeSizeEstimate({
            isSevenFigureLikely: false,
            estimatedAnnualRevenueMin: hasMin ? min : null,
            estimatedAnnualRevenueMax: max,
            confidence: 'high',
            rationale: text
                ? `Imported annual revenue (${text}) is below $1M.`
                : `Imported annual_revenue_max (${max}) is below $1M.`,
            signals: ['contact_insights.annual_revenue_max'],
            sources: [],
            source: 'contact_insights'
        });
    }

    return null;
}

/**
 * Merge a sizeEstimate onto an existing brief, or create a minimal brief shell.
 */
export function mergeSizeEstimateIntoBrief(brief, sizeEstimate, { company = '', domain = '' } = {}) {
    const normalized = normalizeSizeEstimate(sizeEstimate);
    if (!normalized) {
        return brief && typeof brief === 'object' ? brief : null;
    }

    if (brief && typeof brief === 'object') {
        return {
            ...brief,
            sizeEstimate: normalized
        };
    }

    return {
        company: asText(company),
        domain: asText(domain),
        industry: null,
        summary: 'Store-size research completed; limited public company profile beyond size signals.',
        talkingPoints: [],
        risks: [],
        sources: normalized.sources.slice(0, 8),
        reviewCount: null,
        estimatedVisitors: null,
        sizeEstimate: normalized
    };
}

/** Compact block for reply / follow-up prompts (no invented GMV in email — gate only). */
export function formatSizeEstimateForPrompt(sizeEstimate) {
    const normalized = normalizeSizeEstimate(sizeEstimate);
    if (!normalized) return '';

    const lines = [
        `Store-size estimate confidence: ${normalized.confidence}`,
        `Likely ≥$1M/year: ${normalized.isSevenFigureLikely ? 'yes' : 'no'}`
    ];
    if (normalized.rationale) {
        lines.push(`Rationale: ${normalized.rationale}`);
    }
    if (normalized.signals.length) {
        lines.push('Signals:');
        for (const signal of normalized.signals.slice(0, 6)) {
            lines.push(`- ${signal}`);
        }
    }
    if (shouldOfferBuildCta(normalized)) {
        lines.push(
            'CTA path: free build offer (VSL). Soft eligibility only — do not promise approval or invent revenue figures in the email.'
        );
    } else {
        lines.push(
            'CTA path: normal Calendly booking. Do not mention the free build offer or eligibility.'
        );
    }
    return lines.join('\n');
}

export function buildForcedOfferCtaInstructions(offerUrl) {
    const url = asText(offerUrl) || ESSENCE_BUILD_OFFER_URL;
    return [
        'HIGHEST PRIORITY CTA — overrides any Calendly / booking link in the campaign prompt.',
        'Do NOT include a Calendly, booking, or "grab a time" link.',
        'Based on our research, this brand may be eligible for our free on-brand popup & welcome flow',
        '(written, designed, and installed in about 24 hours). Soft eligibility only — do not promise they are approved.',
        'Do not invent or state a specific revenue number.',
        'Use exactly one CTA: this raw https URL on its own line (no markdown):',
        url
    ].join('\n');
}

export function buildForcedBookingCtaInstructions(bookingUrl) {
    const url = asText(bookingUrl);
    if (!url) return '';
    return [
        'CTA: use the normal booking link as the sole call to action.',
        'Do not mention a free build, eligibility, or the acq-build-offer page.',
        'Use this exact URL when linking to book:',
        url
    ].join('\n');
}

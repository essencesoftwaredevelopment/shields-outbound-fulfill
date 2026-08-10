/**
 * Pure helpers for the interested-reply research workflow. No DB / network —
 * everything here is unit-testable and safe to import from anywhere.
 */

export const RESEARCH_HOMEPAGE_TEXT_LIMIT = 8_000;

/**
 * Industry enum for the research brief — the popup-creation API's allowed
 * values, verbatim (see docs/popup-form-generate-brief-payload.md). There is
 * deliberately no catch-all: a company that fits none of these gets NO
 * industry (field omitted from brief and popup payload), never a wrong guess.
 */
export const RESEARCH_INDUSTRIES = Object.freeze([
    'beauty_skincare',
    'fashion_apparel',
    'food_beverage',
    'health_wellness',
    'home_garden',
    'electronics',
    'automotive',
    'pets',
    'sports_outdoors',
    'jewelry_accessories',
    'kids_baby',
    'gifts_collectibles'
]);

const RESEARCH_INDUSTRY_SET = new Set(RESEARCH_INDUSTRIES);

/** Coerce an LLM-emitted industry to the enum; anything off-list becomes null. */
export function normalizeResearchIndustry(raw) {
    const normalized = String(raw || '').trim().toLowerCase().replace(/[\s/-]+/g, '_');
    return RESEARCH_INDUSTRY_SET.has(normalized) ? normalized : null;
}
export const RESEARCH_SERPER_RESULT_LIMIT = 8;
export const RESEARCH_BRIEF_MAX_TALKING_POINTS = 6;
export const RESEARCH_BRIEF_MAX_SOURCES = 8;
/** Rough DTC heuristic: site visitors ≈ published review count × this factor. */
export const VISITORS_PER_REVIEW = 100;

function asText(value) {
    if (value === null || value === undefined) return '';
    return String(value).trim();
}

/** Strip an HTML document down to readable text for LLM context. */
export function stripHtmlToText(html = '') {
    if (!html || typeof html !== 'string') return '';
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|h[1-6]|section|article|tr)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/[ \t]+/g, ' ')
        .replace(/ ?\n ?/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** Pull <title> and meta description before stripping — highest-signal lines. */
export function extractHomepageSummary(html = '', { textLimit = RESEARCH_HOMEPAGE_TEXT_LIMIT } = {}) {
    const source = typeof html === 'string' ? html : '';
    const title = asText(source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
    const description = asText(
        source.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1]
        || source.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i)?.[1]
    );
    const text = stripHtmlToText(source).slice(0, Math.max(textLimit, 0));
    return { title, description, text };
}

/** Serper queries for one lead: overview, news, and review-count sources. */
export function buildSerperQueries({ companyName, domain }) {
    const company = asText(companyName);
    const host = asText(domain);
    const subject = company || host;
    if (!subject) return [];
    const queries = [];
    if (host) queries.push({ q: `${subject} ${host}`, num: RESEARCH_SERPER_RESULT_LIMIT });
    else queries.push({ q: subject, num: RESEARCH_SERPER_RESULT_LIMIT });
    queries.push({ q: `${subject} news OR launch OR funding OR review`, num: RESEARCH_SERPER_RESULT_LIMIT });
    // Aimed at Trustpilot / Google / on-site review aggregates for visitor estimate.
    queries.push({
        q: host
            ? `${subject} ${host} Trustpilot OR "customer reviews" OR "product reviews"`
            : `${subject} Trustpilot OR "customer reviews" OR "product reviews"`,
        num: RESEARCH_SERPER_RESULT_LIMIT
    });
    return queries;
}

/**
 * Coerce a raw review total into a positive integer. Accepts numbers and common
 * string forms ("1,234", "1.2k", "1200 reviews"). Returns null when unknown.
 */
export function normalizeReviewCount(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    if (typeof raw === 'number') {
        if (!Number.isFinite(raw) || raw <= 0) return null;
        return Math.round(raw);
    }
    const text = asText(raw).toLowerCase().replace(/,/g, '');
    if (!text) return null;
    const withSuffix = text.match(/^(\d+(?:\.\d+)?)\s*([kmb])\b/);
    if (withSuffix) {
        const base = Number(withSuffix[1]);
        if (!Number.isFinite(base) || base <= 0) return null;
        const mult = { k: 1_000, m: 1_000_000, b: 1_000_000_000 }[withSuffix[2]];
        return Math.round(base * mult);
    }
    const plain = text.match(/(\d+(?:\.\d+)?)/);
    if (!plain) return null;
    const n = Number(plain[1]);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.round(n);
}

/** estimateVisitors = reviewCount × VISITORS_PER_REVIEW; null when no count. */
export function estimateVisitorsFromReviewCount(reviewCount) {
    const count = normalizeReviewCount(reviewCount);
    if (count === null) return null;
    return count * VISITORS_PER_REVIEW;
}

/**
 * Best-effort scan of Serper snippets / titles for an explicit review total
 * (e.g. "Based on 1,234 reviews", "4.8 · 892 reviews on Trustpilot").
 * Prefers the largest grounded count found — DTC sites often surface the
 * aggregate store total on Trustpilot.
 */
export function extractReviewCountFromSerper(results = []) {
    const patterns = [
        /based on\s+([\d,.]+(?:\.\d+)?\s*[kmb]?)\s+reviews?/i,
        /([\d,.]+(?:\.\d+)?\s*[kmb]?)\s+reviews?\s+on\s+trustpilot/i,
        /trustpilot[^.]{0,40}?([\d,.]+(?:\.\d+)?\s*[kmb]?)\s+reviews?/i,
        /([\d,.]+(?:\.\d+)?\s*[kmb]?)\s*\+?\s*customer\s+reviews?/i,
        /([\d,.]+(?:\.\d+)?\s*[kmb]?)\s+reviews?/i
    ];
    let best = null;
    for (const result of Array.isArray(results) ? results : []) {
        const haystack = [result?.title, result?.snippet].filter(Boolean).join(' ');
        if (!haystack) continue;
        for (const pattern of patterns) {
            const match = haystack.match(pattern);
            if (!match) continue;
            const count = normalizeReviewCount(match[1]);
            if (count !== null && (best === null || count > best)) best = count;
        }
    }
    return best;
}

/** Reduce raw Serper responses to a compact serializable list for the brief LLM. */
export function compactSerperResults(responses = [], { limitPerQuery = RESEARCH_SERPER_RESULT_LIMIT } = {}) {
    const results = [];
    const seen = new Set();
    for (const response of Array.isArray(responses) ? responses : []) {
        const organic = Array.isArray(response?.organic) ? response.organic : [];
        for (const item of organic.slice(0, limitPerQuery)) {
            const link = asText(item?.link);
            const title = asText(item?.title);
            if (!link || !title || seen.has(link)) continue;
            seen.add(link);
            results.push({
                title,
                link,
                snippet: asText(item?.snippet).slice(0, 300),
                date: asText(item?.date) || null
            });
        }
        const kg = response?.knowledgeGraph;
        if (kg && typeof kg === 'object') {
            const kgTitle = asText(kg.title);
            const kgDescription = asText(kg.description);
            if (kgTitle && kgDescription) {
                results.push({
                    title: `Knowledge graph: ${kgTitle}`,
                    link: asText(kg.website) || null,
                    snippet: kgDescription.slice(0, 300),
                    date: null
                });
            }
        }
    }
    return results;
}

/**
 * Validate/normalize the LLM's brief JSON into the canonical shape:
 * { company, domain, industry, summary, talkingPoints, risks, sources,
 *   reviewCount, estimatedVisitors }.
 * Returns null when there is no usable summary (thin research → no brief).
 *
 * @param {object|null} raw
 * @param {{ company?: string, domain?: string, fallbackReviewCount?: number|null }} [opts]
 */
export function normalizeResearchBrief(raw, { company = '', domain = '', fallbackReviewCount = null } = {}) {
    if (!raw || typeof raw !== 'object') return null;
    const summary = asText(raw.summary);
    if (!summary) return null;

    const toStringList = (value, max) => (Array.isArray(value) ? value : [])
        .map((entry) => asText(entry))
        .filter(Boolean)
        .slice(0, max);

    const sources = (Array.isArray(raw.sources) ? raw.sources : [])
        .map((entry) => {
            if (!entry || typeof entry !== 'object') return null;
            const url = asText(entry.url || entry.link);
            const title = asText(entry.title);
            if (!url) return null;
            return { title: title || url, url };
        })
        .filter(Boolean)
        .slice(0, RESEARCH_BRIEF_MAX_SOURCES);

    const reviewCount = normalizeReviewCount(raw.reviewCount)
        ?? normalizeReviewCount(fallbackReviewCount);
    const estimatedVisitors = estimateVisitorsFromReviewCount(reviewCount);

    return {
        company: asText(raw.company) || asText(company),
        domain: asText(raw.domain) || asText(domain),
        industry: normalizeResearchIndustry(raw.industry),
        summary: summary.slice(0, 2_000),
        talkingPoints: toStringList(raw.talkingPoints, RESEARCH_BRIEF_MAX_TALKING_POINTS),
        risks: toStringList(raw.risks, RESEARCH_BRIEF_MAX_TALKING_POINTS),
        sources,
        reviewCount,
        estimatedVisitors
    };
}

/** Render the brief as a compact block for the reply-draft prompt. */
export function formatResearchBriefForPrompt(brief) {
    if (!brief || typeof brief !== 'object') return '';
    const summary = asText(brief.summary);
    if (!summary) return '';
    const lines = [];
    const company = asText(brief.company);
    const domain = asText(brief.domain);
    if (company || domain) {
        lines.push(`Company: ${[company, domain && `(${domain})`].filter(Boolean).join(' ')}`);
    }
    lines.push(`Summary: ${summary}`);
    const talkingPoints = (Array.isArray(brief.talkingPoints) ? brief.talkingPoints : [])
        .map((point) => asText(point))
        .filter(Boolean);
    if (talkingPoints.length) {
        lines.push('Talking points:');
        for (const point of talkingPoints) lines.push(`- ${point}`);
    }
    const risks = (Array.isArray(brief.risks) ? brief.risks : [])
        .map((risk) => asText(risk))
        .filter(Boolean);
    if (risks.length) {
        lines.push('Avoid / be careful with:');
        for (const risk of risks) lines.push(`- ${risk}`);
    }
    const reviewCount = normalizeReviewCount(brief.reviewCount);
    const estimatedVisitors = Number.isFinite(Number(brief.estimatedVisitors))
        && Number(brief.estimatedVisitors) > 0
        ? Math.round(Number(brief.estimatedVisitors))
        : estimateVisitorsFromReviewCount(reviewCount);
    if (reviewCount !== null) {
        lines.push(`Published reviews: ${reviewCount}`);
    }
    if (estimatedVisitors !== null) {
        lines.push(`Estimated site visitors (reviews × ${VISITORS_PER_REVIEW}): ${estimatedVisitors}`);
    }
    return lines.join('\n');
}

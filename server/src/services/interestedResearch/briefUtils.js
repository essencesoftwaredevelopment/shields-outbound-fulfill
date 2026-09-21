/**
 * Pure helpers for the interested-reply research workflow. No DB / network —
 * everything here is unit-testable and safe to import from anywhere.
 */

import { normalizeSizeEstimate } from './sizeEstimate.js';

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

/** Registrable label of a host (`thehandtitan.com` → `thehandtitan`). */
export function registrableSlug(domain) {
    const host = asText(domain).toLowerCase().replace(/^www\./, '');
    if (!host) return '';
    const labels = host.split('.').filter(Boolean);
    if (
        labels.length >= 3
        && ['co', 'com', 'org', 'net', 'gov'].includes(labels[labels.length - 2])
    ) {
        return labels[labels.length - 3] || '';
    }
    return (labels.length >= 2 ? labels[labels.length - 2] : labels[0]) || '';
}

/**
 * True when `companyName` is just the domain slug with spaces/caps
 * (`Thehandtitan` from `thehandtitan.com`). Those names are too easy for
 * Google to expand into unrelated "Titan" products, so queries should be
 * domain-anchored instead.
 */
export function isHumanizedDomainCompany(companyName, domain) {
    const slug = registrableSlug(domain);
    const collapsed = asText(companyName).toLowerCase().replace(/[\s\-_'’]+/g, '');
    return Boolean(slug) && collapsed === slug;
}

/**
 * First clause of a homepage <title> when it looks like a brand name.
 * "Hand Titan, natural trigger point…" → "Hand Titan".
 */
export function companyNameFromHomepageTitle(title, fallback = '') {
    const source = asText(title);
    if (!source) return asText(fallback);
    const candidate = asText(source.split(/\s*[|–—·•,:]\s*/)[0]);
    const words = candidate.split(/\s+/).filter(Boolean);
    if (candidate.length >= 3 && candidate.length <= 80 && words.length <= 6) {
        return candidate;
    }
    return asText(fallback) || candidate;
}

function hostnameFromUrl(url) {
    try {
        return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
        return '';
    }
}

function targetMatchNeedles({ companyName, domain }) {
    const needles = new Set();
    const host = asText(domain).toLowerCase().replace(/^www\./, '');
    if (host) needles.add(host);
    const slug = registrableSlug(domain);
    if (slug.length >= 4) needles.add(slug);
    const company = asText(companyName).toLowerCase();
    if (company.length >= 4) needles.add(company);
    const collapsed = company.replace(/[\s\-_'’]+/g, '');
    if (collapsed.length >= 6) needles.add(collapsed);
    return [...needles];
}

/**
 * Keep a search hit only when it is this company: on-domain, or the title /
 * snippet / URL mentions the host, domain slug, or full company name.
 * Partial tokens like "Titan" never count on their own.
 */
export function isSerperResultAboutTarget(result, { companyName = '', domain = '' } = {}) {
    const link = asText(result?.link);
    const host = hostnameFromUrl(link);
    const targetHost = asText(domain).toLowerCase().replace(/^www\./, '');
    if (targetHost && host && (host === targetHost || host.endsWith(`.${targetHost}`))) {
        return true;
    }

    const needles = targetMatchNeedles({ companyName, domain });
    if (!needles.length) return true;
    const haystack = [result?.title, result?.snippet, link, host]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
    return needles.some((needle) => haystack.includes(needle));
}

/** Drop off-target Serper hits before they reach the brief LLM. */
export function filterSerperResultsForTarget(results = [], { companyName = '', domain = '' } = {}) {
    const list = Array.isArray(results) ? results : [];
    if (!asText(domain) && !asText(companyName)) return list;
    return list.filter((result) => isSerperResultAboutTarget(result, { companyName, domain }));
}

/** Serper queries for one lead: overview, news, and review-count sources. */
export function buildSerperQueries({ companyName, domain }) {
    const company = asText(companyName);
    const host = asText(domain);
    if (!host && !company) return [];

    const quotedCompany = company ? `"${company}"` : '';
    if (!host) {
        return [
            { q: quotedCompany, num: RESEARCH_SERPER_RESULT_LIMIT },
            { q: `${quotedCompany} news OR launch OR funding OR review`, num: RESEARCH_SERPER_RESULT_LIMIT },
            { q: `${quotedCompany} Trustpilot OR "customer reviews" OR "product reviews"`, num: RESEARCH_SERPER_RESULT_LIMIT }
        ];
    }

    // Humanized-domain names ("Thehandtitan") make Google expand to unrelated
    // "Titan" products. Anchor every query on the host instead.
    const named = company && !isHumanizedDomainCompany(company, host);
    const subject = named ? `${quotedCompany} ${host}` : host;
    return [
        { q: subject, num: RESEARCH_SERPER_RESULT_LIMIT },
        { q: `${host} news OR launch OR funding`, num: RESEARCH_SERPER_RESULT_LIMIT },
        { q: `${host} Trustpilot OR "customer reviews" OR reviews`, num: RESEARCH_SERPER_RESULT_LIMIT }
    ];
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
 *   reviewCount, estimatedVisitors, sizeEstimate? }.
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
        .filter((entry) => isSerperResultAboutTarget(
            { title: entry.title, link: entry.url, snippet: '' },
            { companyName: asText(raw.company) || asText(company), domain: asText(raw.domain) || asText(domain) }
        ))
        .slice(0, RESEARCH_BRIEF_MAX_SOURCES);

    // Review totals come only from filtered Serper snippets — never from the
    // LLM, which will copy a "23 reviews" hit from a similarly named product.
    const reviewCount = normalizeReviewCount(fallbackReviewCount);
    const estimatedVisitors = estimateVisitorsFromReviewCount(reviewCount);

    const brief = {
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

    // sizeEstimate is produced by the OpenAI web_search size agent (or insights
    // short-circuit). Preserve when present — do not invent here.
    const sizeEstimate = normalizeSizeEstimate(raw.sizeEstimate);
    if (sizeEstimate) {
        brief.sizeEstimate = sizeEstimate;
    }
    return brief;
}

/**
 * Brief as exposed to the review page. Re-runs the normalizer so an older row
 * with a looser shape still renders predictably; null when there is no
 * summary to show (thin research, inline-path draft, or mid-regeneration).
 */
export function serializeResearchBriefForReview(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const normalized = normalizeResearchBrief(raw, { fallbackReviewCount: raw.reviewCount });
    if (!normalized) return null;
    // Re-attach sizeEstimate after normalize (normalizer already copies when present).
    if (raw.sizeEstimate && typeof raw.sizeEstimate === 'object' && !normalized.sizeEstimate) {
        normalized.sizeEstimate = raw.sizeEstimate;
    }
    return normalized;
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
    const size = brief.sizeEstimate && typeof brief.sizeEstimate === 'object'
        ? brief.sizeEstimate
        : null;
    if (size) {
        const confidence = asText(size.confidence) || 'unknown';
        const likely = size.isSevenFigureLikely === true ? 'yes' : 'no';
        lines.push(`Store-size estimate (≥$1M/year likely): ${likely} (confidence: ${confidence})`);
        const rationale = asText(size.rationale);
        if (rationale) lines.push(`Size rationale: ${rationale.slice(0, 500)}`);
    }
    return lines.join('\n');
}

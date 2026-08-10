/**
 * Pure helpers for the interested-reply research workflow. No DB / network —
 * everything here is unit-testable and safe to import from anywhere.
 */

export const RESEARCH_HOMEPAGE_TEXT_LIMIT = 8_000;
export const RESEARCH_SERPER_RESULT_LIMIT = 8;
export const RESEARCH_BRIEF_MAX_TALKING_POINTS = 6;
export const RESEARCH_BRIEF_MAX_SOURCES = 8;

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

/** Serper queries for one lead: company overview + recent news/announcements. */
export function buildSerperQueries({ companyName, domain }) {
    const company = asText(companyName);
    const host = asText(domain);
    const subject = company || host;
    if (!subject) return [];
    const queries = [];
    if (host) queries.push({ q: `${subject} ${host}`, num: RESEARCH_SERPER_RESULT_LIMIT });
    else queries.push({ q: subject, num: RESEARCH_SERPER_RESULT_LIMIT });
    queries.push({ q: `${subject} news OR launch OR funding OR review`, num: RESEARCH_SERPER_RESULT_LIMIT });
    return queries;
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
 * { company, domain, summary, talkingPoints, risks, sources }.
 * Returns null when there is no usable summary (thin research → no brief).
 */
export function normalizeResearchBrief(raw, { company = '', domain = '' } = {}) {
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

    return {
        company: asText(raw.company) || asText(company),
        domain: asText(raw.domain) || asText(domain),
        summary: summary.slice(0, 2_000),
        talkingPoints: toStringList(raw.talkingPoints, RESEARCH_BRIEF_MAX_TALKING_POINTS),
        risks: toStringList(raw.risks, RESEARCH_BRIEF_MAX_TALKING_POINTS),
        sources
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
    return lines.join('\n');
}

/**
 * OpenAI Responses + hosted web_search size agent.
 * No Serper — the model searches and opens pages itself.
 */
import OpenAI from 'openai';
import {
    normalizeSizeEstimate,
    SEVEN_FIGURE_REVENUE_FLOOR
} from './sizeEstimate.js';

export const SIZE_RESEARCH_MODEL = String(
    process.env.SIZE_RESEARCH_MODEL || process.env.INTERESTED_RESEARCH_MODEL || 'gpt-5.5'
).trim() || 'gpt-5.5';

export const SIZE_RESEARCH_REASONING_EFFORT = String(
    process.env.SIZE_RESEARCH_REASONING_EFFORT || 'high'
).trim() || 'high';

const SIZE_RESEARCH_TIMEOUT_MS = Math.max(
    Number(process.env.SIZE_RESEARCH_TIMEOUT_MS || 600_000) || 600_000,
    60_000
);

const SIZE_JSON_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: [
        'isSevenFigureLikely',
        'estimatedAnnualRevenueMin',
        'estimatedAnnualRevenueMax',
        'confidence',
        'rationale',
        'signals',
        'sources'
    ],
    properties: {
        isSevenFigureLikely: {
            type: 'boolean',
            description: `True only when evidence supports annual revenue at or above ${SEVEN_FIGURE_REVENUE_FLOOR}`
        },
        estimatedAnnualRevenueMin: {
            type: ['number', 'null'],
            description: 'Lower bound USD annual revenue estimate, or null if unknown'
        },
        estimatedAnnualRevenueMax: {
            type: ['number', 'null'],
            description: 'Upper bound USD annual revenue estimate, or null if unknown'
        },
        confidence: {
            type: 'string',
            enum: ['low', 'medium', 'high'],
            description: 'high only when multiple independent public signals agree'
        },
        rationale: {
            type: 'string',
            description: '2-5 sentences explaining the estimate from grounded sources'
        },
        signals: {
            type: 'array',
            items: { type: 'string' },
            description: 'Short grounded signals (reviews, headcount, funding, traffic proxies, etc.)'
        },
        sources: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['title', 'url'],
                properties: {
                    title: { type: 'string' },
                    url: { type: 'string' }
                }
            }
        }
    }
};

function asText(value) {
    if (value === null || value === undefined) return '';
    return String(value).trim();
}

function extractOutputText(response) {
    if (!response) return '';
    if (typeof response.output_text === 'string' && response.output_text.trim()) {
        return response.output_text.trim();
    }
    const parts = [];
    for (const item of Array.isArray(response.output) ? response.output : []) {
        if (item?.type !== 'message') continue;
        for (const content of Array.isArray(item.content) ? item.content : []) {
            if (content?.type === 'output_text' && content.text) {
                parts.push(String(content.text));
            }
        }
    }
    return parts.join('\n').trim();
}

function collectWebSearchSources(response) {
    const sources = [];
    const seen = new Set();
    for (const item of Array.isArray(response?.output) ? response.output : []) {
        if (item?.type !== 'web_search_call') continue;
        const actionSources = item?.action?.sources;
        if (!Array.isArray(actionSources)) continue;
        for (const src of actionSources) {
            const url = asText(src?.url);
            if (!url || seen.has(url)) continue;
            seen.add(url);
            sources.push({ title: asText(src?.title) || url, url });
        }
    }
    return sources;
}

function parseSizeJson(text) {
    const trimmed = asText(text);
    if (!trimmed) return null;
    try {
        return JSON.parse(trimmed);
    } catch {
        const match = trimmed.match(/\{[\s\S]*\}/);
        if (!match) return null;
        try {
            return JSON.parse(match[0]);
        } catch {
            return null;
        }
    }
}

/**
 * Run OpenAI agentic web research to estimate whether the brand is ≥$1M/year.
 *
 * @param {{
 *   openaiKey: string,
 *   companyName?: string,
 *   domain?: string,
 *   leadEmail?: string
 * }} args
 * @returns {Promise<object | null>} normalized sizeEstimate or null
 */
export async function runOpenAiStoreSizeResearch({
    openaiKey,
    companyName = '',
    domain = '',
    leadEmail = ''
}) {
    const key = asText(openaiKey);
    const subject = asText(companyName) || asText(domain);
    if (!key || !subject) return null;

    const client = new OpenAI({
        apiKey: key,
        timeout: SIZE_RESEARCH_TIMEOUT_MS
    });

    const system = [
        'You are a B2B ecommerce research analyst.',
        'Estimate whether this brand likely does $1M+ in annual revenue (7 figures).',
        'Use the web_search tool freely: search, open pages, and dig until you have enough signal or the public web is thin.',
        'Prefer primary sources: company site, about/press, LinkedIn company size, job posts,',
        'review platforms (Trustpilot/Google), funding announcements, app-store ranks, traffic/rank proxies, Shopify apps, etc.',
        'Never invent exact GMV. If evidence is thin or conflicting, set confidence to low or medium and isSevenFigureLikely to false unless clearly over $1M.',
        'isSevenFigureLikely=true requires confidence=high and evidence that annual revenue is at least $1,000,000.',
        'Respond with JSON matching the schema only.'
    ].join(' ');

    const user = [
        `Company: ${asText(companyName) || '(unknown)'}`,
        `Domain: ${asText(domain) || '(unknown)'}`,
        leadEmail ? `Lead email: ${asText(leadEmail)}` : '',
        '',
        'Task: research this brand on the public web and estimate annual revenue band.',
        `Decision threshold: $${SEVEN_FIGURE_REVENUE_FLOOR.toLocaleString('en-US')} USD / year.`
    ].filter(Boolean).join('\n');

    let response;
    try {
        response = await client.responses.create({
            model: SIZE_RESEARCH_MODEL,
            reasoning: { effort: SIZE_RESEARCH_REASONING_EFFORT },
            tools: [
                {
                    type: 'web_search',
                    search_context_size: 'high'
                }
            ],
            include: ['web_search_call.action.sources'],
            text: {
                format: {
                    type: 'json_schema',
                    name: 'store_size_estimate',
                    strict: true,
                    schema: SIZE_JSON_SCHEMA
                }
            },
            input: [
                { role: 'developer', content: system },
                { role: 'user', content: user }
            ]
        });
    } catch (err) {
        // Fallback without strict schema (older API shapes / model quirks).
        console.warn(
            `[size-agent] primary responses.create failed domain=${domain}: ${err?.message || err}`
        );
        response = await client.responses.create({
            model: SIZE_RESEARCH_MODEL,
            reasoning: { effort: SIZE_RESEARCH_REASONING_EFFORT },
            tools: [{ type: 'web_search', search_context_size: 'high' }],
            input: [
                {
                    role: 'developer',
                    content: `${system}\n\nReturn JSON with keys: isSevenFigureLikely, estimatedAnnualRevenueMin, estimatedAnnualRevenueMax, confidence, rationale, signals, sources.`
                },
                { role: 'user', content: user }
            ]
        });
    }

    const parsed = parseSizeJson(extractOutputText(response));
    if (!parsed) {
        console.warn(`[size-agent] empty/unparseable output domain=${domain}`);
        return null;
    }

    const toolSources = collectWebSearchSources(response);
    if ((!Array.isArray(parsed.sources) || !parsed.sources.length) && toolSources.length) {
        parsed.sources = toolSources;
    }
    parsed.source = 'openai_web_search';

    return normalizeSizeEstimate(parsed);
}

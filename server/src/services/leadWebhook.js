import axios from 'axios';
import { OpenAI } from 'openai';

const SERPER_URL = 'https://google.serper.dev/search';
const OPENAI_DEFAULT_MODEL = process.env.OPENAI_FOUNDER_MODEL || 'gpt-4o-mini';
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 500;
const OPENAI_TOP_RESULTS = 8;
const CONFIDENCE_THRESHOLD = 0.6;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function jitter(ms) {
    return ms + Math.floor(Math.random() * 200);
}

function deriveDomain(email) {
    if (typeof email !== 'string') return '';
    const match = email.trim().match(/@([^>]+)$/);
    return match ? match[1].toLowerCase() : '';
}

function buildQuery(domain) {
    return `${domain} founder linkedin`;
}

function normalizeResults(raw) {
    const organic = Array.isArray(raw?.organic) ? raw.organic : [];
    return organic.map((item, idx) => ({
        position: idx + 1,
        title: item?.title || '',
        link: item?.link || '',
        snippet: item?.snippet || ''
    }));
}

function scoreResult(result, domain) {
    let score = 0;
    const link = (result.link || '').toLowerCase();
    const text = `${result.title || ''} ${result.snippet || ''}`.toLowerCase();
    if (link.includes('linkedin.com/in/')) score += 0.55;
    if (text.includes('founder') || text.includes('ceo')) score += 0.2;
    if (domain && link.includes(domain)) score += 0.15;
    if (result.position === 1) score += 0.1;
    return Math.min(1, score);
}

async function withRetry(fn, label, logger = () => {}) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const status = err?.response?.status;
            const msg = err?.response?.data?.message || err?.message || String(err);
            if (attempt === MAX_RETRIES || (status && status < 500 && status !== 429)) {
                logger(`${label} failed after ${attempt} attempt(s): ${status || ''} ${msg}`);
                throw err;
            }
            const delay = jitter(BASE_DELAY_MS * Math.pow(2, attempt - 1));
            logger(`${label} retrying in ${delay}ms: ${status || ''} ${msg}`);
            await sleep(delay);
        }
    }
}

async function searchSerper(query, serperKey, logger) {
    const config = {
        method: 'post',
        url: SERPER_URL,
        headers: {
            'X-API-KEY': serperKey,
            'Content-Type': 'application/json'
        },
        data: { q: query, num: 10, gl: 'us' }
    };

    const res = await withRetry(() => axios.request(config), 'Serper search', logger);
    return normalizeResults(res.data);
}

async function pickWithOpenAI(results, openaiKey, model, logger) {
    if (!openaiKey) return null;
    const openai = new OpenAI({ apiKey: openaiKey });
    const top = results.slice(0, OPENAI_TOP_RESULTS).map((r) => ({
        position: r.position,
        title: r.title,
        link: r.link,
        snippet: r.snippet
    }));

    const prompt = `You will be given search results about a company and should pick the most likely LinkedIn profile URL for the founder or CEO.\nReturn ONLY valid JSON in this shape:\n{"url": "https://linkedin.com/in/...", "confidence": 0-1, "reason": "short reason"}\nIf no LinkedIn profile exists, return {"url": null, "confidence": 0, "reason": "why"}.\nResults:\n${JSON.stringify(top, null, 2)}`;

    const completion = await withRetry(
        () => openai.chat.completions.create({
            model: model || OPENAI_DEFAULT_MODEL,
            messages: [
                { role: 'system', content: 'Select the best LinkedIn profile for the founder/CEO.' },
                { role: 'user', content: prompt }
            ],
            temperature: 0.1,
            response_format: { type: 'json_object' }
        }),
        'OpenAI scoring',
        logger
    );

    const content = completion?.choices?.[0]?.message?.content || '';
    try {
        const parsed = JSON.parse(content);
        const url = typeof parsed.url === 'string' ? parsed.url : null;
        const validUrl = url && url.includes('linkedin.com/in') ? url : null;
        return {
            url: validUrl,
            confidence: Number(parsed.confidence) || 0,
            reason: parsed.reason || 'OpenAI-selected'
        };
    } catch (err) {
        logger(`OpenAI response parse failed: ${err?.message || err}`);
        return null;
    }
}

export async function searchLead({ name, email, serperKey, openaiKey, openaiModel, logger = () => {} }) {
    if (!email || !serperKey) {
        throw new Error('Missing email or Serper API key.');
    }

    const domain = deriveDomain(email);
    if (!domain) {
        throw new Error('Could not derive domain from email.');
    }

    const query = buildQuery(domain);
    logger(`Searching founder for ${domain} (${query})`);

    const results = await searchSerper(query, serperKey, logger);
    if (!results.length) {
        return {
            name,
            email,
            domain,
            query,
            url: null,
            confidence: 0,
            confident: false,
            reason: 'No search results',
            source: 'serper'
        };
    }

    let chosen = null;
    try {
        chosen = await pickWithOpenAI(results, openaiKey, openaiModel, logger);
    } catch (err) {
        logger(`OpenAI scoring error: ${err?.message || err}`);
    }

    if (!chosen || !chosen.url) {
        const scored = results.map((r) => ({
            ...r,
            score: scoreResult(r, domain)
        }));
        scored.sort((a, b) => b.score - a.score);
        const top = scored[0];
        chosen = {
            url: top.link || null,
            confidence: top.score,
            reason: 'Heuristic scoring',
            source: 'heuristic'
        };
    } else {
        chosen.source = 'openai';
    }

    const confident = (chosen.confidence || 0) >= CONFIDENCE_THRESHOLD;
    return {
        name,
        email,
        domain,
        query,
        url: chosen.url || null,
        confidence: chosen.confidence || 0,
        confident,
        reason: chosen.reason || '',
        source: chosen.source || 'heuristic'
    };
}

export async function sendToClay({ webhookUrl, linkedinUrl, name, email, domain, callbackUrl, logger = () => {} }) {
    if (!webhookUrl) {
        return { sent: false, reason: 'Missing Clay webhook URL' };
    }
    if (!linkedinUrl) {
        return { sent: false, reason: 'Missing linkedinUrl' };
    }

    const payload = {
        linkedin_url: linkedinUrl,
        name,
        email,
        domain: domain || null,
        callback_url: callbackUrl || null
    };

    const res = await withRetry(
        () => axios.post(webhookUrl, payload, { timeout: 10_000 }),
        'Clay webhook',
        logger
    );

    return {
        sent: true,
        status: res.status,
        data: res.data
    };
}

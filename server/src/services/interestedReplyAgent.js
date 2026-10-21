/**
 * Free-agent mode for interested replies (interested_autoresponder_prompts.agent_mode).
 *
 * Instead of one completion over a fixed context, the reply model runs a
 * Responses API tool loop and decides for itself what (if anything) to look up:
 * web search, page fetch, the full thread, the lead's enrichment profile, a live
 * store preview. It finishes by calling submit_draft. Code only enforces the
 * turn/time budget and link provenance — a human reviews every draft anyway.
 *
 * DB and popup access are injected by the caller (interestedAutoResponder.js)
 * so this module has no import cycle with it.
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import OpenAI from 'openai';
import { compactSerperResults, extractHomepageSummary } from './interestedResearch/briefUtils.js';

function envInt(name, fallback, min) {
    const value = Number.parseInt(String(process.env[name] || ''), 10);
    return Number.isFinite(value) ? Math.max(value, min) : fallback;
}

export const REPLY_AGENT_MODEL = String(
    process.env.INTERESTED_REPLY_AGENT_MODEL || process.env.INTERESTED_AUTORESPONDER_MODEL || 'gpt-5.5'
).trim() || 'gpt-5.5';
const REPLY_AGENT_REASONING_EFFORT = String(process.env.INTERESTED_REPLY_AGENT_REASONING_EFFORT || 'medium').trim();
const REPLY_AGENT_MAX_TURNS = envInt('INTERESTED_REPLY_AGENT_MAX_TURNS', 10, 2);
// Stays well under the workflow step's function duration (platform default,
// 300 s) with room for the forced final call; once spent, the next model call
// is forced to submit_draft.
const REPLY_AGENT_BUDGET_MS = envInt('INTERESTED_REPLY_AGENT_BUDGET_MS', 150_000, 10_000);

const PAGE_FETCH_TIMEOUT_MS = 15_000;
const PAGE_TEXT_LIMIT = 10_000;
const PAGE_MAX_BYTES = 2_000_000;
const PAGE_MAX_REDIRECTS = 3;
const SERPER_URL = 'https://google.serper.dev/search';
const SERPER_TIMEOUT_MS = 20_000;
const TOOL_OUTPUT_LIMIT = 12_000;
const PROFILE_VALUE_LIMIT = 500;

export const SUBMIT_DRAFT_TOOL_NAME = 'submit_draft';

export const REPLY_AGENT_GUIDANCE = [
    'HOW YOU WORK ON THIS REPLY',
    'You are drafting this reply as an agent with tools. A human reviews every draft before it is sent.',
    '- The campaign prompt above is your brief: voice, format, CTA and rules all come from it.',
    '- Use tools when they would make the reply better or more accurate: checking something about their',
    '  business, reading the full thread, opening a page they mentioned. Skip them when you already have',
    '  what you need. There is no required order and no minimum.',
    '- Only state facts you were given or found with a tool. Only include links that appear in the',
    '  campaign prompt or came back from a tool.',
    `- When you are done, call ${SUBMIT_DRAFT_TOOL_NAME} with the reply exactly as it should be sent, plus`,
    '  short notes for the reviewer (what you checked, anything you are unsure about).'
].join('\n');

function functionTool(name, description, properties = {}) {
    return {
        type: 'function',
        name,
        description,
        parameters: {
            type: 'object',
            properties,
            required: Object.keys(properties),
            additionalProperties: false
        },
        strict: true
    };
}

/** Tool definitions for one run — only the tools this client/lead can actually use. */
export function buildReplyAgentTools({
    webSearch = false,
    thread = false,
    leadProfile = false,
    storePreview = false
} = {}) {
    const tools = [];
    if (webSearch) {
        tools.push(functionTool(
            'web_search',
            'Google search (via Serper). Returns titles, links, snippets and dates. Use it for anything about the prospect, their store, their market or a claim you want to check.',
            { query: { type: 'string', description: 'The search query.' } }
        ));
    }
    tools.push(functionTool(
        'fetch_page',
        'Fetch a public web page and return its title, meta description and visible text (truncated). Good for the prospect\'s own site (about, pricing, product, reviews pages) or any search result worth reading in full.',
        { url: { type: 'string', description: 'Absolute http(s) URL.' } }
    ));
    if (thread) {
        tools.push(functionTool(
            'get_thread',
            'The full email thread with this lead so far, oldest first: our outbound emails and their replies.'
        ));
    }
    if (leadProfile) {
        tools.push(functionTool(
            'get_lead_profile',
            'What we already know about the lead from enrichment: name, role, company domain, sending account and any stored attributes.'
        ));
    }
    if (storePreview) {
        tools.push(functionTool(
            'generate_store_preview',
            'Generate a live, on-brand list-growth popup preview for this prospect\'s store and return its URL. Takes up to a couple of minutes. Useful when showing them something concrete would move the conversation forward; the campaign prompt describes when it fits. Never invent a preview URL — only use one this tool returns.',
            { reason: { type: 'string', description: 'Why this reply benefits from the preview.' } }
        ));
    }
    tools.push(functionTool(
        SUBMIT_DRAFT_TOOL_NAME,
        'Submit the finished reply. This ends your work on this draft.',
        {
            reply: { type: 'string', description: 'The reply exactly as it should be sent, in the format the campaign prompt asks for.' },
            notes_for_reviewer: { type: 'string', description: 'One to three short sentences for the human reviewer: what you checked and anything uncertain.' }
        }
    ));
    return tools;
}

const URL_PATTERN = /https?:\/\/[^\s"'<>()[\]{}]+/gi;

/** Every http(s) URL in a blob of text/HTML, trailing punctuation trimmed. */
export function extractLinks(text) {
    const matches = String(text || '').match(URL_PATTERN) || [];
    return matches.map((link) => link.replace(/[.,;:!?]+$/, ''));
}

/** Host (no www) + path (no trailing slash); query and hash are ignored. */
export function linkKey(raw) {
    try {
        const url = new URL(String(raw).replace(/&amp;/g, '&'));
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
        const host = url.hostname.toLowerCase().replace(/^www\./, '');
        const path = url.pathname.replace(/\/+$/, '');
        return `${host}${path}`;
    } catch {
        return null;
    }
}

export function addAllowedLinks(allowed, text) {
    for (const link of extractLinks(text)) {
        const key = linkKey(link);
        if (key) allowed.add(key);
    }
}

/** Links in the reply that never appeared in the prompt, the input or a tool result. */
export function findUnapprovedLinks(reply, allowed) {
    const seen = new Set();
    const unapproved = [];
    for (const link of extractLinks(reply)) {
        const key = linkKey(link);
        if (!key || allowed.has(key) || seen.has(key)) continue;
        seen.add(key);
        unapproved.push(link);
    }
    return unapproved;
}

export function isPrivateAddress(address) {
    if (net.isIPv4(address)) {
        const [a, b] = address.split('.').map(Number);
        return a === 0 || a === 10 || a === 127 || a >= 224
            || (a === 100 && b >= 64 && b <= 127)
            || (a === 169 && b === 254)
            || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 168);
    }
    if (net.isIPv6(address)) {
        const value = address.toLowerCase();
        if (value === '::' || value === '::1') return true;
        if (value.startsWith('::ffff:')) return isPrivateAddress(value.slice(7));
        return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(value);
    }
    return true;
}

/** Reject anything that isn't a public http(s) host — the model picks these URLs. */
export async function assertPublicUrl(raw, { lookup = dns.lookup } = {}) {
    let url;
    try {
        url = new URL(String(raw || '').trim());
    } catch {
        throw new Error('invalid_url');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported_protocol');
    if (url.username || url.password) throw new Error('credentials_in_url');
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!host || host === 'localhost' || /\.(localhost|local|internal)$/.test(host)) {
        throw new Error('blocked_host');
    }
    const addresses = net.isIP(host)
        ? [host]
        : (await lookup(host, { all: true })).map((entry) => entry.address);
    if (!addresses.length || addresses.some(isPrivateAddress)) throw new Error('blocked_address');
    return url;
}

async function readCapped(response, maxBytes) {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (total < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
        total += value.byteLength;
    }
    if (total >= maxBytes) await reader.cancel().catch(() => {});
    return Buffer.concat(chunks).toString('utf8');
}

export async function fetchPublicPage(rawUrl) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PAGE_FETCH_TIMEOUT_MS);
    try {
        let current = rawUrl;
        for (let hop = 0; hop <= PAGE_MAX_REDIRECTS; hop += 1) {
            const url = await assertPublicUrl(current);
            const response = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; ShieldsOutbound/1.0; +https://essence-ai.app)',
                    Accept: 'text/html,application/xhtml+xml,text/plain'
                },
                redirect: 'manual',
                signal: controller.signal
            });
            const location = response.headers.get('location');
            if (response.status >= 300 && response.status < 400 && location) {
                current = new URL(location, url).toString();
                continue;
            }
            if (!response.ok) return { url: url.toString(), error: `HTTP ${response.status}` };
            const contentType = String(response.headers.get('content-type') || '');
            if (contentType && !/html|text\/plain/i.test(contentType)) {
                return { url: url.toString(), error: `Unsupported content type: ${contentType}` };
            }
            const body = await readCapped(response, PAGE_MAX_BYTES);
            if (/text\/plain/i.test(contentType)) {
                return { url: url.toString(), title: '', description: '', text: body.slice(0, PAGE_TEXT_LIMIT) };
            }
            return { url: url.toString(), ...extractHomepageSummary(body, { textLimit: PAGE_TEXT_LIMIT }) };
        }
        return { url: String(rawUrl), error: 'Too many redirects' };
    } catch (error) {
        const reason = error?.name === 'AbortError' ? 'timeout' : error?.message || 'fetch_failed';
        return { url: String(rawUrl), error: reason };
    } finally {
        clearTimeout(timeoutId);
    }
}

export async function serperSearch(query, serperKey) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SERPER_TIMEOUT_MS);
    try {
        const response = await fetch(SERPER_URL, {
            method: 'POST',
            headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ q: query, num: 10 }),
            signal: controller.signal
        });
        if (!response.ok) return { error: `Search failed (HTTP ${response.status})` };
        const payload = await response.json();
        return { query, results: compactSerperResults([payload], { limitPerQuery: 10 }) };
    } catch (error) {
        return { error: error?.name === 'AbortError' ? 'Search timed out' : (error?.message || 'Search failed') };
    } finally {
        clearTimeout(timeoutId);
    }
}

/** Scalar, non-empty template vars, each capped — the get_lead_profile payload. */
export function buildAgentLeadProfile(templateVars = {}) {
    const profile = {};
    for (const [key, value] of Object.entries(templateVars || {})) {
        if (value === null || value === undefined || typeof value === 'object') continue;
        const text = String(value).trim();
        if (!text) continue;
        profile[key] = text.length > PROFILE_VALUE_LIMIT ? `${text.slice(0, PROFILE_VALUE_LIMIT)}…` : text;
    }
    return profile;
}

function parseArguments(raw) {
    try {
        const parsed = JSON.parse(raw || '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function summarizeToolInput(name, args) {
    if (name === 'web_search') return String(args.query || '').slice(0, 200);
    if (name === 'fetch_page') return String(args.url || '').slice(0, 300);
    if (name === 'generate_store_preview') return String(args.reason || '').slice(0, 200);
    return null;
}

function truncateOutput(text) {
    return text.length > TOOL_OUTPUT_LIMIT ? `${text.slice(0, TOOL_OUTPUT_LIMIT)}…[truncated]` : text;
}

/**
 * Run the reply agent. Returns the submitted reply, the reviewer notes, any
 * store preview URL it generated, and a compact trace for the review page.
 *
 * @param {{
 *   openaiKey?: string,
 *   client?: object,
 *   instructions: string,
 *   input: string,
 *   serperKey?: string | null,
 *   loadThread?: (() => Promise<Array<object>>) | null,
 *   leadProfile?: object | null,
 *   generateStorePreview?: ((reason: string | null) => Promise<string | null>) | null,
 *   allowedUrls?: string[],
 *   model?: string,
 *   maxTurns?: number,
 *   budgetMs?: number
 * }} args
 */
export async function runReplyAgent({
    openaiKey,
    client = null,
    instructions,
    input,
    serperKey = null,
    loadThread = null,
    leadProfile = null,
    generateStorePreview = null,
    allowedUrls = [],
    model = REPLY_AGENT_MODEL,
    maxTurns = REPLY_AGENT_MAX_TURNS,
    budgetMs = REPLY_AGENT_BUDGET_MS
}) {
    const openai = client || new OpenAI({ apiKey: openaiKey });
    const startedAt = Date.now();
    const tools = buildReplyAgentTools({
        webSearch: Boolean(serperKey),
        thread: Boolean(loadThread),
        leadProfile: Boolean(leadProfile),
        storePreview: Boolean(generateStorePreview)
    });

    const allowed = new Set();
    addAllowedLinks(allowed, instructions);
    addAllowedLinks(allowed, input);
    for (const url of allowedUrls) addAllowedLinks(allowed, url);

    let previewUrl = null;
    let previewPromise = null;
    const handlers = {
        web_search: serperKey ? (args) => serperSearch(String(args.query || '').trim(), serperKey) : null,
        fetch_page: (args) => fetchPublicPage(args.url),
        get_thread: loadThread
            ? async () => ({
                messages: (await loadThread()).map((message) => ({
                    direction: message.direction,
                    from: message.from,
                    sentAt: message.sentAt,
                    subject: message.subject,
                    text: message.text
                }))
            })
            : null,
        get_lead_profile: leadProfile ? async () => leadProfile : null,
        generate_store_preview: generateStorePreview
            ? async (args) => {
                // Parallel or repeated calls share one generation.
                previewPromise ||= generateStorePreview(String(args.reason || '').trim() || null);
                const url = await previewPromise;
                if (!url) return { error: 'Preview generation failed. Do not invent a preview URL.' };
                previewUrl = url;
                return { previewUrl: url };
            }
            : null
    };

    const steps = [];
    const usage = { inputTokens: 0, outputTokens: 0 };
    const runTool = async (call) => {
        const toolStartedAt = Date.now();
        const args = parseArguments(call.arguments);
        const handler = handlers[call.name];
        let result;
        try {
            result = handler ? await handler(args) : { error: `Unknown tool: ${call.name}` };
        } catch (error) {
            result = { error: error?.message || 'Tool failed' };
        }
        const output = truncateOutput(JSON.stringify(result ?? null));
        addAllowedLinks(allowed, output);
        steps.push({
            tool: call.name,
            input: summarizeToolInput(call.name, args),
            ok: !result?.error,
            ...(result?.error ? { error: String(result.error).slice(0, 200) } : {}),
            ms: Date.now() - toolStartedAt
        });
        return { type: 'function_call_output', call_id: call.call_id, output };
    };

    const request = (body, forceSubmit) => openai.responses.create({
        model,
        instructions,
        tools,
        parallel_tool_calls: true,
        ...(REPLY_AGENT_REASONING_EFFORT ? { reasoning: { effort: REPLY_AGENT_REASONING_EFFORT } } : {}),
        tool_choice: forceSubmit ? { type: 'function', name: SUBMIT_DRAFT_TOOL_NAME } : 'auto',
        ...body
    });

    let forced = maxTurns <= 1;
    let response = await request({ input: [{ role: 'user', content: input }] }, forced);
    let draft = null;
    let turns = 0;

    for (let turn = 1; turn <= maxTurns; turn += 1) {
        turns = turn;
        usage.inputTokens += Number(response.usage?.input_tokens) || 0;
        usage.outputTokens += Number(response.usage?.output_tokens) || 0;

        const calls = (response.output || []).filter((item) => item?.type === 'function_call');
        if (!calls.length) {
            // Answered in plain text instead of submitting — take it as the draft.
            const text = String(response.output_text || '').trim();
            if (text) draft = { reply: text, notes: null, submitted: false };
            break;
        }

        const submitCall = calls.find((call) => call.name === SUBMIT_DRAFT_TOOL_NAME);
        const outputs = await Promise.all(
            calls.filter((call) => call !== submitCall).map(runTool)
        );

        if (submitCall) {
            const args = parseArguments(submitCall.arguments);
            const reply = String(args.reply || '').trim();
            const unapproved = reply ? findUnapprovedLinks(reply, allowed) : [];
            if (reply && (!unapproved.length || forced)) {
                steps.push({ tool: SUBMIT_DRAFT_TOOL_NAME, input: null, ok: true, ms: 0 });
                draft = {
                    reply,
                    notes: String(args.notes_for_reviewer || '').trim() || null,
                    submitted: true,
                    unapprovedLinks: unapproved
                };
                break;
            }
            steps.push({
                tool: SUBMIT_DRAFT_TOOL_NAME,
                input: null,
                ok: false,
                error: reply ? `Unverified links: ${unapproved.join(', ')}`.slice(0, 200) : 'Empty reply',
                ms: 0
            });
            outputs.push({
                type: 'function_call_output',
                call_id: submitCall.call_id,
                output: JSON.stringify({
                    error: reply
                        ? `These links did not come from the campaign prompt or a tool result: ${unapproved.join(', ')}. Remove them or replace them with a link you got from a tool, then call ${SUBMIT_DRAFT_TOOL_NAME} again.`
                        : 'The reply was empty.'
                })
            });
        }

        if (turn === maxTurns) break;
        forced = turn + 1 >= maxTurns || Date.now() - startedAt >= budgetMs;
        response = await request({ previous_response_id: response.id, input: outputs }, forced);
    }

    if (!draft) {
        throw new Error(`reply_agent_no_draft after ${turns} turn(s)`);
    }

    const elapsedMs = Date.now() - startedAt;
    console.log(
        `[reply-agent] submitted=${draft.submitted} turns=${turns} tools=${steps.length} ms=${elapsedMs}`
        + ` tokens_in=${usage.inputTokens} tokens_out=${usage.outputTokens}`
    );
    return {
        model: response.model || model,
        reply: draft.reply,
        notes: draft.notes,
        previewUrl,
        trace: {
            mode: 'agent',
            notes: draft.notes,
            submitted: draft.submitted,
            unapprovedLinks: draft.unapprovedLinks || [],
            steps,
            turns,
            elapsedMs,
            usage
        }
    };
}

/** Review-page shape of a stored agent_trace (null for non-agent drafts). */
export function serializeAgentTraceForReview(raw) {
    const trace = raw && typeof raw === 'object' ? raw : null;
    if (!trace || trace.mode !== 'agent') return null;
    return {
        notes: trace.notes || null,
        steps: (Array.isArray(trace.steps) ? trace.steps : [])
            .filter((step) => step?.tool && step.tool !== SUBMIT_DRAFT_TOOL_NAME)
            .map((step) => ({
                tool: String(step.tool),
                input: step.input ? String(step.input) : null,
                ok: step.ok !== false,
                error: step.error ? String(step.error) : null
            })),
        unapprovedLinks: Array.isArray(trace.unapprovedLinks) ? trace.unapprovedLinks.map(String) : [],
        turns: Number(trace.turns) || 0,
        elapsedMs: Number(trace.elapsedMs) || 0
    };
}

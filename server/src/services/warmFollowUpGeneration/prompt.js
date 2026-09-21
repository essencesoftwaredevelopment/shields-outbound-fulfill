/**
 * Prompt assembly for AI warm follow-ups. Pure helpers — no DB / network.
 *
 * The code contract always wraps the client's editable prompt so a prompt
 * edit cannot blow length or invent company facts.
 */

export const FOLLOW_UP_CODE_CONTRACT = [
    'You are writing a same-thread warm follow-up email.',
    'Hard rules — follow these:',
    '- At most one CTA.',
    '- Use only facts from the research brief. Never invent company facts.',
    '- If there is no research brief, do not invent company-specific details; stay generic to the thread.',
    '- Do not repeat any earlier outbound in this thread.',
    '- Do not use markdown. Write a normal sentence, then the raw https URL.',
    '- Do not include a sign-off, sender name, or signature. The sending account signature is appended after you write.'
].join('\n');

export const FOLLOW_UP_MAX_CHARS = 700;
export const OUTBOUND_HISTORY_ITEM_MAX_CHARS = 900;

function clipOutboundHistoryText(text, maxChars = OUTBOUND_HISTORY_ITEM_MAX_CHARS) {
    const trimmed = asTrimmedText(text);
    if (trimmed.length <= maxChars) return trimmed;
    return `${trimmed.slice(0, maxChars).trim()}…`;
}

export function formatOutboundThreadHistory(messages = []) {
    const items = (Array.isArray(messages) ? messages : [])
        .map((item, index) => ({
            label: asTrimmedText(item?.label) || `Outbound ${index + 1}`,
            text: clipOutboundHistoryText(item?.text)
        }))
        .filter((item) => item.text);
    if (!items.length) return '';
    return [
        'Our earlier messages in this thread (do not repeat any of them):',
        ...items.map((item, index) => `${index + 1}. ${item.label}:\n${item.text}`)
    ].join('\n\n');
}

export function asTrimmedText(value) {
    if (value === null || value === undefined) return '';
    return String(value).trim();
}

export function shouldUseAiFollowUpCopy({ enabled, systemPrompt, stepInstruction } = {}) {
    if (enabled !== true) return false;
    return Boolean(asTrimmedText(systemPrompt) || asTrimmedText(stepInstruction));
}

export function isFollowUpCopyTooLong(text, maxChars = FOLLOW_UP_MAX_CHARS) {
    return asTrimmedText(text).length > maxChars;
}

export function escapeHtml(text = '') {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function unwrapSplitFollowUpUrls(text) {
    let out = String(text || '');
    let prev = '';
    while (out !== prev) {
        prev = out;
        out = out.replace(
            /(https?:\/\/[^\s<>"']*[?&=%/])\n+(?=[A-Za-z0-9._%~+=&-])/g,
            '$1'
        );
    }
    return out;
}

function splitUrlAndTrailingPunctuation(raw) {
    const match = String(raw || '').match(/^(.*?)([.,);!?'"]*)$/);
    return {
        url: match?.[1] || String(raw || ''),
        trailing: match?.[2] || ''
    };
}

function followUpLinkLabel(url) {
    try {
        const parsed = new URL(url);
        const path = `${parsed.origin}${parsed.pathname}`.replace(/\/$/, '');
        return parsed.search || parsed.hash ? path : url;
    } catch {
        return url;
    }
}

function followUpAnchor(url, label) {
    return `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
}

function linkifyPlainFollowUpText(text) {
    const source = unwrapSplitFollowUpUrls(text);
    const parts = [];
    let lastIndex = 0;
    const tokenRe = /\[([^\]]+)\]\s*\(\s*(https?:\/\/[^\s)]+)\s*\)|https?:\/\/[^\s<>"']+/gi;
    for (const match of source.matchAll(tokenRe)) {
        const markdownLabel = match[1];
        const markdownUrl = match[2];
        const before = source.slice(lastIndex, match.index);

        if (markdownLabel && markdownUrl) {
            if (before) parts.push(escapeHtml(before).replace(/\n/g, '<br>'));
            parts.push(followUpAnchor(markdownUrl, markdownLabel.trim() || followUpLinkLabel(markdownUrl)));
            lastIndex = match.index + match[0].length;
            continue;
        }

        const { url, trailing } = splitUrlAndTrailingPunctuation(match[0]);
        if (!url) continue;
        const urlEnd = match.index + url.length;
        const rest = source.slice(urlEnd);
        const urlAtEnd = !rest.trim() || /^[.,);!?'"]+\s*$/.test(rest);

        if (before) {
            const escapedBefore = escapeHtml(before).replace(/\n/g, '<br>');
            parts.push(urlAtEnd ? escapedBefore.replace(/[ \t]+$/, '') : escapedBefore);
        }
        if (urlAtEnd && before.replace(/\s+$/, '')) {
            parts.push('<br>');
        }
        parts.push(followUpAnchor(url, followUpLinkLabel(url)));
        if (trailing) parts.push(escapeHtml(trailing));
        lastIndex = match.index + match[0].length;
    }
    if (lastIndex < source.length) {
        parts.push(escapeHtml(source.slice(lastIndex)).replace(/\n/g, '<br>'));
    }
    return parts.join('') || escapeHtml(source).replace(/\n/g, '<br>');
}

/** Wrap plain-text follow-up copy as Instantly-ready HTML: paragraphs, breaks, and real links. */
export function plainTextToFollowUpHtml(text = '') {
    const trimmed = unwrapSplitFollowUpUrls(asTrimmedText(text));
    if (!trimmed) return '';
    return trimmed
        .split(/\n{2,}/)
        .map((paragraph) => `<p>${linkifyPlainFollowUpText(paragraph)}</p>`)
        .join('');
}

/** Put a terminal CTA URL on its own line in the plain-text MIME part. */
export function formatFollowUpPlainText(text = '') {
    const trimmed = unwrapSplitFollowUpUrls(asTrimmedText(text));
    if (!trimmed) return '';
    return trimmed
        .replace(/\[([^\]]+)\]\s*\(\s*(https?:\/\/[^\s)]+)\s*\)/g, '$1: $2')
        .replace(/([^\n])[ \t]+(https?:\/\/[^\s<>"']+)([ \t]*)$/gim, '$1\n$2$3');
}

function formatList(items, prefix) {
    const lines = (Array.isArray(items) ? items : [])
        .map((item) => asTrimmedText(item))
        .filter(Boolean);
    if (!lines.length) return '';
    return [prefix, ...lines.map((line) => `- ${line}`)].join('\n');
}

export function formatBriefForFollowUpPrompt(brief) {
    if (!brief || typeof brief !== 'object') return '';
    const summary = asTrimmedText(brief.summary);
    const size = brief.sizeEstimate && typeof brief.sizeEstimate === 'object'
        ? brief.sizeEstimate
        : null;
    if (!summary && !size) return '';
    const lines = [];
    const company = asTrimmedText(brief.company);
    const domain = asTrimmedText(brief.domain);
    if (company || domain) {
        lines.push(`Company: ${[company, domain && `(${domain})`].filter(Boolean).join(' ')}`);
    }
    if (summary) lines.push(`Summary: ${summary}`);
    const talking = formatList(brief.talkingPoints, 'Talking points:');
    if (talking) lines.push(talking);
    const risks = formatList(brief.risks, 'Avoid / be careful with:');
    if (risks) lines.push(risks);
    if (size) {
        const confidence = asTrimmedText(size.confidence) || 'unknown';
        const likely = size.isSevenFigureLikely === true ? 'yes' : 'no';
        lines.push(`Store-size estimate (≥$1M/year likely): ${likely} (confidence: ${confidence})`);
    }
    return lines.join('\n');
}

export function assembleFollowUpMessages({
    systemPrompt = '',
    stepInstruction = '',
    researchBrief = null,
    threadSubject = '',
    leadEmail = '',
    firstName = '',
    previousLeadMessage = '',
    previousOutbound = '',
    previousOutbounds = null,
    retryShorter = false,
    forcedCtaUrl = '',
    forcedCtaMode = null
} = {}) {
    const clientPrompt = asTrimmedText(systemPrompt);
    const step = asTrimmedText(stepInstruction);
    const briefBlock = formatBriefForFollowUpPrompt(researchBrief);
    const formattedFromList = Array.isArray(previousOutbounds)
        ? formatOutboundThreadHistory(previousOutbounds)
        : '';
    const existingOutbound = asTrimmedText(previousOutbound);
    const outboundHistory = formattedFromList
        || (existingOutbound.startsWith('Our earlier messages in this thread')
            ? existingOutbound
            : (existingOutbound
                ? formatOutboundThreadHistory([{ label: 'Previous outbound', text: previousOutbound }])
                : ''));
    const ctaUrl = asTrimmedText(forcedCtaUrl);
    const ctaMode = asTrimmedText(forcedCtaMode).toLowerCase();
    const ctaRules = ctaUrl
        ? [
            ctaMode === 'offer'
                ? 'CTA path: free build offer (VSL). Soft eligibility only — do not promise approval or invent revenue.'
                : 'CTA path: Calendly booking. Do not mention the free build offer.',
            `Use exactly this URL as the sole CTA (raw https, no markdown): ${ctaUrl}`
        ].join('\n')
        : '';
    const system = [
        FOLLOW_UP_CODE_CONTRACT,
        ctaRules ? `\nForced CTA:\n${ctaRules}` : '',
        clientPrompt ? `\nClient prompt (voice, CTA, brand):\n${clientPrompt}` : ''
    ].filter(Boolean).join('\n');

    const user = [
        retryShorter
            ? 'The previous draft was too long. Rewrite it shorter: 2–3 sentences, one CTA.'
            : '',
        `Lead email: ${asTrimmedText(leadEmail) || 'unknown'}`,
        `First name: ${asTrimmedText(firstName) || '(unknown)'}`,
        `Thread subject: ${asTrimmedText(threadSubject) || '(reuse existing thread subject)'}`,
        step ? `This step's instruction:\n${step}` : 'This step has no extra instruction — write a short bump.',
        briefBlock
            ? [
                'Research brief (verified). Use at most one fact; never invent beyond this:',
                briefBlock
            ].join('\n')
            : 'No research brief is available. Do not invent company facts.',
        previousLeadMessage
            ? `Lead's earlier message:\n${asTrimmedText(previousLeadMessage)}`
            : '',
        outboundHistory,
        'Write the follow-up now.'
    ].filter(Boolean).join('\n\n');

    return [
        { role: 'system', content: system },
        { role: 'user', content: user }
    ];
}

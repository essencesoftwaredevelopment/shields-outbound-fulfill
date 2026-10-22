/**
 * Founder finder grounding: what the extraction model sees, the JSON it must
 * return, and the checks a name has to pass before we spend email-finder
 * credits on it.
 *
 * Why: the search is "<domain> founder". For small stores Google drops the
 * domain and returns founders of unrelated companies (Nas Daily, Van Leeuwen,
 * Complex…), and the old free-text prompt picked them. In job
 * 1792511798642-7pq8g1, 64% of "found" founders had no search result tying
 * them to the store, and TryKitt found an email for 3.7% of those vs 26.8% for
 * names a store result backed up.
 *
 * Layers, cheapest first:
 *   1. extraction — structured output with cited result ids (FOUNDER_EXTRACT_SCHEMA)
 *   2. grounding  — deterministic: a result about this store must name the person
 *   3. decisions  — OpenAI Decisions API predicate on the grounded candidate
 */

const NAME_PREFIXES = ['try', 'shop', 'get', 'drink', 'wear', 'eat', 'use', 'join', 'hello', 'hey', 'my', 'the', 'go', 'buy'];
const NAME_SUFFIXES = [
    'official', 'store', 'shop', 'online', 'brand', 'brands', 'studio', 'boutique', 'hq', 'co', 'usa', 'us', 'inc', 'llc',
    'outdoors', 'outdoor', 'beauty', 'skincare', 'skin', 'cosmetics', 'apparel', 'clothing', 'wear', 'fashion',
    'jewelry', 'jewellery', 'designs', 'design', 'home', 'living', 'goods', 'supply', 'labs', 'lab', 'nutrition',
    'wellness', 'health', 'coffee', 'tea', 'foods', 'pets', 'kids', 'baby', 'fitness', 'collective', 'collection',
    'company'
];
const MIN_BRAND_LEN = 4;
// Shorter brand spellings ("true" from truecompany) must match a whole word,
// not a substring of the squashed text.
const SUBSTRING_BRAND_LEN = 6;
// Surnames this long tolerate a trailing-letter difference (Motzfeld / Motzfeldt).
const FUZZY_NAME_LEN = 5;

export const NO_LAST_NAME = 'NoLast';

/** Lowercase, strip accents, collapse everything that is not a letter/digit to one space. */
export function normalizeText(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function squash(value) {
    return normalizeText(value).replace(/ /g, '');
}

function hostOf(link) {
    try {
        return new URL(link).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
        return '';
    }
}

/**
 * Brand spellings a result may use for the store: the domain label plus the
 * label without common storefront prefixes/suffixes (tryriora → riora,
 * arelunestudio → arelune). Squashed, so "Sorlie Ice Cream" matches sorlieicecream.
 *
 * @param {string} domain e.g. "tryriora.com"
 * @returns {string[]}
 */
export function brandVariants(domain) {
    const label = String(domain || '').toLowerCase().replace(/^www\./, '').split('.')[0].replace(/[^a-z0-9]/g, '');
    const variants = new Set([label]);
    for (const prefix of NAME_PREFIXES) {
        if (label.startsWith(prefix)) variants.add(label.slice(prefix.length));
    }
    for (const base of [...variants]) {
        for (const suffix of NAME_SUFFIXES) {
            if (base.endsWith(suffix)) variants.add(base.slice(0, -suffix.length));
        }
    }
    return [...variants].filter((v) => v.length >= MIN_BRAND_LEN);
}

/**
 * True when a search result is about this store: hosted on its domain, or its
 * title/snippet/link names the domain or the brand.
 *
 * @param {{ title?: string, link?: string, snippet?: string }} result
 * @param {string} domain
 */
export function isStoreResult(result, domain) {
    const bare = String(domain || '').toLowerCase().replace(/^www\./, '');
    const host = hostOf(result?.link);
    if (host && (host === bare || host.endsWith(`.${bare}`))) return true;
    const raw = `${result?.title || ''} ${result?.snippet || ''} ${result?.link || ''}`;
    const squashed = squash(raw);
    if (squashed.includes(squash(bare))) return true;
    const words = ` ${normalizeText(raw)} `;
    return brandVariants(bare).some((variant) => (
        variant.length >= SUBSTRING_BRAND_LEN ? squashed.includes(variant) : words.includes(` ${variant} `)
    ));
}

function wordMatches(token, word) {
    if (token === word) return true;
    if (Math.min(token.length, word.length) < FUZZY_NAME_LEN) return false;
    return Math.abs(token.length - word.length) <= 1 && (token.startsWith(word) || word.startsWith(token));
}

function containsWords(normalizedText, words) {
    const tokens = normalizedText.split(' ');
    return words.every((w) => tokens.some((t) => wordMatches(t, w)));
}

/**
 * The words that must appear in a store result for the name to count: the last
 * name (every word of it, so "Van Leeuwen" needs both), or the first name when
 * only a first name is known.
 */
function requiredNameWords(firstName, lastName) {
    const last = normalizeText(lastName);
    if (last && last !== normalizeText(NO_LAST_NAME)) {
        return last.split(' ').filter((w) => w.length >= 2);
    }
    return normalizeText(firstName).split(' ').filter((w) => w.length >= 2).slice(0, 1);
}

/**
 * Deterministic grounding check — the model's say-so is not enough. Passes when
 * a result about this store names the person's last name (or first name when
 * that is all we have), or when a store result names the first name and any
 * result carries the full name ("Courtney, Skeyo founder" on the store page +
 * "Courtney Despos - Founder & CEO, Skeyo" on LinkedIn).
 *
 * @param {{ firstName: string, lastName: string }} candidate
 * @param {Array<{ title?: string, link?: string, snippet?: string }>} results
 * @param {string} domain
 * @returns {{ grounded: boolean, evidenceIds: number[] }} evidenceIds are 1-based result ids
 */
export function groundFounderName(candidate, results, domain) {
    const words = requiredNameWords(candidate?.firstName, candidate?.lastName);
    if (!words.length) return { grounded: false, evidenceIds: [] };
    const firstWords = normalizeText(candidate?.firstName).split(' ').filter((w) => w.length >= 2).slice(0, 1);
    const fullWords = [...new Set([...firstWords, ...words])];
    const texts = (results || []).map((r) => normalizeText(`${r.title || ''} ${r.snippet || ''}`));
    const storeIds = (results || []).map((r, i) => (isStoreResult(r, domain) ? i : -1)).filter((i) => i >= 0);

    const evidenceIds = storeIds.filter((i) => containsWords(texts[i], words)).map((i) => i + 1);
    if (evidenceIds.length) return { grounded: true, evidenceIds };

    const firstNameStoreIds = firstWords.length ? storeIds.filter((i) => containsWords(texts[i], firstWords)) : [];
    const fullNameIds = texts.map((t, i) => (containsWords(t, fullWords) ? i : -1)).filter((i) => i >= 0);
    if (firstNameStoreIds.length && fullNameIds.length) {
        return { grounded: true, evidenceIds: [...new Set([...firstNameStoreIds, ...fullNameIds])].map((i) => i + 1) };
    }
    return { grounded: false, evidenceIds: [] };
}

/**
 * Search results as the model sees them: numbered, with host, and flagged when
 * they are about the store, so "which company is this result about" is explicit.
 */
export function formatSearchResults(results, domain) {
    return (results || [])
        .map((r, i) => {
            const host = hostOf(r.link) || 'unknown';
            const tag = isStoreResult(r, domain) ? ' [mentions this store]' : '';
            return `[${i + 1}] ${host}${tag}\nTitle: ${r.title || ''}\nSnippet: ${r.snippet || ''}`;
        })
        .join('\n\n');
}

export const FOUNDER_EXTRACT_INSTRUCTIONS = `You identify the founder or owner of one specific online store from Google search results.

The search was "<store domain> founder". The store is usually a small Shopify brand with little press, so Google often fills the results with founders of OTHER, unrelated companies. Those people are never the answer.

We want the person who runs the business: founder, co-founder, owner, CEO, president or managing director.

Accept a person only when a result explicitly connects them to THIS store:
- a page on the store's own domain (About, Our Story, Contact, policies) naming the founder, owner, CEO or president;
- a profile, article, review site, directory or social post whose title or snippet names the person together with this store's brand or domain (e.g. "Jane Doe - Founder - Riora", "Riora reviews… founded by Jane Doe");
- a company registry (Companies House, OpenCorporates, state filings) listing the person as a director, officer or owner of the company whose name matches the brand.
You may combine results: a first name on the store's own page ("Courtney, Skeyo founder") plus the full name on a profile for the same brand ("Courtney Despos - Founder & CEO, Skeyo").
Results flagged [mentions this store] are about the store; unflagged results are usually about other companies.

Reject:
- founders/CEOs of a different company, even if the name or product category is similar (a different "Nayla" brand is not naseyla.com);
- famous entrepreneurs, celebrities, investors, journalists, reviewers, customers or employees who are not an owner/founder/CEO;
- names guessed from the domain itself without a result saying that person runs the store.

If a result gives only a first name for the founder (e.g. "Hi, I'm Sarah, founder of Riora"), return that first name with last_name "".
When in doubt, return found=false. A wrong name wastes an email lookup and is worse than no name.`;

export const FOUNDER_EXTRACT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        found: { type: 'boolean', description: 'True only if a result ties a person to this store as founder, co-founder, owner, CEO, president or managing director.' },
        first_name: { type: 'string', description: 'Given name, as written. Empty if not found.' },
        last_name: { type: 'string', description: 'Family name, as written. Empty if unknown or not found.' },
        role: { type: 'string', description: 'Role as stated in the evidence, e.g. "Founder", "Co-founder & CEO", "Owner". Empty if not found.' },
        evidence_ids: {
            type: 'array',
            items: { type: 'integer' },
            description: 'Ids of the results that tie this person to this store.'
        }
    },
    required: ['found', 'first_name', 'last_name', 'role', 'evidence_ids']
};

export function buildExtractInput(results, domain) {
    return `Store domain: ${domain}\nBrand spellings: ${brandVariants(domain).join(', ') || domain}\n\nSearch results:\n${formatSearchResults(results, domain)}`;
}

const HONORIFICS = new Set(['dr', 'mr', 'mrs', 'ms', 'miss', 'mx', 'prof', 'sir', 'madam', 'chef']);
// Letters (any script), apostrophes, hyphens and inner dots/spaces only: rejects
// handles (_shafuramalik_), emails, digits and stray punctuation.
const NAME_PART = /^\p{L}[\p{L}\p{M}'’.\- ]*$/u;

/** "ANDRÉS RESTREPO" → "Andrés Restrepo"; mixed case (McDonald, de la Cruz) is left alone. */
function titleCaseIfShouting(value) {
    if (value !== value.toUpperCase() || value === value.toLowerCase()) return value;
    return value.toLowerCase().replace(/(^|[\s'’-])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase());
}

function cleanNamePart(value) {
    return titleCaseIfShouting(String(value || '').trim().replace(/\s+/g, ' '));
}

/** Collapse a parsed extraction into the stored name ("First Last" / "First NoLast"), or null. */
export function founderNameFromExtraction(parsed) {
    if (!parsed?.found) return null;
    const first = cleanNamePart(parsed.first_name).split(' ')[0] || '';
    const last = cleanNamePart(parsed.last_name);
    if (!first || !NAME_PART.test(first) || first.replace(/[^\p{L}]/gu, '').length < 2) return null;
    if (HONORIFICS.has(normalizeText(first))) return null;
    if (last && !NAME_PART.test(last)) return null;
    return { firstName: first, lastName: last || NO_LAST_NAME, role: cleanNamePart(parsed.role) };
}

export const DECISIONS_URL = 'https://api.openai.com/v1/decisions';
export const DECISIONS_MODEL = 'gpt-6-luna';
export const DECISIONS_QUESTION = 'is_store_founder';

/**
 * Decisions API request: one predicate over the grounded candidate.
 *
 * @param {{ firstName: string, lastName: string, role?: string }} candidate
 * @param {Array<{ title?: string, link?: string, snippet?: string }>} results
 * @param {string} domain
 */
export function buildDecisionsRequest(candidate, results, domain) {
    const name = candidate.lastName && candidate.lastName !== NO_LAST_NAME
        ? `${candidate.firstName} ${candidate.lastName}`
        : `${candidate.firstName} (first name only)`;
    return {
        model: DECISIONS_MODEL,
        input: `Store domain: ${domain}\nCandidate: ${name}${candidate.role ? ` — stated role: ${candidate.role}` : ''}\n\nSearch results:\n${formatSearchResults(results, domain)}`,
        questions: [
            {
                type: 'predicate',
                name: DECISIONS_QUESTION,
                instructions: `Based only on the search results, is the candidate a founder, co-founder, owner, CEO, president or managing director of the business that runs the online store at ${domain}? True also for the artist, designer or maker who runs a one-person or eponymous brand (e.g. an "About me" page on the store), and for a director or officer listed in a company registry for the company matching the brand. False if the evidence is about a different company with a similar name, or if the candidate is only an employee, customer, reviewer, endorsing professional, investor or the founder of another brand.`
            }
        ]
    };
}

/**
 * @returns {{ probability: number | null, refused: boolean, inputTokens: number }}
 */
export function parseDecisionsResponse(body) {
    const answers = Array.isArray(body?.answers) ? body.answers : [];
    const answer = answers.find((a) => a?.name === DECISIONS_QUESTION) || answers[0];
    const inputTokens = Number(body?.usage?.input_tokens) || 0;
    if (!answer || answer.type === 'refusal') return { probability: null, refused: !!answer, inputTokens };
    const probability = Number(answer.probability);
    return { probability: Number.isFinite(probability) ? probability : null, refused: false, inputTokens };
}

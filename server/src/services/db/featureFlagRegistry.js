/**
 * Registry of every per-agency feature flag stored in agency_settings.features.
 *
 * Single source of truth for the settings UI (labels, descriptions, types,
 * defaults) and for validating writes. Readers of the flags stay where they
 * are (agencySettings.js helpers, shopping-audit services, etc.) — this file
 * only describes them. Add a new flag here when you add a reader for it.
 *
 * Types:
 *   boolean  — true/false; absent means `default`
 *   enum     — one of `options`; absent means `default`
 *   number   — finite number; absent means `default`
 *   object   — flat object of `fields` (each number|string); absent = defaults
 */
export const FEATURE_FLAG_GROUPS = [
    { id: 'product', label: 'Product features' },
    { id: 'pipeline', label: 'Pipeline & rate limits' },
    { id: 'shoppingAudit', label: 'Shopping audit tuning' }
];

export const FEATURE_FLAGS = [
    {
        key: 'dealFlow',
        group: 'product',
        type: 'boolean',
        default: false,
        label: 'Deal Flow tab',
        description: 'Kanban board of interested leads in the client view (Interested → Follow Up → Meeting Booked → Won / Lost).'
    },
    {
        key: 'shoppingAudit',
        group: 'product',
        type: 'boolean',
        default: false,
        label: 'Shopping audit pipeline',
        description: 'Allows running the Shopping-ad audit enrichment for this agency\'s clients. Spends Serper + OpenAI per domain.',
        envOverride: 'SHOPPING_AUDIT_ENABLED'
    },
    {
        key: 'autoresponderShoppingAudit',
        group: 'product',
        type: 'boolean',
        default: false,
        label: 'Audit preview in interested replies',
        description: 'The interested-reply autoresponder builds the shopping-audit preview instead of the legacy list-growth popup. Independent of the pipeline flag above.'
    },
    {
        key: 'replyResearchAgent',
        group: 'product',
        type: 'boolean',
        default: false,
        label: 'Reply research agent',
        description: 'Runs the durable lead-research workflow (web research → brief → draft) before drafting interested replies. Spends Serper + OpenAI per interested lead.'
    },
    {
        key: 'trykittPaidAccount',
        group: 'pipeline',
        type: 'boolean',
        default: true,
        label: 'TryKitt paid account',
        description: 'Off = the agency\'s TryKitt key is on the free tier: verification is capped at 20 requests/min and 2 concurrent calls, and pauses with TRYKITT_THROTTLED instead of failing.'
    },
    {
        key: 'enrichmentRunner',
        group: 'pipeline',
        type: 'enum',
        options: [
            { value: 'pm2', label: 'PM2 worker (default)' },
            { value: 'vercel', label: 'Vercel Workflows' }
        ],
        default: 'pm2',
        label: 'Enrichment runner',
        description: 'Where enrichment jobs execute. "Vercel Workflows" is the durable runner validated in production; PM2 is the legacy server queue. The ENRICHMENT_RUNNER host env, when set to vercel, wins for every agency.',
        envOverride: 'ENRICHMENT_RUNNER',
        envOverrideValue: 'vercel'
    },
    {
        key: 'rateLimits',
        group: 'pipeline',
        type: 'object',
        label: 'API rate limit overrides',
        description: 'Per-agency caps that override the host defaults (and the free-tier TryKitt caps). Leave a field blank to keep the default.',
        fields: [
            { key: 'serper', type: 'number', label: 'Serper (req/min)', min: 1 },
            { key: 'openai', type: 'number', label: 'OpenAI (req/min)', min: 1 },
            { key: 'trykitt', type: 'number', label: 'TryKitt (req/min)', min: 1 },
            { key: 'trykittConcurrency', type: 'number', label: 'TryKitt concurrency', min: 1 }
        ]
    },
    {
        key: 'serperGeo',
        group: 'shoppingAudit',
        type: 'object',
        label: 'Serper geo',
        description: 'Country (gl) and language (hl) sent with Serper Shopping searches. Default us / en.',
        fields: [
            { key: 'gl', type: 'string', label: 'Country (gl)', placeholder: 'us' },
            { key: 'hl', type: 'string', label: 'Language (hl)', placeholder: 'en' }
        ]
    },
    {
        key: 'headlessMinPrice',
        group: 'shoppingAudit',
        type: 'number',
        default: 75,
        min: 0,
        label: 'Headless rescue min price (USD)',
        description: 'Only products priced at or above this run the headless Shopping rescue when Serper finds no match.'
    },
    {
        key: 'priceMismatchMinDeltaPct',
        group: 'shoppingAudit',
        type: 'number',
        default: 2.5,
        min: 0,
        label: 'Price mismatch min delta (%)',
        description: 'Minimum ad-vs-site price difference, in percent, before a price-mismatch signal is emitted.'
    },
    {
        key: 'priceMismatchMinDeltaUsd',
        group: 'shoppingAudit',
        type: 'number',
        default: 0.75,
        min: 0,
        label: 'Price mismatch min delta (USD)',
        description: 'Minimum ad-vs-site price difference, in dollars, before a price-mismatch signal is emitted.'
    },
    {
        key: 'titleQualityFallback',
        group: 'shoppingAudit',
        type: 'boolean',
        default: true,
        label: 'Title-quality fallback signal',
        description: 'Off = the signal waterfall skips the title-quality step when no stronger signal is found.'
    },
    {
        key: 'heroHeuristic',
        group: 'shoppingAudit',
        type: 'enum',
        options: [
            { value: 'price_reviews_age', label: 'Price → reviews → age (default)' }
        ],
        default: 'price_reviews_age',
        label: 'Hero product heuristic',
        description: 'How the hero product is picked from a catalog snapshot. Only one heuristic exists today; the key is reserved for alternatives.'
    }
];

const FLAGS_BY_KEY = new Map(FEATURE_FLAGS.map((f) => [f.key, f]));

export function isKnownFeatureFlag(key) {
    return FLAGS_BY_KEY.has(key);
}

function invalid(key, message) {
    return `${key}: ${message}`;
}

/**
 * Validate a features patch coming from the UI. `null` means "unset this key".
 * Unknown keys are allowed only when `allowUnknown` is set (raw JSON editor);
 * their values must be JSON scalars/objects.
 *
 * @returns {{ ok: true, patch: object } | { ok: false, errors: string[] }}
 */
export function validateFeaturesPatch(input, { allowUnknown = true } = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { ok: false, errors: ['patch must be an object'] };
    }
    const errors = [];
    const patch = {};
    for (const [key, value] of Object.entries(input)) {
        if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key)) {
            errors.push(invalid(key, 'invalid key'));
            continue;
        }
        if (value === null) {
            patch[key] = null;
            continue;
        }
        const def = FLAGS_BY_KEY.get(key);
        if (!def) {
            if (!allowUnknown) {
                errors.push(invalid(key, 'unknown flag'));
            } else if (typeof value === 'function' || typeof value === 'undefined') {
                errors.push(invalid(key, 'unsupported value'));
            } else {
                patch[key] = value;
            }
            continue;
        }
        switch (def.type) {
            case 'boolean':
                if (typeof value !== 'boolean') errors.push(invalid(key, 'must be true or false'));
                else patch[key] = value;
                break;
            case 'enum':
                if (!def.options.some((o) => o.value === value)) {
                    errors.push(invalid(key, `must be one of ${def.options.map((o) => o.value).join(', ')}`));
                } else {
                    patch[key] = value;
                }
                break;
            case 'number': {
                const n = typeof value === 'number' ? value : Number(value);
                if (!Number.isFinite(n)) errors.push(invalid(key, 'must be a number'));
                else if (def.min !== undefined && n < def.min) errors.push(invalid(key, `must be ≥ ${def.min}`));
                else patch[key] = n;
                break;
            }
            case 'object': {
                if (!value || typeof value !== 'object' || Array.isArray(value)) {
                    errors.push(invalid(key, 'must be an object'));
                    break;
                }
                const out = {};
                for (const field of def.fields) {
                    const raw = value[field.key];
                    if (raw === undefined || raw === null || raw === '') continue;
                    if (field.type === 'number') {
                        const n = typeof raw === 'number' ? raw : Number(raw);
                        if (!Number.isFinite(n)) { errors.push(invalid(`${key}.${field.key}`, 'must be a number')); continue; }
                        if (field.min !== undefined && n < field.min) { errors.push(invalid(`${key}.${field.key}`, `must be ≥ ${field.min}`)); continue; }
                        out[field.key] = n;
                    } else {
                        const s = String(raw).trim();
                        if (s.length > 64) { errors.push(invalid(`${key}.${field.key}`, 'too long')); continue; }
                        out[field.key] = s;
                    }
                }
                // Preserve unknown sub-keys rather than silently dropping them.
                for (const [subKey, subValue] of Object.entries(value)) {
                    if (!def.fields.some((f) => f.key === subKey) && subValue !== null && subValue !== '') out[subKey] = subValue;
                }
                patch[key] = Object.keys(out).length ? out : null;
                break;
            }
            default:
                errors.push(invalid(key, 'unsupported type'));
        }
    }
    return errors.length ? { ok: false, errors } : { ok: true, patch };
}

/** Registry as sent to the browser (no functions, stable shape). */
export function featureFlagRegistryForClient() {
    return {
        groups: FEATURE_FLAG_GROUPS,
        flags: FEATURE_FLAGS.map((f) => ({
            key: f.key,
            group: f.group,
            type: f.type,
            label: f.label,
            description: f.description,
            default: f.default ?? null,
            options: f.options ?? null,
            fields: f.fields ?? null,
            min: f.min ?? null,
            envOverride: f.envOverride ?? null,
            envOverrideActive: f.envOverride
                ? String(process.env[f.envOverride] || '').toLowerCase() === String(f.envOverrideValue || 'true')
                : false
        }))
    };
}

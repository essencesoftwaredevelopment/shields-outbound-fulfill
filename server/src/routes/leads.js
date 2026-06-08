/**
 * Leads API endpoints (SQL-only, no Firestore)
 *
 * CANONICAL AGENCY IDENTIFIER RULE:
 * Firebase uid = agency_id directly, no mapping table.
 * All endpoints require Firebase ID token authentication.
 * agency_id is ALWAYS derived from verified token, never from client input.
 *
 * All data operations use Cloud SQL (Postgres) as the single source of truth.
 * No Firestore lead storage.
 */

import express from 'express';
import multer from 'multer';
import { parse as csvParse } from 'csv-parse';
import { verifyFirebaseToken } from '../middleware/auth.js';
import * as leadsService from '../services/leads.js';
import * as queries from '../services/db/queries.js';
import { pool } from '../lib/db.js';
import { batchDetectKlaviyo } from '../services/detectKlaviyo.js';
import { normalizeDomain } from '../utils/domain.js';

const uploadVerification = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        if (file.mimetype === 'text/csv' || file.mimetype === 'application/vnd.ms-excel' || file.originalname.toLowerCase().endsWith('.csv')) {
            cb(null, true);
        } else {
            cb(new Error('Only CSV files are allowed'));
        }
    }
});

function parseCsvBuffer(buffer) {
    return new Promise((resolve, reject) => {
        const rows = [];
        const parser = csvParse({ columns: true, trim: true, skip_empty_lines: true, bom: true });
        parser.on('readable', () => {
            let row;
            while ((row = parser.read()) !== null) {
                rows.push(row);
            }
        });
        parser.on('end', () => resolve(rows));
        parser.on('error', reject);
        parser.write(buffer);
        parser.end();
    });
}

const router = express.Router();

function setNoStoreHeaders(res) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('Surrogate-Control', 'no-store');
}

function safeDecodeURIComponent(value = '') {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function safeEncodeURIComponent(value = '') {
    try {
        return encodeURIComponent(value);
    } catch {
        return value;
    }
}

function normalizeOptionalText(value) {
    if (value === undefined) return undefined;
    if (value === null) return null;
    const normalized = String(value).trim();
    return normalized || null;
}

function isEmailLikeSearch(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

// Looks like "example.com" / "shop.co.uk" — no @, no spaces, at least one dot,
// every label is a valid host label. Used to short-circuit the search bar onto
// the (client_id, domain_normalized) index when the user pastes a domain.
function isDomainLikeSearch(value) {
    const trimmed = String(value || '').trim();
    if (!trimmed || trimmed.includes('@') || /\s/.test(trimmed)) return false;
    if (!trimmed.includes('.')) return false;
    return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(trimmed);
}

// Classify whatever the user typed in the lead search bar so the SQL planner
// can route to the most selective index.
//   - email  -> idx_contacts_client_email_lower
//   - domain -> idx_companies_client_domain
//   - text   -> trigram GIN on full_name / email
function classifyLeadSearch(value) {
    const trimmed = String(value || '').trim();
    if (!trimmed) return { kind: 'empty', value: '' };
    if (isEmailLikeSearch(trimmed)) return { kind: 'email', value: trimmed.toLowerCase() };
    if (isDomainLikeSearch(trimmed)) return { kind: 'domain', value: trimmed.toLowerCase() };
    return { kind: 'text', value: trimmed.toLowerCase() };
}

function normalizeOptionalNumber(value) {
    if (value === undefined || value === null || value === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeOptionalBoolean(value) {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === '1' || value === 1) return true;
    if (value === 'false' || value === '0' || value === 0) return false;
    return undefined;
}

function normalizeOptionalTimestamp(value) {
    if (value === undefined || value === null || value === '') return undefined;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return undefined;
    return parsed.toISOString();
}

function normalizeOptionalObject(value) {
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return value;
}

function extractNormalizedDomains(payload) {
    const directDomains = Array.isArray(payload?.domains) ? payload.domains : [];
    const leadRows = Array.isArray(payload?.leads) ? payload.leads : [];

    const rawDomains = [
        ...directDomains,
        ...leadRows.map((row) => row?.domain)
    ];

    const seen = new Set();
    const normalized = [];
    for (const rawDomain of rawDomains) {
        const domain = normalizeDomain(rawDomain);
        if (!domain || seen.has(domain)) continue;
        seen.add(domain);
        normalized.push(domain);
    }

    return normalized;
}

async function runKlaviyoInsightsSync({ agencyId, clientSlug, domains, concurrency = 50, onlyNullUsesKlaviyo = false }) {
    const clientId = await queries.getOrCreateClient(agencyId, clientSlug);
    const normalizedDomains = Array.from(new Set((domains || []).map((domain) => normalizeOptionalText(domain)).filter(Boolean)));

    let domainsToCheck = normalizedDomains;
    if (onlyNullUsesKlaviyo) {
        const nullOnlyResult = await pool.query(
            `SELECT DISTINCT co.domain_normalized AS domain
             FROM companies co
             JOIN contacts c
               ON c.company_id = co.id
              AND c.agency_id = $1
             LEFT JOIN contact_insights ci
               ON ci.contact_id = c.id
             WHERE co.agency_id = $1
             AND co.client_id = $2
             AND co.domain_normalized = ANY($3::text[])
             AND ci.uses_klaviyo IS NULL`,
            [agencyId, clientId, normalizedDomains]
        );

        const nullOnlySet = new Set(
            nullOnlyResult.rows
                .map((row) => String(row.domain || '').trim())
                .filter(Boolean)
        );
        domainsToCheck = normalizedDomains.filter((domain) => nullOnlySet.has(domain));
    }

    if (domainsToCheck.length === 0) {
        return {
            clientId: clientSlug,
            requestedDomainCount: normalizedDomains.length,
            checkedDomainCount: 0,
            skippedAlreadyScoredCount: normalizedDomains.length,
            matchedDomainCount: 0,
            matchedContactCount: 0,
            upsertedCount: 0,
            klaviyoDetectedCount: 0,
            klaviyoDetectedDomains: [],
            unresolvedDomains: [],
            notFoundDomains: []
        };
    }

    const detectionMap = await batchDetectKlaviyo(
        domainsToCheck.map((domain) => ({ domain })),
        null,
        concurrency
    );

    const detectionRows = domainsToCheck.map((domain) => ({
        domain,
        usesKlaviyo: detectionMap.get(domain)
    }));

    const resolvedDetectionRows = detectionRows.filter((row) => typeof row.usesKlaviyo === 'boolean');
    const unresolvedDomains = detectionRows
        .filter((row) => row.usesKlaviyo === null || row.usesKlaviyo === undefined)
        .map((row) => row.domain);

    if (resolvedDetectionRows.length === 0) {
        return {
            clientId: clientSlug,
            requestedDomainCount: normalizedDomains.length,
            checkedDomainCount: domainsToCheck.length,
            skippedAlreadyScoredCount: Math.max(normalizedDomains.length - domainsToCheck.length, 0),
            matchedDomainCount: 0,
            matchedContactCount: 0,
            upsertedCount: 0,
            klaviyoDetectedCount: 0,
            klaviyoDetectedDomains: [],
            unresolvedDomains,
            notFoundDomains: []
        };
    }

    const domainArray = resolvedDetectionRows.map((row) => row.domain);
    const usesKlaviyoArray = resolvedDetectionRows.map((row) => row.usesKlaviyo);

    const matchedDomainsResult = await pool.query(
        `SELECT DISTINCT co.domain_normalized AS domain
         FROM companies co
         WHERE co.agency_id = $1
         AND co.client_id = $2
         AND co.domain_normalized = ANY($3::text[])`,
        [agencyId, clientId, domainArray]
    );

    const matchedDomainSet = new Set(
        matchedDomainsResult.rows.map((row) => String(row.domain || '').trim()).filter(Boolean)
    );

    const updateResult = await pool.query(
        `WITH input_domains AS (
            SELECT *
            FROM UNNEST($3::text[], $4::boolean[]) AS t(domain_normalized, uses_klaviyo)
        ),
        matched_contacts AS (
            SELECT
                c.id AS contact_id,
                c.agency_id,
                co.client_id,
                i.uses_klaviyo
            FROM contacts c
            JOIN companies co ON co.id = c.company_id
            JOIN input_domains i ON i.domain_normalized = co.domain_normalized
            WHERE c.agency_id = $1
            AND co.client_id = $2
        ),
        upserted AS (
            INSERT INTO contact_insights (
                contact_id,
                agency_id,
                client_id,
                uses_klaviyo,
                source,
                source_payload
            )
            SELECT
                mc.contact_id,
                mc.agency_id,
                mc.client_id,
                mc.uses_klaviyo,
                'klaviyo_dns_lookup',
                jsonb_build_object(
                    'checked_at', NOW(),
                    'method', 'dns_txt_klaviyo_site_verification'
                )
            FROM matched_contacts mc
            ON CONFLICT (contact_id)
            DO UPDATE SET
                uses_klaviyo = EXCLUDED.uses_klaviyo,
                source = COALESCE(contact_insights.source, EXCLUDED.source),
                source_payload = COALESCE(contact_insights.source_payload, '{}'::jsonb)
                    || jsonb_build_object(
                        'klaviyo_check', jsonb_build_object(
                            'checked_at', NOW(),
                            'method', 'dns_txt_klaviyo_site_verification'
                        )
                    ),
                updated_at = NOW()
            RETURNING contact_id
        )
        SELECT
            (SELECT COUNT(*)::int FROM matched_contacts) AS matched_contact_count,
            (SELECT COUNT(*)::int FROM upserted) AS upserted_count`,
        [agencyId, clientId, domainArray, usesKlaviyoArray]
    );

    const summary = updateResult.rows[0] || {
        matched_contact_count: 0,
        upserted_count: 0
    };

    const notFoundDomains = normalizedDomains.filter((domain) => !matchedDomainSet.has(domain));
    const klaviyoDetectedDomains = resolvedDetectionRows
        .filter((row) => row.usesKlaviyo === true)
        .map((row) => row.domain);

    return {
        clientId: clientSlug,
        requestedDomainCount: normalizedDomains.length,
        checkedDomainCount: domainsToCheck.length,
        skippedAlreadyScoredCount: Math.max(normalizedDomains.length - domainsToCheck.length, 0),
        matchedDomainCount: matchedDomainSet.size,
        matchedContactCount: Number(summary.matched_contact_count) || 0,
        upsertedCount: Number(summary.upserted_count) || 0,
        klaviyoDetectedCount: klaviyoDetectedDomains.length,
        klaviyoDetectedDomains,
        unresolvedDomains,
        notFoundDomains
    };
}

function buildClientMatchers(...values) {
    const textVariants = new Set();
    const slugVariants = new Set();
    const compactVariants = new Set();

    const addValue = (input) => {
        const raw = String(input || '').trim();
        if (!raw) return;

        const decoded = safeDecodeURIComponent(raw);
        const encodedRaw = safeEncodeURIComponent(raw);
        const encodedDecoded = safeEncodeURIComponent(decoded);

        const variants = [raw, decoded, encodedRaw, encodedDecoded]
            .map((variant) => String(variant || '').trim().toLowerCase())
            .filter(Boolean);

        for (const variant of variants) {
            textVariants.add(variant);

            const slug = variant
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '');
            if (slug) slugVariants.add(slug);

            const compact = variant.replace(/[^a-z0-9]+/g, '');
            if (compact) compactVariants.add(compact);
        }
    };

    values.forEach(addValue);

    return {
        textVariants: Array.from(textVariants),
        slugVariants: Array.from(slugVariants),
        compactVariants: Array.from(compactVariants),
        sets: {
            text: textVariants,
            slug: slugVariants,
            compact: compactVariants
        }
    };
}

function setsIntersect(leftSet, rightSet) {
    for (const value of leftSet) {
        if (rightSet.has(value)) return true;
    }
    return false;
}

function clientMatchersOverlap(left, right) {
    return setsIntersect(left.sets.text, right.sets.text)
        || setsIntersect(left.sets.slug, right.sets.slug)
        || setsIntersect(left.sets.compact, right.sets.compact);
}

/** Matches UI email-discovery state (hasDiscoveredEmail / email_find_completed_at). */
function sqlEmailHasDiscovered(alias = 'c') {
    return `(
        ${alias}.email IS NOT NULL
        AND BTRIM(${alias}.email) <> ''
        AND LOWER(${alias}.email) NOT LIKE '%not found%'
        AND LOWER(${alias}.email) != 'not_found'
    )`;
}

function sqlEmailFindStateClause(state) {
    switch (state) {
        case 'found':
            return sqlEmailHasDiscovered();
        case 'not_found':
            return `(c.email_find_completed_at IS NOT NULL AND NOT ${sqlEmailHasDiscovered()})`;
        case 'not_run':
            return `(c.email_find_completed_at IS NULL AND NOT ${sqlEmailHasDiscovered()})`;
        default:
            return null;
    }
}

const LEAD_FILTER_FIELDS = [
    // ── Contact fields ──────────────────────────────────────────────────────
    {
        key: 'full_name',
        label: 'Founder Name',
        type: 'text',
        operators: [
            { key: 'contains', label: 'Contains' },
            { key: 'not_contains', label: 'Does Not Contain' },
            { key: 'eq', label: 'Equals' },
            { key: 'neq', label: 'Does Not Equal' },
            { key: 'starts_with', label: 'Starts With' },
            { key: 'is_empty', label: 'Is Empty' },
            { key: 'not_empty', label: 'Is Not Empty' }
        ]
    },
    {
        key: 'email',
        label: 'Email',
        type: 'text',
        operators: [
            { key: 'contains', label: 'Contains' },
            { key: 'not_contains', label: 'Does Not Contain' },
            { key: 'eq', label: 'Equals' },
            { key: 'neq', label: 'Does Not Equal' },
            { key: 'starts_with', label: 'Starts With' },
            { key: 'is_empty', label: 'Is Empty' },
            { key: 'not_empty', label: 'Is Not Empty' }
        ]
    },
    {
        key: 'email_status',
        label: 'Email Status',
        type: 'enum',
        operators: [
            { key: 'eq', label: 'Equals' },
            { key: 'neq', label: 'Does Not Equal' },
            { key: 'in', label: 'Is Any Of' },
            { key: 'not_in', label: 'Is None Of' },
            { key: 'is_empty', label: 'Is Empty' },
            { key: 'not_empty', label: 'Is Not Empty' }
        ],
        options: [
            { value: 'valid', label: 'Valid' },
            { value: 'risky', label: 'Valid-Risky' },
            { value: 'invalid', label: 'Invalid' },
            { value: 'unknown', label: 'Unknown' }
        ]
    },
    {
        key: 'email_find_state',
        label: 'Email Discovery',
        type: 'enum',
        operators: [
            { key: 'eq', label: 'Equals' },
            { key: 'neq', label: 'Does Not Equal' },
            { key: 'in', label: 'Is Any Of' },
            { key: 'not_in', label: 'Is None Of' }
        ],
        options: [
            { value: 'found', label: 'Found' },
            { value: 'not_found', label: 'No Email Found' },
            { value: 'not_run', label: 'Not Searched' }
        ]
    },
    {
        key: 'domain',
        label: 'Domain',
        type: 'text',
        operators: [
            { key: 'contains', label: 'Contains' },
            { key: 'not_contains', label: 'Does Not Contain' },
            { key: 'eq', label: 'Equals' },
            { key: 'neq', label: 'Does Not Equal' },
            { key: 'starts_with', label: 'Starts With' },
            { key: 'is_empty', label: 'Is Empty' },
            { key: 'not_empty', label: 'Is Not Empty' }
        ]
    },
    {
        key: 'role_type',
        label: 'Role Type',
        type: 'text',
        operators: [
            { key: 'contains', label: 'Contains' },
            { key: 'not_contains', label: 'Does Not Contain' },
            { key: 'eq', label: 'Equals' },
            { key: 'neq', label: 'Does Not Equal' },
            { key: 'is_empty', label: 'Is Empty' },
            { key: 'not_empty', label: 'Is Not Empty' }
        ]
    },
    {
        key: 'job_id',
        label: 'Job ID',
        type: 'text',
        operators: [
            { key: 'contains', label: 'Contains' },
            { key: 'eq', label: 'Equals' },
            { key: 'neq', label: 'Does Not Equal' },
            { key: 'is_empty', label: 'Is Empty' },
            { key: 'not_empty', label: 'Is Not Empty' }
        ]
    },
    {
        key: 'first_line',
        label: 'First Line',
        type: 'text',
        operators: [
            { key: 'contains', label: 'Contains' },
            { key: 'not_contains', label: 'Does Not Contain' },
            { key: 'is_empty', label: 'Is Empty' },
            { key: 'not_empty', label: 'Is Not Empty' }
        ]
    },
    // ── Date fields ─────────────────────────────────────────────────────────
    {
        key: 'created_at',
        label: 'Created At',
        type: 'date',
        operators: [
            { key: 'on_or_after', label: 'On Or After' },
            { key: 'on_or_before', label: 'On Or Before' },
            { key: 'between', label: 'Between' },
            { key: 'older_than_days', label: 'Older Than Days' }
        ]
    },
    {
        key: 'updated_at',
        label: 'Last Updated',
        type: 'date',
        operators: [
            { key: 'on_or_after', label: 'On Or After' },
            { key: 'on_or_before', label: 'On Or Before' },
            { key: 'between', label: 'Between' },
            { key: 'older_than_days', label: 'Older Than Days' }
        ]
    },
    {
        key: 'last_contacted_at',
        label: 'Last Contacted',
        type: 'date',
        operators: [
            { key: 'on_or_after', label: 'On Or After' },
            { key: 'on_or_before', label: 'On Or Before' },
            { key: 'between', label: 'Between' },
            { key: 'older_than_days', label: 'Older Than Days' },
            { key: 'is_empty', label: 'Is Empty' },
            { key: 'not_empty', label: 'Is Not Empty' }
        ]
    },
    {
        key: 'email_find_completed_at',
        label: 'Email Find Completed',
        type: 'date',
        operators: [
            { key: 'on_or_after', label: 'On Or After' },
            { key: 'on_or_before', label: 'On Or Before' },
            { key: 'is_empty', label: 'Is Empty' },
            { key: 'not_empty', label: 'Is Not Empty' }
        ]
    },
    {
        key: 'email_verify_completed_at',
        label: 'Email Verify Completed',
        type: 'date',
        operators: [
            { key: 'on_or_after', label: 'On Or After' },
            { key: 'on_or_before', label: 'On Or Before' },
            { key: 'is_empty', label: 'Is Empty' },
            { key: 'not_empty', label: 'Is Not Empty' }
        ]
    },
    // ── Campaign / pipeline fields ───────────────────────────────────────────
    {
        key: 'added_to_campaign_at',
        label: 'Added To Campaign',
        type: 'date',
        operators: [
            { key: 'on_or_after', label: 'On Or After' },
            { key: 'on_or_before', label: 'On Or Before' },
            { key: 'between', label: 'Between' },
            { key: 'is_empty', label: 'Is Empty' },
            { key: 'not_empty', label: 'Is Not Empty' }
        ]
    },
    {
        key: 'last_reply_at',
        label: 'Last Reply',
        type: 'date',
        operators: [
            { key: 'on_or_after', label: 'On Or After' },
            { key: 'on_or_before', label: 'On Or Before' },
            { key: 'is_empty', label: 'Is Empty' },
            { key: 'not_empty', label: 'Is Not Empty' }
        ]
    },
    {
        key: 'instantly_status',
        label: 'Instantly Status',
        type: 'enum',
        operators: [
            { key: 'eq', label: 'Equals' },
            { key: 'neq', label: 'Does Not Equal' },
            { key: 'in', label: 'Is Any Of' },
            { key: 'not_in', label: 'Is None Of' }
        ],
        options: [
            { value: 'active', label: 'Active' },
            { value: 'paused', label: 'Paused' },
            { value: 'completed', label: 'Completed' },
            { value: 'bounced', label: 'Bounced' },
            { value: 'unsubscribed', label: 'Unsubscribed' },
            { value: 'skipped', label: 'Skipped' },
            { value: 'interested', label: 'Interested' },
            { value: 'meeting_booked', label: 'Meeting Booked' },
            { value: 'meeting_completed', label: 'Meeting Completed' },
            { value: 'won', label: 'Won' },
            { value: 'out_of_office', label: 'Out Of Office' },
            { value: 'not_interested', label: 'Not Interested' },
            { value: 'wrong_person', label: 'Wrong Person' },
            { value: 'lost', label: 'Lost' },
            { value: 'no_show', label: 'No Show' }
        ]
    },
    {
        key: 'has_replied',
        label: 'Has Replied',
        type: 'boolean',
        operators: [
            { key: 'is_true', label: 'Has Replied' },
            { key: 'is_false', label: 'Has Not Replied' }
        ]
    },
    {
        key: 'campaign_count_all_time',
        label: 'Campaign Count (All Time)',
        type: 'number',
        operators: [
            { key: 'eq', label: 'Equals' },
            { key: 'neq', label: 'Does Not Equal' },
            { key: 'gt', label: 'Greater Than' },
            { key: 'gte', label: 'Greater Than Or Equal' },
            { key: 'lt', label: 'Less Than' },
            { key: 'lte', label: 'Less Than Or Equal' }
        ]
    },
    {
        key: 'campaign_count_active',
        label: 'Active Campaign Count',
        type: 'number',
        operators: [
            { key: 'eq', label: 'Equals' },
            { key: 'neq', label: 'Does Not Equal' },
            { key: 'gt', label: 'Greater Than' },
            { key: 'gte', label: 'Greater Than Or Equal' },
            { key: 'lt', label: 'Less Than' },
            { key: 'lte', label: 'Less Than Or Equal' }
        ]
    },
    // ── Insight fields (contact_insights) ────────────────────────────────────
    {
        key: 'uses_klaviyo',
        label: 'Uses Klaviyo',
        type: 'boolean',
        operators: [
            { key: 'is_true', label: 'Yes' },
            { key: 'is_false', label: 'No' },
            { key: 'is_empty', label: 'Not Checked' }
        ]
    },
    {
        key: 'uses_shopify',
        label: 'Uses Shopify',
        type: 'boolean',
        operators: [
            { key: 'is_true', label: 'Yes' },
            { key: 'is_false', label: 'No' },
            { key: 'is_empty', label: 'Not Checked' }
        ]
    },
    {
        key: 'discovery_call_held',
        label: 'Discovery Call Held',
        type: 'boolean',
        operators: [
            { key: 'is_true', label: 'Yes' },
            { key: 'is_false', label: 'No' },
            { key: 'is_empty', label: 'Not Checked' }
        ]
    },
    {
        key: 'annual_revenue_min',
        label: 'Annual Revenue (Min $)',
        type: 'number',
        operators: [
            { key: 'gt', label: 'Greater Than' },
            { key: 'gte', label: 'Greater Than Or Equal' },
            { key: 'lt', label: 'Less Than' },
            { key: 'lte', label: 'Less Than Or Equal' },
            { key: 'is_empty', label: 'Not Set' },
            { key: 'not_empty', label: 'Is Set' }
        ]
    },
    {
        key: 'annual_revenue_max',
        label: 'Annual Revenue (Max $)',
        type: 'number',
        operators: [
            { key: 'gt', label: 'Greater Than' },
            { key: 'gte', label: 'Greater Than Or Equal' },
            { key: 'lt', label: 'Less Than' },
            { key: 'lte', label: 'Less Than Or Equal' },
            { key: 'is_empty', label: 'Not Set' },
            { key: 'not_empty', label: 'Is Set' }
        ]
    }
];

const LEAD_FILTER_FIELD_MAP = new Map(LEAD_FILTER_FIELDS.map((field) => [field.key, field]));

function getLeadFilterFieldsPayload() {
    return LEAD_FILTER_FIELDS.map((field) => ({
        key: field.key,
        label: field.label,
        type: field.type,
        operators: field.operators,
        options: field.options || []
    }));
}

function parseLeadFiltersQuery(rawFilters) {
    if (typeof rawFilters !== 'string' || !rawFilters.trim()) return { clauses: [] };

    let parsed;
    try {
        parsed = JSON.parse(rawFilters);
    } catch {
        const error = new Error('Invalid filters JSON.');
        error.statusCode = 400;
        throw error;
    }

    // Backward compat: accept old flat array format (all AND)
    if (Array.isArray(parsed)) {
        return { clauses: parsed.slice(0, 25).map((c) => ({ ...c, joinOp: 'AND' })) };
    }

    if (parsed && typeof parsed === 'object') {
        // Old format: { logic, clauses } — spread joinOp from global logic
        if (parsed.logic) {
            const logic = String(parsed.logic || 'AND').toUpperCase() === 'OR' ? 'OR' : 'AND';
            const clauses = Array.isArray(parsed.clauses) ? parsed.clauses.slice(0, 25) : [];
            return { clauses: clauses.map((c) => ({ ...c, joinOp: logic })) };
        }
        // New format: { clauses: [{...clause, joinOp}] }
        const clauses = Array.isArray(parsed.clauses) ? parsed.clauses.slice(0, 25) : [];
        return {
            clauses: clauses.map((c) => ({
                ...c,
                joinOp: String(c.joinOp || 'AND').toUpperCase() === 'OR' ? 'OR' : 'AND'
            }))
        };
    }

    const error = new Error('filters must be a JSON object or array.');
    error.statusCode = 400;
    throw error;
}

const CAMPAIGN_STATS_FILTER_FIELDS = new Set([
    'added_to_campaign_at', 'instantly_status', 'campaign_count_all_time',
    'campaign_count_active', 'last_reply_at', 'has_replied'
]);

const INSIGHTS_FILTER_FIELDS = new Set([
    'uses_klaviyo', 'uses_shopify', 'discovery_call_held',
    'annual_revenue_min', 'annual_revenue_max'
]);

function leadFiltersRequireCampaignStats(filters) {
    return filters.some((filter) => {
        const fieldKey = normalizeOptionalText(filter?.field)?.toLowerCase() || '';
        return CAMPAIGN_STATS_FILTER_FIELDS.has(fieldKey);
    });
}

function leadFiltersRequireInsights(filters) {
    return filters.some((filter) => {
        const fieldKey = normalizeOptionalText(filter?.field)?.toLowerCase() || '';
        return INSIGHTS_FILTER_FIELDS.has(fieldKey);
    });
}

const DATE_FILTER_FIELDS = new Set([
    'created_at', 'updated_at', 'last_contacted_at', 'added_to_campaign_at', 'email_find_completed_at', 'email_verify_completed_at', 'last_reply_at'
]);
const NUMERIC_FILTER_FIELDS = new Set([
    'campaign_count_all_time', 'campaign_count_active', 'annual_revenue_min', 'annual_revenue_max'
]);

function normalizeLeadFilterValue(fieldKey, operatorKey, rawValue) {
    // Operators that need no value
    if (operatorKey === 'is_empty' || operatorKey === 'not_empty'
        || operatorKey === 'is_true' || operatorKey === 'is_false') return null;

    // Multi-value operators — value is a JSON array string
    if (operatorKey === 'in' || operatorKey === 'not_in' || operatorKey === 'between') {
        let arr;
        try { arr = JSON.parse(rawValue); } catch { return null; }
        if (!Array.isArray(arr) || arr.length === 0) return null;
        if (operatorKey === 'between' && arr.length < 2) return null;
        return arr.map((v) => String(v ?? '').trim()).filter(Boolean);
    }

    if (NUMERIC_FILTER_FIELDS.has(fieldKey) || operatorKey === 'older_than_days') {
        const parsed = Number(rawValue);
        return Number.isFinite(parsed) ? parsed : null;
    }

    if (DATE_FILTER_FIELDS.has(fieldKey)) {
        const normalized = normalizeOptionalTimestamp(rawValue);
        return normalized || null;
    }

    const normalizedText = normalizeOptionalText(rawValue);
    if (!normalizedText) return null;

    if (fieldKey === 'email_status') {
        const lowered = normalizedText.toLowerCase();
        return lowered === 'valid-risky' ? 'risky' : lowered;
    }

    if (fieldKey === 'email_find_state') {
        return normalizedText.toLowerCase();
    }

    if (fieldKey === 'instantly_status') {
        return normalizedText.toLowerCase();
    }

    return normalizedText;
}

/**
 * Build a WHERE fragment from per-clause joinOp.
 * Clauses connected by AND are grouped together; OR separates groups.
 * Result: AND (groupA_clause1 AND groupA_clause2) OR (groupB_clause1) ...
 * wrapped appropriately so the whole expression is safe to AND into a parent WHERE.
 */
function joinDynamicClauses(sqlClauses, rawFilters) {
    if (sqlClauses.length === 0) return null;
    // rawFilters[i].joinOp is the connector AFTER clause i
    const groups = [];
    let currentGroup = [sqlClauses[0]];
    for (let i = 0; i < sqlClauses.length - 1; i++) {
        const joinOp = String(rawFilters[i]?.joinOp || 'AND').toUpperCase() === 'OR' ? 'OR' : 'AND';
        if (joinOp === 'OR') {
            groups.push(currentGroup);
            currentGroup = [sqlClauses[i + 1]];
        } else {
            currentGroup.push(sqlClauses[i + 1]);
        }
    }
    groups.push(currentGroup);

    const groupSql = groups
        .map((g) => g.map((c) => `(${c})`).join(' AND '))
        .filter(Boolean);

    if (groupSql.length === 1) return groupSql[0];
    return `(${groupSql.join(' OR ')})`;
}

function buildDynamicLeadFilterClauses(rawFilters, paramsState) {
    const clauses = [];
    const bindParam = (value) => {
        paramsState.params.push(value);
        const ref = `$${paramsState.paramIndex}`;
        paramsState.paramIndex += 1;
        return ref;
    };

    // Helper: bind each element of an array and return [ref, ref, ...]
    const bindArray = (arr) => arr.map((v) => bindParam(v));

    const NO_VALUE_OPS = new Set(['is_empty', 'not_empty', 'is_true', 'is_false']);

    for (const rawFilter of rawFilters) {
        if (!rawFilter || typeof rawFilter !== 'object' || Array.isArray(rawFilter)) continue;

        const fieldKey = normalizeOptionalText(rawFilter.field)?.toLowerCase() || '';
        const operatorKey = normalizeOptionalText(rawFilter.op)?.toLowerCase() || '';
        if (!fieldKey || !operatorKey) continue;

        const fieldDef = LEAD_FILTER_FIELD_MAP.get(fieldKey);
        if (!fieldDef) continue;
        if (!fieldDef.operators.some((op) => op.key === operatorKey)) continue;

        const normalizedValue = normalizeLeadFilterValue(fieldKey, operatorKey, rawFilter.value);
        if (!NO_VALUE_OPS.has(operatorKey) && normalizedValue === null) continue;

        // ── full_name ──────────────────────────────────────────────────────
        if (fieldKey === 'full_name') {
            if (operatorKey === 'contains') {
                // Expression intentionally matches idx_contacts_full_name_trgm (LOWER(full_name))
                const ref = bindParam(`%${String(normalizedValue).toLowerCase()}%`);
                clauses.push(`c.full_name IS NOT NULL AND LOWER(c.full_name) LIKE ${ref}`);
            } else if (operatorKey === 'not_contains') {
                const ref = bindParam(`%${String(normalizedValue).toLowerCase()}%`);
                clauses.push(`(c.full_name IS NULL OR LOWER(c.full_name) NOT LIKE ${ref})`);
            } else if (operatorKey === 'eq') {
                const ref = bindParam(String(normalizedValue).toLowerCase());
                clauses.push(`LOWER(COALESCE(c.full_name, '')) = ${ref}`);
            } else if (operatorKey === 'neq') {
                const ref = bindParam(String(normalizedValue).toLowerCase());
                clauses.push(`LOWER(COALESCE(c.full_name, '')) <> ${ref}`);
            } else if (operatorKey === 'starts_with') {
                const ref = bindParam(`${String(normalizedValue).toLowerCase()}%`);
                clauses.push(`c.full_name IS NOT NULL AND LOWER(c.full_name) LIKE ${ref}`);
            } else if (operatorKey === 'is_empty') {
                clauses.push(`(c.full_name IS NULL OR BTRIM(c.full_name) = '')`);
            } else if (operatorKey === 'not_empty') {
                clauses.push(`(c.full_name IS NOT NULL AND BTRIM(c.full_name) <> '')`);
            }
            continue;
        }

        // ── email ──────────────────────────────────────────────────────────
        if (fieldKey === 'email') {
            if (operatorKey === 'contains') {
                // Matches idx_contacts_email_trgm (LOWER(email))
                const ref = bindParam(`%${String(normalizedValue).toLowerCase()}%`);
                clauses.push(`c.email IS NOT NULL AND LOWER(c.email) LIKE ${ref}`);
            } else if (operatorKey === 'not_contains') {
                const ref = bindParam(`%${String(normalizedValue).toLowerCase()}%`);
                clauses.push(`(c.email IS NULL OR LOWER(c.email) NOT LIKE ${ref})`);
            } else if (operatorKey === 'eq') {
                // Matches idx_contacts_client_email_lower (client_id, LOWER(email))
                const ref = bindParam(String(normalizedValue).toLowerCase());
                clauses.push(`c.email IS NOT NULL AND LOWER(c.email) = ${ref}`);
            } else if (operatorKey === 'neq') {
                const ref = bindParam(String(normalizedValue).toLowerCase());
                clauses.push(`(c.email IS NULL OR LOWER(c.email) <> ${ref})`);
            } else if (operatorKey === 'starts_with') {
                const ref = bindParam(`${String(normalizedValue).toLowerCase()}%`);
                clauses.push(`c.email IS NOT NULL AND LOWER(c.email) LIKE ${ref}`);
            } else if (operatorKey === 'is_empty') {
                clauses.push(`(c.email IS NULL OR BTRIM(c.email) = '')`);
            } else if (operatorKey === 'not_empty') {
                clauses.push(`(c.email IS NOT NULL AND BTRIM(c.email) <> '')`);
            }
            continue;
        }

        // ── email_status ───────────────────────────────────────────────────
        if (fieldKey === 'email_status') {
            if (operatorKey === 'eq') {
                const ref = bindParam(String(normalizedValue).toLowerCase());
                clauses.push(`LOWER(COALESCE(c.email_status, '')) = ${ref}`);
            } else if (operatorKey === 'neq') {
                const ref = bindParam(String(normalizedValue).toLowerCase());
                clauses.push(`LOWER(COALESCE(c.email_status, '')) <> ${ref}`);
            } else if (operatorKey === 'in') {
                const refs = bindArray(normalizedValue.map((v) => v.toLowerCase()));
                clauses.push(`LOWER(COALESCE(c.email_status, '')) = ANY(ARRAY[${refs.join(', ')}]::text[])`);
            } else if (operatorKey === 'not_in') {
                const refs = bindArray(normalizedValue.map((v) => v.toLowerCase()));
                clauses.push(`LOWER(COALESCE(c.email_status, '')) <> ALL(ARRAY[${refs.join(', ')}]::text[])`);
            } else if (operatorKey === 'is_empty') {
                clauses.push(`(c.email_status IS NULL OR BTRIM(c.email_status) = '')`);
            } else if (operatorKey === 'not_empty') {
                clauses.push(`(c.email_status IS NOT NULL AND BTRIM(c.email_status) <> '')`);
            }
            continue;
        }

        // ── email_find_state ───────────────────────────────────────────────
        if (fieldKey === 'email_find_state') {
            const rawStates = operatorKey === 'in' || operatorKey === 'not_in'
                ? (Array.isArray(normalizedValue) ? normalizedValue : [])
                : [String(normalizedValue)];
            const states = rawStates
                .map((value) => String(value).toLowerCase())
                .filter((value) => ['found', 'not_found', 'not_run'].includes(value));
            if (!states.length) continue;

            const stateClauses = states
                .map((state) => sqlEmailFindStateClause(state))
                .filter(Boolean);
            if (!stateClauses.length) continue;

            if (operatorKey === 'eq') {
                clauses.push(stateClauses[0]);
            } else if (operatorKey === 'neq') {
                clauses.push(`NOT (${stateClauses[0]})`);
            } else if (operatorKey === 'in') {
                clauses.push(`(${stateClauses.join(' OR ')})`);
            } else if (operatorKey === 'not_in') {
                clauses.push(`NOT (${stateClauses.join(' OR ')})`);
            }
            continue;
        }

        // ── domain ─────────────────────────────────────────────────────────
        if (fieldKey === 'domain') {
            if (operatorKey === 'contains') {
                // Matches idx_companies_domain_normalized_trgm
                const ref = bindParam(`%${String(normalizedValue).toLowerCase()}%`);
                clauses.push(`co.domain_normalized IS NOT NULL AND co.domain_normalized LIKE ${ref}`);
            } else if (operatorKey === 'not_contains') {
                const ref = bindParam(`%${String(normalizedValue).toLowerCase()}%`);
                clauses.push(`(co.domain_normalized IS NULL OR co.domain_normalized NOT LIKE ${ref})`);
            } else if (operatorKey === 'eq') {
                const ref = bindParam(String(normalizedValue).toLowerCase());
                clauses.push(`co.domain_normalized = ${ref}`);
            } else if (operatorKey === 'neq') {
                const ref = bindParam(String(normalizedValue).toLowerCase());
                clauses.push(`co.domain_normalized <> ${ref}`);
            } else if (operatorKey === 'starts_with') {
                const ref = bindParam(`${String(normalizedValue).toLowerCase()}%`);
                clauses.push(`co.domain_normalized IS NOT NULL AND co.domain_normalized LIKE ${ref}`);
            } else if (operatorKey === 'is_empty') {
                clauses.push(`(co.domain_normalized IS NULL OR BTRIM(co.domain_normalized) = '')`);
            } else if (operatorKey === 'not_empty') {
                clauses.push(`(co.domain_normalized IS NOT NULL AND BTRIM(co.domain_normalized) <> '')`);
            }
            continue;
        }

        // ── role_type ──────────────────────────────────────────────────────
        if (fieldKey === 'role_type') {
            if (operatorKey === 'contains') {
                const ref = bindParam(`%${String(normalizedValue).toLowerCase()}%`);
                clauses.push(`c.role_type IS NOT NULL AND LOWER(c.role_type) LIKE ${ref}`);
            } else if (operatorKey === 'not_contains') {
                const ref = bindParam(`%${String(normalizedValue).toLowerCase()}%`);
                clauses.push(`(c.role_type IS NULL OR LOWER(c.role_type) NOT LIKE ${ref})`);
            } else if (operatorKey === 'eq') {
                const ref = bindParam(String(normalizedValue).toLowerCase());
                clauses.push(`LOWER(COALESCE(c.role_type, '')) = ${ref}`);
            } else if (operatorKey === 'neq') {
                const ref = bindParam(String(normalizedValue).toLowerCase());
                clauses.push(`LOWER(COALESCE(c.role_type, '')) <> ${ref}`);
            } else if (operatorKey === 'is_empty') {
                clauses.push(`(c.role_type IS NULL OR BTRIM(c.role_type) = '')`);
            } else if (operatorKey === 'not_empty') {
                clauses.push(`(c.role_type IS NOT NULL AND BTRIM(c.role_type) <> '')`);
            }
            continue;
        }

        // ── job_id ─────────────────────────────────────────────────────────
        if (fieldKey === 'job_id') {
            if (operatorKey === 'contains') {
                const ref = bindParam(`%${String(normalizedValue).toLowerCase()}%`);
                clauses.push(`LOWER(COALESCE(c.job_id, '')) LIKE ${ref}`);
            } else if (operatorKey === 'eq') {
                const ref = bindParam(String(normalizedValue));
                clauses.push(`COALESCE(c.job_id, '') = ${ref}`);
            } else if (operatorKey === 'neq') {
                const ref = bindParam(String(normalizedValue));
                clauses.push(`COALESCE(c.job_id, '') <> ${ref}`);
            } else if (operatorKey === 'is_empty') {
                clauses.push(`(c.job_id IS NULL OR BTRIM(c.job_id) = '')`);
            } else if (operatorKey === 'not_empty') {
                clauses.push(`(c.job_id IS NOT NULL AND BTRIM(c.job_id) <> '')`);
            }
            continue;
        }

        // ── first_line ─────────────────────────────────────────────────────
        if (fieldKey === 'first_line') {
            if (operatorKey === 'contains') {
                const ref = bindParam(`%${String(normalizedValue).toLowerCase()}%`);
                clauses.push(`c.personalization_first_line IS NOT NULL AND LOWER(c.personalization_first_line) LIKE ${ref}`);
            } else if (operatorKey === 'not_contains') {
                const ref = bindParam(`%${String(normalizedValue).toLowerCase()}%`);
                clauses.push(`(c.personalization_first_line IS NULL OR LOWER(c.personalization_first_line) NOT LIKE ${ref})`);
            } else if (operatorKey === 'is_empty') {
                clauses.push(`(c.personalization_first_line IS NULL OR BTRIM(c.personalization_first_line) = '')`);
            } else if (operatorKey === 'not_empty') {
                clauses.push(`(c.personalization_first_line IS NOT NULL AND BTRIM(c.personalization_first_line) <> '')`);
            }
            continue;
        }

        // ── created_at ─────────────────────────────────────────────────────
        if (fieldKey === 'created_at') {
            if (operatorKey === 'on_or_after') {
                const ref = bindParam(String(normalizedValue));
                clauses.push(`c.created_at >= ${ref}::timestamptz`);
            } else if (operatorKey === 'on_or_before') {
                const ref = bindParam(String(normalizedValue).slice(0, 10));
                clauses.push(`c.created_at < (${ref}::date + INTERVAL '1 day')`);
            } else if (operatorKey === 'between') {
                const refStart = bindParam(normalizedValue[0]);
                const refEnd = bindParam(normalizedValue[1].slice(0, 10));
                clauses.push(`c.created_at >= ${refStart}::timestamptz AND c.created_at < (${refEnd}::date + INTERVAL '1 day')`);
            } else if (operatorKey === 'older_than_days') {
                const ref = bindParam(Number(normalizedValue));
                clauses.push(`c.created_at < NOW() - (${ref}::text || ' days')::interval`);
            }
            continue;
        }

        // ── updated_at ─────────────────────────────────────────────────────
        if (fieldKey === 'updated_at') {
            if (operatorKey === 'on_or_after') {
                const ref = bindParam(String(normalizedValue));
                clauses.push(`c.updated_at >= ${ref}::timestamptz`);
            } else if (operatorKey === 'on_or_before') {
                const ref = bindParam(String(normalizedValue).slice(0, 10));
                clauses.push(`c.updated_at < (${ref}::date + INTERVAL '1 day')`);
            } else if (operatorKey === 'between') {
                const refStart = bindParam(normalizedValue[0]);
                const refEnd = bindParam(normalizedValue[1].slice(0, 10));
                clauses.push(`c.updated_at >= ${refStart}::timestamptz AND c.updated_at < (${refEnd}::date + INTERVAL '1 day')`);
            } else if (operatorKey === 'older_than_days') {
                const ref = bindParam(Number(normalizedValue));
                clauses.push(`c.updated_at < NOW() - (${ref}::text || ' days')::interval`);
            }
            continue;
        }

        // ── last_contacted_at ──────────────────────────────────────────────
        if (fieldKey === 'last_contacted_at') {
            if (operatorKey === 'on_or_after') {
                const ref = bindParam(String(normalizedValue));
                clauses.push(`c.last_contacted_at >= ${ref}::timestamptz`);
            } else if (operatorKey === 'on_or_before') {
                const ref = bindParam(String(normalizedValue).slice(0, 10));
                clauses.push(`c.last_contacted_at < (${ref}::date + INTERVAL '1 day')`);
            } else if (operatorKey === 'between') {
                const refStart = bindParam(normalizedValue[0]);
                const refEnd = bindParam(normalizedValue[1].slice(0, 10));
                clauses.push(`c.last_contacted_at >= ${refStart}::timestamptz AND c.last_contacted_at < (${refEnd}::date + INTERVAL '1 day')`);
            } else if (operatorKey === 'older_than_days') {
                const ref = bindParam(Number(normalizedValue));
                clauses.push(`(c.last_contacted_at IS NULL OR c.last_contacted_at < NOW() - (${ref}::text || ' days')::interval)`);
            } else if (operatorKey === 'is_empty') {
                clauses.push(`c.last_contacted_at IS NULL`);
            } else if (operatorKey === 'not_empty') {
                clauses.push(`c.last_contacted_at IS NOT NULL`);
            }
            continue;
        }

        // ── email_find_completed_at ────────────────────────────────────────
        if (fieldKey === 'email_find_completed_at') {
            if (operatorKey === 'on_or_after') {
                const ref = bindParam(String(normalizedValue));
                clauses.push(`c.email_find_completed_at >= ${ref}::timestamptz`);
            } else if (operatorKey === 'on_or_before') {
                const ref = bindParam(String(normalizedValue).slice(0, 10));
                clauses.push(`c.email_find_completed_at < (${ref}::date + INTERVAL '1 day')`);
            } else if (operatorKey === 'is_empty') {
                clauses.push(`c.email_find_completed_at IS NULL`);
            } else if (operatorKey === 'not_empty') {
                clauses.push(`c.email_find_completed_at IS NOT NULL`);
            }
            continue;
        }

        // ── email_verify_completed_at ──────────────────────────────────────
        if (fieldKey === 'email_verify_completed_at') {
            if (operatorKey === 'on_or_after') {
                const ref = bindParam(String(normalizedValue));
                clauses.push(`c.email_verify_completed_at >= ${ref}::timestamptz`);
            } else if (operatorKey === 'on_or_before') {
                const ref = bindParam(String(normalizedValue).slice(0, 10));
                clauses.push(`c.email_verify_completed_at < (${ref}::date + INTERVAL '1 day')`);
            } else if (operatorKey === 'is_empty') {
                clauses.push(`c.email_verify_completed_at IS NULL`);
            } else if (operatorKey === 'not_empty') {
                clauses.push(`c.email_verify_completed_at IS NOT NULL`);
            }
            continue;
        }

        // ── added_to_campaign_at ───────────────────────────────────────────
        if (fieldKey === 'added_to_campaign_at') {
            if (operatorKey === 'on_or_after') {
                const ref = bindParam(String(normalizedValue));
                clauses.push(`cs.last_campaign_added_at >= ${ref}::timestamptz`);
            } else if (operatorKey === 'on_or_before') {
                const ref = bindParam(String(normalizedValue).slice(0, 10));
                clauses.push(`cs.last_campaign_added_at < (${ref}::date + INTERVAL '1 day')`);
            } else if (operatorKey === 'between') {
                const refStart = bindParam(normalizedValue[0]);
                const refEnd = bindParam(normalizedValue[1].slice(0, 10));
                clauses.push(`cs.last_campaign_added_at >= ${refStart}::timestamptz AND cs.last_campaign_added_at < (${refEnd}::date + INTERVAL '1 day')`);
            } else if (operatorKey === 'is_empty') {
                clauses.push(`cs.last_campaign_added_at IS NULL`);
            } else if (operatorKey === 'not_empty') {
                clauses.push(`cs.last_campaign_added_at IS NOT NULL`);
            }
            continue;
        }

        // ── last_reply_at ──────────────────────────────────────────────────
        if (fieldKey === 'last_reply_at') {
            if (operatorKey === 'on_or_after') {
                const ref = bindParam(String(normalizedValue));
                clauses.push(`cs.last_reply_at >= ${ref}::timestamptz`);
            } else if (operatorKey === 'on_or_before') {
                const ref = bindParam(String(normalizedValue).slice(0, 10));
                clauses.push(`cs.last_reply_at < (${ref}::date + INTERVAL '1 day')`);
            } else if (operatorKey === 'is_empty') {
                clauses.push(`cs.last_reply_at IS NULL`);
            } else if (operatorKey === 'not_empty') {
                clauses.push(`cs.last_reply_at IS NOT NULL`);
            }
            continue;
        }

        // ── has_replied ────────────────────────────────────────────────────
        if (fieldKey === 'has_replied') {
            if (operatorKey === 'is_true') {
                clauses.push(`cs.has_replied IS TRUE`);
            } else if (operatorKey === 'is_false') {
                clauses.push(`(cs.has_replied IS NULL OR cs.has_replied IS FALSE)`);
            }
            continue;
        }

        // ── instantly_status ───────────────────────────────────────────────
        if (fieldKey === 'instantly_status') {
            const buildStatusCheck = (vals) => {
                const refs = bindArray(vals.map((v) => String(v).toLowerCase()));
                return refs.map((ref) => `(
                    ${ref} = ANY(COALESCE(cs.active_interest_status_labels, '{}'::text[]))
                    OR ${ref} = ANY(COALESCE(cs.active_lead_status_labels, '{}'::text[]))
                )`).join(' OR ');
            };
            if (operatorKey === 'eq') {
                const ref = bindParam(String(normalizedValue));
                clauses.push(`(
                    ${ref} = ANY(COALESCE(cs.active_interest_status_labels, '{}'::text[]))
                    OR ${ref} = ANY(COALESCE(cs.active_lead_status_labels, '{}'::text[]))
                )`);
            } else if (operatorKey === 'neq') {
                const ref = bindParam(String(normalizedValue));
                clauses.push(`(
                    ${ref} <> ALL(COALESCE(cs.active_interest_status_labels, '{}'::text[]))
                    AND ${ref} <> ALL(COALESCE(cs.active_lead_status_labels, '{}'::text[]))
                )`);
            } else if (operatorKey === 'in') {
                clauses.push(`(${buildStatusCheck(normalizedValue)})`);
            } else if (operatorKey === 'not_in') {
                const refs = bindArray(normalizedValue.map((v) => String(v).toLowerCase()));
                clauses.push(`NOT (${refs.map((ref) => `(
                    ${ref} = ANY(COALESCE(cs.active_interest_status_labels, '{}'::text[]))
                    OR ${ref} = ANY(COALESCE(cs.active_lead_status_labels, '{}'::text[]))
                )`).join(' OR ')})`);
            }
            continue;
        }

        // ── campaign_count_all_time ────────────────────────────────────────
        if (fieldKey === 'campaign_count_all_time') {
            const ref = bindParam(Number(normalizedValue));
            const target = 'COALESCE(cs.campaign_count_all_time, 0)';
            if (operatorKey === 'eq') clauses.push(`${target} = ${ref}`);
            else if (operatorKey === 'neq') clauses.push(`${target} <> ${ref}`);
            else if (operatorKey === 'gt') clauses.push(`${target} > ${ref}`);
            else if (operatorKey === 'gte') clauses.push(`${target} >= ${ref}`);
            else if (operatorKey === 'lt') clauses.push(`${target} < ${ref}`);
            else if (operatorKey === 'lte') clauses.push(`${target} <= ${ref}`);
            continue;
        }

        // ── campaign_count_active ──────────────────────────────────────────
        if (fieldKey === 'campaign_count_active') {
            const ref = bindParam(Number(normalizedValue));
            const target = 'COALESCE(cs.campaign_count_active, 0)';
            if (operatorKey === 'eq') clauses.push(`${target} = ${ref}`);
            else if (operatorKey === 'neq') clauses.push(`${target} <> ${ref}`);
            else if (operatorKey === 'gt') clauses.push(`${target} > ${ref}`);
            else if (operatorKey === 'gte') clauses.push(`${target} >= ${ref}`);
            else if (operatorKey === 'lt') clauses.push(`${target} < ${ref}`);
            else if (operatorKey === 'lte') clauses.push(`${target} <= ${ref}`);
            continue;
        }

        // ── boolean insight fields (fi alias = filter_insights CTE) ───────
        if (fieldKey === 'uses_klaviyo' || fieldKey === 'uses_shopify' || fieldKey === 'discovery_call_held') {
            const col = `fi.${fieldKey}`;
            if (operatorKey === 'is_true') clauses.push(`${col} IS TRUE`);
            else if (operatorKey === 'is_false') clauses.push(`${col} IS FALSE`);
            else if (operatorKey === 'is_empty') clauses.push(`${col} IS NULL`);
            continue;
        }

        // ── numeric insight fields (fi alias) ──────────────────────────────
        if (fieldKey === 'annual_revenue_min' || fieldKey === 'annual_revenue_max') {
            const col = `fi.${fieldKey}`;
            if (operatorKey === 'gt') { const ref = bindParam(Number(normalizedValue)); clauses.push(`${col} > ${ref}`); }
            else if (operatorKey === 'gte') { const ref = bindParam(Number(normalizedValue)); clauses.push(`${col} >= ${ref}`); }
            else if (operatorKey === 'lt') { const ref = bindParam(Number(normalizedValue)); clauses.push(`${col} < ${ref}`); }
            else if (operatorKey === 'lte') { const ref = bindParam(Number(normalizedValue)); clauses.push(`${col} <= ${ref}`); }
            else if (operatorKey === 'is_empty') clauses.push(`${col} IS NULL`);
            else if (operatorKey === 'not_empty') clauses.push(`${col} IS NOT NULL`);
            continue;
        }
    }

    return clauses;
}

/**
 * GET /leads
 *
 * Fetch contacts (leads) for the authenticated agency with optional filtering.
 *
 * Query parameters:
 *   - clientId: Client slug to resolve to numeric SQL client_id (required)
 *   - emailStatus: Filter by single email_status (valid, valid-risky, invalid, etc.)
 *   - emailStatusMulti: Filter by multiple email statuses (comma-separated, e.g., "valid,valid-risky")
 *   - roleType: Filter by role type (founder, dm, etc.)
 *   - search: Search term for domain, email, or founder name (general search)
 *   - fullName: Specific full name search (contains, for segments)
 *   - founderFilter: Filter founder existence (exists, not_found)
 *   - emailFilter: Filter email existence (exists, not_found)
 *   - instantlyStatus: Filter by active Instantly campaign status/interest status label
 *   - filters: JSON array of dynamic filter clauses
 *   - jobId: Filter by exact job_id
 *   - createdAfter: Filter leads created after date (ISO 8601 format)
 *   - createdBefore: Filter leads created before date (ISO 8601 format)
 *   - limit: Max results (default 200, max 500)
 *   - offset: Pagination offset (default 0)
 *
 * Authorization: Bearer <idToken> (required)
 */
router.get('/leads', verifyFirebaseToken, async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const agencyId = req.agencyId;
        const {
            clientId: clientSlug,
            emailStatus,
            emailStatusMulti,
            roleType,
            search,
            fullName,
            founderFilter,
            emailFilter,
            instantlyStatus,
            filters: rawFilters,
            jobId,
            createdAfter,
            createdBefore,
            instantlyCampaignId,
            includeLatestEvent,
            includeTotal,
            countOnly,
            limit = 200,
            offset = 0
        } = req.query;

        if (!clientSlug) {
            return res.status(400).json({ error: 'clientId parameter is required' });
        }

        // Resolve client slug to numeric SQL ID
        let clientId;
        try {
            clientId = await queries.getOrCreateClient(agencyId, clientSlug);
        } catch (error) {
            console.error('Failed to resolve client ID:', error);
            return res.status(500).json({ error: 'Failed to resolve client ID' });
        }

        const parsedLimit = Math.min(parseInt(limit, 10) || 200, 5000);
        const parsedOffset = parseInt(offset, 10) || 0;
        const shouldIncludeLatestEvent = includeLatestEvent === 'true' || includeLatestEvent === '1';
        const shouldIncludeTotal = includeTotal === 'true' || includeTotal === '1';
        const isCountOnly = countOnly === 'true' || countOnly === '1';

        const { clauses: dynamicFilters } = parseLeadFiltersQuery(rawFilters);
        const rawSearchTerm = typeof search === 'string' ? search.trim() : '';
        const searchClassification = classifyLeadSearch(rawSearchTerm);
        // Honour an explicit override from the client (?searchField=email|domain|text)
        // but otherwise trust the classifier above.
        const explicitSearchField = typeof req.query.searchField === 'string'
            ? req.query.searchField.trim().toLowerCase()
            : '';
        let searchKind = searchClassification.kind;
        const searchValue = searchClassification.value;
        if (explicitSearchField === 'email' && searchValue) searchKind = 'email';
        else if (explicitSearchField === 'domain' && searchValue) searchKind = 'domain';
        else if (explicitSearchField === 'text' && searchValue) searchKind = 'text';
        const searchTerm = searchValue;
        const requiresFilterCampaignStats = leadFiltersRequireCampaignStats(dynamicFilters);
        const requiresFilterInsights = leadFiltersRequireInsights(dynamicFilters);
        const hasAnyLeadFilters = Boolean(
            emailStatus
            || emailStatusMulti
            || roleType
            || searchTerm
            || (typeof fullName === 'string' && fullName.trim())
            || founderFilter
            || emailFilter
            || instantlyStatus
            || (typeof jobId === 'string' && jobId.trim())
            || createdAfter
            || createdBefore
            || instantlyCampaignId
            || dynamicFilters.length > 0
        );

        // Build WHERE clause with filters
        let whereClause = 'c.agency_id = $1 AND c.client_id = $2';
        const paramsState = {
            params: [agencyId, clientId],
            paramIndex: 3
        };
        const params = paramsState.params;
        let paramIndex = paramsState.paramIndex;

        // Single email status filter
        if (emailStatus) {
            if (emailStatus === 'not_run') {
                whereClause += ` AND (c.email_status IS NULL OR c.email_status = '')`;
            } else {
                whereClause += ` AND c.email_status = $${paramIndex}`;
                params.push(emailStatus);
                paramIndex++;
            }
            paramsState.paramIndex = paramIndex;
        }

        // Multi-select email status filter (for segments)
        if (emailStatusMulti) {
            const statuses = emailStatusMulti.split(',').filter(s => s.trim());
            if (statuses.length > 0) {
                const placeholders = statuses.map((_, i) => `$${paramIndex + i}`).join(',');
                whereClause += ` AND c.email_status IN (${placeholders})`;
                params.push(...statuses);
                paramIndex += statuses.length;
                paramsState.paramIndex = paramIndex;
            }
        }

        if (roleType) {
            whereClause += ` AND c.role_type = $${paramIndex}`;
            params.push(roleType);
            paramIndex++;
            paramsState.paramIndex = paramIndex;
        }

        // General search filter. Routed to the most selective index based on
        // classifyLeadSearch() above:
        //   - email  -> (client_id, LOWER(email))      [idx_contacts_client_email_lower]
        //   - domain -> (client_id, domain_normalized) [idx_companies_client_domain]
        //   - text   -> trigram GIN on full_name + email
        if (searchTerm) {
            if (searchKind === 'email') {
                whereClause += ` AND LOWER(c.email) = $${paramIndex}`;
                params.push(searchTerm);
                paramIndex++;
            } else if (searchKind === 'domain') {
                whereClause += ` AND co.domain_normalized = $${paramIndex}`;
                params.push(searchTerm);
                paramIndex++;
            } else {
                // Free-text: use trigram-indexable LIKE on the columns most
                // likely to contain the token. We intentionally drop the
                // domain_normalized branch here — domain searches should be
                // routed via the domain classifier (or ?searchField=domain).
                whereClause += ` AND (
                    LOWER(c.full_name) LIKE $${paramIndex}
                    OR LOWER(c.email) LIKE $${paramIndex}
                )`;
                params.push(`%${searchTerm}%`);
                paramIndex++;
            }
            paramsState.paramIndex = paramIndex;
        }

        // Specific full name search (for segments)
        if (fullName) {
            const nameTerm = `%${fullName.toLowerCase()}%`;
            whereClause += ` AND LOWER(c.full_name) LIKE $${paramIndex}`;
            params.push(nameTerm);
            paramIndex++;
            paramsState.paramIndex = paramIndex;
        }

        // Filter by founder existence
        if (founderFilter === 'exists') {
            whereClause += ` AND c.full_name IS NOT NULL AND c.full_name != '' AND LOWER(c.full_name) NOT LIKE '%not found%' AND LOWER(c.full_name) != 'not_found'`;
        } else if (founderFilter === 'not_found') {
            whereClause += ` AND (c.full_name IS NULL OR c.full_name = '' OR LOWER(c.full_name) LIKE '%not found%' OR LOWER(c.full_name) = 'not_found')`;
        }

        // Filter by email discovery (not SMTP status)
        if (emailFilter === 'exists' || emailFilter === 'found') {
            const findClause = sqlEmailFindStateClause('found');
            if (findClause) whereClause += ` AND ${findClause}`;
        } else if (emailFilter === 'not_found') {
            const findClause = sqlEmailFindStateClause('not_found');
            if (findClause) whereClause += ` AND ${findClause}`;
        } else if (emailFilter === 'not_run') {
            const findClause = sqlEmailFindStateClause('not_run');
            if (findClause) whereClause += ` AND ${findClause}`;
        }

        if (typeof instantlyStatus === 'string' && instantlyStatus.trim()) {
            const normalizedInstantlyStatus = instantlyStatus.trim().toLowerCase();
            whereClause += ` AND EXISTS (
                SELECT 1
                FROM contact_instantly_campaigns cic_status
                WHERE cic_status.contact_id = c.id
                AND cic_status.active = TRUE
                AND (
                    LOWER(COALESCE(cic_status.interest_status_label, '')) = $${paramIndex}
                    OR LOWER(COALESCE(cic_status.lead_status_label, '')) = $${paramIndex}
                )
            )`;
            params.push(normalizedInstantlyStatus);
            paramIndex++;
            paramsState.paramIndex = paramIndex;
        }

        if (typeof jobId === 'string' && jobId.trim()) {
            whereClause += ` AND c.job_id = $${paramIndex}`;
            params.push(jobId.trim());
            paramIndex++;
            paramsState.paramIndex = paramIndex;
        }

        // Date filters
        if (createdAfter) {
            whereClause += ` AND c.created_at >= $${paramIndex}::timestamp`;
            params.push(createdAfter);
            paramIndex++;
            paramsState.paramIndex = paramIndex;
        }

        if (createdBefore) {
            whereClause += ` AND c.created_at <= $${paramIndex}::timestamp`;
            params.push(createdBefore);
            paramIndex++;
            paramsState.paramIndex = paramIndex;
        }

        let sqlInstantlyCampaignId = null;
        if (instantlyCampaignId) {
            const campaignResult = await pool.query(
                `SELECT id
                 FROM instantly_campaigns
                 WHERE agency_id = $1
                 AND client_id = $2
                 AND instantly_campaign_id = $3
                 LIMIT 1`,
                [agencyId, clientId, instantlyCampaignId]
            );

            sqlInstantlyCampaignId = campaignResult.rows[0]?.id || null;
            if (!sqlInstantlyCampaignId) {
                return res.json({
                    leads: [],
                    total: 0,
                    limit: parsedLimit,
                    offset: parsedOffset,
                    hasMore: false
                });
            }

            whereClause += ` AND EXISTS (
                SELECT 1
                FROM contact_instantly_campaigns cic_filter
                WHERE cic_filter.contact_id = c.id
                AND cic_filter.campaign_id = $${paramIndex}
                AND cic_filter.active = TRUE
            )`;
            params.push(sqlInstantlyCampaignId);
            paramIndex++;
            paramsState.paramIndex = paramIndex;
        }

        const dynamicClauses = buildDynamicLeadFilterClauses(dynamicFilters, paramsState);
        const dynamicWhere = joinDynamicClauses(dynamicClauses, dynamicFilters);
        if (dynamicWhere) {
            whereClause += ` AND ${dynamicWhere}`;
        }
        paramIndex = paramsState.paramIndex;

        const filterParams = [...params];
        const baseWithClause = `
            WITH scoped_companies AS (
                SELECT
                    id,
                    domain_normalized
                FROM companies
                WHERE agency_id = $1
                AND client_id = $2
            ),
            scoped_campaigns AS (
                SELECT
                    id,
                    instantly_campaign_id,
                    name
                FROM instantly_campaigns
                WHERE agency_id = $1
                AND client_id = $2
            )
            ${requiresFilterCampaignStats ? `,
            filter_campaign_stats AS (
                SELECT
                    cic.contact_id,
                    COUNT(DISTINCT cic.campaign_id)::int AS campaign_count_all_time,
                    COUNT(DISTINCT cic.campaign_id) FILTER (WHERE cic.active = TRUE)::int AS campaign_count_active,
                    MAX(cic.added_at) AS last_campaign_added_at,
                    MAX(cic.timestamp_last_reply) AS last_reply_at,
                    BOOL_OR(cic.email_reply_count > 0) AS has_replied,
                    ARRAY_REMOVE(
                        ARRAY_AGG(DISTINCT LOWER(cic.lead_status_label)) FILTER (
                            WHERE cic.active = TRUE
                            AND cic.lead_status_label IS NOT NULL
                        ),
                        NULL
                    ) AS active_lead_status_labels,
                    ARRAY_REMOVE(
                        ARRAY_AGG(DISTINCT LOWER(cic.interest_status_label)) FILTER (
                            WHERE cic.active = TRUE
                            AND cic.interest_status_label IS NOT NULL
                        ),
                        NULL
                    ) AS active_interest_status_labels
                FROM contact_instantly_campaigns cic
                JOIN scoped_campaigns sc_scope ON sc_scope.id = cic.campaign_id
                GROUP BY cic.contact_id
            )` : ''}
            ${requiresFilterInsights ? `,
            filter_insights AS (
                SELECT
                    contact_id,
                    uses_klaviyo,
                    uses_shopify,
                    discovery_call_held,
                    annual_revenue_min,
                    annual_revenue_max
                FROM contact_insights
                WHERE agency_id = $1
                AND client_id = $2
            )` : ''}
        `;
        const countQuery = `
            ${baseWithClause}
            SELECT COUNT(*) as count
            FROM contacts c
            JOIN scoped_companies co ON c.company_id = co.id
            ${requiresFilterCampaignStats ? 'LEFT JOIN filter_campaign_stats cs ON cs.contact_id = c.id' : ''}
            ${requiresFilterInsights ? 'LEFT JOIN filter_insights fi ON fi.contact_id = c.id' : ''}
            WHERE ${whereClause}
        `;

        if (isCountOnly && !hasAnyLeadFilters) {
            const simpleCountResult = await pool.query(
                `SELECT COUNT(*) as count
                 FROM contacts c
                 WHERE c.agency_id = $1
                 AND c.client_id = $2`,
                [agencyId, clientId]
            );
            const total = parseInt(simpleCountResult.rows[0]?.count || 0, 10);
            return res.json({
                leads: [],
                total,
                limit: parsedLimit,
                offset: parsedOffset,
                hasMore: false
            });
        }

        if (isCountOnly) {
            const countResult = await pool.query(countQuery, filterParams);
            const total = parseInt(countResult.rows[0]?.count || 0, 10);
            return res.json({
                leads: [],
                total,
                limit: parsedLimit,
                offset: parsedOffset,
                hasMore: false
            });
        }

        const pagedWithClause = `
            ${baseWithClause},
            paged_contacts AS (
                SELECT
                    c.id,
                    c.agency_id,
                    c.company_id,
                    c.role_type,
                    c.full_name,
                    c.email,
                    c.email_status,
                    c.email_find_completed_at,
                    c.email_verify_completed_at,
                    c.last_contacted_at,
                    c.confidence,
                    c.personalization_first_line,
                    c.job_id,
                    c.created_at,
                    c.updated_at,
                    co.domain_normalized
                    ${requiresFilterCampaignStats ? `,
                    cs.campaign_count_all_time,
                    cs.campaign_count_active,
                    cs.last_campaign_added_at` : ''}
                FROM contacts c
                JOIN scoped_companies co ON c.company_id = co.id
                ${requiresFilterCampaignStats ? 'LEFT JOIN filter_campaign_stats cs ON cs.contact_id = c.id' : ''}
                ${requiresFilterInsights ? 'LEFT JOIN filter_insights fi ON fi.contact_id = c.id' : ''}
                WHERE ${whereClause}
                ORDER BY ${requiresFilterCampaignStats ? 'cs.last_campaign_added_at DESC NULLS LAST, ' : ''}c.created_at DESC, c.id DESC
                LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
            ),
            paged_campaign_stats AS (
                SELECT
                    cic.contact_id,
                    COUNT(DISTINCT cic.campaign_id)::int AS campaign_count_all_time,
                    COUNT(DISTINCT cic.campaign_id) FILTER (WHERE cic.active = TRUE)::int AS campaign_count_active,
                    MAX(cic.added_at) AS last_campaign_added_at,
                    json_agg(
                        json_build_object(
                            'campaignId', sc_scope.instantly_campaign_id,
                            'campaignName', sc_scope.name,
                            'addedAt', cic.added_at,
                            'active', cic.active,
                            'lastReplyAt', cic.timestamp_last_reply,
                            'lastReplyCategory', cic.last_reply_category,
                            'leadStatus', cic.lead_status_label,
                            'interestStatus', cic.interest_status_label,
                            'lastSyncedAt', cic.last_synced_at,
                            'lastBounceAt', cic.last_bounce_at,
                            'timestampLastInterestChange', cic.timestamp_last_interest_change
                        )
                        ORDER BY COALESCE(cic.last_synced_at, cic.added_at) DESC NULLS LAST, cic.added_at DESC NULLS LAST
                    ) FILTER (WHERE cic.active = TRUE) AS campaigns_data
                FROM contact_instantly_campaigns cic
                JOIN scoped_campaigns sc_scope ON sc_scope.id = cic.campaign_id
                JOIN paged_contacts pc_scope ON pc_scope.id = cic.contact_id
                GROUP BY cic.contact_id
            )
        `;

        const latestEventSelect = shouldIncludeLatestEvent
            ? `
                le.event_type AS latest_event_type,
                le.reply_category AS latest_event_reply_category,
                le.message_text AS latest_event_message_text,
                le.reply_text_snippet AS latest_event_reply_text_snippet,
                le.event_timestamp AS latest_event_timestamp,
                le.email_account AS latest_event_email_account,
            `
            : '';

        const latestEventJoin = shouldIncludeLatestEvent
            ? `
            LEFT JOIN LATERAL (
                SELECT
                    cie.event_type,
                    cie.reply_category,
                    cie.message_text,
                    cie.reply_text_snippet,
                    cie.event_timestamp,
                    cie.email_account
                FROM contact_instantly_events cie
                WHERE cie.contact_id = pc.id
                ORDER BY cie.event_timestamp DESC NULLS LAST, cie.created_at DESC NULLS LAST, cie.id DESC
                LIMIT 1
            ) le ON TRUE`
            : '';

        // Fetch contacts with pagination and campaign data
        const contactsQuery = `
            ${pagedWithClause}
            SELECT
                pc.id,
                pc.agency_id,
                pc.company_id,
                pc.role_type,
                pc.full_name,
                pc.email,
                pc.email_status,
                pc.email_find_completed_at,
                pc.email_verify_completed_at,
                pc.last_contacted_at,
                pc.confidence,
                pc.personalization_first_line,
                pc.job_id,
                pc.created_at,
                pc.updated_at,
                pc.domain_normalized,
                ci.annual_revenue_text,
                ci.annual_revenue_min,
                ci.annual_revenue_max,
                ci.uses_klaviyo,
                ci.klaviyo_percent,
                ci.discovery_call_held,
                ci.last_discovery_call_at,
                ci.source AS insight_source,
                ci.notes AS insight_notes,
                ci.attributes AS insight_attributes,
                pcs.campaign_count_all_time,
                pcs.campaign_count_active,
                pcs.last_campaign_added_at,
                ${latestEventSelect}
                pcs.campaigns_data
            FROM paged_contacts pc
            LEFT JOIN paged_campaign_stats pcs ON pcs.contact_id = pc.id
            LEFT JOIN contact_insights ci ON ci.contact_id = pc.id
            ${latestEventJoin}
            ORDER BY ${requiresFilterCampaignStats ? 'pc.last_campaign_added_at DESC NULLS LAST, ' : ''}pc.created_at DESC, pc.id DESC
        `;
        params.push(parsedLimit + 1, parsedOffset);

        const result = await pool.query(contactsQuery, params);
        const hasMore = result.rows.length > parsedLimit;
        const pagedRows = hasMore ? result.rows.slice(0, parsedLimit) : result.rows;
        let total = null;

        if (shouldIncludeTotal) {
            const countResult = await pool.query(countQuery, filterParams);
            total = parseInt(countResult.rows[0]?.count || 0, 10);
        }

        const leads = pagedRows.map((row) => ({
            id: row.id,
            domain: row.domain_normalized,
            email: row.email,
            founderName: row.full_name,
            roleType: typeof row.role_type === 'string' && row.role_type.startsWith('instantly:')
                ? 'instantly_lead'
                : row.role_type,
            status: row.email_status,
            verified: row.email_status === 'valid',
            confidence: row.confidence,
            emailFindCompletedAt: row.email_find_completed_at,
            emailVerifyCompletedAt: row.email_verify_completed_at,
            lastContactedAt: row.last_contacted_at,
            firstLine: row.personalization_first_line,
            jobId: row.job_id,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            lastContactedAt: row.last_contacted_at,
            campaignCountAllTime: row.campaign_count_all_time,
            campaignCountActive: row.campaign_count_active,
            lastCampaignAddedAt: row.last_campaign_added_at,
            campaignsData: row.campaigns_data || [],
            latestEvent: row.latest_event_type
                ? {
                    eventType: row.latest_event_type,
                    replyCategory: row.latest_event_reply_category,
                    messageText: row.latest_event_message_text,
                    replyTextSnippet: row.latest_event_reply_text_snippet,
                    eventTimestamp: row.latest_event_timestamp,
                    emailAccount: row.latest_event_email_account
                }
                : null,
            insights: {
                annualRevenueText: row.annual_revenue_text,
                annualRevenueMin: row.annual_revenue_min,
                annualRevenueMax: row.annual_revenue_max,
                usesKlaviyo: row.uses_klaviyo,
                klaviyoPercent: row.klaviyo_percent,
                discoveryCallHeld: row.discovery_call_held,
                lastDiscoveryCallAt: row.last_discovery_call_at,
                source: row.insight_source,
                notes: row.insight_notes,
                attributes: row.insight_attributes || {}
            }
        }));

        res.json({
            leads,
            total,
            limit: parsedLimit,
            offset: parsedOffset,
            hasMore
        });
    } catch (error) {
        console.error('Error fetching leads:', error);
        res.status(error?.statusCode || 500).json({ error: error?.message || 'Failed to fetch leads' });
    }
});

router.get('/leads/filter-fields', verifyFirebaseToken, async (_req, res) => {
    res.json({
        fields: getLeadFilterFieldsPayload()
    });
});

/**
 * GET /leads/lookup
 *
 * Fast single-lead lookup for opening the lead detail panel from analytics/events.
 * Accepts either contactId or email (email is case-insensitive exact match).
 */
router.get('/leads/lookup', verifyFirebaseToken, async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const agencyId = req.agencyId;
        const clientSlug = typeof req.query.clientId === 'string' ? req.query.clientId.trim() : '';
        const contactIdRaw = typeof req.query.contactId === 'string' ? req.query.contactId.trim() : '';
        const emailRaw = typeof req.query.email === 'string' ? req.query.email.trim() : '';

        if (!clientSlug) {
            return res.status(400).json({ error: 'clientId parameter is required.' });
        }

        const parsedContactId = Number.parseInt(contactIdRaw, 10);
        const hasContactId = Number.isInteger(parsedContactId) && parsedContactId > 0;
        const normalizedEmail = emailRaw.toLowerCase();

        if (!hasContactId && !normalizedEmail) {
            return res.status(400).json({ error: 'contactId or email is required.' });
        }

        const clientId = await queries.getOrCreateClient(agencyId, clientSlug);

        const result = await pool.query(
            `SELECT
                c.id,
                c.role_type,
                c.full_name,
                c.email,
                c.email_status,
                c.email_find_completed_at,
                c.email_verify_completed_at,
                c.last_contacted_at,
                c.confidence,
                c.personalization_first_line,
                c.job_id,
                c.created_at,
                c.updated_at,
                co.domain_normalized,
                ci.annual_revenue_text,
                ci.annual_revenue_min,
                ci.annual_revenue_max,
                ci.uses_klaviyo,
                ci.klaviyo_percent,
                ci.discovery_call_held,
                ci.last_discovery_call_at,
                ci.source AS insight_source,
                ci.notes AS insight_notes,
                ci.attributes AS insight_attributes,
                (
                    SELECT COUNT(*)::int
                    FROM contact_instantly_campaigns cic_count
                    WHERE cic_count.contact_id = c.id
                ) AS campaign_count_all_time,
                (
                    SELECT COUNT(*)::int
                    FROM contact_instantly_campaigns cic_count
                    WHERE cic_count.contact_id = c.id
                      AND cic_count.active = TRUE
                ) AS campaign_count_active,
                (
                    SELECT MAX(cic_count.added_at)
                    FROM contact_instantly_campaigns cic_count
                    WHERE cic_count.contact_id = c.id
                      AND cic_count.active = TRUE
                ) AS last_campaign_added_at,
                (
                    SELECT json_agg(
                        json_build_object(
                            'campaignId', ic.instantly_campaign_id,
                            'campaignName', ic.name,
                            'addedAt', cic.added_at,
                            'active', cic.active,
                            'lastReplyAt', cic.timestamp_last_reply,
                            'lastReplyCategory', cic.last_reply_category,
                            'leadStatus', cic.lead_status_label,
                            'interestStatus', cic.interest_status_label,
                            'lastSyncedAt', cic.last_synced_at,
                            'lastBounceAt', cic.last_bounce_at,
                            'timestampLastInterestChange', cic.timestamp_last_interest_change
                        )
                        ORDER BY COALESCE(cic.last_synced_at, cic.added_at) DESC NULLS LAST, cic.added_at DESC NULLS LAST
                    )
                    FROM contact_instantly_campaigns cic
                    JOIN instantly_campaigns ic ON ic.id = cic.campaign_id
                    WHERE cic.contact_id = c.id
                      AND cic.active = TRUE
                ) AS campaigns_data
             FROM contacts c
             JOIN companies co ON co.id = c.company_id
             LEFT JOIN contact_insights ci ON ci.contact_id = c.id
             WHERE c.agency_id = $1
               AND c.client_id = $2
               AND (
                   ($3::bigint IS NOT NULL AND c.id = $3)
                   OR ($4::text IS NOT NULL AND LOWER(c.email) = $4)
               )
             LIMIT 1`,
            [
                agencyId,
                clientId,
                hasContactId ? parsedContactId : null,
                normalizedEmail || null
            ]
        );

        const row = result.rows[0];
        if (!row) {
            return res.status(404).json({ error: 'Lead not found.' });
        }

        res.json({
            lead: {
                id: row.id,
                domain: row.domain_normalized,
                email: row.email,
                founderName: row.full_name,
                roleType: typeof row.role_type === 'string' && row.role_type.startsWith('instantly:')
                    ? 'instantly_lead'
                    : row.role_type,
                status: row.email_status,
                verified: row.email_status === 'valid',
                confidence: row.confidence,
                emailFindCompletedAt: row.email_find_completed_at,
                emailVerifyCompletedAt: row.email_verify_completed_at,
                lastContactedAt: row.last_contacted_at,
                firstLine: row.personalization_first_line,
                jobId: row.job_id,
                createdAt: row.created_at,
                updatedAt: row.updated_at,
                campaignCountAllTime: row.campaign_count_all_time,
                campaignCountActive: row.campaign_count_active,
                lastCampaignAddedAt: row.last_campaign_added_at,
                campaignsData: row.campaigns_data || [],
                latestEvent: null,
                insights: {
                    annualRevenueText: row.annual_revenue_text,
                    annualRevenueMin: row.annual_revenue_min,
                    annualRevenueMax: row.annual_revenue_max,
                    usesKlaviyo: row.uses_klaviyo,
                    klaviyoPercent: row.klaviyo_percent,
                    discoveryCallHeld: row.discovery_call_held,
                    lastDiscoveryCallAt: row.last_discovery_call_at,
                    source: row.insight_source,
                    notes: row.insight_notes,
                    attributes: row.insight_attributes || {}
                }
            }
        });
    } catch (error) {
        console.error('Error looking up lead:', error);
        res.status(error?.statusCode || 500).json({ error: error?.message || 'Failed to look up lead.' });
    }
});

/**
 * POST /leads/mark-sent
 *
 * Mark contacts as sent/exported by updating last_contacted_at.
 * This is the send-safety guardrail to prevent accidental resends.
 *
 * Request body:
 *   - contactIds: Array of contact IDs to mark as sent
 *   - emails: Array of email addresses to mark as sent (alternative)
 *
 * Authorization: Bearer <idToken> (required)
 */
router.post('/leads/mark-sent', verifyFirebaseToken, async (req, res) => {
    try {
        const agencyId = req.agencyId;
        const { contactIds, emails } = req.body || {};

        if (contactIds && Array.isArray(contactIds) && contactIds.length > 0) {
            const updated = await leadsService.markContactsAsSent(agencyId, contactIds);
            return res.json({
                count: updated.length,
                contacts: updated,
                method: 'contact_ids'
            });
        }

        if (emails && Array.isArray(emails) && emails.length > 0) {
            const updated = await leadsService.markEmailsAsSent(agencyId, emails);
            return res.json({
                count: updated.length,
                contacts: updated,
                method: 'emails'
            });
        }

        res.status(400).json({ error: 'contactIds or emails must be provided as non-empty arrays' });
    } catch (error) {
        console.error('Error marking contacts as sent:', error);
        res.status(500).json({ error: 'Failed to mark contacts as sent' });
    }
});

/**
 * GET /leads/companies
 *
 * Fetch companies (domains) for the authenticated agency with contact counts.
 *
 * Query parameters:
 *   - limit: Max results (default 500, max 1000)
 *   - offset: Pagination offset (default 0)
 *
 * Authorization: Bearer <idToken> (required)
 */
router.get('/leads/companies', verifyFirebaseToken, async (req, res) => {
    try {
        const agencyId = req.agencyId;
        const { limit = 500, offset = 0 } = req.query;

        const parsedLimit = Math.min(parseInt(limit, 10) || 500, 1000);
        const parsedOffset = parseInt(offset, 10) || 0;

        const companies = await leadsService.getCompaniesForAgency(agencyId, { limit: parsedLimit, offset: parsedOffset });

        // Get total count
        const countResult = await queries.pool.query(
            `SELECT COUNT(*) as count FROM companies WHERE agency_id = $1`,
            [agencyId]
        );
        const total = parseInt(countResult.rows[0]?.count || 0, 10);

        res.json({
            companies,
            total,
            limit: parsedLimit,
            offset: parsedOffset,
            hasMore: parsedOffset + parsedLimit < total
        });
    } catch (error) {
        console.error('Error fetching companies:', error);
        res.status(500).json({ error: 'Failed to fetch companies' });
    }
});

/**
 * GET /leads/stats
 *
 * Get summary statistics for authenticated agency's leads.
 *
 * Returns:
 *   - total_contacts: Total number of contacts
 *   - total_companies: Total number of unique companies
 *   - verified_emails: Contacts with valid email status
 *   - contacted_count: Contacts that have been sent to
 *   - untouched_count: Contacts never sent to
 *
 * Authorization: Bearer <idToken> (required)
 */
router.get('/leads/stats', verifyFirebaseToken, async (req, res) => {
    try {
        const agencyId = req.agencyId;
        const stats = await leadsService.getLeadStats(agencyId);

        res.json({
            stats,
            agencyId: req.auth.agencyId,
            email: req.auth.email
        });
    } catch (error) {
        console.error('Error fetching lead stats:', error);
        res.status(500).json({ error: 'Failed to fetch lead stats' });
    }
});

/**
 * GET /stats/companies-count
 *
 * Get total company count for authenticated agency.
 *
 * Returns:
 *   - count: Total number of companies
 *
 * Authorization: Bearer <idToken> (required)
 */
router.get('/stats/companies-count', verifyFirebaseToken, async (req, res) => {
    try {
        const agencyId = req.agencyId;
        const clientSlug = typeof req.query.clientId === 'string' ? req.query.clientId.trim() : '';
        const clientName = typeof req.query.clientName === 'string' ? req.query.clientName.trim() : '';
        const matchers = buildClientMatchers(clientSlug, clientName);
        console.log('[stats/companies-count] request', {
            agencyId,
            clientSlug,
            clientName,
            textVariants: matchers.textVariants,
            slugVariants: matchers.slugVariants,
            compactVariants: matchers.compactVariants
        });

        if (clientSlug) {
            const matchedResult = await pool.query(
                `
                    WITH client_candidates AS (
                        SELECT
                            id,
                            name,
                            LOWER(name) AS lower_name,
                            REPLACE(REPLACE(LOWER(name), '%40', '@'), '%2e', '.') AS decoded_name,
                            REGEXP_REPLACE(LOWER(name), '[^a-z0-9]+', '-', 'g') AS slug_name,
                            REGEXP_REPLACE(LOWER(name), '[^a-z0-9]+', '', 'g') AS compact_name,
                            REGEXP_REPLACE(REPLACE(REPLACE(LOWER(name), '%40', '@'), '%2e', '.'), '[^a-z0-9]+', '-', 'g') AS decoded_slug_name,
                            REGEXP_REPLACE(REPLACE(REPLACE(LOWER(name), '%40', '@'), '%2e', '.'), '[^a-z0-9]+', '', 'g') AS decoded_compact_name
                        FROM clients
                        WHERE agency_id = $1
                    ),
                    matched_clients AS (
                        SELECT id, name
                        FROM client_candidates
                        WHERE
                            lower_name = ANY($2::text[])
                            OR decoded_name = ANY($2::text[])
                            OR slug_name = ANY($3::text[])
                            OR decoded_slug_name = ANY($3::text[])
                            OR compact_name = ANY($4::text[])
                            OR decoded_compact_name = ANY($4::text[])
                    )
                    SELECT
                        COUNT(co.id)::int AS count,
                        COALESCE(
                            json_agg(
                                DISTINCT jsonb_build_object(
                                    'id', mc.id,
                                    'name', mc.name
                                )
                            ) FILTER (WHERE mc.id IS NOT NULL),
                            '[]'::json
                        ) AS matched_clients
                    FROM matched_clients mc
                    LEFT JOIN companies co
                        ON co.client_id = mc.id
                       AND co.agency_id = $1
                `,
                [agencyId, matchers.textVariants, matchers.slugVariants, matchers.compactVariants]
            );

            const matchedPayload = matchedResult.rows[0] || {};
            const count = parseInt(matchedPayload.count || 0, 10);
            const matchedClients = Array.isArray(matchedPayload.matched_clients)
                ? matchedPayload.matched_clients
                : [];

            if (matchedClients.length === 0) {
                const topClientsResult = await pool.query(
                    `
                        SELECT
                            cl.id,
                            cl.name,
                            COUNT(co.id)::int AS company_count
                        FROM clients cl
                        LEFT JOIN companies co
                            ON co.client_id = cl.id
                           AND co.agency_id = $1
                        WHERE cl.agency_id = $1
                        GROUP BY cl.id, cl.name
                        ORDER BY company_count DESC, cl.name ASC
                        LIMIT 10
                    `,
                    [agencyId]
                );
                console.warn('[stats/companies-count] no SQL client match', {
                    agencyId,
                    clientSlug,
                    clientName,
                    textVariants: matchers.textVariants,
                    slugVariants: matchers.slugVariants,
                    compactVariants: matchers.compactVariants,
                    topClients: topClientsResult.rows
                });
                return res.json({
                    count: 0,
                    clientId: clientSlug,
                    matchedClients: [],
                    debug: {
                        reason: 'no_sql_client_match',
                        topClients: topClientsResult.rows
                    }
                });
            }

            console.log('[stats/companies-count] scoped result', {
                agencyId,
                clientSlug,
                clientName,
                matchedClients,
                count,
            });
            return res.json({
                count,
                clientId: clientSlug,
                matchedClients
            });
        }

        const countResult = await pool.query(
            `SELECT COUNT(*) as count FROM companies WHERE agency_id = $1`,
            [agencyId]
        );

        const count = parseInt(countResult.rows[0]?.count || 0, 10);
        console.log('[stats/companies-count] agency-wide result', {
            agencyId,
            count
        });
        res.json({ count });
    } catch (error) {
        console.error('Error fetching companies count:', error);
        res.status(500).json({ error: 'Failed to fetch companies count' });
    }
});

/**
 * GET /stats/companies-counts
 *
 * Get company counts for multiple client slugs in one request.
 *
 * Query parameters:
 *   - clientIds: Comma-separated client slugs (required)
 *
 * Returns:
 *   - counts: Object map of { [clientSlug]: number }
 *
 * Authorization: Bearer <idToken> (required)
 */
router.get('/stats/companies-counts', verifyFirebaseToken, async (req, res) => {
    try {
        const agencyId = req.agencyId;
        const rawClientIds = typeof req.query.clientIds === 'string'
            ? req.query.clientIds
            : Array.isArray(req.query.clientIds)
                ? req.query.clientIds.join(',')
                : '';

        const clientSlugs = [...new Set(
            rawClientIds
                .split(',')
                .map((value) => value.trim())
                .filter(Boolean)
        )];

        if (clientSlugs.length === 0) {
            return res.json({ counts: {} });
        }

        const result = await pool.query(
            `
                SELECT
                    cl.id,
                    cl.name AS client_name,
                    COUNT(co.id)::int AS count
                FROM clients cl
                LEFT JOIN companies co
                    ON co.client_id = cl.id
                    AND co.agency_id = $1
                WHERE cl.agency_id = $1
                GROUP BY cl.id, cl.name
            `,
            [agencyId]
        );

        const counts = clientSlugs.reduce((acc, slug) => {
            acc[slug] = 0;
            return acc;
        }, {});

        const requestedMatchers = clientSlugs.map((slug) => ({
            slug,
            matchers: buildClientMatchers(slug)
        }));
        const sqlClients = result.rows.map((row) => ({
            id: row.id,
            name: row.client_name,
            count: Number(row.count) || 0,
            matchers: buildClientMatchers(row.client_name)
        }));

        for (const requested of requestedMatchers) {
            let totalCount = 0;
            for (const sqlClient of sqlClients) {
                if (clientMatchersOverlap(requested.matchers, sqlClient.matchers)) {
                    totalCount += sqlClient.count;
                }
            }
            counts[requested.slug] = totalCount;
        }

        const unmatched = requestedMatchers
            .filter((requested) => counts[requested.slug] === 0)
            .map((requested) => requested.slug);
        if (unmatched.length > 0) {
            console.warn('[stats/companies-counts] unmatched slugs', {
                agencyId,
                unmatched,
                topClients: sqlClients
                    .sort((a, b) => b.count - a.count)
                    .slice(0, 10)
                    .map((client) => ({
                        id: client.id,
                        name: client.name,
                        company_count: client.count
                    }))
            });
        }

        res.json({ counts });
    } catch (error) {
        console.error('Error fetching companies counts by client:', error);
        res.status(500).json({ error: 'Failed to fetch companies counts' });
    }
});

/**
 * GET /instantly-campaigns
 *
 * Fetch Instantly campaigns for a specific client.
 *
 * Query parameters:
 *   - clientId: Client slug to resolve to numeric SQL client_id (required)
 *
 * Returns:
 *   - campaigns: Array of { id: instantly_campaign_id, name: campaign_name }
 *
 * Authorization: Bearer <idToken> (required)
 */
router.get('/instantly-campaigns', verifyFirebaseToken, async (req, res) => {
    try {
        const agencyId = req.agencyId;
        const { clientId: clientSlug } = req.query;

        if (!clientSlug) {
            return res.status(400).json({ error: 'clientId parameter is required' });
        }

        // Resolve client slug to numeric SQL ID
        let clientId;
        try {
            clientId = await queries.getOrCreateClient(agencyId, clientSlug);
        } catch (error) {
            console.error('Failed to resolve client ID:', error);
            return res.status(500).json({ error: 'Failed to resolve client ID' });
        }

        // Fetch campaigns from instantly_campaigns table
        const campaignsQuery = `
            SELECT 
                instantly_campaign_id as id,
                name
            FROM instantly_campaigns
            WHERE agency_id = $1 AND client_id = $2
            ORDER BY created_at DESC
        `;

        const result = await pool.query(campaignsQuery, [agencyId, clientId]);

        res.json({
            campaigns: result.rows
        });
    } catch (error) {
        console.error('Error fetching instantly campaigns:', error);
        res.status(500).json({ error: 'Failed to fetch campaigns' });
    }
});

router.get('/leads/:contactId/events', verifyFirebaseToken, async (req, res) => {
    try {
        const agencyId = req.agencyId;
        const contactId = Number.parseInt(req.params.contactId, 10);
        const limit = Math.min(Number.parseInt(req.query.limit, 10) || 50, 200);

        if (!Number.isInteger(contactId) || contactId <= 0) {
            return res.status(400).json({ error: 'Valid contactId is required.' });
        }

        const result = await pool.query(
            `WITH timeline_events AS (
                SELECT
                    cie.id::text AS id,
                    cie.event_type,
                    cie.reply_category,
                    cie.instantly_campaign_id,
                    ic.name AS campaign_name,
                    cie.instantly_lead_id,
                    cie.lead_email,
                    cie.email_account,
                    cie.unibox_url,
                    cie.step,
                    cie.variant,
                    cie.message_text,
                    cie.reply_text_snippet,
                    cie.event_timestamp,
                    cie.source,
                    cie.payload,
                    cie.created_at
                FROM contact_instantly_events cie
                JOIN contacts c ON c.id = cie.contact_id
                LEFT JOIN instantly_campaigns ic ON ic.id = cie.campaign_id
                WHERE cie.contact_id = $1
                AND c.agency_id = $2

                UNION ALL

                SELECT
                    CONCAT('campaign-link:', cic.contact_id, ':', cic.campaign_id) AS id,
                    'added_to_campaign' AS event_type,
                    NULL::text AS reply_category,
                    ic.instantly_campaign_id,
                    ic.name AS campaign_name,
                    cic.instantly_lead_id,
                    c.email AS lead_email,
                    NULL::text AS email_account,
                    NULL::text AS unibox_url,
                    NULL::integer AS step,
                    NULL::integer AS variant,
                    COALESCE(
                        NULLIF(BTRIM(cic.notes), ''),
                        CONCAT('Added to campaign via ', REPLACE(cic.upload_source, '_', ' '))
                    ) AS message_text,
                    NULL::text AS reply_text_snippet,
                    cic.added_at AS event_timestamp,
                    'campaign_link' AS source,
                    jsonb_build_object(
                        'upload_source', cic.upload_source,
                        'uploaded_by', cic.uploaded_by,
                        'job_id', cic.job_id,
                        'notes', cic.notes,
                        'active', cic.active,
                        'removed_at', cic.removed_at
                    ) AS payload,
                    cic.added_at AS created_at
                FROM contact_instantly_campaigns cic
                JOIN contacts c ON c.id = cic.contact_id
                LEFT JOIN instantly_campaigns ic ON ic.id = cic.campaign_id
                WHERE cic.contact_id = $1
                AND c.agency_id = $2
                AND cic.added_at IS NOT NULL
            )
            SELECT
                id,
                event_type,
                reply_category,
                instantly_campaign_id,
                campaign_name,
                instantly_lead_id,
                lead_email,
                email_account,
                unibox_url,
                step,
                variant,
                message_text,
                reply_text_snippet,
                event_timestamp,
                source,
                payload,
                created_at
            FROM timeline_events
            ORDER BY event_timestamp DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
            LIMIT $3`,
            [contactId, agencyId, limit]
        );

        res.json({ events: result.rows });
    } catch (error) {
        console.error('Error fetching lead events:', error);
        res.status(500).json({ error: 'Failed to fetch lead events' });
    }
});

/**
 * POST /leads/insights/klaviyo
 *
 * Bulk-run Klaviyo detection for domains and persist result to contact_insights.uses_klaviyo.
 *
 * Request body:
 *   - clientId: string (required)
 *   - domains: string[] (optional)
 *   - leads: Array<{ domain: string }> (optional)
 *   - concurrency: number (optional, default 50, max 100)
 *   - onlyNullUsesKlaviyo: boolean (optional, default false)
 *
 * At least one of domains or leads must be supplied.
 */
router.post('/leads/insights/klaviyo', verifyFirebaseToken, async (req, res) => {
    try {
        const agencyId = req.agencyId;
        const clientSlug = typeof req.body?.clientId === 'string' ? req.body.clientId.trim() : '';
        if (!clientSlug) {
            return res.status(400).json({ error: 'clientId is required.' });
        }

        const domains = extractNormalizedDomains(req.body);
        if (domains.length === 0) {
            return res.status(400).json({
                error: 'Provide at least one domain via domains[] or leads[].'
            });
        }
        if (domains.length > 1000) {
            return res.status(400).json({
                error: 'Maximum 1000 domains per request.'
            });
        }

        const requestedConcurrency = Number(req.body?.concurrency);
        const concurrency = Number.isFinite(requestedConcurrency)
            ? Math.max(1, Math.min(Math.floor(requestedConcurrency), 100))
            : 50;
        const onlyNullUsesKlaviyo = normalizeOptionalBoolean(req.body?.onlyNullUsesKlaviyo) === true;
        const summary = await runKlaviyoInsightsSync({
            agencyId,
            clientSlug,
            domains,
            concurrency,
            onlyNullUsesKlaviyo
        });

        return res.json(summary);
    } catch (error) {
        console.error('Error running bulk Klaviyo insights sync:', error);
        return res.status(500).json({
            error: error?.message || 'Failed to sync Klaviyo insights.'
        });
    }
});

router.post('/leads/insights/klaviyo/query', verifyFirebaseToken, async (req, res) => {
    try {
        const agencyId = req.agencyId;
        const clientSlug = typeof req.body?.clientId === 'string' ? req.body.clientId.trim() : '';
        if (!clientSlug) {
            return res.status(400).json({ error: 'clientId is required.' });
        }

        const requestedConcurrency = Number(req.body?.concurrency);
        const concurrency = Number.isFinite(requestedConcurrency)
            ? Math.max(1, Math.min(Math.floor(requestedConcurrency), 100))
            : 50;
        const onlyNullUsesKlaviyo = normalizeOptionalBoolean(req.body?.onlyNullUsesKlaviyo) !== false;
        const queryInput = req.body?.query || {};

        const clientId = await queries.getOrCreateClient(agencyId, clientSlug);
        const {
            emailStatus,
            emailStatusMulti,
            roleType,
            search,
            fullName,
            founderFilter,
            emailFilter,
            instantlyStatus,
            jobId,
            createdAfter,
            createdBefore,
            instantlyCampaignId
        } = queryInput;

        let dynamicFilters = [];
        const rawFiltersInput = queryInput?.filters;
        if (Array.isArray(rawFiltersInput)) {
            dynamicFilters = rawFiltersInput.slice(0, 25).map((c) => ({ ...c, joinOp: 'AND' }));
        } else if (rawFiltersInput && typeof rawFiltersInput === 'object') {
            const parsed = rawFiltersInput.clauses
                ? rawFiltersInput  // already { clauses } format
                : { clauses: [] };
            dynamicFilters = Array.isArray(parsed.clauses)
                ? parsed.clauses.slice(0, 25).map((c) => ({
                    ...c,
                    joinOp: String(c.joinOp || parsed.logic || 'AND').toUpperCase() === 'OR' ? 'OR' : 'AND'
                }))
                : [];
        } else if (typeof rawFiltersInput === 'string') {
            dynamicFilters = parseLeadFiltersQuery(rawFiltersInput).clauses;
        }

        let whereClause = 'c.agency_id = $1 AND c.client_id = $2';
        const paramsState = {
            params: [agencyId, clientId],
            paramIndex: 3
        };
        const params = paramsState.params;
        let paramIndex = paramsState.paramIndex;

        if (emailStatus) {
            if (emailStatus === 'not_run') {
                whereClause += ` AND (c.email_status IS NULL OR c.email_status = '')`;
            } else {
                whereClause += ` AND c.email_status = $${paramIndex}`;
                params.push(emailStatus);
                paramIndex++;
            }
            paramsState.paramIndex = paramIndex;
        }

        if (emailStatusMulti) {
            const statuses = String(emailStatusMulti).split(',').filter((s) => s.trim());
            if (statuses.length > 0) {
                const placeholders = statuses.map((_, i) => `$${paramIndex + i}`).join(',');
                whereClause += ` AND c.email_status IN (${placeholders})`;
                params.push(...statuses);
                paramIndex += statuses.length;
                paramsState.paramIndex = paramIndex;
            }
        }

        if (roleType) {
            whereClause += ` AND c.role_type = $${paramIndex}`;
            params.push(roleType);
            paramIndex++;
            paramsState.paramIndex = paramIndex;
        }

        if (search) {
            const searchTerm = String(search).toLowerCase().trim();
            whereClause += ` AND (
                LOWER(co.domain_normalized) = $${paramIndex}
                OR LOWER(c.email) = $${paramIndex}
                OR LOWER(c.full_name) = $${paramIndex}
            )`;
            params.push(searchTerm);
            paramIndex++;
            paramsState.paramIndex = paramIndex;
        }

        if (fullName) {
            const nameTerm = `%${String(fullName).toLowerCase()}%`;
            whereClause += ` AND LOWER(c.full_name) LIKE $${paramIndex}`;
            params.push(nameTerm);
            paramIndex++;
            paramsState.paramIndex = paramIndex;
        }

        if (founderFilter === 'exists') {
            whereClause += ` AND c.full_name IS NOT NULL AND c.full_name != '' AND LOWER(c.full_name) NOT LIKE '%not found%' AND LOWER(c.full_name) != 'not_found'`;
        } else if (founderFilter === 'not_found') {
            whereClause += ` AND (c.full_name IS NULL OR c.full_name = '' OR LOWER(c.full_name) LIKE '%not found%' OR LOWER(c.full_name) = 'not_found')`;
        }

        if (emailFilter === 'exists' || emailFilter === 'found') {
            const findClause = sqlEmailFindStateClause('found');
            if (findClause) whereClause += ` AND ${findClause}`;
        } else if (emailFilter === 'not_found') {
            const findClause = sqlEmailFindStateClause('not_found');
            if (findClause) whereClause += ` AND ${findClause}`;
        } else if (emailFilter === 'not_run') {
            const findClause = sqlEmailFindStateClause('not_run');
            if (findClause) whereClause += ` AND ${findClause}`;
        }

        if (typeof instantlyStatus === 'string' && instantlyStatus.trim()) {
            const normalizedInstantlyStatus = instantlyStatus.trim().toLowerCase();
            whereClause += ` AND EXISTS (
                SELECT 1
                FROM contact_instantly_campaigns cic_status
                WHERE cic_status.contact_id = c.id
                AND cic_status.active = TRUE
                AND (
                    LOWER(COALESCE(cic_status.interest_status_label, '')) = $${paramIndex}
                    OR LOWER(COALESCE(cic_status.lead_status_label, '')) = $${paramIndex}
                )
            )`;
            params.push(normalizedInstantlyStatus);
            paramIndex++;
            paramsState.paramIndex = paramIndex;
        }

        if (typeof jobId === 'string' && jobId.trim()) {
            whereClause += ` AND c.job_id = $${paramIndex}`;
            params.push(jobId.trim());
            paramIndex++;
            paramsState.paramIndex = paramIndex;
        }

        if (createdAfter) {
            whereClause += ` AND c.created_at >= $${paramIndex}::timestamp`;
            params.push(createdAfter);
            paramIndex++;
            paramsState.paramIndex = paramIndex;
        }

        if (createdBefore) {
            whereClause += ` AND c.created_at <= $${paramIndex}::timestamp`;
            params.push(createdBefore);
            paramIndex++;
            paramsState.paramIndex = paramIndex;
        }

        if (instantlyCampaignId) {
            const campaignResult = await pool.query(
                `SELECT id
                 FROM instantly_campaigns
                 WHERE agency_id = $1
                 AND client_id = $2
                 AND instantly_campaign_id = $3
                 LIMIT 1`,
                [agencyId, clientId, instantlyCampaignId]
            );

            const sqlInstantlyCampaignId = campaignResult.rows[0]?.id || null;
            if (!sqlInstantlyCampaignId) {
                return res.json({
                    clientId: clientSlug,
                    requestedDomainCount: 0,
                    checkedDomainCount: 0,
                    skippedAlreadyScoredCount: 0,
                    matchedDomainCount: 0,
                    matchedContactCount: 0,
                    upsertedCount: 0,
                    klaviyoDetectedCount: 0,
                    klaviyoDetectedDomains: [],
                    unresolvedDomains: [],
                    notFoundDomains: []
                });
            }

            whereClause += ` AND EXISTS (
                SELECT 1
                FROM contact_instantly_campaigns cic_filter
                WHERE cic_filter.contact_id = c.id
                AND cic_filter.campaign_id = $${paramIndex}
                AND cic_filter.active = TRUE
            )`;
            params.push(sqlInstantlyCampaignId);
            paramIndex++;
            paramsState.paramIndex = paramIndex;
        }

        const dynamicClauses = buildDynamicLeadFilterClauses(dynamicFilters, paramsState);
        const dynamicWhere = joinDynamicClauses(dynamicClauses, dynamicFilters);
        if (dynamicWhere) {
            whereClause += ` AND ${dynamicWhere}`;
        }

        const requiresKlaviyoCampaignStats = leadFiltersRequireCampaignStats(dynamicFilters);
        const requiresKlaviyoInsights = leadFiltersRequireInsights(dynamicFilters);
        const domainResult = await pool.query(
            `WITH scoped_companies AS (
                SELECT
                    id,
                    domain_normalized
                FROM companies
                WHERE agency_id = $1
                AND client_id = $2
            ),
            scoped_campaigns AS (
                SELECT
                    id,
                    instantly_campaign_id,
                    name
                FROM instantly_campaigns
                WHERE agency_id = $1
                AND client_id = $2
            ),
            campaign_stats AS (
                SELECT
                    cic.contact_id,
                    COUNT(DISTINCT cic.campaign_id)::int AS campaign_count_all_time,
                    COUNT(DISTINCT cic.campaign_id) FILTER (WHERE cic.active = TRUE)::int AS campaign_count_active,
                    MAX(cic.added_at) AS last_campaign_added_at,
                    MAX(cic.timestamp_last_reply) AS last_reply_at,
                    BOOL_OR(cic.email_reply_count > 0) AS has_replied,
                    ARRAY_REMOVE(
                        ARRAY_AGG(DISTINCT LOWER(cic.lead_status_label)) FILTER (
                            WHERE cic.active = TRUE
                            AND cic.lead_status_label IS NOT NULL
                        ),
                        NULL
                    ) AS active_lead_status_labels,
                    ARRAY_REMOVE(
                        ARRAY_AGG(DISTINCT LOWER(cic.interest_status_label)) FILTER (
                            WHERE cic.active = TRUE
                            AND cic.interest_status_label IS NOT NULL
                        ),
                        NULL
                    ) AS active_interest_status_labels
                FROM contact_instantly_campaigns cic
                JOIN scoped_campaigns sc_scope ON sc_scope.id = cic.campaign_id
                GROUP BY cic.contact_id
            )
            ${requiresKlaviyoInsights ? `,
            filter_insights AS (
                SELECT
                    contact_id,
                    uses_klaviyo,
                    uses_shopify,
                    discovery_call_held,
                    annual_revenue_min,
                    annual_revenue_max
                FROM contact_insights
                WHERE agency_id = $1
                AND client_id = $2
            )` : ''}
            SELECT DISTINCT co.domain_normalized AS domain
            FROM contacts c
            JOIN scoped_companies co ON c.company_id = co.id
            LEFT JOIN campaign_stats cs ON cs.contact_id = c.id
            ${requiresKlaviyoInsights ? 'LEFT JOIN filter_insights fi ON fi.contact_id = c.id' : ''}
            WHERE ${whereClause}`,
            paramsState.params
        );

        const domains = Array.from(new Set(
            domainResult.rows
                .map((row) => String(row.domain || '').trim())
                .filter(Boolean)
        ));

        const summary = await runKlaviyoInsightsSync({
            agencyId,
            clientSlug,
            domains,
            concurrency,
            onlyNullUsesKlaviyo
        });

        return res.json({
            ...summary,
            queryMatchedDomainCount: domains.length
        });
    } catch (error) {
        console.error('Error running query-based Klaviyo insights sync:', error);
        return res.status(500).json({
            error: error?.message || 'Failed to sync Klaviyo insights for query.'
        });
    }
});

router.post('/leads/:contactId/insights', verifyFirebaseToken, async (req, res) => {
    try {
        const agencyId = req.agencyId;
        const contactId = Number.parseInt(req.params.contactId, 10);

        if (!Number.isInteger(contactId) || contactId <= 0) {
            return res.status(400).json({ error: 'Valid contactId is required.' });
        }

        const annualRevenueText = normalizeOptionalText(req.body?.annualRevenueText);
        const annualRevenueMin = normalizeOptionalNumber(req.body?.annualRevenueMin);
        const annualRevenueMax = normalizeOptionalNumber(req.body?.annualRevenueMax);
        const usesKlaviyo = normalizeOptionalBoolean(req.body?.usesKlaviyo);
        const klaviyoPercent = normalizeOptionalNumber(req.body?.klaviyoPercent);
        const discoveryCallHeld = normalizeOptionalBoolean(req.body?.discoveryCallHeld);
        const lastDiscoveryCallAt = normalizeOptionalTimestamp(req.body?.lastDiscoveryCallAt);
        const source = normalizeOptionalText(req.body?.source);
        const notes = normalizeOptionalText(req.body?.notes);
        const attributes = normalizeOptionalObject(req.body?.attributes);
        const sourcePayload = normalizeOptionalObject(req.body?.sourcePayload);

        const result = await pool.query(
            `INSERT INTO contact_insights (
                contact_id,
                agency_id,
                client_id,
                annual_revenue_text,
                annual_revenue_min,
                annual_revenue_max,
                uses_klaviyo,
                klaviyo_percent,
                discovery_call_held,
                last_discovery_call_at,
                source,
                notes,
                attributes,
                source_payload
            )
            SELECT
                c.id,
                c.agency_id,
                co.client_id,
                COALESCE($3, NULL),
                COALESCE($4, NULL),
                COALESCE($5, NULL),
                COALESCE($6, NULL),
                COALESCE($7, NULL),
                COALESCE($8, NULL),
                COALESCE($9, NULL),
                COALESCE($10, NULL),
                COALESCE($11, NULL),
                COALESCE($12::jsonb, '{}'::jsonb),
                COALESCE($13::jsonb, '{}'::jsonb)
            FROM contacts c
            JOIN companies co ON co.id = c.company_id
            WHERE c.id = $1
            AND c.agency_id = $2
            ON CONFLICT (contact_id)
            DO UPDATE SET
                annual_revenue_text = COALESCE(EXCLUDED.annual_revenue_text, contact_insights.annual_revenue_text),
                annual_revenue_min = COALESCE(EXCLUDED.annual_revenue_min, contact_insights.annual_revenue_min),
                annual_revenue_max = COALESCE(EXCLUDED.annual_revenue_max, contact_insights.annual_revenue_max),
                uses_klaviyo = COALESCE(EXCLUDED.uses_klaviyo, contact_insights.uses_klaviyo),
                klaviyo_percent = COALESCE(EXCLUDED.klaviyo_percent, contact_insights.klaviyo_percent),
                discovery_call_held = COALESCE(EXCLUDED.discovery_call_held, contact_insights.discovery_call_held),
                last_discovery_call_at = COALESCE(EXCLUDED.last_discovery_call_at, contact_insights.last_discovery_call_at),
                source = COALESCE(EXCLUDED.source, contact_insights.source),
                notes = COALESCE(EXCLUDED.notes, contact_insights.notes),
                attributes = CASE
                    WHEN EXCLUDED.attributes = '{}'::jsonb THEN contact_insights.attributes
                    ELSE EXCLUDED.attributes
                END,
                source_payload = CASE
                    WHEN EXCLUDED.source_payload = '{}'::jsonb THEN contact_insights.source_payload
                    ELSE EXCLUDED.source_payload
                END,
                updated_at = NOW()
            RETURNING *`,
            [
                contactId,
                agencyId,
                annualRevenueText,
                annualRevenueMin,
                annualRevenueMax,
                usesKlaviyo,
                klaviyoPercent,
                discoveryCallHeld,
                lastDiscoveryCallAt,
                source,
                notes,
                attributes ? JSON.stringify(attributes) : null,
                sourcePayload ? JSON.stringify(sourcePayload) : null
            ]
        );

        if (!result.rowCount) {
            return res.status(404).json({ error: 'Lead not found for this agency.' });
        }

        res.json({ insight: result.rows[0] });
    } catch (error) {
        console.error('Error upserting lead insights:', error);
        res.status(500).json({ error: 'Failed to save lead insights' });
    }
});

/**
 * POST /leads/verification-import/preview
 *
 * Parse an uploaded CSV and return its headers + first 5 data rows so the
 * frontend can let the user map columns before committing the import.
 *
 * Body: multipart/form-data  file=<csv>
 */
router.post('/leads/verification-import/preview', verifyFirebaseToken, uploadVerification.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'CSV file is required.' });
        }
        const rows = await parseCsvBuffer(req.file.buffer);
        if (rows.length === 0) {
            return res.status(400).json({ error: 'CSV file is empty or contains no data rows.' });
        }
        const headers = Object.keys(rows[0]);
        const previewRows = rows.slice(0, 5);
        return res.json({ headers, previewRows, totalRows: rows.length });
    } catch (error) {
        console.error('Error parsing CSV for verification preview:', error);
        return res.status(400).json({ error: error?.message || 'Failed to parse CSV.' });
    }
});

/**
 * POST /leads/verification-import
 *
 * Update email_status and email_verify_completed_at for contacts matched by email.
 * Only updates contacts that belong to the authenticated agency + client.
 *
 * Body: multipart/form-data
 *   file          – CSV file
 *   clientId      – client slug (required)
 *   emailColumn   – CSV column name whose value is the email address (required)
 *   statusColumn  – CSV column name whose value is the email status  (required)
 *   verifiedAtColumn – CSV column name whose value is an ISO date for email_verify_completed_at (optional)
 */
router.post('/leads/verification-import', verifyFirebaseToken, uploadVerification.single('file'), async (req, res) => {
    try {
        const agencyId = req.agencyId;
        const clientSlug = normalizeOptionalText(req.body?.clientId);
        const emailColumn = normalizeOptionalText(req.body?.emailColumn);
        const statusColumn = normalizeOptionalText(req.body?.statusColumn);
        const verifiedAtColumn = normalizeOptionalText(req.body?.verifiedAtColumn) || null;

        if (!clientSlug) return res.status(400).json({ error: 'clientId is required.' });
        if (!emailColumn) return res.status(400).json({ error: 'emailColumn is required.' });
        if (!statusColumn) return res.status(400).json({ error: 'statusColumn is required.' });
        if (!req.file) return res.status(400).json({ error: 'CSV file is required.' });

        const clientId = await queries.getOrCreateClient(agencyId, clientSlug);
        const rows = await parseCsvBuffer(req.file.buffer);
        if (rows.length === 0) {
            return res.status(400).json({ error: 'CSV file is empty or contains no data rows.' });
        }
        if (rows.length > 50000) {
            return res.status(400).json({ error: 'CSV exceeds 50 000 row limit. Split the file and re-upload.' });
        }

        const defaultVerifiedAt = new Date().toISOString();
        let totalRows = rows.length;
        let matched = 0;
        let skipped = 0;
        let notFound = 0;

        const BATCH = 500;
        for (let i = 0; i < rows.length; i += BATCH) {
            const batch = rows.slice(i, i + BATCH);

            // Build arrays for a single multi-row UPDATE
            const emails = [];
            const statuses = [];
            const verifiedAts = [];

            for (const row of batch) {
                const email = String(row[emailColumn] || '').trim().toLowerCase();
                const rawStatus = String(row[statusColumn] || '').trim();
                if (!email || !rawStatus) { skipped++; continue; }

                const normalizedStatus = leadsService.normalizeEmailStatus(rawStatus);
                if (!normalizedStatus) { skipped++; continue; }

                let effectiveVerifiedAt = defaultVerifiedAt;
                if (verifiedAtColumn && row[verifiedAtColumn]) {
                    const parsed = normalizeOptionalTimestamp(String(row[verifiedAtColumn]).trim());
                    if (parsed) effectiveVerifiedAt = parsed;
                }

                emails.push(email);
                statuses.push(normalizedStatus);
                verifiedAts.push(effectiveVerifiedAt);
            }

            if (emails.length === 0) continue;

            // Bulk UPDATE via unnest
            const result = await pool.query(
                `UPDATE contacts AS c
                 SET
                     email_status              = v.new_status,
                     email_verify_completed_at = v.new_verified_at::timestamptz,
                     updated_at       = NOW()
                 FROM (
                     SELECT
                         UNNEST($1::text[]) AS email_lower,
                         UNNEST($2::text[]) AS new_status,
                         UNNEST($3::text[]) AS new_verified_at
                 ) AS v
                 WHERE c.agency_id = $4
                   AND c.client_id = $5
                   AND c.email IS NOT NULL
                   AND LOWER(c.email) = v.email_lower`,
                [emails, statuses, verifiedAts, agencyId, clientId]
            );

            matched += emails.length;
            notFound += emails.length - (result.rowCount || 0);
        }

        return res.json({
            totalRows,
            matched,
            updated: matched - notFound,
            skipped,
            notFound,
        });
    } catch (error) {
        console.error('Error running verification import:', error);
        return res.status(500).json({ error: error?.message || 'Failed to import verification CSV.' });
    }
});

export default router;

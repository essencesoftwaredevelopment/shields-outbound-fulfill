/**
 * Cohort + sentinel rules for pipeline enrichment (re-process and CSV mapping).
 */

export function isNotFoundValue(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    return !normalized || normalized === 'not found';
}

/**
 * Derive per-domain cohort flags from CSV row + column mapping.
 */
export function computeCohortMeta(rawRow, columnMapping = {}) {
    const raw = rawRow && typeof rawRow === 'object' ? rawRow : {};
    const founderCol = String(columnMapping.founder || '').trim();
    const emailCol = String(columnMapping.email || '').trim();

    const founderVal = founderCol ? String(raw[founderCol] ?? '').trim() : '';
    const emailVal = emailCol ? String(raw[emailCol] ?? '').trim() : '';

    let founderExcluded = raw._enrichment?.founderExcluded === true;
    if (founderCol && isNotFoundValue(founderVal)) {
        founderExcluded = true;
    }
    if (emailCol && isNotFoundValue(emailVal)) {
        founderExcluded = true;
    }

    const inFounderCohort = !founderCol || (!isNotFoundValue(founderVal) && founderVal.length > 0);
    const inEmailCohort = !emailCol || (!isNotFoundValue(emailVal) && emailVal.length > 0);

    return {
        inFounderCohort,
        inEmailCohort,
        founderExcluded
    };
}

export function mergeEnrichmentIntoRawRow(rawRow, columnMapping) {
    const raw = rawRow && typeof rawRow === 'object' ? { ...rawRow } : {};
    const cohort = computeCohortMeta(raw, columnMapping);
    raw._enrichment = {
        ...(raw._enrichment && typeof raw._enrichment === 'object' ? raw._enrichment : {}),
        ...cohort
    };
    return raw;
}

export function readEnrichmentMeta(rawRow) {
    const raw = rawRow && typeof rawRow === 'object' ? rawRow : {};
    const meta = raw._enrichment && typeof raw._enrichment === 'object' ? raw._enrichment : {};
    return {
        inFounderCohort: meta.inFounderCohort !== false,
        inEmailCohort: meta.inEmailCohort !== false,
        founderExcluded: meta.founderExcluded === true
    };
}

const CSV_EMAIL_STATUS_ALIASES = {
    valid: 'valid',
    verified: 'valid',
    deliverable: 'valid',
    ok: 'valid',
    safe: 'valid',
    good: 'valid',
    risky: 'risky',
    'valid-risky': 'risky',
    'valid_risky': 'risky',
    'catch-all': 'risky',
    'catch_all': 'risky',
    catchall: 'risky',
    'accept-all': 'risky',
    'accept_all': 'risky',
    acceptall: 'risky',
    invalid: 'invalid',
    undeliverable: 'invalid',
    bounced: 'invalid',
    bounce: 'invalid',
    bad: 'invalid',
    unknown: 'unknown',
    unverified: 'unknown',
    unverifiable: 'unknown'
};

/**
 * Map an uploaded email-status cell onto contacts.email_status. Accepts the
 * labels common providers/exports use (Instantly, TryKitt, MillionVerifier…).
 * Empty cells return null (leave the column alone); anything unrecognised is
 * 'unknown' so a mapped column never silently drops a lead into "unverified".
 * Provider results still go through normalizeEmailStatus in services/leads.js.
 */
export function normalizeCsvEmailStatus(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (!normalized) return null;
    return CSV_EMAIL_STATUS_ALIASES[normalized] || 'unknown';
}

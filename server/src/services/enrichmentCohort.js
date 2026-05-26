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

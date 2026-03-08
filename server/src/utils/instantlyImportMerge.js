const HEADER_NORMALIZATION_REGEX = /[^a-z0-9]+/g;

export function normalizeHeaderKey(value = '') {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(HEADER_NORMALIZATION_REGEX, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function normalizeCampaignName(value = '') {
    return normalizeHeaderKey(value);
}

export function normalizeDomainForMatch(value = '') {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return '';
    const withoutProtocol = raw.replace(/^https?:\/\//, '');
    const withoutWww = withoutProtocol.replace(/^www\./, '');
    return withoutWww.split('/')[0].split('?')[0].trim();
}

export function normalizeEmailForMatch(value = '') {
    const raw = String(value || '').trim().toLowerCase();
    return raw || '';
}

export function normalizePersonName(value = '') {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(HEADER_NORMALIZATION_REGEX, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function extractCampaignApiItems(payload) {
    if (Array.isArray(payload?.items)) return payload.items;
    if (Array.isArray(payload?.data)) return payload.data;
    if (Array.isArray(payload?.campaigns)) return payload.campaigns;
    if (Array.isArray(payload)) return payload;
    return [];
}

function campaignCreatedAtTimestamp(campaign) {
    const createdRaw = campaign?.timestamp_created
        || campaign?.createdAt
        || campaign?.created_at
        || campaign?.created
        || campaign?.created_at_utc
        || null;
    if (!createdRaw) return 0;
    const ts = new Date(createdRaw).getTime();
    return Number.isFinite(ts) ? ts : 0;
}

function isCampaignActive(campaign) {
    const status = campaign?.status ?? campaign?.state;
    if (typeof status === 'number') return status === 1;
    const normalized = String(status || '').trim().toLowerCase();
    return normalized === '1' || normalized === 'active' || normalized === 'running';
}

export function choosePreferredCampaign(candidates = []) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
        return { selected: null, resolutionReason: 'no_candidates' };
    }

    const ordered = [...candidates].sort((a, b) => {
        const aActive = isCampaignActive(a) ? 1 : 0;
        const bActive = isCampaignActive(b) ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;

        const aCreated = campaignCreatedAtTimestamp(a);
        const bCreated = campaignCreatedAtTimestamp(b);
        if (aCreated !== bCreated) return bCreated - aCreated;

        const aId = String(a?.id ?? a?.campaignId ?? a?.uuid ?? a?._id ?? '');
        const bId = String(b?.id ?? b?.campaignId ?? b?.uuid ?? b?._id ?? '');
        return aId.localeCompare(bId);
    });

    const resolutionReason = ordered.length > 1
        ? 'duplicate_name_resolved_active_then_newest'
        : 'single_match';

    return {
        selected: ordered[0],
        resolutionReason
    };
}

export function mapCsvEmailStatus(rawStatus = '') {
    const normalized = normalizeHeaderKey(rawStatus);
    if (!normalized) return null;

    const validTokens = new Set(['valid', 'verified', 'deliverable']);
    const riskyTokens = new Set(['risky', 'valid risky', 'valid risky email', 'accept all', 'catch all']);
    const invalidTokens = new Set(['invalid', 'undeliverable', 'not found', 'email not found', 'bounced', 'bounce']);
    const unknownTokens = new Set(['unknown', 'not run', 'not verified', 'unverified', 'pending']);

    if (validTokens.has(normalized)) return 'valid';
    if (riskyTokens.has(normalized)) return 'risky';
    if (invalidTokens.has(normalized)) return 'invalid';
    if (unknownTokens.has(normalized)) return 'unknown';

    if (normalized.includes('valid') && normalized.includes('risky')) return 'risky';
    if (normalized.includes('valid')) return 'valid';
    if (normalized.includes('risky')) return 'risky';
    if (normalized.includes('invalid')) return 'invalid';
    if (normalized.includes('unknown')) return 'unknown';

    return null;
}

export function shouldBackfillEmailStatus(currentStatus, incomingStatus) {
    if (!incomingStatus) return false;
    const current = normalizeHeaderKey(currentStatus);
    return !current || current === 'unknown';
}

export function getCsvValueByAliases(row, aliasGroups, headerLookup) {
    if (!row || !aliasGroups || !headerLookup) return '';

    for (const alias of aliasGroups) {
        const normalizedAlias = normalizeHeaderKey(alias);
        const sourceHeader = headerLookup.get(normalizedAlias);
        if (!sourceHeader) continue;
        const value = row[sourceHeader];
        if (value === null || typeof value === 'undefined') continue;
        const text = String(value).trim();
        if (text) return text;
    }
    return '';
}

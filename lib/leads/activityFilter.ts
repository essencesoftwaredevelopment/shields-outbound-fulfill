export const LEAD_ACTIVITY_FIELD_KEY = "lead_activity";

export const DEFAULT_ACTIVITY_EVENT_TYPE = "email_sent";
export const DEFAULT_ACTIVITY_OP = "at_least_once";

const OPS_WITH_COUNT = new Set(["eq", "neq", "gte", "gt", "lt", "lte"]);

const FALLBACK_TIMEFRAMES = [
    { key: "in_the_last", label: "in the last" },
    { key: "after", label: "after" },
    { key: "before", label: "before" },
    { key: "between", label: "between" },
    { key: "between_dates", label: "between dates" },
    { key: "at_least", label: "at least" },
    { key: "over_all_time", label: "over all time" }
];

const FALLBACK_UNITS = [
    { key: "hours", label: "hours" },
    { key: "days", label: "days" },
    { key: "weeks", label: "weeks" }
];

export const ADDED_TO_CAMPAIGN_EVENT_TYPE = "added_to_campaign";
export const ACTIVITY_WHERE_DIMENSION_CAMPAIGN = "campaign";

const WHERE_OPS_MULTI = new Set(["in", "not_in"]);
const WHERE_OPS = new Set(["eq", "neq", "in", "not_in"]);

export type LeadActivityTimeframe = {
    kind: string;
    amount?: number;
    unit?: string;
    date?: string;
    start?: string;
    end?: string;
    minAmount?: number;
    maxAmount?: number;
};

export type LeadActivityWhere = {
    dimension: string;
    op: string;
    value: string | string[];
};

export type LeadActivityValue = {
    eventType: string;
    count?: number;
    timeframe: LeadActivityTimeframe;
    where?: LeadActivityWhere[];
};

export function activityFrequencyNeedsCount(operatorKey: string) {
    return OPS_WITH_COUNT.has(operatorKey);
}

export function fallbackActivityTimeframes() {
    return FALLBACK_TIMEFRAMES;
}

export function fallbackActivityUnits() {
    return FALLBACK_UNITS;
}

export function defaultLeadActivityValue(eventType = DEFAULT_ACTIVITY_EVENT_TYPE): LeadActivityValue {
    return {
        eventType,
        timeframe: { kind: "in_the_last", amount: 30, unit: "days" }
    };
}

export function serializeLeadActivityValue(value: LeadActivityValue) {
    return JSON.stringify(value);
}

export function activityEventSupportsWhere(eventType: string) {
    return eventType === ADDED_TO_CAMPAIGN_EVENT_TYPE;
}

export function defaultActivityWhereClause(): LeadActivityWhere {
    return { dimension: ACTIVITY_WHERE_DIMENSION_CAMPAIGN, op: "eq", value: "" };
}

function parseWhereValue(op: string, raw: unknown): string | string[] | null {
    if (WHERE_OPS_MULTI.has(op)) {
        const values = Array.isArray(raw)
            ? raw.map((item) => String(item || "").trim()).filter(Boolean)
            : String(raw || "").trim()
                ? [String(raw).trim()]
                : [];
        return values;
    }
    if (Array.isArray(raw)) {
        return String(raw[0] || "").trim();
    }
    return String(raw || "").trim();
}

function parseWhereClauses(raw: unknown): LeadActivityWhere[] | undefined {
    if (!Array.isArray(raw) || raw.length === 0) return undefined;
    const clauses: LeadActivityWhere[] = [];
    for (const item of raw) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const dimension = String((item as { dimension?: unknown }).dimension || "").trim();
        const op = String((item as { op?: unknown }).op || "").trim().toLowerCase();
        if (!dimension || !WHERE_OPS.has(op)) continue;
        const value = parseWhereValue(op, (item as { value?: unknown }).value);
        if (value == null) continue;
        clauses.push({ dimension, op, value });
    }
    return clauses.length ? clauses : undefined;
}

function isWhereClauseComplete(clause: LeadActivityWhere) {
    if (!clause.dimension || !WHERE_OPS.has(clause.op)) return false;
    if (WHERE_OPS_MULTI.has(clause.op)) {
        return Array.isArray(clause.value) && clause.value.length > 0;
    }
    return typeof clause.value === "string" && clause.value.trim().length > 0;
}

export function parseLeadActivityValue(raw: string | null | undefined): LeadActivityValue | null {
    if (!raw || typeof raw !== "string") return null;
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        const eventType = String(parsed.eventType || "").trim();
        const timeframe = parsed.timeframe && typeof parsed.timeframe === "object"
            ? parsed.timeframe as LeadActivityTimeframe
            : null;
        if (!eventType || !timeframe?.kind) return null;
        const count = Number.parseInt(String(parsed.count ?? ""), 10);
        const where = activityEventSupportsWhere(eventType) ? parseWhereClauses(parsed.where) : undefined;
        return {
            eventType,
            ...(Number.isInteger(count) ? { count } : {}),
            timeframe: {
                kind: String(timeframe.kind),
                ...(timeframe.amount != null ? { amount: Number(timeframe.amount) } : {}),
                ...(timeframe.unit ? { unit: String(timeframe.unit) } : {}),
                ...(timeframe.date ? { date: String(timeframe.date) } : {}),
                ...(timeframe.start ? { start: String(timeframe.start) } : {}),
                ...(timeframe.end ? { end: String(timeframe.end) } : {}),
                ...(timeframe.minAmount != null ? { minAmount: Number(timeframe.minAmount) } : {}),
                ...(timeframe.maxAmount != null ? { maxAmount: Number(timeframe.maxAmount) } : {})
            },
            ...(where ? { where } : {})
        };
    } catch {
        return null;
    }
}

export function isLeadActivityFilterComplete(operatorKey: string, rawValue: string) {
    const value = parseLeadActivityValue(rawValue);
    if (!value?.eventType || !value.timeframe?.kind) return false;
    if (activityFrequencyNeedsCount(operatorKey)) {
        if (!Number.isInteger(value.count) || (value.count as number) < 0) return false;
    }
    if (value.where?.length && !value.where.every(isWhereClauseComplete)) return false;

    const { timeframe } = value;
    if (timeframe.kind === "over_all_time") return true;
    if (timeframe.kind === "in_the_last" || timeframe.kind === "at_least") {
        return Number(timeframe.amount) > 0 && Boolean(timeframe.unit);
    }
    if (timeframe.kind === "after" || timeframe.kind === "before") {
        return Boolean(timeframe.date);
    }
    if (timeframe.kind === "between") {
        return Number(timeframe.minAmount) > 0 && Number(timeframe.maxAmount) > 0 && Boolean(timeframe.unit);
    }
    if (timeframe.kind === "between_dates") {
        return Boolean(timeframe.start) && Boolean(timeframe.end);
    }
    return false;
}

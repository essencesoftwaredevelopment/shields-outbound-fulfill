export function formatPercent(value: number | null | undefined, digits = 1) {
    if (value === null || value === undefined || !Number.isFinite(value)) return "—";
    return `${(value * 100).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
}

export function formatNumber(value: number | null | undefined, digits = 0) {
    if (value === null || value === undefined || !Number.isFinite(value)) return "—";
    return value.toLocaleString(undefined, { maximumFractionDigits: digits });
}

export function formatMoney(value: number | null | undefined) {
    if (value === null || value === undefined || !Number.isFinite(value)) return "—";
    return `$${value.toLocaleString(undefined, { maximumFractionDigits: value >= 100 ? 0 : 2 })}`;
}

export function formatDate(value: string | null | undefined) {
    if (!value) return "—";
    const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00Z`) : new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "2-digit" });
}

export function formatDateTime(value: string | null | undefined) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** ISO timestamp → value for <input type="datetime-local"> in the browser's timezone. */
export function toDateTimeLocal(value: string | null | undefined) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fromDateTimeLocal(value: string) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

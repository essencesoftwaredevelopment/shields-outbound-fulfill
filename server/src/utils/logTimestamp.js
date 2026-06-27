/** ISO-8601 local-to-UTC timestamp for console logs, e.g. 2026-06-27T18:46:50.482 */
export function logTimestamp(date = new Date()) {
    return date.toISOString().slice(0, -1);
}

export function formatTimestampedLog(message, date = new Date()) {
    return `[${logTimestamp(date)}] ${message}`;
}

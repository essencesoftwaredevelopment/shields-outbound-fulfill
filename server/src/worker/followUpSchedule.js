/**
 * followUpSchedule.js
 *
 * Timezone-aware scheduling helpers for the follow-up worker.
 */

/**
 * Parse schedule times, e.g. "09:00,14:00" → [{ hour: 9, minute: 0 }, ...]
 */
export function parseScheduleTimes(raw) {
    return raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
            const [h, m] = s.split(':').map(Number);
            if (!Number.isFinite(h) || !Number.isFinite(m)) {
                throw new Error(`Invalid FOLLOWUP_SCHEDULE_TIMES entry: "${s}"`);
            }
            return { hour: h, minute: m };
        });
}

function getZonedDateParts(date, timeZone) {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
        hour12: false
    });
    const parts = Object.fromEntries(
        formatter.formatToParts(date).map(({ type, value }) => [type, value])
    );
    return {
        year: parseInt(parts.year, 10),
        month: parseInt(parts.month, 10),
        day: parseInt(parts.day, 10),
        hour: parseInt(parts.hour, 10),
        minute: parseInt(parts.minute, 10),
        second: parseInt(parts.second, 10)
    };
}

/**
 * Convert a wall-clock date/time in an IANA timezone to a UTC timestamp (ms).
 */
export function zonedTimeToUtcMs(year, month, day, hour, minute, timeZone) {
    let utcMs = Date.UTC(year, month - 1, day, hour, minute, 0);
    for (let i = 0; i < 4; i++) {
        const zoned = getZonedDateParts(new Date(utcMs), timeZone);
        const zonedAsUtc = Date.UTC(
            zoned.year, zoned.month - 1, zoned.day,
            zoned.hour, zoned.minute, zoned.second
        );
        const desiredAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
        utcMs += desiredAsUtc - zonedAsUtc;
    }
    return utcMs;
}

function addDaysToCalendarDate(year, month, day, days, timeZone) {
    const baseMs = zonedTimeToUtcMs(year, month, day, 12, 0, timeZone);
    const rolled = getZonedDateParts(new Date(baseMs + days * 86_400_000), timeZone);
    return { year: rolled.year, month: rolled.month, day: rolled.day };
}

/**
 * Return milliseconds until the next scheduled run, evaluating all configured
 * times in the given IANA timezone. Picks the earliest future slot.
 */
export function msUntilNextRun(now = new Date(), scheduleTimes, timeZone = 'UTC') {
    if (!scheduleTimes?.length) {
        throw new Error('followUpSchedule: scheduleTimes must not be empty');
    }

    const nowMs = now.getTime();
    const today = getZonedDateParts(now, timeZone);
    let bestMs = null;

    // Today and tomorrow cover every case for a twice-daily (or less) schedule.
    for (let dayOffset = 0; dayOffset < 2; dayOffset++) {
        const { year, month, day } = addDaysToCalendarDate(
            today.year, today.month, today.day, dayOffset, timeZone
        );
        for (const { hour, minute } of scheduleTimes) {
            const slotMs = zonedTimeToUtcMs(year, month, day, hour, minute, timeZone);
            if (slotMs > nowMs && (bestMs === null || slotMs < bestMs)) {
                bestMs = slotMs;
            }
        }
    }

    if (bestMs === null) {
        throw new Error(`followUpSchedule: no upcoming slot found in timezone ${timeZone}`);
    }
    return bestMs - nowMs;
}

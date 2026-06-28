/**
 * Coalesce concurrent callers into one in-flight promise (e.g. pool-friendly progress flushes).
 * @template T
 * @param {(...args: unknown[]) => Promise<T>} fn
 */
export function createSingleFlight(fn) {
    /** @type {Promise<T> | null} */
    let inFlight = null;
    return (...args) => {
        if (!inFlight) {
            inFlight = Promise.resolve()
                .then(() => fn(...args))
                .finally(() => {
                    inFlight = null;
                });
        }
        return inFlight;
    };
}

/**
 * At most one execution per minIntervalMs; trailing edge coalesces bursts.
 * @template T
 * @param {(...args: unknown[]) => Promise<T>} fn
 * @param {number} minIntervalMs
 */
export function createDebouncedAsync(fn, minIntervalMs = 750) {
    let lastRunAt = 0;
    /** @type {Promise<T> | undefined} */
    let scheduled = undefined;
    /** @type {unknown[] | null} */
    let pendingArgs = null;

    const flush = createSingleFlight(async () => {
        const args = pendingArgs;
        pendingArgs = null;
        if (!args) return;

        const elapsed = Date.now() - lastRunAt;
        if (elapsed < minIntervalMs) {
            await new Promise((resolve) => setTimeout(resolve, minIntervalMs - elapsed));
        }
        await fn(...args);
        lastRunAt = Date.now();
    });

    return (...args) => {
        pendingArgs = args;
        if (!scheduled) {
            scheduled = flush().finally(() => {
                scheduled = undefined;
            });
        }
        return scheduled;
    };
}

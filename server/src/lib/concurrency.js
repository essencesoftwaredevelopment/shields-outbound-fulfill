/**
 * Lightweight p-limit replacement (avoids #async_hooks in Vercel workflow bundles).
 * @param {number} concurrency
 */
export function createConcurrencyLimit(concurrency) {
    const max = Math.max(1, concurrency);
    let active = 0;
    /** @type {Array<() => void>} */
    const queue = [];

    const next = () => {
        if (active >= max || !queue.length) return;
        active += 1;
        const run = queue.shift();
        run?.();
    };

    return (fn) =>
        new Promise((resolve, reject) => {
            const run = async () => {
                try {
                    resolve(await fn());
                } catch (error) {
                    reject(error);
                } finally {
                    active -= 1;
                    next();
                }
            };
            queue.push(run);
            next();
        });
}

/**
 * @template T, R
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
export async function mapWithConcurrency(items, concurrency, worker) {
    if (!items.length) return [];
    const limit = createConcurrencyLimit(concurrency);
    return Promise.all(items.map((item, index) => limit(() => worker(item, index))));
}

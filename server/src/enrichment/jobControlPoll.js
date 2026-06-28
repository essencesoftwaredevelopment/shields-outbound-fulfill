import { getJobControlFlags } from './persist.js';

export const DEFAULT_PAUSE_POLL_MS = 1000;

function isPoolExhausted(err) {
    const msg = String(err?.message || err?.code || '');
    return msg.includes('EMAXCONNSESSION')
        || msg.includes('max clients reached')
        || err?.code === 'XX000';
}

async function getJobControlFlagsWithRetry(jobId, agencyId) {
    const deadline = Date.now() + 10_000;
    let delay = 200;

    while (Date.now() < deadline) {
        try {
            return await getJobControlFlags(jobId, agencyId);
        } catch (err) {
            if (!isPoolExhausted(err)) throw err;
            await new Promise((resolve) => setTimeout(resolve, delay));
            delay = Math.min(delay * 2, 2000);
        }
    }

    return { cancelled: false, paused: false };
}

/**
 * Poll jobs.paused / jobs.cancelled for cooperative stop (Vercel workflow steps).
 * @returns {() => void} stop polling
 */
export function startJobControlPoll(
    jobId,
    agencyId,
    {
        onPaused,
        onCancelled,
        intervalMs = DEFAULT_PAUSE_POLL_MS
    } = {}
) {
    if (!jobId || !agencyId) {
        return () => {};
    }

    const timer = setInterval(() => {
        void (async () => {
            try {
                const flags = await getJobControlFlagsWithRetry(jobId, agencyId);
                if (flags.cancelled) {
                    clearInterval(timer);
                    onCancelled?.(flags);
                    return;
                }
                if (flags.paused) {
                    clearInterval(timer);
                    onPaused?.(flags);
                }
            } catch (err) {
                console.warn(`[${jobId}] job control poll:`, err?.message || err);
            }
        })();
    }, intervalMs);

    return () => clearInterval(timer);
}

export function createStopGate() {
    let stopCode = null;
    return {
        isStopped: () => stopCode != null,
        getStopCode: () => stopCode,
        requestStop(code) {
            stopCode = code;
        },
        throwIfStopped() {
            if (!stopCode) return;
            const err = new Error(
                stopCode === 'JOB_CANCELLED' ? 'Job cancelled' : 'Job paused'
            );
            err.code = stopCode;
            throw err;
        }
    };
}

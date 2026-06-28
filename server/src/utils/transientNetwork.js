/** @param {unknown} err */
export function isTransientNetworkError(err) {
    const code = String(err?.code || '').toUpperCase();
    return [
        'ENOTFOUND',
        'EAI_AGAIN',
        'ECONNRESET',
        'ETIMEDOUT',
        'ECONNREFUSED',
        'EPIPE',
        'ENETUNREACH',
        'ECONNABORTED'
    ].includes(code);
}

/** Retry rate limits, server errors, and transient DNS/socket failures. */
export function shouldRetryHttpOrNetwork(status, err) {
    if (isTransientNetworkError(err)) return true;
    return status === 429 || (status >= 500 && status < 600);
}

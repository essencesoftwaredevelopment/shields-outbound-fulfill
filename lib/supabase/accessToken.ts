const REFRESH_SKEW_MS = 15_000;

export function accessTokenNeedsRefresh(
    expiresAtSeconds: number | undefined,
    nowMs = Date.now(),
    skewMs = REFRESH_SKEW_MS
): boolean {
    if (!expiresAtSeconds) return true;
    return expiresAtSeconds * 1000 <= nowMs + skewMs;
}

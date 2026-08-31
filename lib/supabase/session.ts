import { supabase } from "./client";
import { accessTokenNeedsRefresh } from "./accessToken";

let refreshInFlight: Promise<string | null> | null = null;

/**
 * Access token for the Express API. Refreshes when the JWT is expired or
 * within 15s of expiry, and coalesces concurrent callers so two API requests
 * cannot rotate the refresh token at the same time.
 */
export async function getAccessToken(): Promise<string | null> {
    const { data } = await supabase.auth.getSession();
    const session = data.session;
    if (!session?.access_token) return null;

    if (!accessTokenNeedsRefresh(session.expires_at)) {
        return session.access_token;
    }

    if (!refreshInFlight) {
        const fallbackToken = session.access_token;
        const fallbackExpiresAt = session.expires_at;
        refreshInFlight = supabase.auth
            .refreshSession()
            .then(({ data: refreshed, error }) => {
                if (!error && refreshed.session?.access_token) {
                    return refreshed.session.access_token;
                }
                if (error) {
                    console.warn("Session refresh failed:", error.message);
                }
                // Keep serving the current JWT if it is still in date — a
                // transient refresh blip must not look like a signed-out user.
                const stillValid =
                    typeof fallbackExpiresAt === "number"
                    && fallbackExpiresAt * 1000 > Date.now();
                return stillValid ? fallbackToken : null;
            })
            .finally(() => {
                refreshInFlight = null;
            });
    }

    return refreshInFlight;
}

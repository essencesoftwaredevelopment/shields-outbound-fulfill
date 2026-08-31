/**
 * Cookie lifetime for the refresh token, not the 1-hour access JWT.
 * A short Max-Age drops the refresh token from the browser and forces a re-login.
 * 400 days is Chrome's practical persistent-cookie cap.
 */
export const AUTH_COOKIE_OPTIONS = {
    path: "/",
    sameSite: "lax" as const,
    maxAge: 60 * 60 * 24 * 400,
};

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE_OPTIONS } from "./cookieOptions";

type CookieToSet = { name: string; value: string; options?: CookieOptions };

/**
 * Refresh the Supabase Auth cookies on each document/RSC request.
 * Must return `supabaseResponse` so the browser and server stay in sync.
 */
export async function updateSession(request: NextRequest) {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
    if (!supabaseUrl || !supabaseAnonKey) {
        return NextResponse.next({ request });
    }

    // No session cookie: skip Auth entirely so public pages (review links,
    // /auth) and code-exchange callbacks are unchanged.
    const hasAuthCookie = request.cookies
        .getAll()
        .some((cookie) => cookie.name.includes("-auth-token"));
    if (!hasAuthCookie) {
        return NextResponse.next({ request });
    }

    let supabaseResponse = NextResponse.next({ request });

    const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
        cookieOptions: AUTH_COOKIE_OPTIONS,
        cookies: {
            getAll() {
                return request.cookies.getAll();
            },
            setAll(cookiesToSet: CookieToSet[], headers?: Record<string, string>) {
                cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
                supabaseResponse = NextResponse.next({ request });
                cookiesToSet.forEach(({ name, value, options }) => {
                    supabaseResponse.cookies.set(name, value, options);
                });
                if (headers) {
                    Object.entries(headers).forEach(([key, value]) => {
                        supabaseResponse.headers.set(key, value);
                    });
                }
            },
        },
    });

    // Touches Auth so an expired access JWT is rotated via the refresh token
    // and written back through setAll. Do not use getSession() here.
    // Never fail the page if GoTrue is slow or down — the client can refresh.
    try {
        await supabase.auth.getUser();
    } catch (err) {
        console.warn(
            "Session refresh skipped:",
            err instanceof Error ? err.message : err
        );
    }

    return supabaseResponse;
}

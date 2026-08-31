import { createBrowserClient } from "@supabase/ssr";
import { AUTH_COOKIE_OPTIONS } from "./cookieOptions";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

export function createClient() {
    return createBrowserClient(supabaseUrl, supabaseAnonKey, {
        cookieOptions: AUTH_COOKIE_OPTIONS,
    });
}

export const supabase = createClient();

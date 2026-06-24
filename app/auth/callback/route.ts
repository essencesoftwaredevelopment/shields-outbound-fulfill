import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
    const { searchParams, origin } = new URL(request.url);
    const code = searchParams.get("code");
    const tokenHash = searchParams.get("token_hash");
    const type = searchParams.get("type") as EmailOtpType | null;
    const next = searchParams.get("next") ?? "/";

    const supabase = await createClient();

    if (code) {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (!error) {
            return NextResponse.redirect(`${origin}${next}?confirmed=1`);
        }
        console.error("Auth callback code exchange failed:", error.message);
    }

    if (tokenHash && type) {
        const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
        if (!error) {
            return NextResponse.redirect(`${origin}${next}?confirmed=1`);
        }
        console.error("Auth callback OTP verification failed:", error.message);
    }

    return NextResponse.redirect(`${origin}/auth?error=confirmation_failed`);
}

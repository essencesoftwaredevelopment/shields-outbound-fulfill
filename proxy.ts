import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

export async function proxy(request: NextRequest) {
    return updateSession(request);
}

export const config = {
    matcher: [
        // Pages and RSC only. Skip static assets, Express rewrites, workflow
        // triggers, and Workflow runtime — getUser() must never gate those.
        "/((?!_next/|favicon.ico|api/|internal/|\\.well-known/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
    ],
};

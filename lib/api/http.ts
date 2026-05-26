import { getAccessToken } from "@/lib/supabase/session";
import { getPipelineBaseUrl } from "@/lib/pipeline/client";

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await getAccessToken();
    if (!token) {
        throw new Error("Not signed in");
    }
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    if (init.body && !headers.has("Content-Type") && typeof init.body === "string") {
        headers.set("Content-Type", "application/json");
    }
    const base = getPipelineBaseUrl().replace(/\/$/, "");
    const url = path.startsWith("http") ? path : `${base}${path.startsWith("/") ? path : `/${path}`}`;
    return fetch(url, {
        cache: "no-store",
        ...init,
        headers,
    });
}

export async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await apiFetch(path, init);
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
        const message = (payload as { error?: string } | null)?.error || response.statusText || "Request failed";
        throw new Error(message);
    }
    return payload as T;
}

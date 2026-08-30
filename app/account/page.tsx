"use client";

import AppShell from "@/components/app-shell";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Separator } from "@/components/ui/separator";
import { useAuth } from "@/hooks/use-auth";
import { apiJson } from "@/lib/api/http";
import { getAccessToken } from "@/lib/supabase/session";
import { getPipelineBaseUrl } from "@/lib/pipeline/client";
import { useMemo, useState, useEffect } from "react";
import { FeatureFlagsEditor } from "@/components/feature-flags/FeatureFlagsEditor";

async function fetchWithRetry(url: string, options: RequestInit = {}, retries = 2): Promise<Response> {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fetch(url, options);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : "";
            if (attempt < retries && (message.includes("ECONNRESET") || message.includes("Failed to fetch"))) {
                await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
                continue;
            }
            throw error;
        }
    }
    throw new Error("Max retries exceeded");
}

export default function AccountPage() {
    const { user } = useAuth();
    const [checkoutLoading, setCheckoutLoading] = useState(false);
    const [checkoutError, setCheckoutError] = useState<string | null>(null);
    const [emailProvider, setEmailProvider] = useState<string>("trykitt");
    const [providerLoading, setProviderLoading] = useState(false);
    const [providerSaved, setProviderSaved] = useState(false);

    const checkoutBaseUrl = useMemo(() => {
        if (typeof window === "undefined") return "";
        const base = process.env.NEXT_PUBLIC_PIPELINE_URL || "";
        if (!base) return "";
        return base.endsWith("/") ? base.slice(0, -1) : base;
    }, []);

    useEffect(() => {
        async function loadProvider() {
            if (!user) return;
            try {
                const data = await apiJson<{ email_verification_provider?: string }>("/api/agency/settings");
                setEmailProvider(data.email_verification_provider || "trykitt");
            } catch (error) {
                console.error("Failed to load email provider preference:", error);
            }
        }
        loadProvider();
    }, [user?.id]);

    const handleSaveProvider = async () => {
        if (!user) return;
        setProviderLoading(true);
        setProviderSaved(false);
        try {
            await apiJson("/api/agency/settings", {
                method: "PATCH",
                body: JSON.stringify({ email_verification_provider: emailProvider }),
            });
            setProviderSaved(true);
            setTimeout(() => setProviderSaved(false), 3000);
        } catch (error) {
            console.error("Failed to save email provider preference:", error);
            alert("Failed to save preference. Please try again.");
        } finally {
            setProviderLoading(false);
        }
    };

    const handleSubscribe = async () => {
        if (checkoutLoading) return;
        setCheckoutError(null);
        setCheckoutLoading(true);
        try {
            if (!user) {
                throw new Error("Please sign in first.");
            }
            const token = await getAccessToken();
            if (!token) {
                throw new Error("Please sign in first.");
            }
            const endpoint = `${checkoutBaseUrl || ""}/api/stripe/checkout`;
            const resp = await fetchWithRetry(endpoint, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({}),
            });
            const data = await resp.json();
            if (!resp.ok || !data?.url) {
                throw new Error(data?.error || "Unable to start checkout.");
            }
            window.location.href = data.url as string;
        } catch (error) {
            const message = error instanceof Error ? error.message : "Checkout failed.";
            setCheckoutError(message);
        } finally {
            setCheckoutLoading(false);
        }
    };

    return (
        <AppShell>
            <div className="flex max-w-2xl flex-col gap-8">
                <div className="flex flex-col gap-2">
                    <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Account</p>
                    <h1 className="text-3xl font-semibold tracking-tight">Profile & Billing</h1>
                    <p className="text-muted-foreground">
                        View your login details and manage your session.
                    </p>
                </div>

                <div className="grid gap-4 sm:grid-cols-3">
                    <Card size="sm">
                        <CardHeader>
                            <CardDescription>Signed in as</CardDescription>
                            <CardTitle className="truncate text-sm font-normal">{user?.email || "—"}</CardTitle>
                        </CardHeader>
                    </Card>
                    <Card size="sm">
                        <CardHeader>
                            <CardDescription>User ID</CardDescription>
                            <CardTitle className="truncate text-sm font-normal">{user?.id || "—"}</CardTitle>
                        </CardHeader>
                    </Card>
                    <Card size="sm">
                        <CardHeader>
                            <CardDescription>Email confirmed</CardDescription>
                            <CardTitle className="text-sm font-normal">
                                {user?.email_confirmed_at ? "Yes" : "No — check your inbox"}
                            </CardTitle>
                        </CardHeader>
                    </Card>
                </div>

                {checkoutError && (
                    <Alert variant="destructive">
                        <AlertDescription>{checkoutError}</AlertDescription>
                    </Alert>
                )}

                <Separator />

                <div className="flex flex-col gap-4">
                    <div>
                        <h2 className="text-lg font-semibold">Email Verification Provider</h2>
                        <p className="text-sm text-muted-foreground">
                            Choose which service to use for email verification during pipeline runs.
                        </p>
                    </div>

                    <RadioGroup
                        value={emailProvider}
                        onValueChange={setEmailProvider}
                        className="max-w-lg gap-3"
                    >
                        <Label
                            htmlFor="trykitt"
                            className="flex cursor-pointer items-start gap-3 rounded-lg border p-4 font-normal has-data-[state=checked]:border-primary has-data-[state=checked]:bg-primary/5"
                        >
                            <RadioGroupItem value="trykitt" id="trykitt" className="mt-0.5" />
                            <div className="grid gap-1">
                                <span className="font-medium">TryKitt</span>
                                <span className="text-sm text-muted-foreground">
                                    Cloud-based email verification service (requires API key in vault)
                                </span>
                            </div>
                        </Label>

                        <Label
                            htmlFor="self_hosted"
                            className="flex cursor-pointer items-start gap-3 rounded-lg border p-4 font-normal has-data-[state=checked]:border-primary has-data-[state=checked]:bg-primary/5"
                        >
                            <RadioGroupItem value="self_hosted" id="self_hosted" className="mt-0.5" />
                            <div className="grid gap-1">
                                <span className="font-medium">Self-Hosted Verifier</span>
                                <span className="text-sm text-muted-foreground">
                                    Use the self-hosted email verification service (no API key required)
                                </span>
                            </div>
                        </Label>
                    </RadioGroup>

                    <div className="flex flex-col gap-3">
                        <Button
                            type="button"
                            className="w-fit"
                            onClick={handleSaveProvider}
                            disabled={providerLoading}
                        >
                            {providerLoading ? "Saving..." : "Save Preference"}
                        </Button>

                        {providerSaved && (
                            <Alert>
                                <AlertDescription>
                                    Email verification provider saved successfully.
                                </AlertDescription>
                            </Alert>
                        )}
                    </div>
                </div>

                <Separator />

                <div className="flex flex-col gap-4">
                    <div>
                        <h2 className="text-lg font-semibold">Features</h2>
                        <p className="text-sm text-muted-foreground">
                            Which optional features and tuning values are enabled for your agency.
                        </p>
                    </div>
                    {user && <FeatureFlagsEditor />}
                </div>
            </div>
        </AppShell>
    );
}

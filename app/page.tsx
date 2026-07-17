"use client";

import { ChangeEvent, FormEvent, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { ArrowRight, Plus, User } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { getAccessToken } from "@/lib/supabase/session";
import { createClient as createClientApi, getPipelineBaseUrl } from "@/lib/pipeline/client";
import AppShell from "@/components/app-shell";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { PipelineJob } from "@/lib/pipeline/types";

type Niche = {
  id: string;
  label: string;
  detail: string;
  icon: string;
  hint: string;
};

const API_KEY_FIELDS = ["openai", "serper", "kitt"] as const;
type ApiKeyName = (typeof API_KEY_FIELDS)[number];
const FIRESTORE_FIELD_MAP: Record<ApiKeyName, string> = {
  openai: "openai_key",
  serper: "serper_key",
  kitt: "trykitt_key",
};
const API_KEY_LABELS: Record<ApiKeyName, string> = {
  openai: "OpenAI",
  serper: "Serper",
  kitt: "TryKitt",
};
type ApiKeyState = Record<ApiKeyName, string>;


type VaultMessage = {
  tone: "idle" | "success" | "error";
  text: string;
};

const createEmptyKeys = (): ApiKeyState => ({
  openai: "",
  serper: "",
  kitt: "",
});

async function hashKeyValue(value: string) {
  const cryptoImpl = typeof globalThis.crypto === "undefined" ? null : globalThis.crypto;
  if (!cryptoImpl?.subtle) {
    throw new Error("Secure hashing is unavailable in this environment.");
  }
  const encoded = new TextEncoder().encode(value);
  const digest = await cryptoImpl.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function createFingerprintMap(keys: ApiKeyState): Promise<ApiKeyState> {
  const hashedEntries = await Promise.all(
    API_KEY_FIELDS.map(async (key) => {
      const value = keys[key];
      if (!value) {
        return [key, ""] as const;
      }
      const hash = await hashKeyValue(value);
      return [key, hash] as const;
    }),
  );

  return hashedEntries.reduce<ApiKeyState>((acc, [key, hash]) => {
    acc[key] = hash;
    return acc;
  }, createEmptyKeys());
}

type AgencySettingsPayload = {
  openai_key?: string;
  serper_key?: string;
  trykitt_key?: string;
  trykitt_paid_account?: boolean;
};

const readKeysFromAgencySettings = (
  data: AgencySettingsPayload | null | undefined,
): ApiKeyState => ({
  openai: data?.openai_key || "",
  serper: data?.serper_key || "",
  kitt: data?.trykitt_key || "",
});

// Absent flag = paid, matching the server's isTryKittPaidAccount default.
const readTryKittPaidFromAgencySettings = (
  data: AgencySettingsPayload | null | undefined,
): boolean => data?.trykitt_paid_account !== false;

function HomeContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { user, loading } = useAuth();
  const agencyId = user?.id ?? "";
  const [apiKeys, setApiKeys] = useState<ApiKeyState>(() => createEmptyKeys());
  const [lastSavedKeys, setLastSavedKeys] = useState<ApiKeyState>(() => createEmptyKeys());
  const [kittPaidAccount, setKittPaidAccount] = useState(true);
  const [lastSavedKittPaidAccount, setLastSavedKittPaidAccount] = useState(true);
  const [vaultModalOpen, setVaultModalOpen] = useState(false);
  const [clientModalOpen, setClientModalOpen] = useState(false);
  const [newClientName, setNewClientName] = useState("");
  const [newClientIndustry, setNewClientIndustry] = useState<Niche["id"]>("ecom");
  const [newClientInstantlyKey, setNewClientInstantlyKey] = useState("");
  const [clientSaving, setClientSaving] = useState(false);
  const [clientMessage, setClientMessage] = useState<VaultMessage>({ tone: "idle", text: "" });
  const [vaultSaving, setVaultSaving] = useState(false);
  const [vaultLoading, setVaultLoading] = useState(false);
  const [vaultMessage, setVaultMessage] = useState<VaultMessage>({ tone: "idle", text: "" });
  const [jobState, setJobState] = useState<PipelineJob | null>(null);
  const [jobClientName, setJobClientName] = useState<string>("");
  const [jobClientId, setJobClientId] = useState<string>("");
  const [clients, setClients] = useState<Array<{ id: string; name: string }>>([]);
  const [companyCountsByClient, setCompanyCountsByClient] = useState<Record<string, number>>({});
  const [companyCountsLoadingByClient, setCompanyCountsLoadingByClient] = useState<Record<string, boolean>>({});
  const shouldShowKeys = searchParams?.get("showKeys") === "1";

  useEffect(() => {
    setVaultModalOpen(shouldShowKeys);
    if (!shouldShowKeys) {
      setApiKeys(lastSavedKeys);
      setVaultMessage({ tone: "idle", text: "" });
    }
  }, [shouldShowKeys, lastSavedKeys]);

  const closeVaultModal = useCallback(() => {
    setVaultModalOpen(false);
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (params.has("showKeys")) {
      params.delete("showKeys");
      const queryString = params.toString();
      router.replace(queryString ? `${pathname}?${queryString}` : pathname, { scroll: false });
    }
  }, [pathname, router, searchParams]);

  const handleKeyChange = (event: ChangeEvent<HTMLInputElement>, key: ApiKeyName) => {
    if (vaultMessage.tone !== "idle") {
      setVaultMessage({ tone: "idle", text: "" });
    }
    setApiKeys((prev) => ({
      ...prev,
      [key]: event.target.value,
    }));
  };

  useEffect(() => {
    if (!loading && !user) {
      router.replace("/auth");
    }
  }, [loading, user, router]);

  const clientIdsKey = useMemo(
    () => clients.map((c) => c.id).filter(Boolean).sort().join(","),
    [clients]
  );

  // One batched request for all client company counts (not N parallel calls).
  useEffect(() => {
    if (!user?.id || !clientIdsKey) {
      setCompanyCountsByClient({});
      setCompanyCountsLoadingByClient({});
      return;
    }

    let cancelled = false;
    const clientIds = clientIdsKey.split(",");

    const loadingByClient = clientIds.reduce<Record<string, boolean>>((acc, id) => {
      acc[id] = true;
      return acc;
    }, {});
    setCompanyCountsLoadingByClient(loadingByClient);

    (async () => {
      try {
        const token = await getAccessToken();
        if (!token || cancelled) return;

        const params = new URLSearchParams({ clientIds: clientIdsKey });
        const response = await fetch(
          `${getPipelineBaseUrl()}/api/stats/companies-counts?${params}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
          }
        );
        const payload = response.ok
          ? ((await response.json()) as { counts?: Record<string, number> })
          : null;

        if (cancelled) return;

        const counts = payload?.counts || {};
        const loadingDone = clientIds.reduce<Record<string, boolean>>((acc, id) => {
          acc[id] = false;
          return acc;
        }, {});
        setCompanyCountsByClient(counts);
        setCompanyCountsLoadingByClient(loadingDone);
      } catch (error) {
        console.error("Failed to fetch company counts:", error);
        if (!cancelled) {
          const loadingDone = clientIds.reduce<Record<string, boolean>>((acc, id) => {
            acc[id] = false;
            return acc;
          }, {});
          setCompanyCountsByClient({});
          setCompanyCountsLoadingByClient(loadingDone);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user?.id, clientIdsKey]);

  // Resolve client name for current job by looking up clients list or fetching the doc
  useEffect(() => {
    const clientId = jobClientId || undefined;
    if (!user || !clientId) {
      setJobClientName("");
      return;
    }
    const local = clients.find((c) => c.id === clientId)?.name;
    setJobClientName(local || clientId);
  }, [jobClientId, clients, user]);

  useEffect(() => {
    if (!user) {
      setVaultLoading(false);
      setApiKeys(createEmptyKeys());
      setLastSavedKeys(createEmptyKeys());
      setCompanyCountsByClient({});
      setCompanyCountsLoadingByClient({});
      setClients([]);
      return;
    }

    let cancelled = false;
    setVaultLoading(true);

    const loadVaultKeys = async () => {
      try {
        const token = await getAccessToken();
        if (!token) {
          if (!cancelled) {
            setApiKeys(createEmptyKeys());
            setLastSavedKeys(createEmptyKeys());
          }
          return;
        }
        const response = await fetch(`${getPipelineBaseUrl()}/api/agency/settings`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const payload = response.ok ? await response.json() : null;
        const storedKeys = readKeysFromAgencySettings(payload);
        const storedPaid = readTryKittPaidFromAgencySettings(payload);
        if (!cancelled) {
          setApiKeys(storedKeys);
          setLastSavedKeys(storedKeys);
          setKittPaidAccount(storedPaid);
          setLastSavedKittPaidAccount(storedPaid);
        }
      } catch {
        if (!cancelled) {
          setVaultMessage({
            tone: "error",
            text: "Unable to load saved API keys.",
          });
        }
      } finally {
        if (!cancelled) {
          setVaultLoading(false);
        }
      }
    };

    const loadClients = async () => {
      try {
        const token = await getAccessToken();
        if (!token) {
          if (!cancelled) setClients([]);
          return;
        }
        const response = await fetch(`${getPipelineBaseUrl()}/api/clients`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const payload = response.ok ? await response.json() : null;
        const rows = Array.isArray(payload?.clients)
          ? payload.clients.map((c: { id: string; name?: string }) => ({
              id: c.id,
              name: c.name || c.id,
            }))
          : [];
        if (!cancelled) setClients(rows);
      } catch {
        if (!cancelled) setClients([]);
      }
    };

    void loadVaultKeys();
    void loadClients();

    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  const handleVaultSave = async () => {
    if (!user) {
      setVaultMessage({ tone: "error", text: "You must be signed in to save keys." });
      return;
    }

    setVaultSaving(true);
    setVaultMessage({ tone: "idle", text: "" });

    try {
      const sanitizedKeys = API_KEY_FIELDS.reduce<ApiKeyState>((acc, key) => {
        acc[key] = apiKeys[key].trim();
        return acc;
      }, createEmptyKeys());

      const token = await getAccessToken();
      if (!token) {
        throw new Error("You must be signed in to save keys.");
      }

      const response = await fetch(`${getPipelineBaseUrl()}/api/agency/settings`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          openai_key: sanitizedKeys.openai,
          serper_key: sanitizedKeys.serper,
          trykitt_key: sanitizedKeys.kitt,
          trykitt_paid_account: kittPaidAccount,
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error((payload?.error as string) || "Unable to save API keys.");
      }

      setApiKeys(sanitizedKeys);
      setLastSavedKeys(sanitizedKeys);
      setLastSavedKittPaidAccount(kittPaidAccount);
      setVaultMessage({ tone: "success", text: "Keys saved to your vault." });
    } catch (error) {
      setVaultMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "Unable to save API keys.",
      });
    } finally {
      setVaultSaving(false);
    }
  };

  const handleVaultSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await handleVaultSave();
  };

  const handleClientSave = async () => {
    if (!user) {
      setClientMessage({ tone: "error", text: "You must be signed in." });
      return;
    }
    if (!newClientName.trim()) {
      setClientMessage({ tone: "error", text: "Client name is required." });
      return;
    }
    setClientSaving(true);
    setClientMessage({ tone: "idle", text: "" });
    try {
      const token = await getAccessToken();
      if (!token) {
        throw new Error("You must be signed in.");
      }
      const created = await createClientApi({
        idToken: token,
        name: newClientName.trim(),
        industry: newClientIndustry as "ecom" | "saas" | "agency" | "local",
        instantly_key: newClientInstantlyKey.trim(),
      });
      setClients((prev) => {
        const next = prev.filter((c) => c.id !== created.id);
        next.push({ id: created.id, name: newClientName.trim() });
        return next.sort((a, b) => a.name.localeCompare(b.name));
      });
      setClientMessage({ tone: "success", text: "Client saved." });
      setClientModalOpen(false);
    } catch (error) {
      setClientSaving(false);
      setClientMessage({ tone: "error", text: error instanceof Error ? error.message : "Unable to save client." });
    }
  };

  const showVaultStatus = vaultLoading || Boolean(vaultMessage.text);
  const vaultStatusTone = vaultLoading ? "idle" : vaultMessage.tone;
  const vaultStatusText = vaultLoading ? "Loading saved keys..." : vaultMessage.text;
  const hasVaultChanges =
    API_KEY_FIELDS.some((key) => apiKeys[key] !== lastSavedKeys[key])
    || kittPaidAccount !== lastSavedKittPaidAccount;

  const openClientModal = () => {
    setClientMessage({ tone: "idle", text: "" });
    setNewClientName("");
    setNewClientIndustry("ecom");
    setNewClientInstantlyKey("");
    setClientModalOpen(true);
  };

  if (loading || !user) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 text-center">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Shield&apos;s Outbound
        </p>
        <h2 className="text-lg font-semibold">Checking access...</h2>
        <p className="text-sm text-muted-foreground">Hang tight while we confirm your session.</p>
      </div>
    );
  }

  return (
    <AppShell>
      <div className="flex flex-col gap-8">
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Good evening
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">ESSENCE Outbound</h1>
          <p className="max-w-xl text-muted-foreground">
            Kick off a fresh outbound motion. Pick a niche preset, drop your CSV, and we&apos;ll do
            the rest.
          </p>
          <Button className="mt-2 w-fit" onClick={openClientModal}>
            <Plus data-icon="inline-start" />
            Create Client
          </Button>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {clients.length === 0 ? (
            <Card className="col-span-full">
              <CardContent className="flex flex-col items-center justify-center gap-1 py-12 text-center">
                <p className="font-medium">No clients yet</p>
                <CardDescription>Use Create Client to add one.</CardDescription>
              </CardContent>
            </Card>
          ) : (
            clients.map((client) => (
              <Card
                key={client.id}
                className="cursor-pointer transition-colors hover:bg-muted/40"
                onClick={() => router.push(`/clients/${client.id}`)}
              >
                <CardHeader>
                  <div className="flex items-start gap-3">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                      <User className="size-4 text-muted-foreground" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <CardTitle className="truncate">{client.name}</CardTitle>
                      <CardDescription className="mt-2">
                        {companyCountsLoadingByClient[client.id] ? (
                          <Skeleton className="h-7 w-16" aria-label="Loading company count" />
                        ) : (
                          <span className="text-2xl font-semibold text-foreground">
                            {(companyCountsByClient[client.id] || 0).toLocaleString()}
                          </span>
                        )}
                        <span className="mt-0.5 block text-sm">companies in database</span>
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardFooter className="border-0 bg-transparent pt-0">
                  <Button variant="ghost" size="sm" className="px-0" tabIndex={-1}>
                    View leads
                    <ArrowRight data-icon="inline-end" />
                  </Button>
                </CardFooter>
              </Card>
            ))
          )}
        </div>
      </div>

      {/* Metrics grid hidden for now */}

      {/* <section className="pipeline-panel">
        <div className="pipeline-panel__header">
          <div>
            <p className="eyebrow eyebrow--muted">
              {jobState ? "Live pipeline" : "Pipeline monitor"}
            </p>
            {jobState && (
              jobClientName ? (
                <p className="pipeline-panel__client">{jobClientName}</p>
              ) : (
                <p className="pipeline-panel__client">Client ID: {(jobState as any)?.clientId || "—"}</p>
              )
            )}
            <h2 className="pipeline-panel__title">
              {jobState ? jobState.fileName : "No runs yet"}
            </h2>
            {!jobState && (
              <p className="pipeline-panel__subtitle">
                Kick off a run to see stage progress, logs, and download links.
              </p>
            )}
          </div>
        </div>
      </section> */}

      <Dialog
        open={vaultModalOpen}
        onOpenChange={(open) => {
          if (!open) closeVaultModal();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              API Vault
            </p>
            <DialogTitle>Connect Data Providers</DialogTitle>
            <DialogDescription>
              Store the keys that power scraping, enrichment, and verification.
            </DialogDescription>
          </DialogHeader>

          <form className="grid gap-4" onSubmit={handleVaultSubmit}>
            <div className="grid gap-2">
              <Label htmlFor="openai-key">OpenAI API Key</Label>
              <Input
                id="openai-key"
                type="text"
                placeholder="sk-..."
                value={apiKeys.openai}
                onChange={(event) => handleKeyChange(event, "openai")}
              />
              <p className="text-xs text-muted-foreground">Founders + first-line inference.</p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="serper-key">Serper API Key</Label>
              <Input
                id="serper-key"
                type="text"
                placeholder="serper_..."
                value={apiKeys.serper}
                onChange={(event) => handleKeyChange(event, "serper")}
              />
              <p className="text-xs text-muted-foreground">Automating Google searches at scale</p>
            </div>
            <div className="grid gap-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="kitt-key">Kitt API Key</Label>
                <Label
                  htmlFor="kitt-paid-account"
                  className="flex cursor-pointer items-center gap-1.5 text-xs font-normal text-muted-foreground"
                >
                  <input
                    id="kitt-paid-account"
                    type="checkbox"
                    className="size-3.5 cursor-pointer accent-primary"
                    checked={kittPaidAccount}
                    onChange={(event) => {
                      if (vaultMessage.tone !== "idle") {
                        setVaultMessage({ tone: "idle", text: "" });
                      }
                      setKittPaidAccount(event.target.checked);
                    }}
                  />
                  Paid Account
                </Label>
              </div>
              <Input
                id="kitt-key"
                type="text"
                placeholder="kitt_..."
                value={apiKeys.kitt}
                onChange={(event) => handleKeyChange(event, "kitt")}
              />
              <p className="text-xs text-muted-foreground">
                Email finding + verification.
                {!kittPaidAccount
                  ? " Free-tier keys are throttled to 2 concurrent requests at 20/min."
                  : ""}
              </p>
            </div>
            {showVaultStatus && (
              <Alert variant={vaultStatusTone === "error" ? "destructive" : "default"}>
                <AlertDescription>{vaultStatusText}</AlertDescription>
              </Alert>
            )}
            <DialogFooter className="border-0 bg-transparent p-0 sm:justify-end">
              <Button
                type="submit"
                variant={hasVaultChanges ? "default" : "secondary"}
                disabled={vaultSaving || vaultLoading}
                aria-busy={vaultSaving}
              >
                {vaultSaving ? "Saving..." : "Save to Vault"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={clientModalOpen} onOpenChange={setClientModalOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Client
            </p>
            <DialogTitle>Create Client</DialogTitle>
            <DialogDescription>
              Enter client name, Instantly API key, and industry.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="client-name">Client Name</Label>
              <Input
                id="client-name"
                type="text"
                placeholder="Acme Co"
                value={newClientName}
                onChange={(e) => setNewClientName(e.target.value)}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="client-industry">Industry</Label>
              <Select
                value={newClientIndustry}
                onValueChange={(value) => setNewClientIndustry(value as Niche["id"])}
              >
                <SelectTrigger id="client-industry" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ecom">E-commerce</SelectItem>
                  <SelectItem value="saas">SaaS</SelectItem>
                  <SelectItem value="agency">Agency</SelectItem>
                  <SelectItem value="local">Local Biz</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="instantly-key">Instantly API Key</Label>
              <Input
                id="instantly-key"
                type="text"
                placeholder="instantly_..."
                value={newClientInstantlyKey}
                onChange={(e) => setNewClientInstantlyKey(e.target.value)}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
              />
              <p className="text-xs text-muted-foreground">Used to route leads into Instantly.</p>
            </div>

            {clientMessage.text && (
              <Alert variant={clientMessage.tone === "error" ? "destructive" : "default"}>
                <AlertDescription>{clientMessage.text}</AlertDescription>
              </Alert>
            )}

            <DialogFooter className="border-0 bg-transparent p-0 sm:justify-end">
              <Button
                type="button"
                disabled={clientSaving}
                aria-busy={clientSaving}
                onClick={handleClientSave}
              >
                {clientSaving ? "Saving..." : "Save Client"}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}

export default function Home() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen flex-col items-center justify-center gap-3 text-center">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Shields Outbound
          </p>
          <h2 className="text-lg font-semibold">Loading...</h2>
          <p className="text-sm text-muted-foreground">Preparing your workspace.</p>
        </div>
      }
    >
      <HomeContent />
    </Suspense>
  );
}

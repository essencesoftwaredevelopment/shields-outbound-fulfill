"use client";

import { ChangeEvent, FormEvent, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { createPortal } from "react-dom";
import { useAuth } from "@/hooks/use-auth";
import { getAccessToken } from "@/lib/supabase/session";
import { createClient as createClientApi, getPipelineBaseUrl } from "@/lib/pipeline/client";
import AppShell from "@/components/app-shell";
import {
  PipelineJob,
  PipelineStageKey,
  PipelineStageState,
  PipelineStageStatus,
} from "@/lib/pipeline/types";

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

const readKeysFromAgencySettings = (data: {
  openai_key?: string;
  serper_key?: string;
  trykitt_key?: string;
} | null | undefined): ApiKeyState => ({
  openai: data?.openai_key || "",
  serper: data?.serper_key || "",
  kitt: data?.trykitt_key || "",
});

function HomeContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { user, loading } = useAuth();
  const agencyId = user?.id ?? "";
  const [apiKeys, setApiKeys] = useState<ApiKeyState>(() => createEmptyKeys());
  const [lastSavedKeys, setLastSavedKeys] = useState<ApiKeyState>(() => createEmptyKeys());
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
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [toastVisible, setToastVisible] = useState(false);
  const [clients, setClients] = useState<Array<{ id: string; name: string }>>([]);
  const [companyCountsByClient, setCompanyCountsByClient] = useState<Record<string, number>>({});
  const [companyCountsLoadingByClient, setCompanyCountsLoadingByClient] = useState<Record<string, boolean>>({});
  const shouldShowKeys = searchParams?.get("showKeys") === "1";

  const showToast = useCallback((message: string) => {
    setToastMessage(message);
    setToastVisible(true);
  }, [setToastMessage, setToastVisible]);

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
    if (!toastVisible || !toastMessage) {
      return;
    }
    const timer = setTimeout(() => {
      setToastVisible(false);
      setTimeout(() => setToastMessage(null), 300);
    }, 5000);
    return () => clearTimeout(timer);
  }, [toastVisible, toastMessage]);

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
        if (!cancelled) {
          setApiKeys(storedKeys);
          setLastSavedKeys(storedKeys);
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
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error((payload?.error as string) || "Unable to save API keys.");
      }

      setApiKeys(sanitizedKeys);
      setLastSavedKeys(sanitizedKeys);
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
  const hasVaultChanges = API_KEY_FIELDS.some((key) => apiKeys[key] !== lastSavedKeys[key]);
  const vaultButtonClass = `secondary-button${hasVaultChanges ? " secondary-button--active" : ""}`;

  if (loading || !user) {
    return (
      <div className="auth-gate">
        <p className="eyebrow">Shield&apos;s Outbound</p>
        <h2>Checking access...</h2>
        <p className="auth-card__subtitle">Hang tight while we confirm your session.</p>
      </div>
    );
  }

  return (
    <AppShell>
      <section className="hero-panel">
        <div className="hero-panel__layout">
          <div className="hero-panel__content">
            <p className="eyebrow">Good evening</p>
            <h1 className="hero-panel__title">ESSENCE Outbound</h1>
            <p className="hero-panel__description">
              Kick off a fresh outbound motion.
              Pick a niche preset, drop your CSV, and we&apos;ll do the rest.
            </p>
            <div className="modal__actions" style={{ marginTop: "1rem" }}>
              <button
                type="button"
                className="primary-button"
                onClick={() => {
                  setClientMessage({ tone: "idle", text: "" });
                  setNewClientName("");
                  setNewClientIndustry("ecom");
                  setNewClientInstantlyKey("");
                  setClientModalOpen(true);
                }}
              >
                Create Client
              </button>
            </div>
          </div>
        </div>


        <div className="niche-grid">
          {clients.length === 0 ? (
            <div className="pipeline-panel__empty">
              <p>No clients yet.</p>
              <p className="pipeline-panel__subtitle">Use Create Client to add one.</p>
            </div>
          ) : (
            clients.map((client) => (
              <div key={client.id} className="niche-card" style={{ position: 'relative' }}>
                <button
                  type="button"
                  onClick={() => router.push(`/clients/${client.id}`)}
                  style={{ border: 'none', background: 'none', padding: 0, width: '100%', textAlign: 'left', cursor: 'pointer' }}
                >
                  <span className="niche-card__icon" aria-hidden>
                    👤
                  </span>
                  <div className="niche-card__text">
                    <p className="niche-card__label">{client.name}</p>
                    <p className="niche-card__detail">
                      {companyCountsLoadingByClient[client.id] ? (
                        <span
                          className="card-big-data card-big-data--loading spinner"
                          aria-label="Loading company count"
                          role="status"
                        />
                      ) : (
                        <strong className="card-big-data">{(companyCountsByClient[client.id] || 0).toLocaleString()}</strong>
                      )}
                      <br />
                      companies in database
                    </p>
                  </div>
                  <span className="niche-card__cta">View leads →</span>
                </button>
              </div>
            ))
          )}
        </div>
      </section>

      {/* Metrics grid hidden for now */}

      <section className="pipeline-panel">
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
      </section>

      {
        vaultModalOpen && (
          <div
            className="modal-overlay"
            role="dialog"
            aria-modal="true"
            onClick={closeVaultModal}
          >
            <div className="modal modal--vault" onClick={(event) => event.stopPropagation()}>
              <div className="modal__header">
                <div>
                  <p className="eyebrow eyebrow--muted">API Vault</p>
                  <h2 className="modal__title">Connect Data Providers</h2>
                  <p className="modal__description">
                    Store the keys that power scraping, enrichment, and verification. Keys stay local for now—wire up the
                    secure vault service when you are ready.
                  </p>
                </div>
              </div>

              <form className="modal__body" onSubmit={handleVaultSubmit}>
                <label className="settings-field">
                  <span className="settings-field__label">OpenAI API Key</span>
                  <input
                    type="password"
                    placeholder="sk-..."
                    value={apiKeys.openai}
                    onChange={(event) => handleKeyChange(event, "openai")}
                  />
                  <span className="settings-field__hint">Founders + first-line inference.</span>
                  {/* <span className="settings-field__meta">{fingerprintLabel("openai")}</span> */}
                </label>
                <label className="settings-field">
                  <span className="settings-field__label">Serper API Key</span>
                  <input
                    type="password"
                    placeholder="serper_..."
                    value={apiKeys.serper}
                    onChange={(event) => handleKeyChange(event, "serper")}
                  />
                  <span className="settings-field__hint">Automating Google searches at scale</span>
                  {/* <span className="settings-field__meta">{fingerprintLabel("serper")}</span> */}
                </label>
                <label className="settings-field">
                  <span className="settings-field__label">Kitt API Key</span>
                  <input
                    type="password"
                    placeholder="kitt_..."
                    value={apiKeys.kitt}
                    onChange={(event) => handleKeyChange(event, "kitt")}
                  />
                  <span className="settings-field__hint">Email finding + verification.</span>
                  {/* <span className="settings-field__meta">{fingerprintLabel("kitt")}</span> */}
                </label>
                {showVaultStatus && (
                  <p className={`vault-status vault-status--${vaultStatusTone}`} aria-live="polite">
                    {vaultStatusText}
                  </p>
                )}
                <div className="modal__actions modal__actions--end">
                  <button
                    type="submit"
                    className={vaultButtonClass}
                    disabled={vaultSaving || vaultLoading}
                    aria-busy={vaultSaving}
                  >
                    {vaultSaving ? "Saving..." : "Save to Vault"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )
      }

      {
        clientModalOpen && (
          <div
            className="modal-overlay"
            role="dialog"
            aria-modal="true"
            onClick={() => setClientModalOpen(false)}
          >
            <div className="modal" onClick={(event) => event.stopPropagation()}>
              <div className="modal__header">
                <div>
                  <p className="eyebrow eyebrow--muted">Client</p>
                  <h2 className="modal__title">Create Client</h2>
                  <p className="modal__description">Enter client name, Instantly API key, and industry.</p>
                </div>
              </div>

              <div className="modal__body">
                <label className="settings-field">
                  <span className="settings-field__label">Client Name</span>
                  <input
                    type="text"
                    placeholder="Acme Co"
                    value={newClientName}
                    onChange={(e) => setNewClientName(e.target.value)}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                  />
                </label>

                <label className="settings-field">
                  <span className="settings-field__label">Industry</span>
                  <select
                    value={newClientIndustry}
                    onChange={(e) => setNewClientIndustry(e.target.value as Niche["id"])}
                  >
                    <option value="ecom">E-commerce</option>
                    <option value="saas">SaaS</option>
                    <option value="agency">Agency</option>
                    <option value="local">Local Biz</option>
                  </select>
                </label>

                <label className="settings-field">
                  <span className="settings-field__label">Instantly API Key</span>
                  <input
                    type="password"
                    placeholder="instantly_..."
                    value={newClientInstantlyKey}
                    onChange={(e) => setNewClientInstantlyKey(e.target.value)}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                  />
                  <span className="settings-field__hint">Used to route leads into Instantly.</span>
                </label>

                {clientMessage.text && (
                  <p className={`vault-status vault-status--${clientMessage.tone}`} aria-live="polite">
                    {clientMessage.text}
                  </p>
                )}

                <div className="modal__actions modal__actions--end">
                  <button
                    type="button"
                    className="secondary-button secondary-button--active"
                    disabled={clientSaving}
                    aria-busy={clientSaving}
                    onClick={handleClientSave}
                  >
                    {clientSaving ? "Saving..." : "Save Client"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )
      }

      {toastVisible && toastMessage && (
        <div
          className="toast"
          role="status"
          aria-live="polite"
          style={{
            position: 'fixed',
            bottom: '24px',
            right: '24px',
            background: '#1f2937',
            color: '#f9fafb',
            padding: '16px 20px',
            borderRadius: '8px',
            boxShadow: '0 10px 25px rgba(0, 0, 0, 0.3)',
            maxWidth: '420px',
            zIndex: 10000,
            fontSize: '14px',
            lineHeight: '1.5',
            animation: 'slideIn 0.3s ease-out',
          }}
        >
          {toastMessage}
        </div>
      )}
    </AppShell>
  );
}

export default function Home() {
  return (
    <Suspense fallback={
      <div className="auth-gate">
        <p className="eyebrow">Shields Outbound</p>
        <h2>Loading...</h2>
        <p className="auth-card__subtitle">Preparing your workspace.</p>
      </div>
    }>
      <HomeContent />
    </Suspense>
  );
}

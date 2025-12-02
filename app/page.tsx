"use client";

import { ChangeEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import { firestore } from "@/lib/firebase/firestore";

type Niche = {
  id: string;
  label: string;
  detail: string;
  icon: string;
  hint: string;
};

const API_KEY_FIELDS = ["openai", "serper", "kitt"] as const;
type ApiKeyName = (typeof API_KEY_FIELDS)[number];
type ApiKeyState = Record<ApiKeyName, string>;

type VaultMessage = {
  tone: "idle" | "success" | "error";
  text: string;
};

function createEmptyKeys(): ApiKeyState {
  return API_KEY_FIELDS.reduce((acc, key) => {
    acc[key] = "";
    return acc;
  }, {} as ApiKeyState);
}

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

export default function Home() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const [activeNiche, setActiveNiche] = useState<Niche | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [apiKeys, setApiKeys] = useState<ApiKeyState>(() => createEmptyKeys());
  const [savedFingerprints, setSavedFingerprints] = useState<ApiKeyState>(() => createEmptyKeys());
  const [vaultModalOpen, setVaultModalOpen] = useState(false);
  const [selectedClient, setSelectedClient] = useState("");
  const [vaultSaving, setVaultSaving] = useState(false);
  const [vaultLoading, setVaultLoading] = useState(false);
  const [vaultMessage, setVaultMessage] = useState<VaultMessage>({ tone: "idle", text: "" });

  const clients = useMemo(
    () => [
      { id: "client-1", name: "Aurora Retail" },
      { id: "client-2", name: "Northwind SaaS" },
      { id: "client-3", name: "Beacon Agency" },
    ],
    [],
  );

  const niches = useMemo<Niche[]>(
    () => [
      {
        id: "ecom",
        label: "E-commerce",
        detail: "Shopify optimized",
        icon: "🛍️",
        hint: "Get ecommerce signals and product info.",
      },
      {
        id: "saas",
        const handleKeyChange = (event: ChangeEvent<HTMLInputElement>, key: ApiKeyName) => {
          if (vaultMessage.tone !== "idle") {
            setVaultMessage({ tone: "idle", text: "" });
          }
          hint: "Get feature benefits and marketing info.",
      },
      {
        id: "agency",
        label: "Agency",

        const fetchVaultKeys = async () => {
          if (!user) {
            setApiKeys(createEmptyKeys());
            setSavedFingerprints(createEmptyKeys());
            return;
          }

          setVaultLoading(true);
          try {
            const vaultRef = doc(firestore, "users", user.uid);
            const snapshot = await getDoc(vaultRef);
            if (!snapshot.exists()) {
              setSavedFingerprints(createEmptyKeys());
              return;
            }

            const data = snapshot.data();
            const storedKeys = (data.apiKeys ?? {}) as Partial<ApiKeyState>;
            const storedHashes = (data.apiKeyHashes ?? {}) as Partial<ApiKeyState>;

            setApiKeys({
              openai: storedKeys.openai ?? "",
              serper: storedKeys.serper ?? "",
              kitt: storedKeys.kitt ?? "",
            });
            setSavedFingerprints({
              openai: storedHashes.openai ?? "",
              serper: storedHashes.serper ?? "",
              kitt: storedHashes.kitt ?? "",
            });
          } catch (error) {
            setVaultMessage({
              tone: "error",
              text: "Unable to load saved API keys.",
            });
          } finally {
            setVaultLoading(false);
          }
        };

        useEffect(() => {
    void fetchVaultKeys();
  }, [user]);

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

      const hashedEntries = await Promise.all(
        API_KEY_FIELDS.map(async (key) => {
          const value = sanitizedKeys[key];
          if (!value) {
            return [key, ""] as const;
          }
          const hash = await hashKeyValue(value);
          return [key, hash] as const;
        }),
      );

      const hashPayload = hashedEntries.reduce<ApiKeyState>((acc, [key, hash]) => {
        acc[key] = hash;
        return acc;
      }, createEmptyKeys());

      const vaultRef = doc(firestore, "users", user.uid);

      await setDoc(
        vaultRef,
        {
          apiKeys: sanitizedKeys,
          apiKeyHashes: hashPayload,
          vaultUpdatedAt: serverTimestamp(),
        },
        { merge: true },
      );

      setApiKeys(sanitizedKeys);
      setSavedFingerprints(hashPayload);
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

  const fingerprintLabel = (key: ApiKeyName) => {
    const hash = savedFingerprints[key];
    if (!hash) {
      return "No saved fingerprint yet.";
    }
    return `Fingerprint · ${hash.slice(0, 8)}…${hash.slice(-6)}`;
  };
  detail: "Service business focus",
    icon: "🏢",
      hint: "Get service offerings, client types, and current client names",
      },
{
  id: "local",
    label: "Local Biz",
      detail: "Geo-specific focus",
        icon: "🔧",
          hint: "Get location-based info and local market details.",
      },
    ],
[]
  );

const handleCardClick = (niche: Niche) => {
  setActiveNiche(niche);
  setModalOpen(true);
  setSelectedFile(null);
};

const closeModal = () => {
  setModalOpen(false);
  setActiveNiche(null);
  setSelectedFile(null);
};

const openVaultModal = () => setVaultModalOpen(true);
const closeVaultModal = () => setVaultModalOpen(false);

const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
  const file = event.target.files?.[0] ?? null;
  setSelectedFile(file);
};

const uploadDisabled = !selectedFile || !selectedClient.trim();

const handleKeyChange = (
  event: ChangeEvent<HTMLInputElement>,
  key: keyof typeof apiKeys,
) => {
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
  <div className="dashboard">
    <aside className="sidebar">
      <div className="sidebar__brand">
        <span className="sidebar__tag">{new Date().toLocaleDateString()}</span>
        {/* <h3>Quick Links</h3> */}
      </div>
      <div className="sidebar__nav">
        <button type="button" className="sidebar__btn" onClick={openVaultModal}>
          🔑  Keys
        </button>
      </div>
      <button
        type="button"
        className="sidebar__settings"
        disabled
        aria-disabled="true"
        title="Workspace settings coming soon"
      >
        Settings
      </button>
    </aside>

    <div className="dashboard__inner">
      <div className="dashboard__content">
        <section className="hero-panel">
          <div className="hero-panel__layout">
            <div className="hero-panel__content">
              <p className="eyebrow">Good evening, Jacques</p>
              <h1 className="hero-panel__title">New Pipeline</h1>
              <p className="hero-panel__description">
                Kick off a fresh outbound motion.
                Pick a niche preset, drop your CSV, and we'll do the rest.
              </p>
            </div>
          </div>

          <div className="niche-grid">
            {niches.map((niche) => (
              <button
                type="button"
                key={niche.id}
                onClick={() => handleCardClick(niche)}
                className="niche-card"
              >
                <span className="niche-card__icon" aria-hidden>
                  {niche.icon}
                </span>
                <div className="niche-card__text">
                  <p className="niche-card__label">{niche.label}</p>
                  <p className="niche-card__detail">{niche.detail}</p>
                </div>
                <span className="niche-card__cta">Upload CSV →</span>
              </button>
            ))}
          </div>
        </section>

        {/* <section className="metrics-grid">
          <div className="metric-card">
            <p className="metric-card__label">Throughput</p>
            <p className="metric-card__value">218</p>
            <p className="metric-card__hint">Leads processed in the past 24h.</p>
          </div>
          <div className="metric-card">
            <p className="metric-card__label">Warm Replies</p>
            <p className="metric-card__value metric-card__value--success">37</p>
            <p className="metric-card__hint">Queued for AE follow-up.</p>
          </div>
          <div className="metric-card">
            <p className="metric-card__label">Health</p>
            <p className="metric-card__value metric-card__value--warning">92%</p>
            <p className="metric-card__hint">Deliverability baseline vs SLA.</p>
          </div>
        </section> */}
      </div>
    </div>

    {modalOpen && activeNiche && (
      <div
        className="modal-overlay"
        role="dialog"
        aria-modal="true"
        onClick={closeModal}
      >
        <div className="modal" onClick={(event) => event.stopPropagation()}>
          <div className="modal__header">
            <div>
              <p className="eyebrow eyebrow--muted">{activeNiche.detail}</p>
              <h2 className="modal__title">{activeNiche.icon}  {activeNiche.label} · Upload CSV</h2>
              <p className="modal__description">{activeNiche.hint}</p>
            </div>
          </div>

          <div className="modal__body">
            <label className="settings-field">
              <span className="settings-field__label">Client Account</span>
              <select
                value={selectedClient}
                onChange={(event) => setSelectedClient(event.target.value)}
              >
                <option value="">Select client...</option>
                {clients.map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.name}
                  </option>
                ))}
              </select>
              <span className="settings-field__hint">Route leads into the client’s Instantly workspace.</span>
            </label>

            <label className="upload-area">
              <span className="upload-area__title">Drop CSV or click to browse</span>
              <span className="upload-area__hint">Max 50k rows · UTF-8</span>
              {selectedFile && (
                <span className="upload-area__file" title={selectedFile.name}>
                  {selectedFile.name}
                </span>
              )}
              <input
                type="file"
                accept=".csv"
                className="sr-only"
                onChange={handleFileChange}
                      <span className="settings-field__meta">{fingerprintLabel("openai")}</span>
                />
            </label>
            <div className="modal__actions">
              <button
                type="button"
                className="primary-button"
                disabled={uploadDisabled}
                aria-disabled={uploadDisabled}
              >
                Upload & Validate
                <span className="settings-field__meta">{fingerprintLabel("serper")}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    )}

    {vaultModalOpen && (
        <div
          className="modal-overlay"
                      <span className="settings-field__meta">{fingerprintLabel("kitt")}</span>
          role="dialog"
    {(vaultLoading || vaultMessage.text) && (
      <p
        className={`vault-status vault-status--${vaultLoading ? "idle" : vaultMessage.tone}`}
        aria-live="polite"
      >
        {vaultLoading ? "Loading saved keys..." : vaultMessage.text}
      </p>
    )}
    aria-modal="true"
    <button
      type="submit"
      className="secondary-button"
      disabled={vaultSaving || vaultLoading}
      aria-busy={vaultSaving}
    >
      {vaultSaving ? "Saving..." : "Save to Vault"}
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

        <form className="modal__body" onSubmit={(event) => event.preventDefault()}>
          <label className="settings-field">
            <span className="settings-field__label">OpenAI API Key</span>
            <input
              type="password"
              placeholder="sk-..."
              value={apiKeys.openai}
              onChange={(event) => handleKeyChange(event, "openai")}
            />
            <span className="settings-field__hint">Add AI capabilities</span>
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
          </label>
          <label className="settings-field">
            <span className="settings-field__label">Kitt API Key</span>
            <input
              type="password"
              placeholder="kitt_..."
              value={apiKeys.kitt}
              onChange={(event) => handleKeyChange(event, "kitt")}
            />
            <span className="settings-field__hint">Email finding and verification.</span>
          </label>
          <div className="modal__actions modal__actions--end">
            <button type="button" className="secondary-button" disabled>
              Save to Vault (Coming Soon)
            </button>
          </div>
        </form>
      </div>
  </div>
)}
    </div >
  );
}

"use client";

import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { doc, getDoc, serverTimestamp, setDoc, collection, getDocs, deleteDoc, onSnapshot } from "firebase/firestore";
import { getIdToken, signOut } from "firebase/auth";
import { firebaseAuth } from "@/lib/firebase/auth";
import { useAuth } from "@/hooks/use-auth";
import { firestore } from "@/lib/firebase/firestore";
import { createPipelineJob, getJobResultUrl, getJobStreamUrl } from "@/lib/pipeline/client";
import AppShell from "@/components/app-shell";
import {
  PipelineJob,
  PipelineLogEntry,
  PipelineServerEvent,
  PipelineStageKey,
  PipelineStageState,
  PipelineStageStatus,
} from "@/lib/pipeline/types";
import { log } from "util";

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
type ApiKeyState = Record<ApiKeyName, string>;

const STAGE_ORDER: PipelineStageKey[] = ["founders", "emailDiscovery", "verification", "personalization"];
const STAGE_METADATA: Record<PipelineStageKey, { title: string; detail: string }> = {
  founders: {
    title: "Founder Finder",
    detail: "Serper batches + OpenAI reasoning",
  },
  emailDiscovery: {
    title: "Email Discovery",
    detail: "TryKitt find_email automation",
  },
  verification: {
    title: "Verification",
    detail: "TryKitt verify_email final pass",
  },
  personalization: {
    title: "Personalization",
    detail: "Shopify detection + AI first-lines",
  },
};

type JobStatus = PipelineJob["status"];
type StageStatus = PipelineStageStatus;

const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  error: "Error",
};

const STAGE_STATUS_LABELS: Record<StageStatus, string> = {
  pending: "Pending",
  running: "Running",
  completed: "Completed",
  error: "Error",
};

const formatJobStatus = (status?: JobStatus) => (status ? JOB_STATUS_LABELS[status] : "Idle");

const formatStageStatus = (status?: StageStatus) => (status ? STAGE_STATUS_LABELS[status] : "Pending");

const humanizeKey = (value: string) =>
  value
    .replace(/[_-]/g, " ")
    .replace(/\b(\w)/g, (match) => match.toUpperCase());

const describeStageProgress = (stage?: PipelineStageState) => {
  if (!stage) {
    return "Awaiting scheduler.";
  }
  const processed = typeof stage.progress?.processed === "number" ? stage.progress.processed : null;
  const total = typeof stage.progress?.total === "number" ? stage.progress.total : null;

  if (processed !== null && total) {
    return `${processed.toLocaleString()} / ${total.toLocaleString()} processed`;
  }

  const stats = stage.progress?.stats;
  if (stats && Object.keys(stats).length > 0) {
    const summary = Object.entries(stats)
      .filter(([, value]) => typeof value === "number")
      .slice(0, 3)
      .map(([key, value]) => `${humanizeKey(key)}: ${value}`)
      .join(" • ");
    if (summary) {
      return summary;
    }
  }

  if (stage.status === "completed") {
    return "Stage completed.";
  }

  if (stage.status === "running") {
    return "Running...";
  }

  if (stage.status === "error") {
    return stage.error || "Stage failed.";
  }

  return "Queued.";
};

const extractStageSummary = (stage?: PipelineStageState) => {
  if (!stage?.summary) {
    return [] as Array<[string, unknown]>;
  }

  return Object.entries(stage.summary).slice(0, 4);
};

const formatSummaryValue = (value: unknown) => {
  if (typeof value === "number") {
    return value.toLocaleString();
  }
  if (typeof value === "string") {
    return value;
  }
  if (value === null || typeof value === "undefined") {
    return "—";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const formatLogTimestamp = (timestamp: string) => {
  if (!timestamp) {
    return "";
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
};

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

const readKeysFromSnapshot = (data: Record<string, unknown> | undefined): ApiKeyState => ({
  openai: typeof data?.[FIRESTORE_FIELD_MAP.openai] === "string" ? (data[FIRESTORE_FIELD_MAP.openai] as string) : "",
  serper: typeof data?.[FIRESTORE_FIELD_MAP.serper] === "string" ? (data[FIRESTORE_FIELD_MAP.serper] as string) : "",
  kitt: typeof data?.[FIRESTORE_FIELD_MAP.kitt] === "string" ? (data[FIRESTORE_FIELD_MAP.kitt] as string) : "",
});

export default function Home() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const [activeNiche, setActiveNiche] = useState<Niche | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [apiKeys, setApiKeys] = useState<ApiKeyState>(() => createEmptyKeys());
  const [savedFingerprints, setSavedFingerprints] = useState<ApiKeyState>(() => createEmptyKeys());
  const [lastSavedKeys, setLastSavedKeys] = useState<ApiKeyState>(() => createEmptyKeys());
  const [vaultModalOpen, setVaultModalOpen] = useState(false);
  const [clientModalOpen, setClientModalOpen] = useState(false);
  const [newClientName, setNewClientName] = useState("");
  const [newClientIndustry, setNewClientIndustry] = useState<Niche["id"]>("ecom");
  const [newClientInstantlyKey, setNewClientInstantlyKey] = useState("");
  const [clientSaving, setClientSaving] = useState(false);
  const [clientMessage, setClientMessage] = useState<VaultMessage>({ tone: "idle", text: "" });
  const [selectedClient, setSelectedClient] = useState("");
  const [dedupeStrategy, setDedupeStrategy] = useState<'skip' | 'include'>('skip');
  const [vaultSaving, setVaultSaving] = useState(false);
  const [vaultLoading, setVaultLoading] = useState(false);
  const [vaultMessage, setVaultMessage] = useState<VaultMessage>({ tone: "idle", text: "" });
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [jobState, setJobState] = useState<PipelineJob | null>(null);
  const [jobClientName, setJobClientName] = useState<string>("");
  const [jobClientId, setJobClientId] = useState<string>("");
  // Removed live logs UI per request
  const [jobStatusMessage, setJobStatusMessage] = useState("");
  const [jobStreamConnected, setJobStreamConnected] = useState(false);
  const jobStreamRef = useRef<EventSource | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [toastVisible, setToastVisible] = useState(false);
  const [editClientModalOpen, setEditClientModalOpen] = useState(false);
  const [editingClient, setEditingClient] = useState<{ id: string; name: string } | null>(null);
  const [editClientName, setEditClientName] = useState("");
  const [editClientIndustry, setEditClientIndustry] = useState<Niche["id"]>("ecom");
  const [editClientInstantlyKey, setEditClientInstantlyKey] = useState("");
  const [editClientSaving, setEditClientSaving] = useState(false);
  const [editClientMessage, setEditClientMessage] = useState<VaultMessage>({ tone: "idle", text: "" });
  const [isDeleting, setIsDeleting] = useState(false);

  const [clients, setClients] = useState<Array<{ id: string; name: string; totalLeads?: number }>>([]);

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
        label: "SaaS",
        detail: "B2B tech focus",
        icon: "🌐",
        hint: "Get feature benefits and marketing info.",
      },
      {
        id: "agency",
        label: "Agency",
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
    [],
  );

  const handleCardClick = (niche: Niche) => {
    setActiveNiche(niche);
    setModalOpen(true);
    setSelectedFile(null);
    setUploadError("");
  };

  const closeModal = () => {
    setModalOpen(false);
    setActiveNiche(null);
    setSelectedFile(null);
    setUploadError("");
  };

  const openVaultModal = () => setVaultModalOpen(true);
  const closeVaultModal = () => {
    // set local state back to live saved keys in Firestore
    // set status messages back to idle
    setApiKeys(lastSavedKeys);
    setVaultMessage({ tone: "idle", text: "" });
    setVaultModalOpen(false);
  }

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    setSelectedFile(file);
    setUploadError("");
  };

  const uploadDisabled = !selectedFile || !selectedClient.trim() || uploading;

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
    if (toastVisible) {
      const timer = setTimeout(() => {
        setToastVisible(false);
        setTimeout(() => setToastMessage(null), 300);
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [toastVisible]);

  useEffect(() => {
    if (!loading && !user) {
      router.replace("/auth");
    }
  }, [loading, user, router]);

  // Open modals based on query params (e.g., Keys from /clients)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const showKeys = params.get('showKeys');
    const clientParam = params.get('client');
    if (showKeys === '1') {
      setVaultModalOpen(true);
      // Clean up param so back/refresh doesn't keep reopening
      const url = new URL(window.location.href);
      url.searchParams.delete('showKeys');
      window.history.replaceState({}, '', url.toString());
    }
    if (clientParam) {
      setSelectedClient(clientParam);
      setModalOpen(true);
      const url = new URL(window.location.href);
      url.searchParams.delete('client');
      window.history.replaceState({}, '', url.toString());
    }
  }, []);

  const closeJobStream = useCallback(() => {
    jobStreamRef.current?.close();
    jobStreamRef.current = null;
    setJobStreamConnected(false);
  }, []);

  useEffect(() => {
    return () => {
      closeJobStream();
    };
  }, [closeJobStream]);

  const handleServerEvent = useCallback((payload: PipelineServerEvent) => {
    if (payload.type === "state" && payload.state) {
      setJobState(payload.state);
    } else if (payload.type === "error" && payload.error) {
      setJobStatusMessage(payload.error);
    }
  }, []);

  // Resolve client name for current job by looking up clients list or fetching the doc
  useEffect(() => {
    const clientId = jobClientId || undefined;
    if (!user || !clientId) {
      setJobClientName("");
      return;
    }
    const local = clients.find((c) => c.id === clientId)?.name;
    if (local) {
      setJobClientName(local);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const clientRef = doc(firestore, "users", user.uid, "clients", clientId);
        const snap = await getDoc(clientRef);
        if (!cancelled) {
          const name = (snap.data()?.name as string) || clientId;
          setJobClientName(name);
        }
      } catch {
        if (!cancelled) setJobClientName(clientId);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobClientId, clients, user]);

  const openJobStream = useCallback(
    (jobId: string) => {
      if (!jobId) {
        return;
      }
      closeJobStream();
      setJobStatusMessage("Connecting to pipeline...");

      const stream = new EventSource(getJobStreamUrl(jobId));
      jobStreamRef.current = stream;

      stream.onopen = () => {
        setJobStreamConnected(true);
        setJobStatusMessage("Live updates streaming.");
      };

      stream.onmessage = (event) => {
        if (!event.data) {
          return;
        }
        try {
          const parsed = JSON.parse(event.data) as PipelineServerEvent;
          handleServerEvent(parsed);
        } catch (error) {
          console.warn("Unable to parse pipeline event", error);
        }
      };

      stream.onerror = () => {
        setJobStreamConnected(false);
        setJobStatusMessage("Lost connection to pipeline stream.");
        stream.close();
        jobStreamRef.current = null;
      };
    },
    [closeJobStream, handleServerEvent],
  );

  useEffect(() => {
    if (!user) {
      setVaultLoading(false);
      setApiKeys(createEmptyKeys());
      setSavedFingerprints(createEmptyKeys());
      setLastSavedKeys(createEmptyKeys());
      setClients([]);
      return;
    }

    let cancelled = false;
    setVaultLoading(true);

    const loadVaultKeys = async () => {
      try {
        const vaultRef = doc(firestore, "users", user.uid);
        const snapshot = await getDoc(vaultRef);
        if (!snapshot.exists()) {
          if (!cancelled) {
            setApiKeys(createEmptyKeys());
            setSavedFingerprints(createEmptyKeys());
            setLastSavedKeys(createEmptyKeys());
          }
          return;
        }

        const storedKeys = readKeysFromSnapshot(snapshot.data());
        const fingerprints = await createFingerprintMap(storedKeys);

        if (!cancelled) {
          setApiKeys(storedKeys);
          setSavedFingerprints(fingerprints);
          setLastSavedKeys(storedKeys);
        }
      } catch (error) {
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

    void loadVaultKeys();

    const loadClients = async () => {
      try {
        const colRef = collection(firestore, "users", user.uid, "clients");
        const snap = await getDocs(colRef);
        const rows = snap.docs.map((d) => ({
          id: d.id,
          name: (d.data().name as string) || d.id,
          totalLeads: (d.data().totalLeads as number) || 0
        }));
        if (!cancelled) setClients(rows);
      } catch {
        if (!cancelled) setClients([]);
      }
    };

    const colRef = collection(firestore, "users", user.uid, "clients");
    const unsubscribeClients = onSnapshot(colRef, (snap) => {
      if (cancelled) return;
      const rows = snap.docs.map((d) => ({
        id: d.id,
        name: (d.data().name as string) || d.id,
        totalLeads: (d.data().totalLeads as number) || 0
      }));
      setClients(rows);
    }, () => {
      if (!cancelled) setClients([]);
    });

    return () => {
      cancelled = true;
      try { unsubscribeClients(); } catch { }
    };
  }, [user]);

  // Removed animated leads; show live values directly

  useEffect(() => {
    if (!jobState) {
      return;
    }
    if (jobState.status === "completed") {
      setJobStatusMessage("Pipeline finished.");
      closeJobStream();
    } else if (jobState.status === "error") {
      setJobStatusMessage(jobState.error || "Pipeline failed.");
      closeJobStream();
    }
  }, [jobState, closeJobStream]);

  const handleUploadClick = async () => {
    if (!selectedFile || !user) {
      return;
    }
    setUploadError("");
    setUploading(true);
    try {
      const idToken = await getIdToken(user);
      const response = await createPipelineJob({
        file: selectedFile,
        idToken,
        clientId: selectedClient,
        nicheId: activeNiche?.id,
        nicheLabel: activeNiche?.label,
        dedupeStrategy,
      });

      const freshJob = response.job;
      console.log('=== UPLOAD RESPONSE DEBUG ===');
      console.log('Full response:', JSON.stringify(response, null, 2));
      console.log('Fresh job:', JSON.stringify(freshJob, null, 2));
      console.log('Dedupe stats exists?', !!freshJob.dedupeStats);
      console.log('Dedupe stats value:', freshJob.dedupeStats);
      console.log('=============================');
      setJobState(freshJob);
      // logs removed
      setJobStatusMessage("Job queued.");

      // Track client context for job and resolve name immediately
      setJobClientId(selectedClient);
      const localClientName = clients.find((c) => c.id === selectedClient)?.name || "";
      if (localClientName) {
        setJobClientName(localClientName);
      } else {
        // Fallback fetch if not in local cache
        try {
          const clientRef = doc(firestore, "users", user.uid, "clients", selectedClient);
          const snap = await getDoc(clientRef);
          const name = (snap.data()?.name as string) || selectedClient;
          setJobClientName(name);
        } catch {
          setJobClientName(selectedClient);
        }
      }

      // Show toast with deduplication stats
      if (freshJob.dedupeStats) {
        console.log('Dedupe stats:', freshJob.dedupeStats);
        const { total, skipped, new: newCount } = freshJob.dedupeStats;

        if (dedupeStrategy === 'include') {
          // Include strategy: show how many are being processed vs already exist
          const existing = total - newCount;
          if (existing > 0) {
            const msg = `Processing all ${total} domain${total !== 1 ? 's' : ''} (${newCount} new, ${existing} existing).`;
            setToastMessage(msg);
            setToastVisible(true);
          } else {
            const msg = `Processing ${total} new domain${total !== 1 ? 's' : ''}.`;
            setToastMessage(msg);
            setToastVisible(true);
          }
        } else {
          // Skip strategy: show how many were filtered out
          if (skipped > 0) {
            const msg = `${skipped} duplicate domain${skipped !== 1 ? 's' : ''} removed. ${newCount} unique domain${newCount !== 1 ? 's' : ''} will be processed.`;
            setToastMessage(msg);
            setToastVisible(true);
          } else {
            const msg = `All ${total} domain${total !== 1 ? 's are' : ' is'} unique. Processing started.`;
            setToastMessage(msg);
            setToastVisible(true);
          }
        }
      }

      openJobStream(response.jobId || freshJob.id);
      setModalOpen(false);
      setActiveNiche(null);
      setSelectedFile(null);
      setSelectedClient("");
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "Unable to start pipeline.");
    } finally {
      setUploading(false);
    }
  };

  const handleDownloadResults = () => {
    if (!jobState || jobState.status !== "completed") {
      return;
    }
    const url = getJobResultUrl(jobState.id);
    window.open(url, "_blank", "noopener,noreferrer");
  };

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

      const fingerprints = await createFingerprintMap(sanitizedKeys);

      const firestorePayload = API_KEY_FIELDS.reduce<Record<string, string>>((acc, key) => {
        acc[FIRESTORE_FIELD_MAP[key]] = sanitizedKeys[key];
        return acc;
      }, {});

      const vaultRef = doc(firestore, "users", user.uid);

      await setDoc(
        vaultRef,
        {
          ...firestorePayload,
          vaultUpdatedAt: serverTimestamp(),
        },
        { merge: true },
      );

      setApiKeys(sanitizedKeys);
      setSavedFingerprints(fingerprints);
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
      const clientId = newClientName.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 60);
      const clientRef = doc(firestore, "users", user.uid, "clients", clientId);
      await setDoc(
        clientRef,
        {
          id: clientId,
          name: newClientName.trim(),
          industry: newClientIndustry,
          instantly_key: newClientInstantlyKey.trim(),
          createdAt: serverTimestamp(),
        },
        { merge: true },
      );
      setClientMessage({ tone: "success", text: "Client saved." });
      setClientSaving(false);
      setClientModalOpen(false);
      // Refresh client list
      try {
        const colRef = collection(firestore, "users", user.uid, "clients");
        const snap = await getDocs(colRef);
        setClients(snap.docs.map((d) => ({
          id: d.id,
          name: (d.data().name as string) || d.id,
          totalLeads: (d.data().totalLeads as number) || 0
        })));
      } catch { }

    } catch (error) {
      setClientSaving(false);
      setClientMessage({ tone: "error", text: error instanceof Error ? error.message : "Unable to save client." });
    }
  };

  const handleEditClientSave = async () => {
    if (!user || !editingClient) return;
    if (!editClientName.trim()) {
      setEditClientMessage({ tone: "error", text: "Client name is required." });
      return;
    }
    setEditClientSaving(true);
    setEditClientMessage({ tone: "idle", text: "" });
    try {
      const clientRef = doc(firestore, "users", user.uid, "clients", editingClient.id);
      await setDoc(
        clientRef,
        {
          name: editClientName.trim(),
          industry: editClientIndustry,
          instantly_key: editClientInstantlyKey.trim(),
        },
        { merge: true },
      );
      setEditClientMessage({ tone: "success", text: "Client updated." });
      setEditClientSaving(false);

      // Refresh client list
      const colRef = collection(firestore, "users", user.uid, "clients");
      const snap = await getDocs(colRef);
      setClients(snap.docs.map((d) => ({
        id: d.id,
        name: (d.data().name as string) || d.id,
        totalLeads: (d.data().totalLeads as number) || 0
      })));

      setTimeout(() => {
        setEditClientModalOpen(false);
        setEditingClient(null);
      }, 800);
    } catch (error) {
      setEditClientSaving(false);
      setEditClientMessage({ tone: "error", text: error instanceof Error ? error.message : "Unable to update client." });
    }
  };

  const handleDeleteClient = async () => {
    if (!user || !editingClient) return;
    setIsDeleting(true);
    try {
      const idToken = await getIdToken(user);
      const resp = await fetch(`/api/clients/${encodeURIComponent(editingClient.id)}/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken })
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.error || `Delete failed (${resp.status})`);
      }

      // Refresh client list
      const colRef = collection(firestore, "users", user.uid, "clients");
      const snap = await getDocs(colRef);
      setClients(snap.docs.map((d) => ({
        id: d.id,
        name: (d.data().name as string) || d.id,
        totalLeads: (d.data().totalLeads as number) || 0
      })));

      setToastMessage(`Client "${editingClient.name}" deleted successfully.`);
      setToastVisible(true);
      setEditClientModalOpen(false);
      setEditingClient(null);
    } catch (error) {
      setToastMessage(`Failed to delete client: ${error instanceof Error ? error.message : 'Unknown error'}`);
      setToastVisible(true);
    } finally {
      setIsDeleting(false);
    }
  };
  const fingerprintLabel = (key: ApiKeyName) => {
    const hash = savedFingerprints[key];
    if (!hash) {
      return "No saved fingerprint yet.";
    }
    return `Fingerprint · ${hash.slice(0, 8)}…${hash.slice(-6)}`;
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
            <p className="eyebrow">Good evening, Jacques</p>
            <h1 className="hero-panel__title">Shields Outbound</h1>
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

        {/* Niche cards commented out for future use */}
        {false && (
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
        )}

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
                      <strong className="card-big-data">{(client.totalLeads || 0).toLocaleString()}</strong>
                      <br />
                      total leads
                    </p>
                  </div>
                  <span className="niche-card__cta">View leads →</span>
                </button>

                {/* Edit client button (top-right) */}
                <button
                  type="button"
                  onClick={async (e) => {
                    e.stopPropagation();
                    setEditingClient(client);
                    setEditClientName(client.name);
                    setEditClientMessage({ tone: "idle", text: "" });

                    // Load full client data from Firestore
                    if (user) {
                      try {
                        const clientRef = doc(firestore, "users", user.uid, "clients", client.id);
                        const clientSnap = await getDoc(clientRef);
                        if (clientSnap.exists()) {
                          const data = clientSnap.data();
                          setEditClientIndustry((data.industry as Niche["id"]) || "ecom");
                          setEditClientInstantlyKey(data.instantly_key || "");
                        }
                      } catch { }
                    }

                    setEditClientModalOpen(true);
                  }}
                  className="client-edit-btn"
                  aria-label="Edit client"
                  title="Edit client"
                >
                  ✏️
                </button>

                {/* Upload Leads button (bottom-right) */}
                <button
                  type="button"
                  className="primary-button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedClient(client.id);
                    setActiveNiche(null);
                    setModalOpen(true);
                  }}
                  aria-label="Upload Leads"
                  title="Upload Leads"
                  style={{ position: 'absolute', bottom: '8px', right: '8px' }}
                >
                  Upload Leads
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

        {jobState ? (
          <div className="stage-grid">
            {[...STAGE_ORDER]
              .map((stageKey) => {
                const stage = jobState.stages[stageKey];
                const meta = STAGE_METADATA[stageKey];
                const summaryEntries = extractStageSummary(stage);
                const processed = typeof stage?.progress?.processed === "number" ? stage.progress.processed : null;
                const total = typeof stage?.progress?.total === "number" ? stage.progress.total : null;
                return (
                  <article
                    key={stageKey}
                    className={`stage-card stage-card--${stage?.status ?? "pending"} ${stage?.status === "running" ? "stage-card--running" : ""}`}
                  >
                    <div className="stage-card__head">
                      <div>
                        <p className="stage-card__label">{meta.title}</p>
                        <p className="stage-card__detail">{meta.detail}</p>
                      </div>
                      <span className="stage-card__status">{formatStageStatus(stage?.status)}</span>
                    </div>
                    <p className="stage-card__progress">
                      {processed !== null && total ? (
                        <span>
                          <span className="stage-card__progress-number">{processed.toLocaleString()}</span>
                          <span> / </span>
                          <span className="stage-card__progress-number stage-card__progress-total">{total.toLocaleString()}</span>
                          <span> processed</span>
                        </span>
                      ) : (
                        describeStageProgress(stage)
                      )}
                    </p>
                    {stage?.error && <p className="stage-card__error">{stage.error}</p>}
                    {summaryEntries.length > 0 && (
                      <dl className="stage-card__summary">
                        {summaryEntries.map(([key, value]) => (
                          <div key={key} className="stage-card__summary-row">
                            <dt>{humanizeKey(key)}</dt>
                            <dd>{formatSummaryValue(value)}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </article>
                );
              })}
          </div>
        ) : (
          <div className="pipeline-panel__empty">
            <p>No pipeline runs yet.</p>
            <p className="pipeline-panel__subtitle">
              Select a niche, upload your CSV, and we&apos;ll stream the progress here.
            </p>
          </div>
        )}
      </section>

      {
        modalOpen && (
          <div
            className="modal-overlay"
            role="dialog"
            aria-modal="true"
            onClick={closeModal}
          >
            <div className="modal" onClick={(event) => event.stopPropagation()}>
              <div className="modal__header">
                <div>
                  <p className="eyebrow eyebrow--muted">{activeNiche?.detail || "Upload"}</p>
                  <h2 className="modal__title">
                    {activeNiche?.icon || "📤"}  {activeNiche?.label || "Upload CSV"}
                  </h2>
                  <p className="modal__description">{activeNiche?.hint || "Upload your domains CSV to start the pipeline."}</p>
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
                  <span className="settings-field__hint">
                    Route leads into the client’s Instantly workspace.
                  </span>
                </label>

                <label className="settings-field">
                  <span className="settings-field__label">Duplicates</span>
                  <select
                    value={dedupeStrategy}
                    onChange={(e) => setDedupeStrategy(e.target.value as 'skip' | 'include')}
                  >
                    <option value="skip">Skip already processed domains</option>
                    <option value="include">Include duplicates in processed-domains</option>
                  </select>
                  <span className="settings-field__hint">Deduplication is scoped to the selected client.</span>
                </label>

                <label className="upload-area">
                  <span className="upload-area__title">Drop CSV or click to browse</span>
                  <span className="upload-area__hint">Max 50k rows · UTF-8</span>
                  {selectedFile && (
                    <span className="upload-area__file" title={selectedFile.name}>
                      {selectedFile?.name}
                    </span>
                  )}
                  <input
                    type="file"
                    accept=".csv"
                    className="sr-only"
                    onChange={handleFileChange}
                  />
                </label>
                {uploadError && (
                  <p className="form-error" role="alert">
                    {uploadError}
                  </p>
                )}
                <div className="modal__actions">
                  <button
                    type="button"
                    className="primary-button"
                    disabled={uploadDisabled}
                    aria-disabled={uploadDisabled}
                    onClick={handleUploadClick}
                  >
                    {uploading ? "Uploading..." : "Upload & Validate"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )
      }

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

      {
        editClientModalOpen && editingClient && (
          <div
            className="modal-overlay"
            role="dialog"
            aria-modal="true"
            onClick={() => {
              if (!editClientSaving && !isDeleting) {
                setEditClientModalOpen(false);
                setEditingClient(null);
              }
            }}
          >
            <div className="modal" onClick={(event) => event.stopPropagation()} style={{ maxWidth: '480px' }}>
              <div className="modal__header">
                <div>
                  <p className="eyebrow eyebrow--muted">Edit</p>
                  <h2 className="modal__title">Edit Client</h2>
                  <p className="modal__description">
                    Update the client information below.
                  </p>
                </div>
              </div>

              <div className="modal__body">
                <label className="label">
                  Client Name
                  <input
                    className="input"
                    type="text"
                    placeholder="e.g. ACME Corp"
                    value={editClientName}
                    onChange={(e) => setEditClientName(e.target.value)}
                    disabled={editClientSaving || isDeleting}
                  />
                </label>

                <label className="label">
                  Industry
                  <select
                    className="select"
                    value={editClientIndustry}
                    onChange={(e) => setEditClientIndustry(e.target.value as Niche["id"])}
                    disabled={editClientSaving || isDeleting}
                  >
                    <option value="ecom">E-Commerce</option>
                    <option value="saas">SaaS</option>
                    <option value="agency">Agency</option>
                    <option value="local-biz">Local Business</option>
                  </select>
                </label>

                <label className="label">
                  Instantly API Key
                  <input
                    className="input"
                    type="text"
                    placeholder="Enter API key"
                    value={editClientInstantlyKey}
                    onChange={(e) => setEditClientInstantlyKey(e.target.value)}
                    disabled={editClientSaving || isDeleting}
                  />
                </label>

                {editClientMessage.tone !== "idle" && (
                  <div className={`vault-message vault-message--${editClientMessage.tone}`}>
                    {editClientMessage.text}
                  </div>
                )}

                <div className="modal__actions" style={{ gap: '0.75rem' }}>
                  {/* <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      setEditClientModalOpen(false);
                      setEditingClient(null);
                    }}
                    disabled={editClientSaving || isDeleting}
                    style={{ flex: 1 }}
                  >
                    Cancel
                  </button> */}
                  <button
                    type="button"
                    className="primary-button"
                    onClick={handleEditClientSave}
                    disabled={editClientSaving || isDeleting}
                    style={{ flex: 1 }}
                  >
                    {editClientSaving ? 'Saving...' : 'Save Changes'}
                  </button>
                </div>

                <button
                  type="button"
                  className="primary-button"
                  onClick={handleDeleteClient}
                  disabled={editClientSaving || isDeleting}
                  style={{
                    background: '#ef4444',
                    color: '#fff',
                    marginTop: '1rem',
                    width: '100%'
                  }}
                >
                  {isDeleting ? 'Deleting...' : 'Delete Client'}
                </button>
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

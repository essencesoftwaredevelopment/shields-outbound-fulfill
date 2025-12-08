"use client";

import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { doc, getDoc, serverTimestamp, setDoc, collection, onSnapshot, query, orderBy } from "firebase/firestore";
import { getIdToken } from "firebase/auth";
import { useAuth } from "@/hooks/use-auth";
import { firestore } from "@/lib/firebase/firestore";
import { createPipelineJob, getJobResultUrl, getJobStreamUrl, getPipelineBaseUrl } from "@/lib/pipeline/client";
import AppShell from "@/components/app-shell";
import {
    PipelineJob,
    PipelineServerEvent,
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

type Lead = {
    id: string;
    domain?: string;
    email?: string;
    status?: string;
    verified?: boolean;
    firstLine?: string;
    founderName?: string;
    personalizationUrl?: string;
    personalizationTitle?: string;
    updatedAt?: string;
};

type Campaign = {
    id: string;
    name: string;
    status?: number;
    createdAt?: string;
    totalLeads?: number;
};

type JobStatus = PipelineJob["status"];
type StageStatus = PipelineStageStatus;

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

const JOB_STATUS_COLORS: Record<JobStatus, string> = {
    queued: "#fbbf24",
    running: "#3b82f6",
    completed: "#22c55e",
    error: "#f87171",
};

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

export default function ClientPage() {
    const router = useRouter();
    const params = useParams();
    const searchParams = useSearchParams();
    const clientId = (params?.clientId as string) || "";
    const { user, loading } = useAuth();

    const [activeTab, setActiveTab] = useState<"campaigns" | "leads">(
        (searchParams?.get("tab") as "campaigns" | "leads") || "campaigns"
    );
    const [clientName, setClientName] = useState<string>(clientId);
    const [clientIndustry, setClientIndustry] = useState<Niche["id"]>("ecom");

    // Campaign state
    const [modalOpen, setModalOpen] = useState(false);
    const [wizardStep, setWizardStep] = useState<1 | 2 | 3>(1);
    const [selectedFile, setSelectedFile] = useState<File | null>(null);

    // Step 2: Processing options
    const [dedupeStrategy, setDedupeStrategy] = useState<'skip' | 'include'>('skip');
    const [findFounder, setFindFounder] = useState(true);
    const [findEmail, setFindEmail] = useState(true);
    const [verifyEmail, setVerifyEmail] = useState(true);

    // Step 3: Personalization options
    const [selectedCampaignId, setSelectedCampaignId] = useState<string>("");
    const [personalizeFirstLine, setPersonalizeFirstLine] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [uploadError, setUploadError] = useState("");
    const [jobState, setJobState] = useState<PipelineJob | null>(null);
    const [jobHistory, setJobHistory] = useState<PipelineJob[]>([]);
    const [jobStatusMessage, setJobStatusMessage] = useState("");
    const [jobStreamConnected, setJobStreamConnected] = useState(false);
    const jobStreamRef = useRef<EventSource | null>(null);
    const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const reconnectAttemptsRef = useRef(0);
    const lastStreamingJobIdRef = useRef<string | null>(null);
    const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

    const createEmptyStageState = useCallback((): PipelineStageState => ({
        status: "pending",
        startedAt: null,
        completedAt: null,
        summary: null,
        error: null,
        progress: null,
    }), []);

    const normalizeStages = useCallback((raw: unknown): Record<PipelineStageKey, PipelineStageState> => {
        const source = (raw && typeof raw === "object") ? raw as Record<string, Partial<PipelineStageState>> : {};
        const stages: Record<PipelineStageKey, PipelineStageState> = {
            founders: createEmptyStageState(),
            emailDiscovery: createEmptyStageState(),
            verification: createEmptyStageState(),
            personalization: createEmptyStageState(),
        };
        STAGE_ORDER.forEach((key) => {
            const value = source[key];
            if (value && typeof value === "object") {
                stages[key] = {
                    status: value.status || stages[key].status,
                    startedAt: value.startedAt ?? stages[key].startedAt,
                    completedAt: value.completedAt ?? stages[key].completedAt,
                    summary: value.summary ?? stages[key].summary,
                    error: value.error ?? stages[key].error,
                    progress: value.progress ?? stages[key].progress,
                };
            }
        });
        return stages;
    }, [createEmptyStageState]);

    const formatJobDate = useCallback((value: string | null | undefined) => {
        if (!value) {
            return "—";
        }
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) {
            return value;
        }
        return date.toLocaleString();
    }, []);

    const [toastMessage, setToastMessage] = useState<string | null>(null);
    const [toastVisible, setToastVisible] = useState(false);

    // Upload to Instantly modal state
    const [uploadModalOpen, setUploadModalOpen] = useState(false);
    const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
    const [csvPreviewRows, setCsvPreviewRows] = useState<Record<string, string>[]>([]);
    const [columnMapping, setColumnMapping] = useState<Record<string, { column: string; isCustom: boolean }>>({});
    const [jobPendingUpload, setJobPendingUpload] = useState<string | null>(null);

    // Leads state
    const [leads, setLeads] = useState<Lead[]>([]);
    const [stats, setStats] = useState<{ total: number; verified: number; unverified: number }>(() => ({ total: 0, verified: 0, unverified: 0 }));
    const [selectedLead, setSelectedLead] = useState<Lead | null>(null);

    // Campaigns state
    const [campaigns, setCampaigns] = useState<Campaign[]>([]);

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

    useEffect(() => {
        if (!loading && !user) {
            router.replace("/auth");
        }
    }, [loading, user, router]);

    useEffect(() => {
        if (!user || !clientId) return;
        let cancelled = false;

        // Load client data
        (async () => {
            try {
                const ref = doc(firestore, "users", user.uid, "clients", clientId);
                const snap = await getDoc(ref);
                if (!cancelled && snap.exists()) {
                    const data = snap.data();
                    setClientName((data.name as string) || clientId);
                    setClientIndustry((data.industry as Niche["id"]) || "ecom");
                }
            } catch {
                /* noop */
            }
        })();

        // Subscribe to leads subcollection
        const leadsCol = collection(firestore, "users", user.uid, "clients", clientId, "leads");
        const unsubLeads = onSnapshot(leadsCol, (snap) => {
            if (cancelled) return;
            const rows = snap.docs.map((d) => {
                const data = d.data();
                const emailStatus = (data.email_status as string) || "";
                const isVerified = emailStatus === "valid" || emailStatus === "verified";
                return {
                    id: d.id,
                    domain: (data.domain as string) || (data.website as string) || "",
                    email: (data.email as string) || "",
                    status: emailStatus,
                    verified: isVerified,
                    firstLine: (data.personalization_first_line as string) || "",
                    founderName: (data.founder_name as string) || "",
                    personalizationUrl: (data.personalization_url as string) || "",
                    personalizationTitle: (data.personalization_title as string) || "",
                    updatedAt: data.updatedAt ? new Date(data.updatedAt.toDate()).toLocaleString() : "",
                } as Lead;
            });
            setLeads(rows);
            const verified = rows.filter((r) => r.verified).length;
            const total = rows.length;
            setStats({ total, verified, unverified: Math.max(0, total - verified) });
        }, () => {
            if (!cancelled) {
                setLeads([]);
                setStats({ total: 0, verified: 0, unverified: 0 });
            }
        });

        // Subscribe to campaigns subcollection
        const campaignsCol = collection(firestore, "users", user.uid, "clients", clientId, "campaigns");
        const unsubCampaigns = onSnapshot(campaignsCol, (snap) => {
            if (cancelled) return;
            const rows = snap.docs.map((d) => {
                const data = d.data();
                return {
                    id: d.id,
                    name: (data.name as string) || d.id,
                    status: (data.status as number) || 0,
                    createdAt: data.createdAt?.toDate ? new Date(data.createdAt.toDate()).toLocaleString() : "",
                    totalLeads: (data.totalLeads as number) || 0,
                } as Campaign;
            });
            setCampaigns(rows);
        }, () => {
            if (!cancelled) {
                setCampaigns([]);
            }
        });

        return () => {
            cancelled = true;
            try { unsubLeads(); } catch { }
            try { unsubCampaigns(); } catch { }
        };
    }, [user, clientId]);

    useEffect(() => {
        if (toastVisible) {
            const timer = setTimeout(() => {
                setToastVisible(false);
                setTimeout(() => setToastMessage(null), 300);
            }, 5000);
            return () => clearTimeout(timer);
        }
    }, [toastVisible]);

    const closeJobStream = useCallback(() => {
        if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
            reconnectTimeoutRef.current = null;
        }
        reconnectAttemptsRef.current = 0;
        jobStreamRef.current?.close();
        jobStreamRef.current = null;
        setJobStreamConnected(false);
    }, []);

    useEffect(() => {
        return () => {
            closeJobStream();
        };
    }, [closeJobStream]);

    const fetchJobSnapshot = useCallback(async (jobId: string) => {
        if (!jobId) return;
        try {
            const response = await fetch(`${getPipelineBaseUrl()}/api/jobs/${jobId}`);
            if (!response.ok) return;
            const payload = await response.json();
            if (payload?.job) {
                setJobState(payload.job);
            }
        } catch (error) {
            console.error('Failed to fetch job snapshot:', error);
        }
    }, []);

    const handleServerEvent = useCallback((payload: PipelineServerEvent) => {
        if (payload.type === "state" && payload.state) {
            setJobState(payload.state);
        } else if (payload.type === "error" && payload.error) {
            setJobStatusMessage(payload.error);
        }
    }, []);

    const openJobStream = useCallback(
        (jobId: string, isReconnect = false) => {
            if (!jobId) {
                return;
            }
            closeJobStream();
            if (!isReconnect) {
                reconnectAttemptsRef.current = 0;
            }
            setSelectedJobId(jobId);
            lastStreamingJobIdRef.current = jobId;
            setJobStatusMessage(isReconnect ? "Reconnecting to pipeline..." : "Connecting to pipeline...");
            fetchJobSnapshot(jobId);

            const stream = new EventSource(getJobStreamUrl(jobId));
            jobStreamRef.current = stream;

            stream.onopen = () => {
                setJobStreamConnected(true);
                setJobStatusMessage("Live updates streaming.");
                reconnectAttemptsRef.current = 0;
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
                setJobStatusMessage("Lost connection to pipeline stream, retrying...");
                stream.close();
                jobStreamRef.current = null;
                fetchJobSnapshot(jobId);

                const MAX_RETRIES = 5;
                if (reconnectAttemptsRef.current >= MAX_RETRIES) {
                    setJobStatusMessage("Unable to reconnect to pipeline stream.");
                    return;
                }

                const attempt = reconnectAttemptsRef.current;
                reconnectAttemptsRef.current = attempt + 1;
                const delay = Math.min(10000, 1000 * Math.pow(2, attempt));
                reconnectTimeoutRef.current = setTimeout(() => {
                    openJobStream(jobId, true);
                }, delay);
            };
        },
        [closeJobStream, handleServerEvent, fetchJobSnapshot],
    );

    // Check for active job on mount (after openJobStream is defined)
    useEffect(() => {
        if (!user || !clientId) return;
        let cancelled = false;

        (async () => {
            try {
                const jobRef = doc(firestore, "users", user.uid, "clients", clientId, "activeJob", "current");
                const jobSnap = await getDoc(jobRef);
                if (!cancelled && jobSnap.exists()) {
                    const data = jobSnap.data();
                    if (data.jobId) {
                        if (data.status === 'pending-upload') {
                            // Job is completed and pending upload
                            setJobPendingUpload(data.jobId);
                            fetchJobSnapshot(data.jobId);
                        } else if (data.status !== 'completed' && data.status !== 'error') {
                            // Reconnect to active job
                            openJobStream(data.jobId);
                        } else {
                            fetchJobSnapshot(data.jobId);
                        }
                    }
                }
            } catch (error) {
                console.error('Failed to check for active job:', error);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [user, clientId, openJobStream, fetchJobSnapshot]);

    useEffect(() => {
        if (!user || !clientId) {
            return;
        }
        const jobsRef = collection(firestore, "users", user.uid, "clients", clientId, "jobs");
        const jobsQuery = query(jobsRef, orderBy("createdAt", "desc"));
        const unsubscribe = onSnapshot(jobsQuery, (snap) => {
            const rows = snap.docs.map((docSnap) => {
                const data = docSnap.data() as Record<string, unknown>;
                const id = (data.id as string) || docSnap.id;
                const createdAt = typeof data.createdAt === "string" && data.createdAt
                    ? data.createdAt
                    : new Date().toISOString();
                const completedAt = typeof data.completedAt === "string" ? data.completedAt : null;
                const dedupe = data.dedupeStats as { total?: number; skipped?: number; new?: number } | undefined;
                const totalVal = Number(dedupe?.total ?? 0);
                const skippedVal = Number(dedupe?.skipped ?? 0);
                const newVal = Number(dedupe?.new ?? 0);
                const jobObj: PipelineJob = {
                    id,
                    status: (data.status as PipelineJob["status"]) || "queued",
                    error: (data.error as string) || null,
                    fileName: (data.fileName as string) || id,
                    createdAt,
                    completedAt,
                    stages: normalizeStages(data.stages),
                    dedupeStats: dedupe
                        ? {
                            total: Number.isFinite(totalVal) ? totalVal : 0,
                            skipped: Number.isFinite(skippedVal) ? skippedVal : 0,
                            new: Number.isFinite(newVal) ? newVal : 0,
                        }
                        : null,
                };
                return jobObj;
            });
            setJobHistory(rows);
        }, (error) => {
            console.error('Job history subscription error:', error);
            setJobHistory([]);
        });

        return () => unsubscribe();
    }, [user, clientId, normalizeStages]);

    useEffect(() => {
        if (!jobHistory.length) {
            if (!jobState) {
                setSelectedJobId(null);
            }
            return;
        }

        const latest = jobHistory[0];
        if (!jobState) {
            setJobState(latest);
            return;
        }

        const hasActiveStream = jobStreamConnected || jobState.status === "running";
        if (jobState.id === latest.id) {
            if (!hasActiveStream && (jobState.status !== latest.status || jobState.completedAt !== latest.completedAt)) {
                setJobState(latest);
            }
        } else if (!hasActiveStream) {
            setJobState(latest);
        }
    }, [jobHistory, jobState, jobStreamConnected]);

    useEffect(() => {
        if (jobState) {
            setSelectedJobId(jobState.id);
        }
    }, [jobState?.id]);

    useEffect(() => {
        if (!jobState || !user || !clientId) {
            return;
        }

        const isLiveJob = lastStreamingJobIdRef.current === jobState.id;
        if (jobState.status === "completed") {
            if (!isLiveJob) {
                return;
            }
            setJobStatusMessage("Pipeline finished.");
            closeJobStream();
            setJobPendingUpload(jobState.id);

            // Update job status to pending-upload in Firestore
            (async () => {
                try {
                    const jobRef = doc(firestore, "users", user.uid, "clients", clientId, "activeJob", "current");
                    await setDoc(jobRef, { status: 'pending-upload' }, { merge: true });
                } catch (error) {
                    console.error('Failed to update job status:', error);
                }
            })();
            lastStreamingJobIdRef.current = null;
        } else if (jobState.status === "error") {
            if (!isLiveJob) {
                return;
            }
            setJobStatusMessage(jobState.error || "Pipeline failed.");
            closeJobStream();

            // Update job status in Firestore
            (async () => {
                try {
                    const jobRef = doc(firestore, "users", user.uid, "clients", clientId, "activeJob", "current");
                    await setDoc(jobRef, { status: 'error', error: jobState.error }, { merge: true });
                } catch (error) {
                    console.error('Failed to update job status:', error);
                }
            })();
            lastStreamingJobIdRef.current = null;
        }
    }, [jobState, closeJobStream, user, clientId]);

    const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0] ?? null;
        setSelectedFile(file);
        setUploadError("");
    };

    const handleSelectJob = useCallback((job: PipelineJob) => {
        if (!job) {
            return;
        }
        setJobState(job);
        setSelectedJobId(job.id);

        if (job.status === "running" || job.status === "queued") {
            openJobStream(job.id);
        } else {
            lastStreamingJobIdRef.current = null;
            closeJobStream();
        }

        fetchJobSnapshot(job.id);
    }, [closeJobStream, openJobStream, fetchJobSnapshot]);

    const handleUploadClick = async () => {
        if (!selectedFile || !user) {
            return;
        }
        setUploadError("");
        setUploading(true);
        try {
            const idToken = await getIdToken(user);
            const activeNiche = niches.find(n => n.id === clientIndustry);
            const response = await createPipelineJob({
                file: selectedFile,
                idToken,
                clientId: clientId,
                nicheId: activeNiche?.id,
                nicheLabel: activeNiche?.label,
                dedupeStrategy,
                campaignId: selectedCampaignId || undefined,
                findFounder,
                findEmail,
                verifyEmail,
                personalizeFirstLine,
            });

            const freshJob = response.job;
            setJobState(freshJob);
            setJobStatusMessage("Job queued.");

            // Show toast with deduplication stats
            if (freshJob.dedupeStats) {
                const { total, skipped, new: newCount } = freshJob.dedupeStats;

                // Check if no domains will be processed (skip strategy with 0 new domains)
                if (dedupeStrategy === 'skip' && newCount === 0) {
                    const msg = `${skipped} duplicate domain${skipped !== 1 ? 's' : ''} removed. 0 unique domains to process. Upload cancelled.`;
                    setToastMessage(msg);
                    setToastVisible(true);
                    setModalOpen(false);
                    setSelectedFile(null);
                    setSelectedCampaignId("");
                    setUploading(false);
                    return;
                }

                if (dedupeStrategy === 'include') {
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

            const jobId = response.jobId || freshJob.id;

            // Save job ID to Firestore for persistence
            try {
                const jobRef = doc(firestore, "users", user.uid, "clients", clientId, "activeJob", "current");
                await setDoc(jobRef, {
                    jobId,
                    status: freshJob.status,
                    createdAt: serverTimestamp(),
                    campaignId: selectedCampaignId || null
                }, { merge: true });
            } catch (error) {
                console.error('Failed to save job to Firestore:', error);
            }

            openJobStream(jobId);
            setModalOpen(false);
            setSelectedFile(null);
            setSelectedCampaignId("");
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

    const handleUploadToInstantly = async () => {
        const currentJobId = jobState?.id || jobPendingUpload;
        if (!currentJobId || !user) {
            setToastMessage('No completed job available to upload.');
            setToastVisible(true);
            return;
        }

        // Fetch CSV data for preview and mapping
        try {
            const idToken = await getIdToken(user);
            setUploading(true);
            const response = await fetch(`${getPipelineBaseUrl()}/api/jobs/${currentJobId}/csv-preview`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ idToken, clientId })
            });

            if (!response.ok) {
                let message = 'Failed to fetch CSV preview';
                try {
                    const payload = await response.json();
                    if (payload?.error) {
                        message = String(payload.error);
                    }
                } catch {
                    /* noop */
                }
                throw new Error(message);
            }

            const data = await response.json();
            setCsvHeaders(data.headers || []);
            setCsvPreviewRows(data.previewRows || []);

            // Initialize column mapping with Instantly-aligned defaults
            const defaultMapping: Record<string, { column: string; isCustom: boolean }> = {
                email: { column: 'email', isCustom: false },
                firstName: { column: 'first_name', isCustom: false },
                lastName: { column: 'last_name', isCustom: false },
                website: { column: 'domain', isCustom: false },
                personalization: { column: 'personalization', isCustom: false }
            };
            setColumnMapping(defaultMapping);
            setUploadModalOpen(true);
            setToastMessage('Loaded CSV preview. Map columns to upload.');
            setToastVisible(true);
        } catch (error) {
            setToastMessage(error instanceof Error ? error.message : 'Failed to load CSV data');
            setToastVisible(true);
        } finally {
            setUploading(false);
        }
    };

    const handleConfirmUpload = async () => {
        const currentJobId = jobState?.id || jobPendingUpload;
        if (!currentJobId || !user) {
            setToastMessage('No completed job available to upload.');
            setToastVisible(true);
            return;
        }

        if (!selectedCampaignId) {
            alert('Please select a campaign');
            return;
        }

        try {
            setUploading(true);
            const idToken = await getIdToken(user);
            const response = await fetch(`${getPipelineBaseUrl()}/api/jobs/${currentJobId}/upload-to-instantly`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    idToken,
                    clientId,
                    campaignId: selectedCampaignId,
                    columnMapping
                })
            });

            if (!response.ok) {
                throw new Error('Failed to upload to Instantly');
            }

            const result = await response.json();
            setToastMessage(`Successfully uploaded ${result.count || 0} leads to Instantly`);
            setToastVisible(true);
            setUploadModalOpen(false);

            // Clear pending upload state
            setJobPendingUpload(null);
            const jobRef = doc(firestore, "users", user.uid, "clients", clientId, "activeJob", "current");
            await setDoc(jobRef, { status: 'uploaded' }, { merge: true });
        } catch (error) {
            alert(error instanceof Error ? error.message : 'Failed to upload to Instantly');
        } finally {
            setUploading(false);
        }
    };

    const handleDiscardJob = async () => {
        if (!user || !clientId) return;

        try {
            const jobRef = doc(firestore, "users", user.uid, "clients", clientId, "activeJob", "current");
            await setDoc(jobRef, { status: 'discarded' }, { merge: true });
            setJobPendingUpload(null);
            setJobState(null);
        } catch (error) {
            console.error('Failed to discard job:', error);
        }
    };

    const uploadDisabled = !selectedFile || uploading;

    if (loading || !user) {
        return (
            <div className="auth-gate">
                <p className="eyebrow">Shields Outbound</p>
                <h2>Checking access...</h2>
                <p className="auth-card__subtitle">Hang tight while we confirm your session.</p>
            </div>
        );
    }

    return (
        <>
            <AppShell>
                <section className="hero-panel">
                    <div className="hero-panel__layout">
                        <div className="hero-panel__content">
                            <button
                                onClick={() => router.back()}
                                className="secondary-button secondary-button--active"
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.5rem',
                                    width: 'fit-content',
                                    marginBottom: '1rem'
                                }}
                            >
                                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                                    <path d="M10 12L6 8L10 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                                Back
                            </button>
                            <h1 className="hero-panel__title">{clientName}</h1>
                            <p className="hero-panel__description">Manage campaigns and view leads for this client.</p>
                        </div>
                    </div>

                    {/* Tab Navigation */}
                    <div className="tab-nav">
                        <button
                            className={`tab-nav__button ${activeTab === "campaigns" ? "tab-nav__button--active" : ""}`}
                            onClick={() => setActiveTab("campaigns")}
                        >
                            Campaigns
                        </button>
                        <button
                            className={`tab-nav__button ${activeTab === "leads" ? "tab-nav__button--active" : ""}`}
                            onClick={() => setActiveTab("leads")}
                        >
                            All Leads
                        </button>
                    </div>

                    {/* Campaigns Tab */}
                    {activeTab === "campaigns" && (
                        <>
                            <div style={{ marginTop: '2rem' }}>
                                <button
                                    type="button"
                                    className="primary-button"
                                    onClick={() => {
                                        setModalOpen(true);
                                        setWizardStep(1);
                                        setSelectedFile(null);
                                        setDedupeStrategy('skip');
                                        setFindFounder(true);
                                        setFindEmail(true);
                                        setVerifyEmail(true);
                                        setPersonalizeFirstLine(false);
                                        setSelectedCampaignId("");
                                        setUploadError("");
                                    }}
                                >
                                    Upload Leads
                                </button>
                            </div>

                            {/* Active Campaigns List */}
                            {campaigns.filter(c => c.status === 1).length > 0 && (
                                <div style={{ marginTop: '2rem' }}>
                                    <p className="eyebrow eyebrow--muted">Active Campaigns</p>
                                    <h2 className="pipeline-panel__title" style={{ fontSize: '1.25rem', marginTop: '0.5rem' }}>Campaigns</h2>
                                    <div style={{
                                        marginTop: '1rem',
                                        display: 'grid',
                                        gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                                        gap: '1rem'
                                    }}>
                                        {campaigns.filter(c => c.status === 1).map((campaign) => (
                                            <div
                                                key={campaign.id}
                                                style={{
                                                    border: '1px solid rgba(255, 255, 255, 0.15)',
                                                    borderRadius: '16px',
                                                    padding: '1.25rem',
                                                    background: 'rgba(255, 255, 255, 0.05)',
                                                    transition: 'transform 0.2s ease, border-color 0.2s ease',
                                                    cursor: 'pointer'
                                                }}
                                                onMouseEnter={(e) => {
                                                    e.currentTarget.style.transform = 'translateY(-2px)';
                                                    e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.3)';
                                                }}
                                                onMouseLeave={(e) => {
                                                    e.currentTarget.style.transform = 'translateY(0)';
                                                    e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.15)';
                                                }}
                                            >
                                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
                                                    <p style={{
                                                        margin: 0,
                                                        fontSize: '1.1rem',
                                                        fontWeight: 600,
                                                        color: '#ffffff'
                                                    }}>{campaign.name}</p>
                                                    <span style={{
                                                        display: 'inline-flex',
                                                        alignItems: 'center',
                                                        padding: '0.25rem 0.65rem',
                                                        borderRadius: '999px',
                                                        fontSize: '0.7rem',
                                                        fontWeight: 600,
                                                        textTransform: 'uppercase',
                                                        letterSpacing: '0.05em',
                                                        background: 'rgba(34, 197, 94, 0.15)',
                                                        color: '#22c55e',
                                                        border: '1px solid rgba(34, 197, 94, 0.3)'
                                                    }}>Active</span>
                                                </div>
                                                <p style={{
                                                    margin: '0.5rem 0 0',
                                                    fontSize: '0.85rem',
                                                    color: 'rgba(255, 255, 255, 0.6)'
                                                }}>
                                                    Leads: {campaign.totalLeads?.toLocaleString() || 0}
                                                </p>
                                                {campaign.createdAt && (
                                                    <p style={{
                                                        margin: '0.5rem 0 0',
                                                        fontSize: '0.8rem',
                                                        color: 'rgba(255, 255, 255, 0.4)'
                                                    }}>
                                                        Created: {campaign.createdAt}
                                                    </p>
                                                )}
                                                {/* Upload to Instantly Modal rendered once outside the list */}

                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            <div style={{ marginTop: '2rem' }}>
                                <div className="pipeline-panel__header">
                                    <div>
                                        <p className="eyebrow eyebrow--muted">
                                            {jobState ? "Live pipeline" : "Pipeline monitor"}
                                        </p>
                                        <h2 className="pipeline-panel__title">
                                            {jobState
                                                ? `${jobState.stages.verification?.summary?.valid || 0} / ${jobState.stages.verification?.progress?.total || jobState.dedupeStats?.new || 0}`
                                                : "No runs yet"}
                                        </h2>
                                        {!jobState && (
                                            <p className="pipeline-panel__subtitle">
                                                Upload leads to see stage progress and pipeline status.
                                            </p>
                                        )}
                                    </div>
                                    {(jobState?.status === 'completed' || jobPendingUpload) && (
                                        <div style={{ display: 'flex', gap: '0.75rem' }}>
                                            <button
                                                type="button"
                                                className="secondary-button secondary-button--active"
                                                onClick={handleDownloadResults}
                                            >
                                                Download CSV
                                            </button>
                                            <button
                                                type="button"
                                                className="primary-button"
                                                onClick={handleUploadToInstantly}
                                                disabled={uploading}
                                            >
                                                {uploading ? 'Uploading...' : 'Upload to Instantly'}
                                            </button>
                                            <button
                                                type="button"
                                                className="secondary-button"
                                                onClick={handleDiscardJob}
                                                style={{ color: 'rgba(239, 68, 68, 0.9)' }}
                                            >
                                                Discard
                                            </button>
                                        </div>
                                    )}
                                </div>

                                {jobState ? (
                                    <div className="stage-grid" style={{ marginTop: '1.5rem' }}>
                                        {[...STAGE_ORDER].map((stageKey) => {
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
                                    <div className="pipeline-panel__empty" style={{ marginTop: '1.5rem' }}>
                                        <p>No pipeline runs yet.</p>
                                        <p className="pipeline-panel__subtitle">
                                            Upload a CSV to start processing leads.
                                        </p>
                                    </div>
                                )}

                                <div style={{ marginTop: '2.5rem' }}>
                                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '1rem' }}>
                                        <p className="eyebrow eyebrow--muted">Job history</p>
                                        {jobHistory.length > 0 && (
                                            <span style={{ fontSize: '0.75rem', color: 'rgba(255, 255, 255, 0.55)' }}>
                                                {jobHistory.length} run{jobHistory.length === 1 ? '' : 's'} saved
                                            </span>
                                        )}
                                    </div>
                                    {jobHistory.length > 0 ? (
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '1rem' }}>
                                            {jobHistory.map((job) => {
                                                const isSelected = job.id === selectedJobId;
                                                const statusColor = JOB_STATUS_COLORS[job.status];
                                                const totalProcessed = job.stages?.verification?.progress?.total
                                                    || job.dedupeStats?.total
                                                    || job.dedupeStats?.new
                                                    || job.stages?.founders?.progress?.total
                                                    || 0;
                                                const validLeads = job.stages?.verification?.summary?.valid
                                                    || job.stages?.emailDiscovery?.summary?.found
                                                    || 0;
                                                return (
                                                    <button
                                                        key={job.id}
                                                        type="button"
                                                        onClick={() => handleSelectJob(job)}
                                                        style={{
                                                            all: 'unset',
                                                            display: 'grid',
                                                            gridTemplateColumns: 'minmax(0, 1fr) 120px 160px',
                                                            alignItems: 'center',
                                                            gap: '1rem',
                                                            padding: '1rem 1.25rem',
                                                            borderRadius: '12px',
                                                            border: `1px solid ${isSelected ? 'rgba(59, 130, 246, 0.65)' : 'rgba(255, 255, 255, 0.08)'}`,
                                                            background: isSelected ? 'rgba(59, 130, 246, 0.12)' : 'rgba(255, 255, 255, 0.03)',
                                                            cursor: 'pointer',
                                                            transition: 'background 0.2s ease, border-color 0.2s ease, transform 0.2s ease',
                                                        }}
                                                        onMouseEnter={(event) => {
                                                            event.currentTarget.style.transform = 'translateY(-2px)';
                                                            if (!isSelected) {
                                                                event.currentTarget.style.borderColor = 'rgba(59, 130, 246, 0.35)';
                                                            }
                                                        }}
                                                        onMouseLeave={(event) => {
                                                            event.currentTarget.style.transform = 'translateY(0)';
                                                            event.currentTarget.style.borderColor = isSelected ? 'rgba(59, 130, 246, 0.65)' : 'rgba(255, 255, 255, 0.08)';
                                                        }}
                                                    >
                                                        <div>
                                                            <p style={{
                                                                margin: 0,
                                                                fontWeight: 600,
                                                                color: '#ffffff',
                                                                fontSize: '0.95rem'
                                                            }}>{job.fileName || job.id}</p>
                                                            <p style={{
                                                                margin: '0.35rem 0 0',
                                                                fontSize: '0.8rem',
                                                                color: 'rgba(255, 255, 255, 0.55)'
                                                            }}>Started {formatJobDate(job.createdAt)}</p>
                                                        </div>
                                                        <div style={{ display: 'flex', justifyContent: 'center' }}>
                                                            <span style={{
                                                                display: 'inline-flex',
                                                                alignItems: 'center',
                                                                justifyContent: 'center',
                                                                padding: '0.3rem 0.75rem',
                                                                borderRadius: '999px',
                                                                fontSize: '0.72rem',
                                                                fontWeight: 600,
                                                                letterSpacing: '0.03em',
                                                                textTransform: 'uppercase',
                                                                background: `${statusColor}22`,
                                                                color: statusColor,
                                                                border: `1px solid ${statusColor}55`
                                                            }}>{JOB_STATUS_LABELS[job.status]}</span>
                                                        </div>
                                                        <div style={{ textAlign: 'right' }}>
                                                            <p style={{
                                                                margin: 0,
                                                                color: 'rgba(255, 255, 255, 0.7)',
                                                                fontSize: '0.8rem'
                                                            }}>Completed</p>
                                                            <p style={{
                                                                margin: '0.25rem 0 0',
                                                                fontSize: '0.9rem',
                                                                fontWeight: 500,
                                                                color: job.status === 'completed' ? '#22c55e' : 'rgba(255, 255, 255, 0.6)'
                                                            }}>{job.status === 'completed' ? formatJobDate(job.completedAt) : 'In progress'}</p>
                                                            <p style={{
                                                                margin: '0.25rem 0 0',
                                                                fontSize: '0.75rem',
                                                                color: 'rgba(255, 255, 255, 0.45)'
                                                            }}>{validLeads.toLocaleString()} valid · {totalProcessed.toLocaleString()} total</p>
                                                        </div>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    ) : (
                                        <p className="pipeline-panel__subtitle" style={{ marginTop: '1rem' }}>
                                            No completed jobs yet. Run the pipeline to populate history.
                                        </p>
                                    )}
                                </div>
                            </div>
                        </>
                    )}

                    {/* Leads Tab */}
                    {activeTab === "leads" && (
                        <>
                            <div style={{
                                display: 'flex',
                                gap: '1rem',
                                marginTop: '2rem',
                                flexWrap: 'wrap'
                            }}>
                                <div className="metric-chip">
                                    <span className="metric-chip__label">Total</span>
                                    <span className="metric-chip__value">{stats.total.toLocaleString()}</span>
                                </div>
                                <div className="metric-chip">
                                    <span className="metric-chip__label">Verified</span>
                                    <span className="metric-chip__value" style={{ color: '#16a34a' }}>{stats.verified.toLocaleString()}</span>
                                </div>
                                <div className="metric-chip">
                                    <span className="metric-chip__label">Unverified</span>
                                    <span className="metric-chip__value" style={{ color: '#a1a1aa' }}>{stats.unverified.toLocaleString()}</span>
                                </div>
                            </div>

                            <div style={{ marginTop: '1.5rem' }}>
                                {leads.length === 0 ? (
                                    <div className="pipeline-panel__empty">
                                        <p>No leads yet.</p>
                                        <p className="pipeline-panel__subtitle">Upload leads to start seeing them here.</p>
                                    </div>
                                ) : (
                                    <div style={{
                                        overflowX: 'auto',
                                        border: '1px solid rgba(255, 255, 255, 0.1)',
                                        borderRadius: '8px',
                                        backgroundColor: 'rgba(0, 0, 0, 0.2)'
                                    }}>
                                        <table style={{
                                            width: '100%',
                                            borderCollapse: 'collapse',
                                            fontSize: '0.875rem'
                                        }}>
                                            <thead>
                                                <tr style={{
                                                    backgroundColor: 'rgba(255, 255, 255, 0.05)',
                                                    borderBottom: '1px solid rgba(255, 255, 255, 0.1)'
                                                }}>
                                                    <th style={{
                                                        textAlign: 'left',
                                                        padding: '0.75rem 1rem',
                                                        fontWeight: 600,
                                                        color: 'rgba(255, 255, 255, 0.9)'
                                                    }}>Domain</th>
                                                    <th style={{
                                                        textAlign: 'left',
                                                        padding: '0.75rem 1rem',
                                                        fontWeight: 600,
                                                        color: 'rgba(255, 255, 255, 0.9)'
                                                    }}>Email</th>
                                                    <th style={{
                                                        textAlign: 'left',
                                                        padding: '0.75rem 1rem',
                                                        fontWeight: 600,
                                                        color: 'rgba(255, 255, 255, 0.9)'
                                                    }}>Status</th>
                                                    <th style={{
                                                        textAlign: 'left',
                                                        padding: '0.75rem 1rem',
                                                        fontWeight: 600,
                                                        color: 'rgba(255, 255, 255, 0.9)'
                                                    }}>Verified</th>
                                                    <th style={{
                                                        textAlign: 'left',
                                                        padding: '0.75rem 1rem',
                                                        fontWeight: 600,
                                                        color: 'rgba(255, 255, 255, 0.9)'
                                                    }}>First Line</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {leads.slice(0, 20).map((lead, index) => (
                                                    <tr
                                                        key={lead.id}
                                                        onClick={() => setSelectedLead(lead)}
                                                        style={{
                                                            backgroundColor: index % 2 === 0 ? 'transparent' : 'rgba(255, 255, 255, 0.03)',
                                                            borderBottom: index < 19 && index < leads.length - 1 ? '1px solid rgba(255, 255, 255, 0.05)' : 'none',
                                                            cursor: 'pointer',
                                                            transition: 'background-color 0.15s ease'
                                                        }}
                                                        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.08)'}
                                                        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = index % 2 === 0 ? 'transparent' : 'rgba(255, 255, 255, 0.03)'}
                                                    >
                                                        <td style={{
                                                            padding: '0.75rem 1rem',
                                                            maxWidth: '200px',
                                                            overflow: 'hidden',
                                                            textOverflow: 'ellipsis',
                                                            whiteSpace: 'nowrap'
                                                        }}>{lead.domain || '—'}</td>
                                                        <td style={{
                                                            padding: '0.75rem 1rem',
                                                            maxWidth: '250px',
                                                            overflow: 'hidden',
                                                            textOverflow: 'ellipsis',
                                                            whiteSpace: 'nowrap'
                                                        }}>{lead.email || '—'}</td>
                                                        <td style={{
                                                            padding: '0.75rem 1rem',
                                                            maxWidth: '120px',
                                                            overflow: 'hidden',
                                                            textOverflow: 'ellipsis',
                                                            whiteSpace: 'nowrap'
                                                        }}>{lead.status || '—'}</td>
                                                        <td style={{
                                                            padding: '0.75rem 1rem',
                                                            color: lead.verified ? '#16a34a' : 'rgba(255, 255, 255, 0.5)'
                                                        }}>{lead.verified ? 'Yes' : 'No'}</td>
                                                        <td style={{
                                                            padding: '0.75rem 1rem',
                                                            maxWidth: '400px',
                                                            overflow: 'hidden',
                                                            textOverflow: 'ellipsis',
                                                            whiteSpace: 'nowrap',
                                                            fontStyle: lead.firstLine ? 'italic' : 'normal',
                                                            color: lead.firstLine ? 'rgba(255, 255, 255, 0.85)' : 'rgba(255, 255, 255, 0.3)'
                                                        }}>{lead.firstLine || '—'}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                            </div>
                        </>
                    )}
                </section>
            </AppShell>

            {/* Upload Modal - Wizard */}
            {modalOpen && (
                <div
                    className="modal-overlay"
                    role="dialog"
                    aria-modal="true"
                    onClick={() => setModalOpen(false)}
                >
                    <div className="modal" onClick={(event) => event.stopPropagation()} style={{ maxWidth: '720px' }}>
                        <div className="modal__header">
                            <div>
                                <p className="eyebrow eyebrow--muted">Step {wizardStep} / 3</p>
                                <h2 className="modal__title">
                                    {wizardStep === 1 && '📤 Upload CSV'}
                                    {wizardStep === 2 && '⚙️ Processing Options'}
                                    {wizardStep === 3 && '✨ Personalization'}
                                </h2>
                                <p className="modal__description">
                                    {wizardStep === 1 && 'Upload your CSV file with domain column'}
                                    {wizardStep === 2 && 'Configure enrichment and verification steps'}
                                    {wizardStep === 3 && 'Industry-specific personalization settings'}
                                </p>
                            </div>
                        </div>

                        <div className="modal__body">
                            {/* Step Progress Indicator */}
                            <div style={{
                                display: 'flex',
                                gap: '0.5rem',
                                marginBottom: '1.5rem'
                            }}>
                                {[1, 2, 3].map((step) => (
                                    <div
                                        key={step}
                                        style={{
                                            flex: 1,
                                            height: '4px',
                                            borderRadius: '2px',
                                            background: step <= wizardStep ? '#3b82f6' : 'rgba(255, 255, 255, 0.15)',
                                            transition: 'background 0.3s ease'
                                        }}
                                    />
                                ))}
                            </div>

                            {/* Step 1: File Upload */}
                            {wizardStep === 1 && (
                                <>
                                    <label className="upload-area">
                                        <span className="upload-area__title">Drop CSV or click to browse</span>
                                        <span className="upload-area__hint">Must contain a domain column</span>
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
                                </>
                            )}

                            {/* Step 2: Processing Options */}
                            {wizardStep === 2 && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                                    <label className="settings-field">
                                        <span className="settings-field__label">Duplicates</span>
                                        <select
                                            value={dedupeStrategy}
                                            onChange={(e) => setDedupeStrategy(e.target.value as 'skip' | 'include')}
                                        >
                                            <option value="skip">Skip domains already tried</option>
                                            <option value="include">Re-process domains</option>
                                        </select>
                                        <span className="settings-field__hint">Deduplication is scoped to this client.</span>
                                    </label>

                                    <div style={{
                                        display: 'flex',
                                        flexDirection: 'column',
                                        gap: '0.75rem',
                                        padding: '1rem',
                                        background: 'rgba(255, 255, 255, 0.03)',
                                        borderRadius: '8px',
                                        border: '1px solid rgba(255, 255, 255, 0.1)'
                                    }}>
                                        <label style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '0.75rem',
                                            cursor: 'pointer',
                                            padding: '0.5rem',
                                            opacity: 1
                                        }}>
                                            <input
                                                type="checkbox"
                                                checked={findFounder}
                                                onChange={(e) => {
                                                    const checked = e.target.checked;
                                                    setFindFounder(checked);
                                                    // If unchecking, cascade disable dependent options
                                                    if (!checked) {
                                                        setFindEmail(false);
                                                        setVerifyEmail(false);
                                                    }
                                                }}
                                                style={{
                                                    width: '18px',
                                                    height: '18px',
                                                    cursor: 'pointer',
                                                    borderRadius: '4px',
                                                    appearance: 'none',
                                                    border: '2px solid rgba(255, 255, 255, 0.3)',
                                                    background: findFounder ? '#3b82f6' : 'transparent',
                                                    position: 'relative',
                                                    flexShrink: 0
                                                }}
                                            />
                                            {findFounder && (
                                                <svg
                                                    style={{
                                                        position: 'absolute',
                                                        width: '18px',
                                                        height: '18px',
                                                        pointerEvents: 'none',
                                                        marginLeft: '0px'
                                                    }}
                                                    viewBox="0 0 18 18"
                                                    fill="none"
                                                >
                                                    <path
                                                        d="M14 6L7.5 12.5L4 9"
                                                        stroke="white"
                                                        strokeWidth="2"
                                                        strokeLinecap="round"
                                                        strokeLinejoin="round"
                                                    />
                                                </svg>
                                            )}
                                            <div style={{ flex: 1 }}>
                                                <div style={{ fontWeight: 500, color: 'rgba(255, 255, 255, 0.9)' }}>
                                                    Find Founder
                                                </div>
                                                <div style={{ fontSize: '0.875rem', color: 'rgba(255, 255, 255, 0.6)', marginTop: '0.125rem' }}>
                                                    Search for founder names using Serper + OpenAI
                                                </div>
                                            </div>
                                        </label>

                                        <label style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '0.75rem',
                                            cursor: findFounder ? 'pointer' : 'not-allowed',
                                            padding: '0.5rem',
                                            opacity: findFounder ? 1 : 0.5
                                        }}>
                                            <input
                                                type="checkbox"
                                                checked={findEmail}
                                                disabled={!findFounder}
                                                onChange={(e) => {
                                                    const checked = e.target.checked;
                                                    setFindEmail(checked);
                                                    // If unchecking, cascade disable verify email
                                                    if (!checked) {
                                                        setVerifyEmail(false);
                                                    }
                                                }}
                                                style={{
                                                    width: '18px',
                                                    height: '18px',
                                                    cursor: findFounder ? 'pointer' : 'not-allowed',
                                                    borderRadius: '4px',
                                                    appearance: 'none',
                                                    border: `2px solid rgba(255, 255, 255, ${findFounder ? '0.3' : '0.15'})`,
                                                    background: findEmail ? '#3b82f6' : 'transparent',
                                                    position: 'relative',
                                                    flexShrink: 0
                                                }}
                                            />
                                            {findEmail && (
                                                <svg
                                                    style={{
                                                        position: 'absolute',
                                                        width: '18px',
                                                        height: '18px',
                                                        pointerEvents: 'none',
                                                        marginLeft: '0px'
                                                    }}
                                                    viewBox="0 0 18 18"
                                                    fill="none"
                                                >
                                                    <path
                                                        d="M14 6L7.5 12.5L4 9"
                                                        stroke="white"
                                                        strokeWidth="2"
                                                        strokeLinecap="round"
                                                        strokeLinejoin="round"
                                                    />
                                                </svg>
                                            )}
                                            <div style={{ flex: 1 }}>
                                                <div style={{ fontWeight: 500, color: 'rgba(255, 255, 255, 0.9)' }}>
                                                    Find Email
                                                </div>
                                                <div style={{ fontSize: '0.875rem', color: 'rgba(255, 255, 255, 0.6)', marginTop: '0.125rem' }}>
                                                    Discover email addresses with TryKitt
                                                </div>
                                            </div>
                                        </label>

                                        <label style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '0.75rem',
                                            cursor: (findFounder && findEmail) ? 'pointer' : 'not-allowed',
                                            padding: '0.5rem',
                                            opacity: (findFounder && findEmail) ? 1 : 0.5
                                        }}>
                                            <input
                                                type="checkbox"
                                                checked={verifyEmail}
                                                disabled={!findFounder || !findEmail}
                                                onChange={(e) => setVerifyEmail(e.target.checked)}
                                                style={{
                                                    width: '18px',
                                                    height: '18px',
                                                    cursor: (findFounder && findEmail) ? 'pointer' : 'not-allowed',
                                                    borderRadius: '4px',
                                                    appearance: 'none',
                                                    border: `2px solid rgba(255, 255, 255, ${(findFounder && findEmail) ? '0.3' : '0.15'})`,
                                                    background: verifyEmail ? '#3b82f6' : 'transparent',
                                                    position: 'relative',
                                                    flexShrink: 0
                                                }}
                                            />
                                            {verifyEmail && (
                                                <svg
                                                    style={{
                                                        position: 'absolute',
                                                        width: '18px',
                                                        height: '18px',
                                                        pointerEvents: 'none',
                                                        marginLeft: '0px'
                                                    }}
                                                    viewBox="0 0 18 18"
                                                    fill="none"
                                                >
                                                    <path
                                                        d="M14 6L7.5 12.5L4 9"
                                                        stroke="white"
                                                        strokeWidth="2"
                                                        strokeLinecap="round"
                                                        strokeLinejoin="round"
                                                    />
                                                </svg>
                                            )}
                                            <div style={{ flex: 1 }}>
                                                <div style={{ fontWeight: 500, color: 'rgba(255, 255, 255, 0.9)' }}>
                                                    Verify Email
                                                </div>
                                                <div style={{ fontSize: '0.875rem', color: 'rgba(255, 255, 255, 0.6)', marginTop: '0.125rem' }}>
                                                    Validate email deliverability with TryKitt
                                                </div>
                                            </div>
                                        </label>
                                    </div>
                                </div>
                            )}

                            {/* Step 3: Personalization */}
                            {wizardStep === 3 && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                                    <label className="settings-field">
                                        <span className="settings-field__label">Industry</span>
                                        <select
                                            value={clientIndustry}
                                            onChange={(e) => setClientIndustry(e.target.value as Niche['id'])}
                                        >
                                            <option value="ecom">E-commerce</option>
                                            <option value="saas">SaaS</option>
                                            <option value="agency">Agency</option>
                                            <option value="local">Local Business</option>
                                        </select>
                                        <span className="settings-field__hint">Select your target industry for personalization.</span>
                                    </label>

                                    <div style={{
                                        display: 'flex',
                                        flexDirection: 'column',
                                        gap: '0.75rem',
                                        padding: '1rem',
                                        background: 'rgba(255, 255, 255, 0.03)',
                                        borderRadius: '8px',
                                        border: '1px solid rgba(255, 255, 255, 0.1)'
                                    }}>
                                        {clientIndustry === 'ecom' && (
                                            <label style={{
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: '0.75rem',
                                                cursor: 'pointer',
                                                padding: '0.5rem'
                                            }}>
                                                <input
                                                    type="checkbox"
                                                    checked={personalizeFirstLine}
                                                    onChange={(e) => setPersonalizeFirstLine(e.target.checked)}
                                                    style={{ width: '18px', height: '18px', cursor: 'pointer' }}
                                                />
                                                <div style={{ flex: 1 }}>
                                                    <div style={{ fontWeight: 500, color: 'rgba(255, 255, 255, 0.9)' }}>
                                                        Personalize with Product Data
                                                    </div>
                                                    <div style={{ fontSize: '0.875rem', color: 'rgba(255, 255, 255, 0.6)', marginTop: '0.125rem' }}>
                                                        Generate first line based on Shopify products
                                                    </div>
                                                </div>
                                            </label>
                                        )}

                                        {clientIndustry === 'saas' && (
                                            <label style={{
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: '0.75rem',
                                                cursor: 'pointer',
                                                padding: '0.5rem'
                                            }}>
                                                <input
                                                    type="checkbox"
                                                    checked={personalizeFirstLine}
                                                    onChange={(e) => setPersonalizeFirstLine(e.target.checked)}
                                                    style={{ width: '18px', height: '18px', cursor: 'pointer' }}
                                                />
                                                <div style={{ flex: 1 }}>
                                                    <div style={{ fontWeight: 500, color: 'rgba(255, 255, 255, 0.9)' }}>
                                                        Personalize with Feature/Benefit
                                                    </div>
                                                    <div style={{ fontSize: '0.875rem', color: 'rgba(255, 255, 255, 0.6)', marginTop: '0.125rem' }}>
                                                        Generate first line based on SaaS features
                                                    </div>
                                                </div>
                                            </label>
                                        )}

                                        {clientIndustry === 'agency' && (
                                            <label style={{
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: '0.75rem',
                                                cursor: 'pointer',
                                                padding: '0.5rem'
                                            }}>
                                                <input
                                                    type="checkbox"
                                                    checked={personalizeFirstLine}
                                                    onChange={(e) => setPersonalizeFirstLine(e.target.checked)}
                                                    style={{ width: '18px', height: '18px', cursor: 'pointer' }}
                                                />
                                                <div style={{ flex: 1 }}>
                                                    <div style={{ fontWeight: 500, color: 'rgba(255, 255, 255, 0.9)' }}>
                                                        Personalize with Client Name
                                                    </div>
                                                    <div style={{ fontSize: '0.875rem', color: 'rgba(255, 255, 255, 0.6)', marginTop: '0.125rem' }}>
                                                        Generate first line referencing current clients
                                                    </div>
                                                </div>
                                            </label>
                                        )}

                                        {clientIndustry === 'local' && (
                                            <label style={{
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: '0.75rem',
                                                cursor: 'pointer',
                                                padding: '0.5rem'
                                            }}>
                                                <input
                                                    type="checkbox"
                                                    checked={personalizeFirstLine}
                                                    onChange={(e) => setPersonalizeFirstLine(e.target.checked)}
                                                    style={{ width: '18px', height: '18px', cursor: 'pointer' }}
                                                />
                                                <div style={{ flex: 1 }}>
                                                    <div style={{ fontWeight: 500, color: 'rgba(255, 255, 255, 0.9)' }}>
                                                        Personalize with Service Offering
                                                    </div>
                                                    <div style={{ fontSize: '0.875rem', color: 'rgba(255, 255, 255, 0.6)', marginTop: '0.125rem' }}>
                                                        Generate first line based on local services
                                                    </div>
                                                </div>
                                            </label>
                                        )}
                                    </div>

                                    {/* Campaign selection removed; will be chosen after job completes in the upload modal */}
                                </div>
                            )}

                            {/* Navigation Buttons */}
                            <div className="modal__actions" style={{ marginTop: '1.5rem' }}>
                                {wizardStep > 1 && (
                                    <button
                                        type="button"
                                        className="secondary-button secondary-button--active"
                                        onClick={() => setWizardStep((prev) => (prev - 1) as 1 | 2 | 3)}
                                    >
                                        Back
                                    </button>
                                )}
                                {wizardStep < 3 ? (
                                    <button
                                        type="button"
                                        className="primary-button"
                                        disabled={wizardStep === 1 ? !selectedFile : false}
                                        onClick={() => setWizardStep((prev) => (prev + 1) as 1 | 2 | 3)}
                                    >
                                        Next
                                    </button>
                                ) : (
                                    <button
                                        type="button"
                                        className="primary-button"
                                        disabled={uploading}
                                        onClick={handleUploadClick}
                                    >
                                        {uploading ? "Processing..." : "Upload Leads"}
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Upload to Instantly Modal (rendered once) */}
            {uploadModalOpen && (
                <div
                    className="modal-overlay"
                    role="dialog"
                    aria-modal="true"
                    onClick={() => setUploadModalOpen(false)}
                >
                    <div className="modal" onClick={(event) => event.stopPropagation()} style={{ maxWidth: '900px' }}>
                        <div className="modal__header">
                            <div>
                                <h2 className="modal__title">Map Columns to Instantly</h2>
                                <p className="modal__description">
                                    Map your CSV columns to Instantly variables. Preview shows first 3 rows.
                                </p>
                            </div>
                        </div>

                        <div className="modal__body" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
                            <label className="settings-field" style={{ marginBottom: '1.5rem' }}>
                                <span className="settings-field__label">Campaign *</span>
                                <select
                                    value={selectedCampaignId}
                                    onChange={(e) => setSelectedCampaignId(e.target.value)}
                                >
                                    <option value="">Select campaign...</option>
                                    {campaigns.filter(c => c.status === 1).map((campaign) => (
                                        <option key={campaign.id} value={campaign.id}>{campaign.name}</option>
                                    ))}
                                </select>
                            </label>

                            <div style={{ marginBottom: '2rem' }}>
                                <h3 style={{ fontSize: '1rem', marginBottom: '1rem', color: 'rgba(255, 255, 255, 0.9)' }}>Standard Variables</h3>
                                {['email', 'firstName', 'lastName', 'website', 'personalization'].map((field) => {
                                    const displayName = field === 'firstName' ? 'First Name' : field === 'lastName' ? 'Last Name' : field === 'companyName' ? 'Company Name' : field.charAt(0).toUpperCase() + field.slice(1);
                                    return (
                                        <div key={field} style={{ marginBottom: '1.5rem' }}>
                                            <label className="settings-field">
                                                <span className="settings-field__label">{displayName} {field === 'email' && '*'}</span>
                                                <select value={columnMapping[field]?.column || ''} onChange={(e) => setColumnMapping({ ...columnMapping, [field]: { column: e.target.value, isCustom: false } })}>
                                                    <option value="">-- Not mapped --</option>
                                                    {csvHeaders.map((header) => (<option key={header} value={header}>{header}</option>))}
                                                </select>
                                            </label>
                                            {columnMapping[field]?.column && csvPreviewRows.length > 0 && (
                                                <div style={{ marginTop: '0.5rem', padding: '0.75rem', background: 'rgba(255, 255, 255, 0.03)', borderRadius: '6px', fontSize: '0.875rem' }}>
                                                    <div style={{ color: 'rgba(255, 255, 255, 0.6)', marginBottom: '0.5rem' }}>Preview:</div>
                                                    {csvPreviewRows.slice(0, 3).map((row, idx) => (
                                                        <div key={idx} style={{ padding: '0.375rem 0', color: 'rgba(255, 255, 255, 0.8)', borderBottom: idx < 2 ? '1px solid rgba(255, 255, 255, 0.1)' : 'none' }}>
                                                            {row[columnMapping[field].column] || '(empty)'}
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                        <div className="modal__actions">
                            <button type="button" className="secondary-button secondary-button--active" onClick={() => setUploadModalOpen(false)}>Cancel</button>
                            <button type="button" className="primary-button" disabled={uploading || !columnMapping.email?.column || !selectedCampaignId} onClick={handleConfirmUpload}>
                                {uploading ? 'Uploading...' : 'Upload to Instantly'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Lead Detail Panel */}
            {selectedLead && (
                <>
                    <div
                        className="modal-overlay"
                        role="dialog"
                        aria-modal="true"
                        onClick={() => setSelectedLead(null)}
                        style={{ zIndex: 10000 }}
                    />
                    <div
                        className="modal"
                        style={{
                            position: 'fixed',
                            top: 0,
                            right: 0,
                            bottom: 0,
                            width: '480px',
                            maxWidth: '90vw',
                            height: '100vh',
                            maxHeight: 'none',
                            margin: 0,
                            borderRadius: '0',
                            transform: 'translateX(0)',
                            opacity: 1,
                            overflowY: 'auto',
                            zIndex: 10001,
                            animation: 'slideInFromRight 0.25s ease-out'
                        }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <style jsx>{`
              @keyframes slideInFromRight {
                from {
                  transform: translateX(100%);
                }
                to {
                  transform: translateX(0);
                }
              }
            `}</style>

                        <div className="modal__header">
                            <div>
                                <p className="eyebrow eyebrow--muted">Lead Details</p>
                                <h2 className="modal__title">{selectedLead.domain}</h2>
                            </div>
                            <button
                                onClick={() => setSelectedLead(null)}
                                style={{
                                    background: 'transparent',
                                    border: 'none',
                                    cursor: 'pointer',
                                    color: 'rgba(255, 255, 255, 0.6)',
                                    fontSize: '1.5rem',
                                    padding: '0.25rem',
                                    lineHeight: 1
                                }}
                            >
                                ✕
                            </button>
                        </div>

                        <div className="modal__body">
                            <label className="settings-field">
                                <span className="settings-field__label">Founder</span>
                                <div style={{ padding: '0.625rem 0', color: 'rgba(255, 255, 255, 0.9)' }}>
                                    {selectedLead.founderName || '—'}
                                </div>
                            </label>

                            <label className="settings-field">
                                <span className="settings-field__label">Email</span>
                                <div style={{ padding: '0.625rem 0', color: 'rgba(255, 255, 255, 0.9)', wordBreak: 'break-all' }}>
                                    {selectedLead.email || '—'}
                                </div>
                            </label>

                            <label className="settings-field">
                                <span className="settings-field__label">Email Status</span>
                                <div style={{
                                    padding: '0.625rem 0',
                                    color: selectedLead.verified ? '#16a34a' : 'rgba(255, 255, 255, 0.7)'
                                }}>
                                    {selectedLead.status || '—'}
                                </div>
                            </label>

                            {(selectedLead.firstLine || selectedLead.personalizationTitle) && (
                                <>
                                    <div style={{ borderTop: '1px solid rgba(255, 255, 255, 0.1)', margin: '1.5rem 0' }} />

                                    {selectedLead.personalizationTitle && (
                                        <label className="settings-field">
                                            <span className="settings-field__label">Product Title</span>
                                            <div style={{ padding: '0.625rem 0', color: 'rgba(255, 255, 255, 0.9)' }}>
                                                {selectedLead.personalizationTitle}
                                            </div>
                                        </label>
                                    )}

                                    {selectedLead.personalizationUrl && (
                                        <label className="settings-field">
                                            <span className="settings-field__label">Product URL</span>
                                            <a
                                                href={selectedLead.personalizationUrl}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                style={{
                                                    display: 'block',
                                                    padding: '0.625rem 0',
                                                    color: '#3b82f6',
                                                    textDecoration: 'none',
                                                    wordBreak: 'break-all'
                                                }}
                                            >
                                                {selectedLead.personalizationUrl}
                                            </a>
                                        </label>
                                    )}

                                    {selectedLead.firstLine && (
                                        <label className="settings-field">
                                            <span className="settings-field__label">AI First Line</span>
                                            <div style={{
                                                padding: '0.75rem',
                                                backgroundColor: 'rgba(59, 130, 246, 0.1)',
                                                borderRadius: '6px',
                                                borderLeft: '3px solid rgba(59, 130, 246, 0.5)',
                                                fontStyle: 'italic',
                                                color: 'rgba(255, 255, 255, 0.9)',
                                                marginTop: '0.5rem'
                                            }}>
                                                "{selectedLead.firstLine}"
                                            </div>
                                        </label>
                                    )}
                                </>
                            )}

                            <div style={{ borderTop: '1px solid rgba(255, 255, 255, 0.1)', margin: '1.5rem 0' }} />

                            <label className="settings-field">
                                <span className="settings-field__label">Domain ID</span>
                                <div style={{
                                    padding: '0.625rem 0',
                                    color: 'rgba(255, 255, 255, 0.6)',
                                    fontFamily: 'monospace',
                                    fontSize: '0.875rem'
                                }}>
                                    {selectedLead.id}
                                </div>
                            </label>

                            {selectedLead.updatedAt && (
                                <label className="settings-field">
                                    <span className="settings-field__label">Last Updated</span>
                                    <div style={{ padding: '0.625rem 0', color: 'rgba(255, 255, 255, 0.6)', fontSize: '0.875rem' }}>
                                        {selectedLead.updatedAt}
                                    </div>
                                </label>
                            )}
                        </div>
                    </div>
                </>
            )}

            {/* Toast Notification */}
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
        </>
    );
}

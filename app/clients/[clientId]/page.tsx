"use client";

import { ChangeEvent, FormEvent, UIEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { doc, serverTimestamp, setDoc, collection, onSnapshot, query, orderBy, getDocs, limit, startAfter, where, startAt, endAt, DocumentSnapshot } from "firebase/firestore";
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
    campaigns?: string[];
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
    "pending-upload": "Ready to Upload",
    uploaded: "Uploaded",
    discarded: "Discarded",
    error: "Error",
    cancelled: "Cancelled",
    paused: "Paused",
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
    "pending-upload": "#22c55e",
    uploaded: "#10b981",
    discarded: "#a1a1aa",
    error: "#f87171",
    cancelled: "#a1a1aa",
    paused: "#f59e0b",
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
    if (!stage) {
        return [] as Array<[string, unknown]>;
    }
    const fallbackStats = stage.progress?.stats || {};
    const source = (stage.summary && Object.keys(stage.summary).length > 0) ? stage.summary : fallbackStats;
    return Object.entries(source);
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

const extractNumberFrom = (source: Record<string, unknown> | null | undefined, keys: string[]) => {
    if (!source) return null;
    for (const key of keys) {
        const value = source[key];
        if (typeof value === "number" && Number.isFinite(value)) {
            return value;
        }
    }
    return null;
};

const deriveStageTotals = (stage?: PipelineStageState) => {
    const stageName = stage?.progress?.stage;
    const progress = stage?.progress;
    const summary = stage?.summary as Record<string, unknown> | null;
    const stats = progress?.stats as Record<string, unknown> | undefined;

    // if it's the founders stage, or email find stage, use found
    // if it's the verification stage, use verified/valid
    const throughputNum =
        stageName === "founders" || stageName === "emailDiscovery" ?
            (typeof progress?.found === "number" && Number.isFinite(progress.found) ? progress.found : null)
            ?? extractNumberFrom(stats, ["Found", "processed", "completed", "personalized"])
            ?? extractNumberFrom(summary, ["Found", "processed", "completed", "personalized"])
            : stageName === "verification" ?
                extractNumberFrom(summary, ["Valid", "valid"])
                ?? extractNumberFrom(stats, ["valid"])
                : stageName === "personalization" ?
                    extractNumberFrom(summary, ["personalized", "Personalized"])
                    ?? (typeof progress?.stats?.['personalized'] === "number" && Number.isFinite(progress.stats?.personalized) ? progress.stats.personalized : null) : null;

    const total =
        (typeof progress?.total === "number" && Number.isFinite(progress.total) ? progress.total : null)
        ?? extractNumberFrom(stats, ["total", "queued", "attempted"])
        ?? extractNumberFrom(summary, ["total", "queued", "attempted"]);

    return { throughputNum, total };
};

export default function ClientPage() {
    const router = useRouter();
    const params = useParams();
    const searchParams = useSearchParams();
    const clientId = (params?.clientId as string) || "";
    const { user, loading } = useAuth();

    const [activeTab, setActiveTab] = useState<"info" | "campaigns" | "leads">(
        (searchParams?.get("tab") as "info" | "campaigns" | "leads") || "campaigns"
    );
    const [clientName, setClientName] = useState<string>(clientId);
    const [clientIndustry, setClientIndustry] = useState<Niche["id"]>("ecom");
    const [clientInstantlyKey, setClientInstantlyKey] = useState<string>("");
    const [emailProvider, setEmailProvider] = useState<'trykitt' | 'self_hosted'>('trykitt');

    // Campaign state
    const [modalOpen, setModalOpen] = useState(false);
    const [wizardStep, setWizardStep] = useState<1 | 2 | 3 | 4>(1);
    const [selectedFile, setSelectedFile] = useState<File | null>(null);
    const [csvColumns, setCsvColumns] = useState<string[]>([]);
    const [domainColumn, setDomainColumn] = useState<string>("");
    const [founderColumn, setFounderColumn] = useState<string>("");
    const [emailColumn, setEmailColumn] = useState<string>("");

    // Step 2: Processing options
    const [dedupeStrategy, setDedupeStrategy] = useState<'skip' | 'include'>('skip');
    const [findFounder, setFindFounder] = useState(true);
    const [findEmail, setFindEmail] = useState(true);
    const [verifyEmail, setVerifyEmail] = useState(true);
    const [filterStats, setFilterStats] = useState<{ raw: number; normalized: number; inBatchDupes: number; crossRunDupes: number; willProcess: number } | null>(null);

    // Step 3: Personalization options
    const [selectedCampaignId, setSelectedCampaignId] = useState<string>("");
    const [personalizeFirstLine, setPersonalizeFirstLine] = useState(false);
    const [skipFounderFinder, setSkipFounderFinder] = useState(false);
    const [skipEmailFinder, setSkipEmailFinder] = useState(false);
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
    const lastActiveStatusRef = useRef<string | null>(null);
    const previousJobIdRef = useRef<string | null>(null);
    const lastUploadErrorRef = useRef<string | null>(null);
    const jobStateRef = useRef<PipelineJob | null>(null);
    const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
    const [activeJobStatus, setActiveJobStatus] = useState<string | null>(null);
    const [uploadMetrics, setUploadMetrics] = useState<{ count: number; total: number } | null>(null);
    const [instantlyUploadError, setInstantlyUploadError] = useState<string | null>(null);
    const [isSavingClient, setIsSavingClient] = useState(false);
    const [isDeletingClient, setIsDeletingClient] = useState(false);
    const [deletingJobId, setDeletingJobId] = useState<string | null>(null);
    const [pausingJob, setPausingJob] = useState(false);

    const instantlyWebhookUrl = useMemo(() => {
        if (!user || !clientId) return "";
        return `https://api.shieldsoutboundserver.org/webhook/events/${user.uid}/${clientId}`;
    }, [user, clientId]);
    const [copiedWebhook, setCopiedWebhook] = useState(false);

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
    const [downloadModalOpen, setDownloadModalOpen] = useState(false);
    const [downloadScope, setDownloadScope] = useState<'all' | 'valid'>('all');
    const [stoppingJob, setStoppingJob] = useState(false);
    const leadsContainerRef = useRef<HTMLDivElement | null>(null);

    // Leads state
    const [leads, setLeads] = useState<Lead[]>([]);
    const [allLeadsCached, setAllLeadsCached] = useState(false); // Track if we've fetched all leads for filtering
    const [stats, setStats] = useState<{ total: number; verified: number; unverified: number }>(() => ({ total: 0, verified: 0, unverified: 0 }));
    const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
    const [leadsLoading, setLeadsLoading] = useState(false);
    const [leadsHasMore, setLeadsHasMore] = useState(true);
    const [leadsCursor, setLeadsCursor] = useState<number>(0);
    const [campaignFilterId, setCampaignFilterId] = useState<string>("");
    const [leadSearch, setLeadSearch] = useState<string>("");
    const [clientTotalLeads, setClientTotalLeads] = useState<number>(0);
    const [founderFilter, setFounderFilter] = useState<string>("");
    const [emailFilter, setEmailFilter] = useState<string>("");
    const [emailStatusFilter, setEmailStatusFilter] = useState<string>("");
    const [exportingCsv, setExportingCsv] = useState(false);

    // Campaigns state
    const [campaigns, setCampaigns] = useState<Campaign[]>([]);
    const [syncingCampaigns, setSyncingCampaigns] = useState(false);
    const [campaignSyncMessage, setCampaignSyncMessage] = useState("");

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

    const canUploadToInstantly = useMemo(() => {
        if (!jobState) {
            return false;
        }
        if (jobPendingUpload) {
            return true;
        }
        if (activeJobStatus === "pending-upload") {
            return true;
        }
        if (!activeJobStatus && jobState.status === "completed" ) {
            return true;
        }
        return false;
    }, [activeJobStatus, jobPendingUpload, jobState]);

    const stageCompletionPercent = useMemo(() => {
        if (!jobState?.stages) return 0;
        const totalStages = STAGE_ORDER.length;
        const completedStages = STAGE_ORDER.filter((key) => jobState.stages[key]?.status === 'completed').length;
        return Math.round((completedStages / totalStages) * 100);
    }, [jobState?.stages]);

    const validLeadsCompleted = useMemo(() => {
        if (!jobState?.stages) return 0;
        
        // Check final pipeline stage in reverse order
        const personalizationProcessed = jobState.stages.personalization?.summary?.processed;
        if (typeof personalizationProcessed === 'number' && personalizationProcessed > 0) {
            return personalizationProcessed;
        }
        
        // Check verification stage for valid + valid-risky
        const verValid = (jobState.stages.verification?.summary?.valid as number) || 0;
        const verValidRisky = (jobState.stages.verification?.summary?.['valid-risky'] as number) || 0;
        const verificationTotal = verValid + verValidRisky;
        if (verificationTotal > 0) {
            return verificationTotal;
        }
        
        // Fallback to email discovery found count
        const emailFound = jobState.stages.emailDiscovery?.summary?.found;
        if (typeof emailFound === 'number') return emailFound;
        
        return 0;
    }, [jobState?.stages]);

    const activeStatusLabel = useMemo(() => {
        if (!activeJobStatus) {
            return "";
        }

        const formatNumber = (value: unknown) =>
            typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : null;

        if (activeJobStatus === "pending-upload") {
            const readyCount = formatNumber(
                jobState?.stages?.verification?.summary?.valid
                ?? jobState?.stages?.emailDiscovery?.summary?.found
                ?? jobState?.dedupeStats?.new
            );
            const totalCount = formatNumber(
                jobState?.dedupeStats?.total
            );
            const baseMessage = readyCount && totalCount
                ? `Ready to upload ${readyCount} of ${totalCount} leads to Instantly.`
                : readyCount
                    ? `Ready to upload ${readyCount} leads to Instantly.`
                    : "Ready for Instantly upload.";
            if (instantlyUploadError) {
                return `${baseMessage} Last upload attempt failed: ${instantlyUploadError}`;
            }
            return baseMessage;
        }

        if (activeJobStatus === "uploaded") {
            const uploadedCount = formatNumber(uploadMetrics?.count);
            const uploadedTotal = formatNumber(uploadMetrics?.total);
            if (uploadedCount && uploadedTotal && uploadedCount !== uploadedTotal) {
                return `Uploaded ${uploadedCount} of ${uploadedTotal} leads to Instantly.`;
            }
            if (uploadedCount) {
                return `Uploaded ${uploadedCount} leads to Instantly.`;
            }
            return "Leads uploaded to Instantly.";
        }

        if (activeJobStatus === "discarded") {
            return "Job discarded. Download CSV if you still need the leads.";
        }

        if (activeJobStatus === "error") {
            return jobState?.error || instantlyUploadError || "Pipeline failed.";
        }

        if (activeJobStatus === "running") {
            return "Pipeline running.";
        }

        if (activeJobStatus === "queued") {
            return "Pipeline queued.";
        }

        if (activeJobStatus === "completed") {
            return "Pipeline completed.";
        }

        return "";
    }, [activeJobStatus, uploadMetrics, instantlyUploadError, jobState]);

    const uploadedSummary = useMemo(() => {
        if (activeJobStatus !== "uploaded") {
            return "";
        }
        const count = uploadMetrics?.count;
        const total = uploadMetrics?.total;
        if (typeof count === "number" && Number.isFinite(count)) {
            if (typeof total === "number" && Number.isFinite(total) && total !== count) {
                return `${count.toLocaleString()} / ${total.toLocaleString()} leads uploaded`;
            }
            return `${count.toLocaleString()} leads uploaded`;
        }
        return "Uploaded to Instantly";
    }, [activeJobStatus, uploadMetrics]);

    const canDiscardJob = activeJobStatus === "pending-upload";

    useEffect(() => {
        if (user?.uid) {
            const userDocRef = doc(firestore, "users", user.uid);
            const unsubscribe = onSnapshot(userDocRef, (snapshot) => {
                if (snapshot.exists()) {
                    const data = snapshot.data();
                    setEmailProvider(data?.email_verification_provider || "trykitt");
                }
            });
            return () => unsubscribe();
        }
    }, [user]);

    // Auto-disable verification when using self-hosted (emails are already verified during finding)
    useEffect(() => {
        if (emailProvider === 'self_hosted') {
            setVerifyEmail(false);
        }
    }, [emailProvider]);

    useEffect(() => {
        if (!loading && !user) {
            router.replace("/auth");
        }
    }, [loading, user, router]);

    useEffect(() => {
        if (!user || !clientId) return;
        let cancelled = false;

        // Subscribe to client data
        const clientRef = doc(firestore, "users", user.uid, "clients", clientId);
        const unsubClient = onSnapshot(clientRef, (snap) => {
            if (cancelled) return;
            if (snap.exists()) {
                const data = snap.data();
                setClientName((data.name as string) || clientId);
                setClientIndustry((data.industry as Niche["id"]) || "ecom");
                setClientInstantlyKey((data.instantly_key as string) || "");
                setClientTotalLeads((data.totalLeads as number) || 0);
            }
        }, () => {
            if (!cancelled) {
                setClientName(clientId);
                setClientIndustry("ecom");
                setClientInstantlyKey("");
                setClientTotalLeads(0);
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
            try { unsubClient(); } catch { }
            try { unsubCampaigns(); } catch { }
        };
    }, [user, clientId]);

    useEffect(() => {
        if (!user || !clientId) return;
        
        // Reset and refetch when search, email status filter, or campaign changes
        setLeads([]);
        setLeadsCursor(0);
        setLeadsHasMore(true);
        fetchLeads(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user, clientId, leadSearch, emailStatusFilter, campaignFilterId]);

    // Trigger full data fetch when search or founder/email filters are first applied
    useEffect(() => {
        if (!user || !clientId) return;
        
        const needsFullFetch = Boolean(leadSearch || founderFilter || emailFilter);
        if (needsFullFetch && !allLeadsCached && leads.length > 0) {
            fetchLeads(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [founderFilter, emailFilter]);

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

    const campaignIdToName = useMemo(() => {
        const map = new Map<string, string>();
        campaigns.forEach((c) => map.set(c.id, c.name));
        return map;
    }, [campaigns]);

    const getCampaignNamesForLead = useCallback((lead: Lead) => {
        if (!lead.campaigns || lead.campaigns.length === 0) return [];
        return lead.campaigns.map((id) => campaignIdToName.get(id) || id);
    }, [campaignIdToName]);

    const fetchLeads = useCallback(async (reset = false) => {
        if (!user || !clientId) return;
        setLeadsLoading(true);
        try {
            // Get Firebase ID token for authentication
            const idToken = await getIdToken(user);
            
            // Build query parameters
            const params = new URLSearchParams();
            params.append('clientId', clientId);
            params.append('limit', '100'); // Reasonable page size

            if (emailStatusFilter) {
                params.append('emailStatus', emailStatusFilter);
            }

            // Send search term to backend for SQL filtering
            if (leadSearch.trim()) {
                params.append('search', leadSearch.trim());
            }

            if (!reset && leadsCursor) {
                params.append('offset', String(leadsCursor));
            }

            const response = await fetch(`http://localhost:4000/api/leads?${params.toString()}`, {
                headers: {
                    'Authorization': `Bearer ${idToken}`
                }
            });
            if (!response.ok) {
                throw new Error(`Failed to fetch leads: ${response.statusText}`);
            }

            const data = await response.json();
            const { leads: apiLeads, total, hasMore } = data;

            // Map API response to Lead type
            const mapped: Lead[] = apiLeads.map((row: any) => ({
                id: row.id,
                domain: row.domain || "",
                email: row.email || "",
                status: row.status || "",
                verified: row.verified,
                firstLine: row.firstLine || "",
                founderName: row.founderName || "",
                personalizationUrl: row.personalizationUrl || "",
                personalizationTitle: row.personalizationTitle || "",
                updatedAt: row.updatedAt || "",
                campaigns: row.campaigns || []
            }));

            setLeads(reset ? mapped : (prev) => [...prev, ...mapped]);
            
            // Use server-provided total count
            const verifiedCount = apiLeads.filter((r: any) => r.verified).length;
            setStats({
                total: total,
                verified: verifiedCount,
                unverified: Math.max(0, total - verifiedCount),
            });

            // Set cursor for pagination (use count of loaded items as offset)
            setLeadsCursor(reset ? mapped.length : (leadsCursor || 0) + mapped.length);
            setLeadsHasMore(hasMore || false);
        } catch (error) {
            console.error('Failed to fetch leads:', error);
            setLeadsHasMore(false);
        } finally {
            setLeadsLoading(false);
        }
    }, [user, clientId, leadSearch, leadsCursor, emailStatusFilter]);

    const loadMoreLeads = useCallback(() => {
        if (leadsLoading || !leadsHasMore) return;
        fetchLeads(false);
    }, [fetchLeads, leadsHasMore, leadsLoading]);

    // Leads are already filtered server-side, no need for client-side filtering
    const filteredLeads = useMemo(() => leads, [leads]);

    const displayedStats = useMemo(() => {
        // Stats come from server with filters applied
        return stats;
    }, [stats]);

    useEffect(() => {
        return () => {
            closeJobStream();
        };
    }, [closeJobStream]);

    useEffect(() => {
        jobStateRef.current = jobState;
    }, [jobState]);

    const fetchJobSnapshot = useCallback(async (jobId: string) => {
        if (!jobId || !user || !clientId) return;
        try {
            const idToken = await getIdToken(user);
            const response = await fetch(`${getPipelineBaseUrl()}/api/jobs/${jobId}?clientId=${clientId}`, {
                headers: {
                    'Authorization': `Bearer ${idToken}`
                }
            });
            if (!response.ok) return;
            const payload = await response.json();
            if (payload?.job) {
                setJobState(payload.job);
            }
        } catch (error) {
            console.error('Failed to fetch job snapshot:', error);
        }
    }, [user, clientId]);

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
        if (!user || !clientId) {
            return;
        }

        const activeJobRef = doc(firestore, "users", user.uid, "clients", clientId, "activeJob", "current");
        const unsubscribe = onSnapshot(activeJobRef, (snap) => {
            if (!snap.exists()) {
                setActiveJobStatus(null);
                setJobPendingUpload(null);
                setUploadMetrics(null);
                setJobStatusMessage("");
                setInstantlyUploadError(null);
                lastActiveStatusRef.current = null;
                previousJobIdRef.current = null;
                lastUploadErrorRef.current = null;
                return;
            }

            const data = snap.data() as Record<string, unknown>;
            const jobId = typeof data.jobId === "string" ? data.jobId : null;
            const status = typeof data.status === "string" ? data.status : null;
            const uploadErrorMessage = typeof data.uploadError === "string" ? data.uploadError : null;
            const errorMessage = typeof data.error === "string" ? data.error : uploadErrorMessage;
            const metricsRaw = data.uploadMetrics as Record<string, unknown> | undefined;

            const parsedMetrics = metricsRaw
                ? {
                    count: (() => {
                        const value = metricsRaw.count;
                        return typeof value === "number" && Number.isFinite(value) ? value : 0;
                    })(),
                    total: (() => {
                        const value = metricsRaw.total ?? metricsRaw.count;
                        return typeof value === "number" && Number.isFinite(value) ? value : 0;
                    })(),
                }
                : null;

            setActiveJobStatus(status);
            setUploadMetrics(parsedMetrics);
            setInstantlyUploadError(uploadErrorMessage);

            if (status === "pending-upload") {
                if (uploadErrorMessage && uploadErrorMessage !== lastUploadErrorRef.current) {
                    setToastMessage(uploadErrorMessage);
                    setToastVisible(true);
                }
                lastUploadErrorRef.current = uploadErrorMessage;
            } else {
                lastUploadErrorRef.current = null;
            }

            if (status === "pending-upload" && jobId) {
                setJobPendingUpload(jobId);
            } else if (status && status !== "pending-upload") {
                setJobPendingUpload(null);
            }

            if (jobId) {
                setSelectedJobId(jobId);
                const compositeKey = `${jobId}:${status ?? ""}`;
                if (previousJobIdRef.current !== compositeKey) {
                    previousJobIdRef.current = compositeKey;
                    fetchJobSnapshot(jobId);
                }
            } else {
                previousJobIdRef.current = null;
            }

            const shouldStream = status === "running" || status === "queued";
            const isStreaming = jobId && lastStreamingJobIdRef.current === jobId && Boolean(jobStreamRef.current);
            if (jobId && shouldStream) {
                if (!isStreaming) {
                    openJobStream(jobId);
                }
            } else if (isStreaming && (!status || status === "completed" || status === "pending-upload" || status === "uploaded" || status === "error" || status === "discarded")) {
                closeJobStream();
            }

            if (status && status !== lastActiveStatusRef.current) {
                if (status === "pending-upload") {
                    const message = "Pipeline finished. Ready for Instantly upload.";
                    setJobStatusMessage(message);
                    setToastMessage(message);
                    setToastVisible(true);
                } else if (status === "uploaded") {
                    const uploadedCount = parsedMetrics?.count ?? 0;
                    const uploadedTotal = parsedMetrics?.total ?? 0;
                    const detail = uploadedTotal
                        ? `Uploaded ${uploadedCount.toLocaleString()} of ${uploadedTotal.toLocaleString()} leads to Instantly.`
                        : `Uploaded ${uploadedCount.toLocaleString()} leads to Instantly.`;
                    setJobStatusMessage(detail);
                    setToastMessage(detail);
                    setToastVisible(true);
                    setUploadModalOpen(false);
                } else if (status === "discarded") {
                    const message = "Job discarded.";
                    setJobStatusMessage(message);
                    setToastMessage(message);
                    setToastVisible(true);
                    setUploadModalOpen(false);
                    setJobState(null);
                } else if (status === "error") {
                    const message = errorMessage || "Pipeline failed.";
                    setJobStatusMessage(message);
                    setToastMessage(message);
                    setToastVisible(true);
                } else if (status === "queued") {
                    setJobStatusMessage("Pipeline queued.");
                } else if (status === "running") {
                    setJobStatusMessage("Pipeline running.");
                }
                lastActiveStatusRef.current = status;
            }
        }, (error) => {
            console.error("Active job subscription error:", error);
        });

        return () => {
            unsubscribe();
        };
    }, [user, clientId, fetchJobSnapshot, openJobStream, closeJobStream]);

    useEffect(() => {
        if (!user || !clientId) {
            return;
        }
        const jobsRef = collection(firestore, "users", user.uid, "clients", clientId, "jobs");
        const jobsQuery = query(jobsRef, orderBy("createdAt", "desc"));
        const unsubscribe = onSnapshot(jobsQuery, (snap) => {
            console.log(`[Job History] Received ${snap.docs.length} jobs from Firestore`);
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
            console.log(`[Job History] Parsed jobs:`, rows.map(j => ({ id: j.id, status: j.status, fileName: j.fileName })));
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
        const selectedFromHistory = selectedJobId
            ? jobHistory.find((job) => job.id === selectedJobId) || null
            : null;

        const streamingSelected = (jobStreamConnected || jobState?.status === "running") && jobState && selectedJobId === jobState.id;

        // If we have an active job from the activeJob document that's not in history yet,
        // keep showing that instead of switching to history
        if (jobState && !jobHistory.find(j => j.id === jobState.id)) {
            // Active job exists but isn't in Firestore history yet - keep using it
            return;
        }

        if (selectedFromHistory && streamingSelected) {
            const statusChanged = jobState?.status !== selectedFromHistory.status;
            const completedChanged = jobState?.completedAt !== selectedFromHistory.completedAt;
            const errorChanged = jobState?.error !== selectedFromHistory.error;
            if (statusChanged || completedChanged || errorChanged) {
                setJobState((prev) => prev && prev.id === selectedFromHistory.id
                    ? { ...prev, ...selectedFromHistory, stages: selectedFromHistory.stages || prev.stages }
                    : selectedFromHistory);
            }
        }

        // If a job is selected and not streaming, keep it in sync with history
        if (selectedFromHistory && !streamingSelected) {
            setJobState((prev) => {
                const sameId = prev?.id === selectedFromHistory.id;
                const sameStatus = prev?.status === selectedFromHistory.status;
                const sameCompleted = prev?.completedAt === selectedFromHistory.completedAt;
                const sameError = prev?.error === selectedFromHistory.error;
                const prevStages = prev?.stages ? JSON.stringify(prev.stages) : null;
                const nextStages = selectedFromHistory.stages ? JSON.stringify(selectedFromHistory.stages) : null;
                const sameStages = prevStages === nextStages;
                if (sameId && sameStatus && sameCompleted && sameError && sameStages) {
                    return prev;
                }
                return { ...selectedFromHistory, stages: selectedFromHistory.stages || prev?.stages };
            });
            return;
        }

        // If nothing selected yet, default to latest
        if (!selectedJobId) {
            setSelectedJobId(latest.id);
            if (!streamingSelected) {
                setJobState(latest);
            }
            return;
        }

        // If the previously selected job disappeared, fall back to latest
        if (!selectedFromHistory && !streamingSelected) {
            setSelectedJobId(latest.id);
            setJobState(latest);
        }
    }, [jobHistory, jobState, jobStreamConnected, selectedJobId]);

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
                    await setDoc(jobRef, { status: 'pending-upload', uploadError: null, uploadMetrics: null }, { merge: true });
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
                    await setDoc(jobRef, { status: 'error', error: jobState.error, uploadMetrics: null }, { merge: true });
                } catch (error) {
                    console.error('Failed to update job status:', error);
                }
            })();
            lastStreamingJobIdRef.current = null;
        }
    }, [jobState, closeJobStream, user, clientId]);

    const handleRefreshCampaigns = useCallback(async () => {
        if (!user || !clientId) return;
        setSyncingCampaigns(true);
        setCampaignSyncMessage("");
        try {
            const idToken = await getIdToken(user);
            const resp = await fetch(`/api/clients/${encodeURIComponent(clientId)}/campaigns`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ idToken })
            });
            if (!resp.ok) {
                const data = await resp.json().catch(() => ({}));
                throw new Error(data.error || `Refresh failed (${resp.status})`);
            }
            const data = await resp.json();
            setCampaignSyncMessage(`Synced ${data.count ?? campaigns.length} campaigns.`);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to refresh campaigns';
            setCampaignSyncMessage(message);
        } finally {
            setSyncingCampaigns(false);
        }
    }, [user, clientId, campaigns.length]);

    const guessColumn = (columns: string[], candidates: string[]) => {
        const lower = columns.map((c) => c.toLowerCase());
        for (const candidate of candidates) {
            const idx = lower.findIndex((col) => col === candidate || col.includes(candidate));
            if (idx >= 0) return columns[idx];
        }
        return "";
    };

    const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0] ?? null;
        setSelectedFile(file);
        setUploadError("");

        // Reset mappings when a new file is chosen
        setCsvColumns([]);
        setDomainColumn("");
        setFounderColumn("");
        setEmailColumn("");

        if (!file) return;

        try {
            const text = await file.text();
            const headerLine = text.split(/\r?\n/).find((line) => line.trim().length > 0) || "";
            if (!headerLine) return;
            const columns = headerLine
                .split(",")
                .map((col) => col.trim().replace(/^"|"$/g, ""))
                .filter(Boolean);
            setCsvColumns(columns);

            const detectedDomain = guessColumn(columns, ["domain", "website", "url", "company"]);
            const detectedFounder = guessColumn(columns, ["founder_name", "founder", "owner", "ceo", "name"]);
            const detectedEmail = guessColumn(columns, ["email", "email_address", "contact_email", "mail"]);
            if (detectedDomain) {
                setDomainColumn(detectedDomain);
            }
            if (detectedFounder) {
                setFounderColumn(detectedFounder);
            }
            if (detectedEmail) {
                setEmailColumn(detectedEmail);
            }
        } catch (error) {
            console.error("Failed to read CSV header", error);
        }
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
                skipFounderFinder,
                findEmail,
                skipEmailFinder,
                verifyEmail,
                skipVerification: !verifyEmail, // Invert: unchecked verifyEmail means skip verification
                personalizeFirstLine,
                domainColumn,
                founderColumn,
                emailColumn,
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
                        const msg = `✓ Normalized & validated. Processing all ${total} domain${total !== 1 ? 's' : ''} (${newCount} new, ${existing} existing).`;
                        setToastMessage(msg);
                        setToastVisible(true);
                    } else {
                        const msg = `✓ Normalized & validated. Processing ${total} new domain${total !== 1 ? 's' : ''}.`;
                        setToastMessage(msg);
                        setToastVisible(true);
                    }
                } else {
                    if (skipped > 0) {
                        const msg = `✓ Filtered ${skipped} duplicate${skipped !== 1 ? 's' : ''}. Processing ${newCount} unique domain${newCount !== 1 ? 's' : ''}.`;
                        setToastMessage(msg);
                        setToastVisible(true);
                    } else {
                        const msg = `✓ All ${total} domain${total !== 1 ? 's are' : ' is'} unique. Processing started.`;
                        setToastMessage(msg);
                        setToastVisible(true);
                    }
                }

                // Store filter stats for display
                const inBatchDupes = 0; // Server now handles this internally
                const crossRunDupes = skipped;
                setFilterStats({
                    raw: total + skipped,
                    normalized: total,
                    inBatchDupes,
                    crossRunDupes,
                    willProcess: newCount
                });
            }

            const jobId = response.jobId || freshJob.id;

            // Save job ID to Firestore for persistence
            try {
                const jobRef = doc(firestore, "users", user.uid, "clients", clientId, "activeJob", "current");
                await setDoc(jobRef, {
                    jobId,
                    status: freshJob.status,
                    createdAt: serverTimestamp(),
                    campaignId: selectedCampaignId || null,
                    uploadError: null,
                    uploadMetrics: null
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

    // Auto-disable verification when using self-hosted (emails are already verified during finding)
    useEffect(() => {
        if (emailProvider === 'self-hosted') {
            setVerifyEmail(false);
        }
    }, [emailProvider]);

    // Adjust founder-related options based on mapped columns
    useEffect(() => {
        const hasFounderColumn = founderColumn.trim().length > 0;
        if (hasFounderColumn) {
            setSkipFounderFinder(true);
            setFindFounder(false);
        } else {
            setSkipFounderFinder(false);
            setFindFounder(true);
        }
    }, [founderColumn]);

    // Adjust email-related options based on mapped columns
    useEffect(() => {
        const hasEmailColumn = emailColumn.trim().length > 0;
        if (hasEmailColumn) {
            setSkipEmailFinder(true);
            setFindEmail(false);
        } else {
            setSkipEmailFinder(false);
            setFindEmail(true);
        }
    }, [emailColumn]);

    // Keep downstream steps coherent when founder finding is disabled
    useEffect(() => {
        // Only disable verification if NO founder info AND NO email info
        if (!findFounder && !skipFounderFinder && !findEmail && !skipEmailFinder) {
            setVerifyEmail(false);
        }
    }, [findFounder, skipFounderFinder, findEmail, skipEmailFinder]);

    const handleDownloadResults = (scope: 'all' | 'valid') => {
        if (!jobState || (jobState.status !== "completed" && jobState.status !== "pending-upload")) {
            return;
        }
        const url = getJobResultUrl(jobState.id, scope);
        window.open(url, "_blank", "noopener,noreferrer");
        setDownloadModalOpen(false);
    };

    const handleStopJob = async () => {
        if (!jobState || !user) return;
        setStoppingJob(true);
        setJobStatusMessage('Stopping job...');
        try {
            const idToken = await getIdToken(user);
            const resp = await fetch(`${getPipelineBaseUrl()}/api/jobs/${jobState.id}/stop`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ idToken, clientId })
            });
            if (!resp.ok) {
                const data = await resp.json().catch(() => ({}));
                throw new Error(data.error || `Failed to stop job (${resp.status})`);
            }
            closeJobStream();
            setJobState((prev) => prev ? { ...prev, status: 'cancelled', error: 'Cancelled by user' } : prev);
            setJobStatusMessage('Job cancelled.');
        } catch (error) {
            setToastMessage(error instanceof Error ? error.message : 'Failed to stop job');
            setToastVisible(true);
        } finally {
            setStoppingJob(false);
        }
    };

    const handlePauseResumeJob = async () => {
        if (!user || !jobState?.id || !clientId) return;
        
        const isPaused = jobState.status === 'paused';
        const endpoint = isPaused ? 'resume' : 'pause';
        
        setPausingJob(true);
        try {
            const idToken = await getIdToken(user);
            const resp = await fetch(`${getPipelineBaseUrl()}/api/jobs/${jobState.id}/${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ idToken, clientId })
            });
            if (!resp.ok) {
                const data = await resp.json().catch(() => ({}));
                throw new Error(data.error || `Failed to ${endpoint} job (${resp.status})`);
            }
            const newStatus = isPaused ? 'running' : 'paused';
            setJobState((prev) => prev ? { ...prev, status: newStatus as any } : prev);
            setJobStatusMessage(isPaused ? 'Job resumed.' : 'Job paused.');
        } catch (error) {
            setToastMessage(error instanceof Error ? error.message : `Failed to ${endpoint} job`);
            setToastVisible(true);
        } finally {
            setPausingJob(false);
        }
    };

    const handleSaveClientInfo = async () => {
        if (!user || !clientId) return;
        setIsSavingClient(true);
        try {
            const ref = doc(firestore, "users", user.uid, "clients", clientId);
            await setDoc(ref, {
                name: clientName?.trim() || clientId,
                industry: clientIndustry,
                instantly_key: clientInstantlyKey?.trim() || ""
            }, { merge: true });
            setToastMessage('Client info saved');
            setToastVisible(true);
        } catch (error) {
            setToastMessage(error instanceof Error ? error.message : 'Failed to save client info');
            setToastVisible(true);
        } finally {
            setIsSavingClient(false);
        }
    };

    const handleDeleteClient = async () => {
        if (!user || !clientId) return;
        const confirmed = window.confirm("Delete this client? This removes the client record and related leads.");
        if (!confirmed) return;

        setIsDeletingClient(true);
        try {
            const idToken = await getIdToken(user);
            const resp = await fetch(`/api/clients/${encodeURIComponent(clientId)}/delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ idToken })
            });
            if (!resp.ok) {
                const data = await resp.json().catch(() => ({}));
                throw new Error(data.error || `Failed to delete client (${resp.status})`);
            }
            setToastMessage('Client deleted');
            setToastVisible(true);
            router.push('/clients');
        } catch (error) {
            setToastMessage(error instanceof Error ? error.message : 'Failed to delete client');
            setToastVisible(true);
        } finally {
            setIsDeletingClient(false);
        }
    };

    const handleLeadsScroll = (event: UIEvent<HTMLDivElement>) => {
        const target = event.currentTarget;
        if (target.scrollTop + target.clientHeight >= target.scrollHeight - 50) {
            loadMoreLeads();
        }
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
            const uploadedCount = typeof result.count === 'number' && Number.isFinite(result.count) ? result.count : 0;
            const totalCount = typeof result.total === 'number' && Number.isFinite(result.total)
                ? result.total
                : uploadedCount;
            const toastText = result.message
                ? String(result.message)
                : (totalCount && uploadedCount !== totalCount)
                    ? `Uploaded ${uploadedCount.toLocaleString()} of ${totalCount.toLocaleString()} leads to Instantly`
                    : `Uploaded ${uploadedCount.toLocaleString()} leads to Instantly`;
            setToastMessage(toastText);
            setToastVisible(true);
            setUploadModalOpen(false);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to upload to Instantly';
            setToastMessage(message);
            setToastVisible(true);
        } finally {
            setUploading(false);
        }
    };

    const handleDiscardJob = async () => {
        if (!user || !clientId) return;

        try {
            const jobRef = doc(firestore, "users", user.uid, "clients", clientId, "activeJob", "current");
            await setDoc(jobRef, { status: 'discarded', uploadError: null, uploadMetrics: null }, { merge: true });
            setJobPendingUpload(null);
            setJobState(null);
        } catch (error) {
            console.error('Failed to discard job:', error);
        }
    };

    const handleDeleteJob = async (jobId: string) => {
        if (!user || !clientId) return;
        const confirmDelete = window.confirm("Delete this job? This removes the job record and cached files.");
        if (!confirmDelete) return;

        setDeletingJobId(jobId);
        try {
            const idToken = await getIdToken(user);
            const resp = await fetch(`${getPipelineBaseUrl()}/api/jobs/${encodeURIComponent(jobId)}/delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ idToken, clientId })
            });
            if (!resp.ok) {
                const data = await resp.json().catch(() => ({}));
                throw new Error(data.error || `Failed to delete job (${resp.status})`);
            }
            setJobHistory((prev) => prev.filter((job) => job.id !== jobId));
            if (selectedJobId === jobId) {
                setSelectedJobId(null);
                setJobState(null);
            }
            setToastMessage('Job deleted');
            setToastVisible(true);
        } catch (error) {
            setToastMessage(error instanceof Error ? error.message : 'Failed to delete job');
            setToastVisible(true);
        } finally {
            setDeletingJobId(null);
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
                        <button
                            className={`tab-nav__button ${activeTab === "info" ? "tab-nav__button--active" : ""}`}
                            onClick={() => setActiveTab("info")}
                        >
                            Info
                        </button>
                    </div>

                    {/* Campaigns Tab */}
                    {activeTab === "campaigns" && (
                        <>
                            <div style={{ marginTop: '2rem' }}>
                                <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
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
                                            setSkipEmailFinder(false);
                                            setPersonalizeFirstLine(false);
                                            setSelectedCampaignId("");
                                            setUploadError("");
                                        }}
                                    >
                                        📤 Upload Leads
                                    </button>
                                    <button
                                        type="button"
                                        className="secondary-button secondary-button--active"
                                        onClick={handleRefreshCampaigns}
                                        disabled={syncingCampaigns}
                                        style={{ minWidth: '180px' }}
                                    >
                                        {syncingCampaigns ? 'Refreshing...' : 'Refresh campaigns'}
                                    </button>
                                    {campaignSyncMessage && (
                                        <span style={{ color: 'rgba(255, 255, 255, 0.7)', fontSize: '0.9rem' }}>
                                            {campaignSyncMessage}
                                        </span>
                                    )}
                                </div>
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
                                                ? `${stageCompletionPercent || 0}% completed`
                                                : "No runs yet"}
                                        </h2>
                                        {!jobState && (
                                            <p className="pipeline-panel__subtitle">
                                                Upload leads to see stage progress and pipeline status.
                                            </p>
                                        )}
                                        {jobState && (
                                            <p className="pipeline-panel__subtitle" style={{ marginTop: '0.35rem' }}>
                                                Valid leads: {validLeadsCompleted.toLocaleString()}
                                            </p>
                                        )}
                                        {jobState && (
                                            <div className="pipeline-status-row">
                                                <p className="pipeline-panel__subtitle pipeline-panel__subtitle--status">
                                                    Viewing job: {jobState.fileName || jobState.id} · {JOB_STATUS_LABELS[jobState.status]}
                                                </p>
                                                {(jobState.status === 'running' || jobState.status === 'queued' || jobState.status === 'paused') && (
                                                    <div style={{ display: 'flex', gap: '0.5rem', marginLeft: 'auto' }}>
                                                        {(jobState.status === 'running' || jobState.status === 'paused') && (
                                                            <button
                                                                type="button"
                                                                className="secondary-button secondary-button--active"
                                                                onClick={handlePauseResumeJob}
                                                                disabled={pausingJob}
                                                                style={{ minWidth: '100px' }}
                                                            >
                                                                {pausingJob ? (jobState.status === 'paused' ? 'Resuming...' : 'Pausing...') : (jobState.status === 'paused' ? 'Resume' : 'Pause')}
                                                            </button>
                                                        )}
                                                        <button
                                                            type="button"
                                                            className="destructive-button"
                                                            onClick={handleStopJob}
                                                            disabled={stoppingJob}
                                                            style={{ minWidth: '100px' }}
                                                        >
                                                            {stoppingJob ? 'Stopping...' : 'Stop run'}
                                                        </button>
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                        {activeStatusLabel && jobState && (
                                            <p className="pipeline-panel__subtitle" style={{ marginTop: '0.75rem' }}>
                                                {activeStatusLabel}
                                            </p>
                                        )}
                                    </div>
                                    {(jobState?.status === 'completed' || jobState?.status === 'pending-upload' || canUploadToInstantly) && (
                                        <div style={{ display: 'flex', gap: '0.75rem', width: '100%' }}>
                                            <button
                                                type="button"
                                                className="secondary-button secondary-button--active"
                                                onClick={() => {
                                                    setDownloadScope('all');
                                                    setDownloadModalOpen(true);
                                                }}
                                            >
                                                Download CSV
                                            </button>
                                            {canUploadToInstantly ? (
                                                <button
                                                    type="button"
                                                    className="primary-button"
                                                    onClick={handleUploadToInstantly}
                                                    disabled={uploading}
                                                >
                                                    {uploading ? 'Uploading...' : 'Upload to Instantly'}
                                                </button>
                                            ) : activeJobStatus === 'uploaded' ? (
                                                <span
                                                    style={{
                                                        display: 'inline-flex',
                                                        alignItems: 'center',
                                                        padding: '0.35rem 0.75rem',
                                                        borderRadius: '999px',
                                                        fontSize: '0.75rem',
                                                        fontWeight: 600,
                                                        letterSpacing: '0.02em',
                                                        background: 'rgba(34, 197, 94, 0.12)',
                                                        color: '#22c55e',
                                                        border: '1px solid rgba(34, 197, 94, 0.35)'
                                                    }}
                                                >
                                                    {uploadedSummary}
                                                </span>
                                            ) : null}
                                            {canDiscardJob && (
                                                <button
                                                    type="button"
                                                    className="destructive-button"
                                                    onClick={handleDiscardJob}
                                                    style={{ color: 'rgba(239, 68, 68, 0.9)' }}
                                                >
                                                    Discard
                                                </button>
                                            )}
                                        </div>
                                    )}
                                </div>

                                {jobState ? (
                                    <>
                                        {/* Pipeline flow summary */}
                                        {(() => {
                                            const foundersFound = deriveStageTotals(jobState.stages.founders).throughputNum ?? 0;
                                            const foundersProcessed = deriveStageTotals(jobState.stages.founders).total ?? 0;
                                            const emailsFound = (jobState.stages.emailDiscovery?.summary as any)?.Found ?? (jobState.stages.emailDiscovery?.summary as any)?.found ?? deriveStageTotals(jobState.stages.emailDiscovery).throughputNum ?? 0;
                                            const safe = (jobState.stages.verification?.summary as any)?.Valid ?? (jobState.stages.verification?.summary as any)?.valid ?? 0;
                                            const personalized = (jobState.stages.personalization?.summary as any)?.Personalized ?? (jobState.stages.personalization?.summary as any)?.personalized ?? (jobState.stages.personalization?.progress?.stats as any)?.personalized ?? 0;
                                            
                                            return (
                                                <div style={{ 
                                                    display: 'flex', 
                                                    alignItems: 'center', 
                                                    gap: '0.75rem',
                                                    padding: '1rem 1.5rem',
                                                    background: 'rgba(255, 255, 255, 0.03)',
                                                    borderRadius: '8px',
                                                    border: '1px solid rgba(255, 255, 255, 0.08)',
                                                    marginTop: '1.5rem',
                                                    fontSize: '0.875rem',
                                                    fontVariantNumeric: 'tabular-nums'
                                                }}>
                                                    <span style={{ opacity: 0.5, fontSize: '0.75rem' }}>Pipeline flow:</span>
                                                    <span style={{ fontWeight: '600' }}>{foundersProcessed.toLocaleString()}</span>
                                                    <span style={{ opacity: 0.4 }}>→</span>
                                                    <span style={{ fontWeight: '600' }}>{foundersFound.toLocaleString()}</span>
                                                    <span style={{ opacity: 0.4 }}>→</span>
                                                    <span style={{ fontWeight: '600' }}>{emailsFound.toLocaleString()}</span>
                                                    <span style={{ opacity: 0.4 }}>→</span>
                                                    <span style={{ fontWeight: '600', color: '#22c55e' }}>{safe.toLocaleString()}</span>
                                                    <span style={{ opacity: 0.4 }}>→</span>
                                                    <span style={{ fontWeight: '600', color: '#3b82f6' }}>{personalized.toLocaleString()}</span>
                                                </div>
                                            );
                                        })()}
                                        
                                        <div className="stage-grid" style={{ marginTop: '1.5rem' }}>
                                        {[...STAGE_ORDER].map((stageKey) => {
                                            const stage = jobState.stages[stageKey];
                                            const meta = STAGE_METADATA[stageKey];
                                            const { throughputNum, total } = deriveStageTotals(stage);
                                            const summary = stage?.summary as Record<string, unknown> | null;
                                            const stats = stage?.progress?.stats as Record<string, unknown> | undefined;
                                            
                                            // Simplified metrics based on stage type
                                            let heroNumber = null;
                                            let heroLabel = "";
                                            let subtext = "";
                                            let costFooter = "";
                                            
                                            if (stageKey === "founders") {
                                                const found = throughputNum ?? 0;
                                                const processed = total ?? 0;
                                                const cost = summary?.cost || stats?.cost;
                                                heroNumber = found;
                                                heroLabel = "Found";
                                                subtext = processed > 0 ? `${processed.toLocaleString()} processed • ${((found / processed) * 100).toFixed(0)}% yield` : "Awaiting...";
                                                if (typeof cost === "number") costFooter = `Cost $${cost.toFixed(2)}`;
                                            } else if (stageKey === "emailDiscovery") {
                                                const found = summary?.Found ?? summary?.found ?? throughputNum ?? 0;
                                                const attempted = total ?? 0;
                                                heroNumber = found;
                                                heroLabel = "Emails Found";
                                                subtext = attempted > 0 ? `${attempted.toLocaleString()} checked • ${((found / attempted) * 100).toFixed(1)}% hit rate` : "Awaiting...";
                                            } else if (stageKey === "verification") {
                                                const safe = summary?.Valid ?? summary?.valid ?? 0;
                                                const risky = summary?.["Valid-Risky"] ?? summary?.["valid-risky"] ?? 0;
                                                const verified = total ?? 0;
                                                heroNumber = safe;
                                                heroLabel = "Safe";
                                                const riskyText = risky > 0 ? ` • ${risky} Risky` : "";
                                                subtext = verified > 0 ? `${verified.toLocaleString()} verified${riskyText}` : "Awaiting...";
                                            } else if (stageKey === "personalization") {
                                                const personalized = summary?.Personalized ?? summary?.personalized ?? stats?.personalized ?? throughputNum ?? 0;
                                                const candidates = total ?? 0;
                                                const failed = summary?.failed ?? stats?.failed ?? 0;
                                                heroNumber = personalized;
                                                heroLabel = "Ready";
                                                subtext = candidates > 0 ? `${candidates.toLocaleString()} total` : "Awaiting...";
                                                if (failed > 0) subtext += ` • ${failed} failed`;
                                            }
                                            
                                            return (
                                                <article
                                                    key={stageKey}
                                                    className={`stage-card stage-card--${stage?.status ?? "pending"} ${stage?.status === "running" ? "stage-card--running" : ""}`}
                                                >
                                                    <div className="stage-card__head">
                                                        <div>
                                                            <p className="stage-card__label">{meta.title}</p>
                                                        </div>
                                                        <span className="stage-card__status">{formatStageStatus(stage?.status)}</span>
                                                    </div>
                                                    
                                                    {stage?.error ? (
                                                        <p className="stage-card__error">{stage.error}</p>
                                                    ) : heroNumber !== null ? (
                                                        <>
                                                            <div style={{ marginTop: '0.75rem' }}>
                                                                <div style={{ fontSize: '2.25rem', fontWeight: '700', lineHeight: '1' }}>
                                                                    {heroNumber.toLocaleString()}
                                                                    <span style={{ fontSize: '1rem', fontWeight: '500', marginLeft: '0.5rem', opacity: 0.7 }}>{heroLabel}</span>
                                                                </div>
                                                                <div style={{ fontSize: '0.875rem', marginTop: '0.5rem', opacity: 0.65 }}>
                                                                    {subtext}
                                                                </div>
                                                            </div>
                                                            {costFooter && (
                                                                <div style={{ fontSize: '0.75rem', marginTop: '0.75rem', opacity: 0.5 }}>
                                                                    {costFooter}
                                                                </div>
                                                            )}
                                                        </>
                                                    ) : (
                                                        <p className="stage-card__progress" style={{ marginTop: '0.75rem', opacity: 0.6 }}>
                                                            {describeStageProgress(stage)}
                                                        </p>
                                                    )}
                                                </article>
                                            );
                                        })}
                                    </div>
                                    </>
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
                                                const totalProcessed = job.dedupeStats?.total
                                                    || job.stages?.verification?.progress?.total
                                                    || job.stages?.founders?.progress?.total
                                                    || 0;
                                                const validLeads = job.stages?.verification?.summary?.valid
                                                    || job.stages?.emailDiscovery?.summary?.found
                                                    || 0;
                                                return (
                                                    <div
                                                        key={job.id}
                                                        role="button"
                                                        tabIndex={0}
                                                        onClick={() => handleSelectJob(job)}
                                                        onKeyDown={(event) => {
                                                            if (event.key === 'Enter' || event.key === ' ') {
                                                                event.preventDefault();
                                                                handleSelectJob(job);
                                                            }
                                                        }}
                                                        style={{
                                                            display: 'grid',
                                                            gridTemplateColumns: 'minmax(0, 1fr) 120px 180px',
                                                            alignItems: 'center',
                                                            gap: '1rem',
                                                            padding: '1rem 1.25rem',
                                                            borderRadius: '12px',
                                                            border: `1px solid ${isSelected ? 'rgba(59, 130, 246, 0.65)' : 'rgba(255, 255, 255, 0.08)'}`,
                                                            background: isSelected ? 'rgba(59, 130, 246, 0.12)' : 'rgba(255, 255, 255, 0.03)',
                                                            cursor: 'pointer',
                                                            transition: 'background 0.2s ease, border-color 0.2s ease, transform 0.2s ease',
                                                            position: 'relative'
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
                                                        <button
                                                            type="button"
                                                            onClick={(event) => {
                                                                event.stopPropagation();
                                                                handleDeleteJob(job.id);
                                                            }}
                                                            disabled={deletingJobId === job.id}
                                                            className="destructive-button"
                                                            style={{
                                                                position: 'absolute',
                                                                top: '10px',
                                                                right: '10px',
                                                                padding: '0.35rem 0.75rem',
                                                                height: 'auto',
                                                                minHeight: 'auto',
                                                                fontSize: '0.75rem',
                                                                borderRadius: '8px',
                                                                boxShadow: 'none',
                                                                flex: '0 0 auto'
                                                            }}
                                                        >
                                                            {deletingJobId === job.id ? 'Deleting...' : 'Delete'}
                                                        </button>
                                                    </div>
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
                                {campaignFilterId || leadSearch.trim() ? (
                                    <>
                                        <div className="metric-chip">
                                            <span className="metric-chip__label">Filtered Total</span>
                                            <span className="metric-chip__value">{displayedStats.total.toLocaleString()}</span>
                                        </div>
                                        <div className="metric-chip">
                                            <span className="metric-chip__label">Verified</span>
                                            <span className="metric-chip__value" style={{ color: '#16a34a' }}>{displayedStats.verified.toLocaleString()}</span>
                                        </div>
                                        <div className="metric-chip">
                                            <span className="metric-chip__label">Unverified</span>
                                            <span className="metric-chip__value" style={{ color: '#a1a1aa' }}>{displayedStats.unverified.toLocaleString()}</span>
                                        </div>
                                    </>
                                ) : (
                                    <div className="metric-chip">
                                        <span className="metric-chip__label">Total Leads</span>
                                        <span className="metric-chip__value">{displayedStats.total.toLocaleString()}</span>
                                    </div>
                                )}
                            </div>

                            <div style={{
                                marginTop: '1rem',
                                display: 'flex',
                                gap: '0.75rem',
                                flexWrap: 'wrap',
                                alignItems: 'flex-end'
                            }}>
                                <label className="settings-field" style={{ flex: '1 1 200px', minWidth: '220px' }}>
                                    <span className="settings-field__label">Filter by Campaign</span>
                                    <select
                                        value={campaignFilterId}
                                        onChange={(e) => setCampaignFilterId(e.target.value)}
                                    >
                                        <option value="">All campaigns</option>
                                        {campaigns.map((c) => (
                                            <option key={c.id} value={c.id}>{c.name}</option>
                                        ))}
                                    </select>
                                </label>
                                <label className="settings-field" style={{ flex: '2 1 260px', minWidth: '260px' }}>
                                    <span className="settings-field__label">Search leads</span>
                                    <input
                                        type="text"
                                        value={leadSearch}
                                        onChange={(e) => setLeadSearch(e.target.value)}
                                        placeholder="Search by domain, email, or founder name"
                                    />
                                </label>
                            </div>

                            <div style={{
                                marginTop: '0.75rem',
                                display: 'flex',
                                gap: '0.75rem',
                                flexWrap: 'wrap',
                                alignItems: 'flex-end'
                            }}>
                                <label className="settings-field" style={{ flex: '1 1 180px', minWidth: '180px' }}>
                                    <span className="settings-field__label">Founder</span>
                                    <select
                                        value={founderFilter}
                                        onChange={(e) => setFounderFilter(e.target.value)}
                                    >
                                        <option value="">All</option>
                                        <option value="exists">Exists</option>
                                        <option value="not_found">Not Found</option>
                                        <option value="other">Other</option>
                                    </select>
                                </label>
                                <label className="settings-field" style={{ flex: '1 1 180px', minWidth: '180px' }}>
                                    <span className="settings-field__label">Email</span>
                                    <select
                                        value={emailFilter}
                                        onChange={(e) => setEmailFilter(e.target.value)}
                                    >
                                        <option value="">All</option>
                                        <option value="exists">Exists</option>
                                        <option value="not_found">Not Found</option>
                                    </select>
                                </label>
                                <label className="settings-field" style={{ flex: '1 1 180px', minWidth: '180px' }}>
                                    <span className="settings-field__label">Email Status</span>
                                    <select
                                        value={emailStatusFilter}
                                        onChange={(e) => setEmailStatusFilter(e.target.value)}
                                    >
                                        <option value="">All</option>
                                        <option value="valid">Valid</option>
                                        <option value="valid-risky">Valid-Risky</option>
                                        <option value="not_found">Not Found</option>
                                        <option value="invalid">Invalid</option>
                                        <option value="skipped_no_founder">Skipped (No Founder)</option>
                                    </select>
                                </label>
                                {leadsLoading && (
                                    <div style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '0.5rem',
                                        padding: '0.5rem 0.75rem',
                                        fontSize: '0.875rem',
                                        color: 'rgba(255, 255, 255, 0.7)'
                                    }}>
                                        <svg className="spinner" style={{ width: '16px', height: '16px' }} viewBox="0 0 24 24" fill="none">
                                            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25"/>
                                            <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/>
                                        </svg>
                                        {allLeadsCached ? 'Filtering...' : 'Loading leads...'}
                                    </div>
                                )}
                                <button
                                    type="button"
                                    className="primary-button"
                                    onClick={async () => {
                                        setExportingCsv(true);
                                        try {
                                            let leadsToExport = leads;
                                            
                                            // If we haven't cached all leads yet, fetch them all now
                                            if (!allLeadsCached && user && clientId) {
                                                const leadsCol = collection(firestore, "users", user.uid, "clients", clientId, "leads");
                                                const constraints: unknown[] = [];
                                                if (campaignFilterId) {
                                                    constraints.push(where("campaigns", "array-contains", campaignFilterId));
                                                }
                                                if (emailStatusFilter) {
                                                    constraints.push(where("email_status", "==", emailStatusFilter));
                                                }
                                                
                                                const mapDocToLead = (d: any): Lead => {
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
                                                        campaigns: Array.isArray(data.campaigns) ? data.campaigns : (data.campaignId ? [data.campaignId] : [])
                                                    } as Lead;
                                                };
                                                
                                                const pageSize = 500;
                                                let cursor: DocumentSnapshot | null = null;
                                                const collected: Lead[] = [];
                                                let pagesRead = 0;
                                                
                                                // eslint-disable-next-line no-constant-condition
                                                while (true) {
                                                    const clauses: any[] = [...constraints, orderBy("updatedAt", "desc")];
                                                    if (cursor) {
                                                        clauses.push(startAfter(cursor));
                                                    }
                                                    clauses.push(limit(pageSize));
                                                    
                                                    const snap = await getDocs(query(leadsCol, ...clauses));
                                                    snap.docs.forEach((docSnap) => collected.push(mapDocToLead(docSnap)));
                                                    pagesRead += 1;
                                                    
                                                    if (snap.size < pageSize) {
                                                        break;
                                                    }
                                                    cursor = snap.docs[snap.docs.length - 1];
                                                    
                                                    if (pagesRead >= 100) {
                                                        console.warn('Reached max page limit while exporting');
                                                        break;
                                                    }
                                                }
                                                
                                                leadsToExport = collected;
                                            }
                                            
                                            // Apply client-side filters to get final export set
                                            let filtered = leadsToExport;
                                            
                                            // Search filter
                                            if (leadSearch.trim()) {
                                                const term = leadSearch.trim().toLowerCase();
                                                filtered = filtered.filter((lead) => {
                                                    const domain = (lead.domain || "").toLowerCase();
                                                    const email = (lead.email || "").toLowerCase();
                                                    const founder = (lead.founderName || "").toLowerCase();
                                                    return domain.includes(term) || email.includes(term) || founder.includes(term);
                                                });
                                            }
                                            
                                            // Founder filter
                                            if (founderFilter === "exists") {
                                                filtered = filtered.filter((lead) => {
                                                    const founder = (lead.founderName || "").trim();
                                                    const founderLower = founder.toLowerCase();
                                                    return founder.length > 0 && !founderLower.includes("not found") && founderLower !== "not_found";
                                                });
                                            } else if (founderFilter === "not_found") {
                                                filtered = filtered.filter((lead) => {
                                                    const founder = (lead.founderName || "").trim();
                                                    const founderLower = founder.toLowerCase();
                                                    return founder.length === 0 || founderLower.includes("not found") || founderLower === "not_found";
                                                });
                                            }
                                            
                                            // Email filter
                                            if (emailFilter === "exists") {
                                                filtered = filtered.filter((lead) => {
                                                    const email = (lead.email || "").trim();
                                                    const emailLower = email.toLowerCase();
                                                    return email.length > 0 && !emailLower.includes("not found") && emailLower !== "not_found";
                                                });
                                            } else if (emailFilter === "not_found") {
                                                filtered = filtered.filter((lead) => {
                                                    const email = (lead.email || "").trim();
                                                    const emailLower = email.toLowerCase();
                                                    return email.length === 0 || emailLower.includes("not found") || emailLower === "not_found";
                                                });
                                            }
                                            
                                            // Email status filter (already applied in DB if used)
                                            if (emailStatusFilter && allLeadsCached) {
                                                filtered = filtered.filter((lead) => {
                                                    const status = (lead.status || "").toLowerCase();
                                                    return status === emailStatusFilter.toLowerCase();
                                                });
                                            }
                                            
                                            // Generate CSV
                                            const headers = ['Founder Name', 'Email', 'Status', 'Domain', 'First Line', 'Personalization URL', 'Personalization Title', 'Campaigns', 'Updated At'];
                                            const csvRows = [headers.join(',')];
                                            
                                            filtered.forEach((lead) => {
                                                const row = [
                                                    lead.founderName || '',
                                                    lead.email || '',
                                                    lead.status || '',
                                                    lead.domain || '',
                                                    (lead.firstLine || '').replace(/"/g, '""'),
                                                    lead.personalizationUrl || '',
                                                    (lead.personalizationTitle || '').replace(/"/g, '""'),
                                                    getCampaignNamesForLead(lead).join('; '),
                                                    lead.updatedAt || ''
                                                ];
                                                csvRows.push(row.map(val => `"${val}"`).join(','));
                                            });
                                            
                                            const csvContent = csvRows.join('\n');
                                            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
                                            const link = document.createElement('a');
                                            const url = URL.createObjectURL(blob);
                                            link.setAttribute('href', url);
                                            link.setAttribute('download', `${clientName}_leads_${new Date().toISOString().split('T')[0]}.csv`);
                                            link.style.visibility = 'hidden';
                                            document.body.appendChild(link);
                                            link.click();
                                            document.body.removeChild(link);
                                        } catch (error) {
                                            console.error('CSV export failed:', error);
                                            setToastMessage('Failed to export CSV');
                                            setToastVisible(true);
                                        } finally {
                                            setExportingCsv(false);
                                        }
                                    }}
                                    style={{ flex: '0 0 auto' }}
                                    disabled={leadsLoading || exportingCsv}
                                >
                                    {exportingCsv ? (
                                        <>
                                            <svg className="spinner" style={{ width: '14px', height: '14px', marginRight: '0.5rem' }} viewBox="0 0 24 24" fill="none">
                                                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25"/>
                                                <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/>
                                            </svg>
                                            Exporting...
                                        </>
                                    ) : (
                                        `📥 Export CSV (${allLeadsCached ? filteredLeads.length : displayedStats.total})`
                                    )}
                                </button>
                                {(founderFilter || emailFilter || emailStatusFilter || leadSearch.trim() || campaignFilterId) && (
                                    <button
                                        type="button"
                                        className="secondary-button secondary-button--active"
                                        onClick={() => {
                                            setFounderFilter("");
                                            setEmailFilter("");
                                            setEmailStatusFilter("");
                                            setLeadSearch("");
                                            setCampaignFilterId("");
                                        }}
                                        style={{ flex: '0 0 auto' }}
                                        disabled={leadsLoading}
                                    >
                                        Clear Filters
                                    </button>
                                )}
                            </div>

                            <div style={{ marginTop: '1.5rem', position: 'relative' }}>
                                {leadsLoading && filteredLeads.length === 0 ? (
                                    <div className="pipeline-panel__empty">
                                        <div style={{
                                            display: 'flex',
                                            flexDirection: 'column',
                                            alignItems: 'center',
                                            gap: '1rem'
                                        }}>
                                            <svg className="spinner" style={{ width: '32px', height: '32px' }} viewBox="0 0 24 24" fill="none">
                                                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25"/>
                                                <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/>
                                            </svg>
                                            <p>Loading leads...</p>
                                        </div>
                                    </div>
                                ) : filteredLeads.length === 0 ? (
                                    <div className="pipeline-panel__empty">
                                        <p>No leads yet.</p>
                                        <p className="pipeline-panel__subtitle">Upload leads to start seeing them here.</p>
                                    </div>
                                ) : (
                                    <div style={{
                                        overflowX: 'auto',
                                        border: '1px solid rgba(255, 255, 255, 0.1)',
                                        borderRadius: '8px',
                                        backgroundColor: 'rgba(0, 0, 0, 0.2)',
                                        maxHeight: '520px',
                                        overflowY: 'auto',
                                        position: 'relative'
                                    }}>
                                        {leadsLoading && filteredLeads.length > 0 && (
                                            <div style={{
                                                position: 'absolute',
                                                top: 0,
                                                left: 0,
                                                right: 0,
                                                bottom: 0,
                                                background: 'rgba(0, 0, 0, 0.7)',
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                zIndex: 10,
                                                borderRadius: '8px'
                                            }}>
                                                <div style={{
                                                    display: 'flex',
                                                    flexDirection: 'column',
                                                    alignItems: 'center',
                                                    gap: '0.75rem',
                                                    padding: '1.5rem',
                                                    background: 'rgba(0, 0, 0, 0.8)',
                                                    borderRadius: '12px',
                                                    border: '1px solid rgba(255, 255, 255, 0.1)'
                                                }}>
                                                    <svg className="spinner" style={{ width: '32px', height: '32px', color: '#3b82f6' }} viewBox="0 0 24 24" fill="none">
                                                        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25"/>
                                                        <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/>
                                                    </svg>
                                                    <p style={{ margin: 0, fontSize: '0.95rem', fontWeight: 500 }}>Loading leads...</p>
                                                </div>
                                            </div>
                                        )}
                                        <div
                                            ref={leadsContainerRef}
                                            onScroll={handleLeadsScroll}
                                            style={{ maxHeight: '520px', overflowY: 'auto' }}
                                        >
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
                                                        }}>Founder Name</th>
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
                                                        }}>Domain</th>
                                                        <th style={{
                                                            textAlign: 'left',
                                                            padding: '0.75rem 1rem',
                                                            fontWeight: 600,
                                                            color: 'rgba(255, 255, 255, 0.9)'
                                                        }}>Campaign</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {filteredLeads.map((lead, index) => (
                                                        <tr
                                                            key={lead.id}
                                                            onClick={() => setSelectedLead(lead)}
                                                            style={{
                                                                backgroundColor: index % 2 === 0 ? 'transparent' : 'rgba(255, 255, 255, 0.03)',
                                                                borderBottom: index < filteredLeads.length - 1 ? '1px solid rgba(255, 255, 255, 0.05)' : 'none',
                                                                cursor: 'pointer',
                                                                transition: 'background-color 0.15s ease'
                                                            }}
                                                            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.08)'}
                                                            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = index % 2 === 0 ? 'transparent' : 'rgba(255, 255, 255, 0.03)'}
                                                        >
                                                            <td style={{
                                                                padding: '0.75rem 1rem',
                                                                maxWidth: '220px',
                                                                overflow: 'hidden',
                                                                textOverflow: 'ellipsis',
                                                                whiteSpace: 'nowrap'
                                                            }}>{lead.founderName || '—'}</td>
                                                            <td style={{
                                                                padding: '0.75rem 1rem',
                                                                maxWidth: '250px',
                                                                overflow: 'hidden',
                                                                textOverflow: 'ellipsis',
                                                                whiteSpace: 'nowrap'
                                                            }}>{lead.email || '—'}</td>
                                                            <td style={{
                                                                padding: '0.75rem 1rem',
                                                                maxWidth: '140px',
                                                                overflow: 'hidden',
                                                                textOverflow: 'ellipsis',
                                                                whiteSpace: 'nowrap'
                                                            }}>{lead.status || '—'}</td>
                                                            <td style={{
                                                                padding: '0.75rem 1rem',
                                                                maxWidth: '220px',
                                                                overflow: 'hidden',
                                                                textOverflow: 'ellipsis',
                                                                whiteSpace: 'nowrap'
                                                            }}>{lead.domain || '—'}</td>
                                                            <td style={{
                                                                padding: '0.75rem 1rem',
                                                                maxWidth: '220px',
                                                                overflow: 'hidden',
                                                                textOverflow: 'ellipsis',
                                                                whiteSpace: 'nowrap'
                                                            }}>{getCampaignNamesForLead(lead).join(', ') || '—'}</td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                            {(leadsLoading || leadsHasMore) && (
                                                <div style={{ padding: '0.75rem 1rem', color: 'rgba(255,255,255,0.7)' }}>
                                                    {leadsLoading ? 'Loading leads...' : 'Scroll to load more'}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </>
                    )}

                    {/* Info Tab */}
                    {activeTab === "info" && (
                        <div style={{ marginTop: '2rem', display: 'flex', flexDirection: 'column', gap: '1.5rem', maxWidth: '640px' }}>
                            <p className="eyebrow eyebrow--muted">Client details</p>
                            <label className="settings-field">
                                <span className="settings-field__label">Client Name</span>
                                <input
                                    type="text"
                                    value={clientName}
                                    onChange={(e) => setClientName(e.target.value)}
                                    placeholder="Client name"
                                />
                            </label>
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
                                <span className="settings-field__hint">Used for personalization defaults.</span>
                            </label>
                            <label className="settings-field">
                                <span className="settings-field__label">Instantly API Key</span>
                                <input
                                    type="password"
                                    value={clientInstantlyKey}
                                    onChange={(e) => setClientInstantlyKey(e.target.value)}
                                    placeholder="Paste Instantly API key"
                                />
                            </label>
                            <label className="settings-field">
                                <span className="settings-field__label">Instantly Webhook URL</span>
                                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                                    <input
                                        type="text"
                                        value={instantlyWebhookUrl}
                                        readOnly
                                        placeholder="Webhook URL"
                                        style={{ flex: 1 }}
                                    />
                                    <button
                                        type="button"
                                        onClick={() => {
                                            navigator.clipboard?.writeText(instantlyWebhookUrl || '').then(() => {
                                                setCopiedWebhook(true);
                                                setTimeout(() => setCopiedWebhook(false), 1600);
                                            }).catch(() => setCopiedWebhook(false));
                                        }}
                                        aria-label="Copy webhook URL"
                                        title="Copy webhook URL"
                                        style={{
                                            cursor: 'pointer',
                                            minWidth: '36px',
                                            width: 'auto',
                                            padding: '0.35rem 0.45rem',
                                            borderRadius: '8px',
                                            border: '1px solid rgba(255,255,255,0.15)',
                                            background: 'rgba(255,255,255,0.05)',
                                            color: '#fff'
                                        }}
                                    >
                                        {copiedWebhook ? '✓' : '📋'}
                                    </button>
                                </div>
                                <span className="settings-field__hint">
                                    Paste this into Instantly events/webhook settings for this client.
                                </span>
                            </label>
                            <div className="modal__actions" style={{ justifyContent: 'flex-start' }}>
                                <button
                                    type="button"
                                    className="primary-button"
                                    onClick={handleSaveClientInfo}
                                    disabled={isSavingClient || isDeletingClient}
                                >
                                    {isSavingClient ? 'Saving...' : 'Save'}
                                </button>
                                <button
                                    type="button"
                                    className="destructive-button"
                                    onClick={handleDeleteClient}
                                    disabled={isDeletingClient || isSavingClient}
                                >
                                    {isDeletingClient ? 'Deleting...' : 'Delete client'}
                                </button>
                            </div>
                        </div>
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
                                <p className="eyebrow eyebrow--muted">Step {wizardStep} / 4</p>
                                <h2 className="modal__title">
                                    {wizardStep === 1 && '📤 Upload CSV'}
                                    {wizardStep === 2 && '🗂️ Map Columns'}
                                    {wizardStep === 3 && '⚙️ Processing Options'}
                                    {wizardStep === 4 && '✨ Personalization'}
                                </h2>
                                <p className="modal__description">
                                    {wizardStep === 1 && 'Upload your CSV file with domain column'}
                                    {wizardStep === 2 && 'Confirm which CSV columns map to required fields'}
                                    {wizardStep === 3 && 'Configure enrichment and verification steps'}
                                    {wizardStep === 4 && 'Industry-specific personalization settings'}
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
                                {[1, 2, 3, 4].map((step) => (
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

                            {/* Step 2: Column Mapping */}
                            {wizardStep === 2 && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                                    <div style={{ fontSize: '0.95rem', color: 'rgba(255,255,255,0.8)' }}>
                                        Map the CSV columns so the pipeline knows where to find required fields.
                                    </div>

                                    <label className="settings-field">
                                        <span className="settings-field__label">Domain column <span style={{ color: '#f87171' }}>*</span></span>
                                        <select
                                            value={domainColumn}
                                            onChange={(e) => setDomainColumn(e.target.value)}
                                            disabled={!csvColumns.length}
                                        >
                                            <option value="">Select column</option>
                                            {csvColumns.map((col) => (
                                                <option key={col} value={col}>{col}</option>
                                            ))}
                                        </select>
                                        <span className="settings-field__hint">
                                            {csvColumns.length === 0 ? 'Upload a CSV in Step 1 to detect columns.' : 'Auto-detected similar names like domain/website/url.'}
                                        </span>
                                    </label>

                                    <label className="settings-field">
                                        <span className="settings-field__label">Founder name column (optional)</span>
                                        <select
                                            value={founderColumn}
                                            onChange={(e) => setFounderColumn(e.target.value)}
                                            disabled={!csvColumns.length}
                                        >
                                            <option value="">Select column (or none)</option>
                                            {csvColumns.map((col) => (
                                                <option key={col} value={col}>{col}</option>
                                            ))}
                                        </select>
                                        <span className="settings-field__hint">
                                            {founderColumn
                                                ? `Using "${founderColumn}" for founder names. Founder finder will be skipped.`
                                                : 'Auto-detects columns like founder_name, founder, owner, ceo. Leave blank to run founder finder.'}
                                        </span>
                                    </label>

                                    <label className="settings-field">
                                        <span className="settings-field__label">Email column (optional)</span>
                                        <select
                                            value={emailColumn}
                                            onChange={(e) => setEmailColumn(e.target.value)}
                                            disabled={!csvColumns.length}
                                        >
                                            <option value="">Select column (or none)</option>
                                            {csvColumns.map((col) => (
                                                <option key={col} value={col}>{col}</option>
                                            ))}
                                        </select>
                                        <span className="settings-field__hint">
                                            {emailColumn
                                                ? `Using "${emailColumn}" for email addresses. Email discovery will be skipped.`
                                                : 'Auto-detects columns like email, email_address. Leave blank to run email discovery.'}
                                        </span>
                                    </label>
                                </div>
                            )}

                            {/* Step 3: Processing Options */}
                            {wizardStep === 3 && (
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
                                            cursor: founderColumn ? 'not-allowed' : 'pointer',
                                            padding: '0.5rem',
                                            opacity: founderColumn ? 0.6 : 1
                                        }}>
                                            <input
                                                type="checkbox"
                                                checked={findFounder}
                                                disabled={!!founderColumn}
                                                onChange={(e) => {
                                                    const checked = e.target.checked;
                                                    setFindFounder(checked);
                                                    // If unchecking, cascade disable dependent options
                                                    if (!checked && !skipFounderFinder) {
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
                                                    {skipFounderFinder
                                                        ? 'Skipped - using founder names from your CSV'
                                                        : 'Search for founder names using Serper + OpenAI'}
                                                </div>
                                            </div>
                                        </label>

                                        <label style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '0.75rem',
                                            cursor: (findFounder || skipFounderFinder) ? 'pointer' : 'not-allowed',
                                            padding: '0.5rem',
                                            opacity: (findFounder || skipFounderFinder) ? 1 : 0.5
                                        }}>
                                            <input
                                                type="checkbox"
                                                checked={findEmail}
                                                disabled={!(findFounder || skipFounderFinder)}
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
                                                    cursor: (findFounder || skipFounderFinder) ? 'pointer' : 'not-allowed',
                                                    borderRadius: '4px',
                                                    appearance: 'none',
                                                    border: `2px solid rgba(255, 255, 255, ${(findFounder || skipFounderFinder) ? '0.3' : '0.15'})`,
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
                                                    {skipEmailFinder 
                                                        ? 'Skipped - using emails from your CSV' 
                                                        : `Discover email addresses with ${emailProvider === 'self_hosted' ? 'self-hosted verifier' : 'TryKitt'}`}
                                                </div>
                                            </div>
                                        </label>

                                        <label style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '0.75rem',
                                            cursor: (findEmail || skipEmailFinder) && emailProvider !== 'self_hosted' ? 'pointer' : 'not-allowed',
                                            padding: '0.5rem',
                                            opacity: (findEmail || skipEmailFinder) && emailProvider !== 'self_hosted' ? 1 : 0.5
                                        }}>
                                            <input
                                                type="checkbox"
                                                checked={verifyEmail && emailProvider !== 'self_hosted'}
                                                disabled={(!findEmail && !skipEmailFinder) || emailProvider === 'self_hosted'}
                                                onChange={(e) => setVerifyEmail(e.target.checked)}
                                                style={{
                                                    width: '18px',
                                                    height: '18px',
                                                    cursor: (findEmail || skipEmailFinder) && emailProvider !== 'self_hosted' ? 'pointer' : 'not-allowed',
                                                    borderRadius: '4px',
                                                    appearance: 'none',
                                                    border: `2px solid rgba(255, 255, 255, ${(findEmail || skipEmailFinder) && emailProvider !== 'self_hosted' ? '0.3' : '0.15'})`,
                                                    background: (verifyEmail && emailProvider !== 'self_hosted') ? '#3b82f6' : 'transparent',
                                                    position: 'relative',
                                                    flexShrink: 0
                                                }}
                                            />
                                            {(verifyEmail && emailProvider !== 'self_hosted') && (
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
                                                    {emailProvider === 'self_hosted'
                                                        ? 'Automatically skipped - self-hosted finding already verifies emails'
                                                        : skipEmailFinder 
                                                            ? `Validate emails from your CSV with ${emailProvider === 'self_hosted' ? 'self-hosted verifier' : 'TryKitt'}`
                                                            : `Validate discovered email addresses with ${emailProvider === 'self_hosted' ? 'self-hosted verifier' : 'TryKitt'}`}
                                                </div>
                                            </div>
                                        </label>
                                    </div>
                                </div>
                            )}

                            {/* Step 4: Personalization */}
                            {wizardStep === 4 && (
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
                                                        Personalize with Website Info
                                                    </div>
                                                    <div style={{ fontSize: '0.875rem', color: 'rgba(255, 255, 255, 0.6)', marginTop: '0.125rem' }}>
                                                        Generate first line referencing website content
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
                                        onClick={() => setWizardStep((prev) => (prev - 1) as 1 | 2 | 3 | 4)}
                                    >
                                        Back
                                    </button>
                                )}
                                {wizardStep < 4 ? (
                                    <button
                                        type="button"
                                        className="primary-button"
                                        disabled={
                                            (wizardStep === 1 && !selectedFile) ||
                                            (wizardStep === 2 && !domainColumn)
                                        }
                                        onClick={() => setWizardStep((prev) => (prev + 1) as 1 | 2 | 3 | 4)}
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

            {/* Download CSV scope modal */}
            {downloadModalOpen && (
                <div
                    className="modal-overlay"
                    role="dialog"
                    aria-modal="true"
                    onClick={() => setDownloadModalOpen(false)}
                >
                    <div className="modal" onClick={(event) => event.stopPropagation()} style={{ maxWidth: '520px' }}>
                        <div className="modal__header">
                            <div>
                                <h2 className="modal__title">Download results</h2>
                                <p className="modal__description">
                                    Choose whether to include all leads or only verified/valid-risky leads.
                                </p>
                            </div>
                        </div>

                        <div className="modal__body" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                            {[
                                { value: 'all', label: 'All leads', description: 'Exports every processed lead, regardless of verification status.' },
                                { value: 'valid', label: 'Valid only', description: 'Exports only valid, verified, or valid-risky emails (recommended for sending).' }
                            ].map((option) => (
                                <label
                                    key={option.value}
                                    style={{
                                        display: 'flex',
                                        gap: '0.75rem',
                                        alignItems: 'flex-start',
                                        padding: '0.85rem 1rem',
                                        borderRadius: '10px',
                                        border: downloadScope === option.value ? '1px solid rgba(59, 130, 246, 0.6)' : '1px solid rgba(255, 255, 255, 0.08)',
                                        background: downloadScope === option.value ? 'rgba(59, 130, 246, 0.12)' : 'rgba(255, 255, 255, 0.03)',
                                        cursor: 'pointer'
                                    }}
                                >
                                    <input
                                        type="radio"
                                        name="download-scope"
                                        value={option.value}
                                        checked={downloadScope === option.value}
                                        onChange={() => setDownloadScope(option.value as 'all' | 'valid')}
                                        style={{ marginTop: '0.35rem', cursor: 'pointer' }}
                                    />
                                    <div>
                                        <div style={{ fontWeight: 600, color: '#fff' }}>{option.label}</div>
                                        <div style={{ color: 'rgba(255, 255, 255, 0.7)', fontSize: '0.9rem', marginTop: '0.25rem' }}>
                                            {option.description}
                                        </div>
                                    </div>
                                </label>
                            ))}
                        </div>

                        <div className="modal__actions">
                            <button
                                type="button"
                                className="secondary-button secondary-button--active"
                                onClick={() => setDownloadModalOpen(false)}
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                className="primary-button"
                                disabled={!jobState || (jobState.status !== 'completed' && jobState.status !== 'pending-upload')}
                                onClick={() => handleDownloadResults(downloadScope)}
                            >
                                Download
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

                        {selectedLead?.campaigns && selectedLead.campaigns.length > 0 && (
                            <div style={{ margin: '0 0 1rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                                {getCampaignNamesForLead(selectedLead).map((name) => (
                                    <span key={name} style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        padding: '0.35rem 0.65rem',
                                        borderRadius: '999px',
                                        background: 'rgba(59, 130, 246, 0.15)',
                                        color: '#bfdbfe',
                                        fontSize: '0.8rem',
                                        border: '1px solid rgba(59, 130, 246, 0.35)'
                                    }}>
                                        {name}
                                    </span>
                                ))}
                            </div>
                        )}

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

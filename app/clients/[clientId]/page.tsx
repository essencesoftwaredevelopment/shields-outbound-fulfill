"use client";

import { ChangeEvent, FormEvent, UIEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { doc, serverTimestamp, setDoc, collection, onSnapshot, query, orderBy, getDocs, limit, startAfter, where, startAt, endAt, DocumentSnapshot, deleteDoc, updateDoc } from "firebase/firestore";
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

// Helper function to retry fetch on connection errors
async function fetchWithRetry(url: string, options: RequestInit = {}, retries = 2): Promise<Response> {
    const startTime = Date.now();
    console.log(`🌐 [FETCH] Starting request to ${url}`);
    
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const response = await fetch(url, options);
            const duration = Date.now() - startTime;
            console.log(`✅ [FETCH] Success ${url} (${duration}ms, status: ${response.status})`);
            return response;
        } catch (error: any) {
            const duration = Date.now() - startTime;
            console.error(`❌ [FETCH] Attempt ${attempt + 1}/${retries + 1} failed for ${url} (${duration}ms):`, {
                name: error.name,
                message: error.message,
                code: error.code
            });
            
            if (error.message?.includes('ECONNRESET')) {
                console.error('🔥 ECONNRESET ERROR on frontend fetch!');
            }
            
            if (attempt < retries && (error.message?.includes('ECONNRESET') || error.message?.includes('Failed to fetch'))) {
                const backoff = 1000 * (attempt + 1);
                console.warn(`🔄 [FETCH] Retrying in ${backoff}ms...`);
                await new Promise(resolve => setTimeout(resolve, backoff));
                continue;
            }
            
            console.error(`💥 [FETCH] All attempts failed for ${url}`);
            throw error;
        }
    }
    throw new Error('Max retries exceeded');
}

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
    roleType?: string;
    personalizationUrl?: string;
    personalizationTitle?: string;
    updatedAt?: string;
    createdAt?: string;
    lastVerifiedAt?: string;
    jobId?: string;
    campaigns?: string[];
    campaignsData?: Array<{
        campaignId: string;
        campaignName: string;
        addedAt: string;
    }>;
};

type Campaign = {
    id: string;
    name: string;
    status?: number;
    createdAt?: string;
    totalLeads?: number;
};

type Segment = {
    id: string;
    name: string;
    description?: string;
    filters: {
        fullName?: string;
        founder?: 'exists' | 'not_found';
        email?: 'found' | 'not_found' | 'not_run';
        emailStatus?: string[];
        createdAfter?: string;
        createdBefore?: string;
    };
    createdAt?: string;
    updatedAt?: string;
};

type InstantlyCsvMergeResult = {
    summary: {
        rowsTotal: number;
        rowsMatched: number;
        linksInserted: number;
        linksAlreadyPresent: number;
        contactsNotFound: number;
        campaignNamesUnresolved: number;
    };
    unresolvedCampaignNames: string[];
    skippedRows: Array<{
        row: number;
        reason: string;
        campaignName?: string;
        email?: string | null;
        domain?: string | null;
    }>;
    resolvedCampaigns: Array<{
        campaignName: string;
        instantlyCampaignId: string;
        sqlCampaignId: number;
        resolutionReason: string;
    }>;
};

type JobStatus = PipelineJob["status"];
type StageStatus = PipelineStageStatus;

const STAGE_ORDER: PipelineStageKey[] = ["domainPrep", "founders", "emailDiscovery", "verification", "personalization"];
const STAGE_METADATA: Record<PipelineStageKey, { title: string; detail: string }> = {
    domainPrep: {
        title: "Domain Prep",
        detail: "Normalize, dedupe, optional DNS checks",
    },
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
    running: "Processing",
    failed: "Failed",
    completed: "Completed",
};

const STAGE_STATUS_LABELS: Record<StageStatus, string> = {
    pending: "Pending",
    running: "Running",
    completed: "Completed",
    error: "Error",
};

const JOB_STATUS_COLORS: Record<JobStatus, string> = {
    queued: "#9ca3af",    // Grey for neutral/waiting
    running: "#3b82f6",   // Blue for processing
    failed: "#ef4444",    // Red for failure only
    completed: "#22c55e", // Green for success only
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
        stageName === "domainPrep" ?
            extractNumberFrom(summary, ["processable", "live"])
            ?? extractNumberFrom(stats, ["processable", "live"])
            : stageName === "founders" || stageName === "emailDiscovery" ?
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

const deriveDedupedDomainBaseline = (job?: PipelineJob | null) => {
    const dedupe = job?.dedupeStats as (Record<string, unknown> | null | undefined);
    if (!dedupe) return null;

    // Prefer post-DNS processable domains when available.
    const processable = extractNumberFrom(dedupe, ["processable"]);
    if (processable !== null) return processable;

    // Prefer unique normalized domain count when available.
    const unique = extractNumberFrom(dedupe, ["unique"]);
    if (unique !== null) return unique;

    // Fallback: if "new" is zero, keep total as baseline instead of collapsing to zero.
    const newCount = extractNumberFrom(dedupe, ["new"]);
    const total = extractNumberFrom(dedupe, ["total"]);
    if (newCount !== null && newCount > 0) return newCount;
    return total ?? newCount;
};

const calculateJobProgress = (job: PipelineJob): { processed: number; total: number; percent: number } => {
    // Find the currently active or last completed stage to get the most accurate progress
    let processed = 0;
    const dedupedTotal = deriveDedupedDomainBaseline(job);
    let total = dedupedTotal ?? 0;
    
    // Check stages in order for progress
    for (const stageKey of STAGE_ORDER) {
        const stage = job.stages?.[stageKey];
        if (stage && (stage.status === 'running' || stage.status === 'completed')) {
            const stageTotals = deriveStageTotals(stage);
            if (stageTotals.total) {
                total = stageTotals.total;
                processed = stage.progress?.processed || 0;
            }
        }
    }
    
    const percent = total > 0 ? Math.round((processed / total) * 100) : 0;
    return { processed, total, percent };
};

export default function ClientPage() {
    const router = useRouter();
    const params = useParams();
    const searchParams = useSearchParams();
    const clientId = (params?.clientId as string) || "";
    const { user, loading } = useAuth();

    const [activeTab, setActiveTab] = useState<"info" | "campaigns" | "leads" | "segments" | "personalizer">(
        (searchParams?.get("tab") as "info" | "campaigns" | "leads" | "segments" | "personalizer") || "campaigns"
    );
    const [clientName, setClientName] = useState<string>(clientId);
    const [clientIndustry, setClientIndustry] = useState<Niche["id"]>("ecom");
    const [clientInstantlyKey, setClientInstantlyKey] = useState<string>("");
    const [emailProvider, setEmailProvider] = useState<'trykitt' | 'self_hosted'>('trykitt');

    // Personalizer state
    const [personalizerWizardStep, setPersonalizerWizardStep] = useState<1 | 2>(1);
    const [personalizerFile, setPersonalizerFile] = useState<File | null>(null);
    const [checkKlaviyo, setCheckKlaviyo] = useState(false);
    const [productsToPull, setProductsToPull] = useState(3);
    const [removeB2B, setRemoveB2B] = useState(false);
    const [personalizerDomainStats, setPersonalizerDomainStats] = useState<{
        total: number;
        normalized: number;
        withWww: number;
        run: number;
        notRun: number;
        withFounders: number;
        withEmails: number;
        withPersonalization: number;
    } | null>(null);
    const [processingPersonalizerFile, setProcessingPersonalizerFile] = useState(false);
    const [personalizerJobState, setPersonalizerJobState] = useState<any | null>(null);
    const [personalizerJobId, setPersonalizerJobId] = useState<string | null>(null);
    const [uploadingPersonalizer, setUploadingPersonalizer] = useState(false);

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
    const [runDomainCheck, setRunDomainCheck] = useState(true);
    const [filterStats, setFilterStats] = useState<{ raw: number; normalized: number; inBatchDupes: number; crossRunDupes: number; willProcess: number } | null>(null);
    const [domainCheckStats, setDomainCheckStats] = useState<{ 
        total: number; 
        unique: number; 
        existing: number; 
        new: number;
        run: number;
        notRun: number;
        withFounders: number;
        withEmails: number;
        withPersonalization: number;
    } | null>(null);
    const [checkingDomains, setCheckingDomains] = useState(false);

    // Step 3: Personalization options
    const [selectedCampaignId, setSelectedCampaignId] = useState<string>("");
    const [personalizeFirstLine, setPersonalizeFirstLine] = useState(false);
    const [productPromptUseNew, setProductPromptUseNew] = useState(false);
    const [productPromptUseOld, setProductPromptUseOld] = useState(true);
    const [productPromptProducts, setProductPromptProducts] = useState(3);
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
    const lastFetchTimeRef = useRef<number>(0);
    const userDeselectedRef = useRef<boolean>(false);
    const isFetchingRef = useRef<boolean>(false);
    const currentJobStatusRef = useRef<string | null>(null);
    const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
    const [activeJobStatus, setActiveJobStatus] = useState<string | null>(null);
    const [uploadMetrics, setUploadMetrics] = useState<{ count: number; total: number } | null>(null);
    const [instantlyUploadError, setInstantlyUploadError] = useState<string | null>(null);
    const [isSavingClient, setIsSavingClient] = useState(false);
    const [isDeletingClient, setIsDeletingClient] = useState(false);
    const [deletingJobId, setDeletingJobId] = useState<string | null>(null);
    const [pausingJob, setPausingJob] = useState(false);
    const [stoppingJob, setStoppingJob] = useState(false);
    const [pipelineVisible, setPipelineVisible] = useState(true);
    const [expandedErrorJobId, setExpandedErrorJobId] = useState<string | null>(null);
    const [downloadScope, setDownloadScope] = useState<'all' | 'valid'>('valid');
    const [downloadModalOpen, setDownloadModalOpen] = useState(false);
    const [jobPendingUpload, setJobPendingUpload] = useState<string | null>(null);

    // Manual upload modal state
    const [showManualUploadModal, setShowManualUploadModal] = useState(false);
    const [selectedJobForManual, setSelectedJobForManual] = useState<any>(null);
    const [manualUploadCampaigns, setManualUploadCampaigns] = useState<Campaign[]>([]);
    const [selectedManualCampaign, setSelectedManualCampaign] = useState('');
    const [manualUploadNotes, setManualUploadNotes] = useState('');
    const [manualUploadLoading, setManualUploadLoading] = useState(false);
    const [qualifiedContactsCount, setQualifiedContactsCount] = useState<{qualified: number, total: number} | null>(null);
    const [jobUploadStatus, setJobUploadStatus] = useState<Record<string, any[]>>({});
    const [showInstantlyCsvImportModal, setShowInstantlyCsvImportModal] = useState(false);
    const [instantlyCsvImportFile, setInstantlyCsvImportFile] = useState<File | null>(null);
    const [instantlyCsvImportNotes, setInstantlyCsvImportNotes] = useState('');
    const [instantlyCsvImportLoading, setInstantlyCsvImportLoading] = useState(false);
    const [instantlyCsvImportResult, setInstantlyCsvImportResult] = useState<InstantlyCsvMergeResult | null>(null);
    const [instantlyCsvOverrideCampaigns, setInstantlyCsvOverrideCampaigns] = useState<Campaign[]>([]);
    const [instantlyCsvCampaignOverrides, setInstantlyCsvCampaignOverrides] = useState<Record<string, string>>({});
    const [instantlyCsvCampaignsLoading, setInstantlyCsvCampaignsLoading] = useState(false);

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
            domainPrep: createEmptyStageState(),
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

    // Log whenever toast message changes
    useEffect(() => {
        if (toastMessage) {
            // Filter out Next.js dev-mode RSC streaming errors
            if (toastMessage === 'read ECONNRESET' || toastMessage.includes('react-server-dom-turbopack')) {
                console.warn('⚠️ Suppressing Next.js dev-mode streaming error:', toastMessage);
                setToastMessage(null);
                return;
            }
            
            console.log('🔔🔔🔔 TOAST MESSAGE SET 🔔🔔🔔');
            console.log('Toast content:', toastMessage);
            console.log('Stack trace at toast set:', new Error().stack);
            
            if (toastMessage.toLowerCase().includes('connection')) {
                console.error('🔥🔥🔥 CONNECTION ERROR TOAST DISPLAYED 🔥🔥🔥');
                console.error('Toast message:', toastMessage);
            }
            
            setToastVisible(true);
        }
    }, [toastMessage]);

    // Override console.error to catch ALL errors
    useEffect(() => {
        const originalError = console.error;
        console.error = (...args: any[]) => {
            const errorString = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
            if (errorString.includes('ECONNRESET')) {
                console.log('%c🔥🔥🔥 ECONNRESET DETECTED IN CONSOLE.ERROR 🔥🔥🔥', 'background: red; color: white; font-size: 20px; padding: 10px;');
                console.log('Arguments:', args);
                console.trace('Stack trace:');
            }
            originalError.apply(console, args);
        };

        return () => {
            console.error = originalError;
        };
    }, []);

    // Global error handler to catch unhandled errors
    useEffect(() => {
        const handleError = (event: ErrorEvent) => {
            console.error('🚨🚨🚨 GLOBAL ERROR CAUGHT 🚨🚨🚨', {
                message: event.message,
                filename: event.filename,
                lineno: event.lineno,
                colno: event.colno,
                error: event.error
            });
            
            if (event.message?.includes('ECONNRESET')) {
                console.error('🔥🔥🔥 THIS IS THE ECONNRESET CAUSING YOUR POPUP! 🔥🔥🔥');
                setToastMessage('Connection reset error detected. Check console for details.');
            }
        };

        const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
            console.error('🚨🚨🚨 UNHANDLED PROMISE REJECTION 🚨🚨🚨', {
                reason: event.reason,
                promise: event.promise
            });
            
            if (event.reason?.message?.includes('ECONNRESET') || event.reason?.code === 'ECONNRESET') {
                console.error('🔥🔥🔥 ECONNRESET IN UNHANDLED PROMISE! 🔥🔥🔥');
                console.error('Stack trace:', event.reason?.stack);
                setToastMessage('Connection error (unhandled promise). Check console.');
            }
        };

        window.addEventListener('error', handleError);
        window.addEventListener('unhandledrejection', handleUnhandledRejection);

        return () => {
            window.removeEventListener('error', handleError);
            window.removeEventListener('unhandledrejection', handleUnhandledRejection);
        };
    }, []);

    // Upload to Instantly modal state
    const [uploadModalOpen, setUploadModalOpen] = useState(false);
    const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
    const [csvPreviewRows, setCsvPreviewRows] = useState<Record<string, string>[]>([]);
    const [columnMapping, setColumnMapping] = useState<Record<string, { column: string; isCustom: boolean; customName?: string }>>({});
    const leadsContainerRef = useRef<HTMLDivElement | null>(null);
    const [skipWorkspaceDupes, setSkipWorkspaceDupes] = useState<boolean>(true);
    const [skipCampaignDupes, setSkipCampaignDupes] = useState<boolean>(false);
    const [skipListDupes, setSkipListDupes] = useState<boolean>(false);

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
    const [jobIdFilter, setJobIdFilter] = useState<string>("");
    const [clientTotalLeads, setClientTotalLeads] = useState<number>(0);
    const [founderFilter, setFounderFilter] = useState<string>("");
    const [emailFilter, setEmailFilter] = useState<string>("");
    const [emailStatusFilter, setEmailStatusFilter] = useState<string>("");
    const [exportingCsv, setExportingCsv] = useState(false);

    // Campaigns state
    const [campaigns, setCampaigns] = useState<Campaign[]>([]);
    const [syncingCampaigns, setSyncingCampaigns] = useState(false);
    const [campaignSyncMessage, setCampaignSyncMessage] = useState("");
    const [instantlyCampaigns, setInstantlyCampaigns] = useState<Array<{ id: string; name: string }>>([]);
    const [instantlyCampaignsLoading, setInstantlyCampaignsLoading] = useState(false);

    // Segments state
    const [segments, setSegments] = useState<Segment[]>([]);
    const [segmentCounts, setSegmentCounts] = useState<Record<string, number>>({});
    const [editingSegment, setEditingSegment] = useState<Segment | null>(null);
    const [segmentModalOpen, setSegmentModalOpen] = useState(false);
    const [segmentName, setSegmentName] = useState("");
    const [segmentDescription, setSegmentDescription] = useState("");
    const [segmentFullName, setSegmentFullName] = useState("");
    const [segmentFounder, setSegmentFounder] = useState<'' | 'exists' | 'not_found'>('');
    const [segmentEmail, setSegmentEmail] = useState<'' | 'found' | 'not_found' | 'not_run'>('');
    const [segmentEmailStatus, setSegmentEmailStatus] = useState<string[]>([]);
    const [segmentCreatedAfter, setSegmentCreatedAfter] = useState("");
    const [segmentCreatedBefore, setSegmentCreatedBefore] = useState("");
    const [selectedSegmentId, setSelectedSegmentId] = useState<string>("");
    const [segmentLeads, setSegmentLeads] = useState<Lead[]>([]);
    const [segmentLeadsLoading, setSegmentLeadsLoading] = useState(false);
    const [savingSegment, setSavingSegment] = useState(false);
    const [deletingSegmentId, setDeletingSegmentId] = useState<string | null>(null);
    const [downloadingSegmentId, setDownloadingSegmentId] = useState<string | null>(null);

    // Computed values for pipeline panel
    const stageCompletionPercent = useMemo(() => {
        if (!jobState) return 0;
        const completedStages = STAGE_ORDER.filter(k => jobState.stages[k]?.status === 'completed').length;
        return Math.round((completedStages / STAGE_ORDER.length) * 100);
    }, [jobState]);

    const validLeadsCompleted = useMemo(() => {
        if (!jobState) return 0;
        return (jobState.stages?.verification?.summary as any)?.valid 
            || (jobState.stages?.verification?.summary as any)?.Valid 
            || 0;
    }, [jobState]);

    const activeStatusLabel = useMemo(() => {
        if (!jobState) return null;
        if (jobState.paused) return 'Job paused';
        if (jobState.status === 'running') {
            const runningStage = STAGE_ORDER.find(k => jobState.stages[k]?.status === 'running');
            if (runningStage) {
                return `Running ${STAGE_METADATA[runningStage]?.title || runningStage}...`;
            }
        }
        return null;
    }, [jobState]);

    const canUploadToInstantly = useMemo(() => {
        return jobState?.status === 'completed' && activeJobStatus !== 'uploaded';
    }, [jobState, activeJobStatus]);

    const canDiscardJob = useMemo(() => {
        return jobState && ['completed', 'pending-upload'].includes(jobState.status) && activeJobStatus !== 'uploaded';
    }, [jobState, activeJobStatus]);

    const uploadedSummary = useMemo(() => {
        if (!uploadMetrics) return 'Uploaded';
        const { count, total } = uploadMetrics;
        if (count === total) return `${count.toLocaleString()} uploaded`;
        return `${count.toLocaleString()}/${total.toLocaleString()} uploaded`;
    }, [uploadMetrics]);

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

    // Helper function to display email
    const displayEmail = (email: string | undefined, emailStatus: string | undefined) => {
        // If email exists, show it (even if from Instantly backfill without status)
        if (email && email.trim() !== '') {
            const emailLower = email.toLowerCase().trim();
            if (emailLower === 'not found' || emailLower === 'not_found' || emailLower.includes('not found')) return 'Not Found';
            return email;
        }
        // If email_status exists but no email, it was not found
        if (emailStatus && emailStatus.trim() !== '') return 'Not Found';
        // No email and no status means email finder hasn't run yet
        return 'Not Run';
    };

    // Helper function to display email status
    const displayEmailStatus = (emailStatus: string | undefined) => {
        // If email_status is empty, the email finder hasn't run yet
        if (!emailStatus || emailStatus.trim() === '') return 'Not Run';
        return emailStatus;
    };

    type LeadStatusChipVariant =
        | "valid"
        | "valid-risky"
        | "invalid"
        | "not-found"
        | "not-run"
        | "skipped"
        | "default";

    const getLeadStatusChipMeta = (emailStatus: string | undefined): { label: string; variant: LeadStatusChipVariant } => {
        const normalized = (emailStatus || '').trim().toLowerCase();

        if (!normalized) return { label: "Not Run", variant: "not-run" };
        if (normalized === "valid") return { label: "Valid", variant: "valid" };
        if (normalized === "valid-risky" || normalized === "risky") return { label: "Valid-Risky", variant: "valid-risky" };
        if (normalized === "invalid") return { label: "Invalid", variant: "invalid" };
        if (normalized === "not_found" || normalized.includes("not found")) return { label: "Not Found", variant: "not-found" };
        if (normalized === "skipped_no_founder") return { label: "Skipped", variant: "skipped" };

        return { label: displayEmailStatus(emailStatus), variant: "default" };
    };

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

        // Subscribe to segments subcollection
        const segmentsCol = collection(firestore, "users", user.uid, "clients", clientId, "segments");
        const unsubSegments = onSnapshot(segmentsCol, (snap) => {
            if (cancelled) return;
            const rows = snap.docs.map((d) => {
                const data = d.data();
                return {
                    id: d.id,
                    name: (data.name as string) || d.id,
                    description: (data.description as string) || "",
                    filters: data.filters || {},
                    createdAt: data.createdAt?.toDate ? new Date(data.createdAt.toDate()).toLocaleString() : "",
                    updatedAt: data.updatedAt?.toDate ? new Date(data.updatedAt.toDate()).toLocaleString() : "",
                } as Segment;
            });
            setSegments(rows.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')));
        }, () => {
            if (!cancelled) {
                setSegments([]);
            }
        });

        return () => {
            cancelled = true;
            try { unsubClient(); } catch { }
            try { unsubCampaigns(); } catch { }
            try { unsubSegments(); } catch { }
        };
    }, [user, clientId]);

    useEffect(() => {
        if (!user || !clientId) return;
        
        // Reset and refetch when lead filters change
        setLeads([]);
        setLeadsCursor(0);
        setLeadsHasMore(true);
        fetchLeads(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user, clientId, leadSearch, jobIdFilter, emailStatusFilter, founderFilter, emailFilter, campaignFilterId]);

    // Fetch instantly campaigns for filtering
    useEffect(() => {
        if (!user || !clientId) return;

        const fetchInstantlyCampaigns = async () => {
            setInstantlyCampaignsLoading(true);
            try {
                const idToken = await getIdToken(user);
                const params = new URLSearchParams();
                params.append('clientId', clientId);

                const response = await fetchWithRetry(`${getPipelineBaseUrl()}/api/instantly-campaigns?${params.toString()}`, {
                    headers: { 'Authorization': `Bearer ${idToken}` }
                });

                if (!response.ok) {
                    throw new Error(`Failed to fetch campaigns: ${response.statusText}`);
                }

                const data = await response.json();
                setInstantlyCampaigns(data.campaigns || []);
            } catch (error) {
                console.error('Failed to fetch instantly campaigns:', error);
                setInstantlyCampaigns([]);
            } finally {
                setInstantlyCampaignsLoading(false);
            }
        };

        fetchInstantlyCampaigns();
    }, [user, clientId, uploadModalOpen]);

    // Reset column mapping custom flags when modal opens
    useEffect(() => {
        if (!uploadModalOpen) return;
        setColumnMapping((prev) => {
            const next = { ...prev };
            Object.keys(next).forEach((k) => {
                if (next[k]?.isCustom) {
                    next[k] = { ...next[k], column: '', customName: '' };
                }
            });
            return next;
        });
        setSkipWorkspaceDupes(true);
        setSkipCampaignDupes(false);
        setSkipListDupes(false);
    }, [uploadModalOpen]);

    // Fetch segment counts when segments change
    useEffect(() => {
        if (!user || !clientId || segments.length === 0) return;

        const fetchSegmentCounts = async () => {
            const idToken = await getIdToken(user);
            const counts: Record<string, number> = {};

            await Promise.all(
                segments.map(async (segment) => {
                    try {
                        const params = new URLSearchParams();
                        params.append('clientId', clientId);
                        params.append('limit', '1');

                        if (segment.filters.fullName) params.append('fullName', segment.filters.fullName);
                        if (segment.filters.email === 'found') params.append('emailFilter', 'exists');
                        else if (segment.filters.email === 'not_found') params.append('emailFilter', 'not_found');
                        if (segment.filters.emailStatus && segment.filters.emailStatus.length > 0) {
                            params.append('emailStatusMulti', segment.filters.emailStatus.join(','));
                        }
                        if (segment.filters.createdAfter) params.append('createdAfter', segment.filters.createdAfter);
                        if (segment.filters.createdBefore) params.append('createdBefore', segment.filters.createdBefore);

                        const response = await fetchWithRetry(`${getPipelineBaseUrl()}/api/leads?${params.toString()}`, {
                            headers: { 'Authorization': `Bearer ${idToken}` }
                        });

                        if (response.ok) {
                            const data = await response.json();
                            counts[segment.id] = data.total || 0;
                        }
                    } catch (error) {
                        console.error(`Failed to fetch count for segment ${segment.id}:`, error);
                        counts[segment.id] = 0;
                    }
                })
            );

            setSegmentCounts(counts);
        };

        fetchSegmentCounts();
    }, [user, clientId, segments]);



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

    const mapJobDocToJob = useCallback((docSnap: DocumentSnapshot): PipelineJob => {
        const data = (docSnap.data() as Record<string, unknown> | undefined) || {};
        const id = (data.id as string) || docSnap.id;
        const createdAtRaw = data.createdAt;
        const completedAtRaw = data.completedAt;

        const toIso = (value: unknown) => {
            if (typeof value === "string" && value) return value;
            if (value && typeof (value as any).toDate === "function") {
                try {
                    return (value as any).toDate().toISOString();
                } catch {
                    return new Date().toISOString();
                }
            }
            return new Date().toISOString();
        };

        const dedupe = data.dedupeStats as { total?: number; skipped?: number; new?: number } | undefined;
        const totalVal = Number(dedupe?.total ?? 0);
        const skippedVal = Number(dedupe?.skipped ?? 0);
        const newVal = Number(dedupe?.new ?? 0);

        return {
            id,
            status: (data.status as PipelineJob["status"]) || "queued",
            error: (data.error as string) || null,
            fileName: (data.fileName as string) || id,
            createdAt: toIso(createdAtRaw),
            completedAt: typeof completedAtRaw === "undefined" || completedAtRaw === null ? null : toIso(completedAtRaw),
            stages: normalizeStages(data.stages),
            dedupeStats: dedupe
                ? {
                    total: Number.isFinite(totalVal) ? totalVal : 0,
                    skipped: Number.isFinite(skippedVal) ? skippedVal : 0,
                    new: Number.isFinite(newVal) ? newVal : 0,
                }
                : null,
        };
    }, [normalizeStages]);

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

            if (founderFilter) {
                params.append('founderFilter', founderFilter);
            }

            if (emailFilter) {
                params.append('emailFilter', emailFilter);
            }

            if (campaignFilterId) {
                params.append('instantlyCampaignId', campaignFilterId);
            }

            if (jobIdFilter.trim()) {
                params.append('jobId', jobIdFilter.trim());
            }

            // Send search term to backend for SQL filtering
            if (leadSearch.trim()) {
                params.append('search', leadSearch.trim());
            }

            if (!reset && leadsCursor) {
                params.append('offset', String(leadsCursor));
            }

            const response = await fetchWithRetry(`${getPipelineBaseUrl()}/api/leads?${params.toString()}`, {
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
                roleType: row.roleType || "",
                personalizationUrl: row.personalizationUrl || "",
                personalizationTitle: row.personalizationTitle || "",
                updatedAt: row.updatedAt || "",
                createdAt: row.createdAt || "",
                lastVerifiedAt: row.lastVerifiedAt || "",
                jobId: row.jobId || "",
                campaigns: row.campaigns || [],
                campaignsData: row.campaignsData || []
            }));

            // Deduplicate leads by ID to prevent React key conflicts
            setLeads(reset ? mapped : (prev) => {
                const existingIds = new Set(prev.map(l => l.id));
                const newLeads = mapped.filter(l => !existingIds.has(l.id));
                return [...prev, ...newLeads];
            });
            
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
        } catch (error: any) {
            console.error('❌ [LEADS ERROR] Failed to fetch leads:', {
                message: error.message,
                code: error.code,
                name: error.name,
                stack: error.stack?.split('\n').slice(0, 5)
            });
            
            if (error.message?.includes('ECONNRESET') || error.code === 'ECONNRESET') {
                console.error('🔥🔥🔥 ECONNRESET ERROR CAUGHT IN fetchLeads() 🔥🔥🔥');
                console.error('This is likely causing the popup you see');
                setToastMessage('Connection error. Please refresh the page.');
            } else {
                setToastMessage(`Error loading leads: ${error.message}`);
            }
            
            setLeadsHasMore(false);
        } finally {
            setLeadsLoading(false);
        }
    }, [user, clientId, leadSearch, jobIdFilter, leadsCursor, emailStatusFilter, founderFilter, emailFilter, campaignFilterId]);

    const loadMoreLeads = useCallback(() => {
        if (leadsLoading || !leadsHasMore) return;
        fetchLeads(false);
    }, [fetchLeads, leadsHasMore, leadsLoading]);

    // All filters are now applied server-side
    const filteredLeads = useMemo(() => {
        return leads;
    }, [leads]);

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

    const fetchJobSnapshot = useCallback(async (jobId: string, force = false) => {
        if (!jobId || !user || !clientId) return;
        
        // Prevent concurrent fetches
        if (isFetchingRef.current) {
            console.log(`⏭️ [GUARD] Skipping fetchJobSnapshot - fetch already in progress`);
            return;
        }
        
        // Debounce: prevent fetches more often than once per 3 seconds unless forced
        const now = Date.now();
        const timeSinceLastFetch = now - lastFetchTimeRef.current;
        if (!force && timeSinceLastFetch < 3000) {
            console.log(`⏭️ [DEBOUNCE] Skipping fetchJobSnapshot, last fetch was ${timeSinceLastFetch}ms ago`);
            return;
        }
        
        isFetchingRef.current = true;
        lastFetchTimeRef.current = now;
        
        try {
            const idToken = await getIdToken(user);
            const response = await fetchWithRetry(`${getPipelineBaseUrl()}/api/jobs/${jobId}?clientId=${clientId}`, {
                headers: {
                    'Authorization': `Bearer ${idToken}`
                }
            });
            if (!response.ok) return;
            const payload = await response.json();
            if (payload?.job) {
                setJobState(payload.job);
            }
        } catch (error: any) {
            console.error('❌ [JOB SNAPSHOT ERROR]:', {
                message: error.message,
                code: error.code,
                name: error.name,
                stack: error.stack?.split('\n').slice(0, 5)
            });
            
            if (error.message?.includes('ECONNRESET') || error.code === 'ECONNRESET') {
                console.error('🔥🔥🔥 ECONNRESET ERROR CAUGHT IN fetchJobSnapshot() 🔥🔥🔥');
                setToastMessage('Connection error loading job. Please refresh.');
            }
        } finally {
            isFetchingRef.current = false;
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
            
            // Don't open stream if job isn't running/queued
            const currentStatus = currentJobStatusRef.current;
            if (currentStatus && currentStatus !== 'running' && currentStatus !== 'queued') {
                console.log(`⏭️ [GUARD] Not opening stream - job status is "${currentStatus}", not running/queued`);
                return;
            }
            
            // Prevent opening multiple streams for the same job
            if (jobStreamRef.current && lastStreamingJobIdRef.current === jobId) {
                console.log(`⏭️ [GUARD] Stream already open for job ${jobId}`);
                return;
            }
            
            closeJobStream();
            if (!isReconnect) {
                reconnectAttemptsRef.current = 0;
            }
            setSelectedJobId(jobId);
            lastStreamingJobIdRef.current = jobId;
            setJobStatusMessage(isReconnect ? "Reconnecting to pipeline..." : "Connecting to pipeline...");
            // Only fetch snapshot on initial open, not reconnects
            if (!isReconnect) {
                fetchJobSnapshot(jobId, true);
            }

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

            stream.onerror = (event) => {
                console.warn('⚠️ EventSource error:', {
                    jobId,
                    readyState: stream.readyState,
                    attempt: reconnectAttemptsRef.current,
                    status: currentJobStatusRef.current
                });
                
                setJobStreamConnected(false);
                stream.close();
                jobStreamRef.current = null;
                
                // Check if job status still requires streaming before reconnecting
                const currentStatus = currentJobStatusRef.current;
                if (currentStatus && currentStatus !== 'running' && currentStatus !== 'queued') {
                    console.log(`⏹️ Stopping stream reconnection - job status is "${currentStatus}"`);
                    setJobStatusMessage("");
                    return;
                }
                
                setJobStatusMessage("Lost connection to pipeline stream, retrying...");

                const MAX_RETRIES = 5;
                if (reconnectAttemptsRef.current >= MAX_RETRIES) {
                    setJobStatusMessage("Unable to reconnect to pipeline stream.");
                    // Fetch one final time after giving up
                    fetchJobSnapshot(jobId, true);
                    return;
                }

                const attempt = reconnectAttemptsRef.current;
                reconnectAttemptsRef.current = attempt + 1;
                const delay = Math.min(10000, 1000 * Math.pow(2, attempt));
                console.log(`⏳ Reconnecting in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
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
            
            // Store current status in ref for stream error handler to check
            currentJobStatusRef.current = status;

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
                    // Use force=false to respect debouncing
                    fetchJobSnapshot(jobId, false);
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
            } else if (isStreaming && (!status || status === "completed" || status === "uploaded" || status === "failed" || status === "discarded")) {
                closeJobStream();
            }

            if (status && status !== lastActiveStatusRef.current) {
                if (status === "completed") {
                    const message = "Pipeline finished.";
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
                } else if (status === "failed") {
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
            const rows = snap.docs.map(mapJobDocToJob);
            console.log(`[Job History] Parsed jobs:`, rows.map(j => ({ id: j.id, status: j.status, fileName: j.fileName })));
            setJobHistory(rows);
        }, (error) => {
            console.error('Job history subscription error:', error);
            setJobHistory([]);
        });

        return () => unsubscribe();
    }, [user, clientId, mapJobDocToJob]);

    useEffect(() => {
        if (!user || !clientId || !selectedJobId) {
            return;
        }

        const jobRef = doc(firestore, "users", user.uid, "clients", clientId, "jobs", selectedJobId);
        // Subscribe with explicit listener for realtime updates
        const unsubscribe = onSnapshot(jobRef, { includeMetadataChanges: false }, (snap) => {
            if (!snap.exists()) {
                return;
            }
            const jobObj = mapJobDocToJob(snap);
            // Only update from Firestore if NOT currently streaming via SSE
            // SSE has fresher data for running jobs
            const isStreaming = lastStreamingJobIdRef.current === selectedJobId;
            if (!isStreaming || jobObj.status !== "running") {
                setJobState(jobObj);
            }
        }, (error) => {
            console.error("Job subscription error:", error);
        });

        return () => unsubscribe();
    }, [user, clientId, selectedJobId, mapJobDocToJob]);

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

        // If nothing selected yet, default to latest (unless user explicitly deselected)
        if (!selectedJobId) {
            if (!userDeselectedRef.current) {
                setSelectedJobId(latest.id);
                if (!streamingSelected) {
                    setJobState(latest);
                }
            }
            return;
        }

        // If the previously selected job disappeared, fall back to latest
        if (!selectedFromHistory && !streamingSelected) {
            setSelectedJobId(latest.id);
            setJobState(latest);
        }
    }, [jobHistory, jobState, jobStreamConnected, selectedJobId]);

    // Fetch upload status for all jobs in a single batch request
    const fetchJobsUploadStatus = useCallback(async () => {
        if (!user || !clientId || jobHistory.length === 0) {
            return;
        }

        try {
            const token = await user.getIdToken();
            const jobIds = jobHistory.map(job => job.id);
            
            const response = await fetch(
                `${getPipelineBaseUrl()}/api/jobs/batch/upload-status`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify({
                        jobIds,
                        clientId,
                        agencyId: user.uid
                    })
                }
            );
            
            if (!response.ok) {
                throw new Error(`Failed to fetch upload status: ${response.status}`);
            }
            
            const data = await response.json();
            setJobUploadStatus(data.statusMap || {});
        } catch (error) {
            console.error('Error fetching upload status:', error);
        }
    }, [user, clientId, jobHistory]);

    useEffect(() => {
        if (jobState) {
            setSelectedJobId(jobState.id);
        }
    }, [jobState?.id]);

    // Fetch upload status when job history changes
    useEffect(() => {
        fetchJobsUploadStatus();
    }, [fetchJobsUploadStatus]);

    // Track personalizer job status
    useEffect(() => {
        if (!user || !clientId || !personalizerJobId) {
            return;
        }

        const jobRef = doc(firestore, "users", user.uid, "clients", clientId, "jobs", personalizerJobId);
        const unsubscribe = onSnapshot(jobRef, (snap) => {
            if (!snap.exists()) {
                return;
            }
            const jobData = snap.data();
            setPersonalizerJobState(jobData);

            // Show toast on completion
            if (jobData.status === 'completed' && !jobData.__toastShown) {
                setToastMessage(`Personalizer complete! ${jobData.result?.personalized || 0} leads personalized`);
                setToastVisible(true);
                // Mark that we showed the toast
                updateDoc(jobRef, { __toastShown: true }).catch(() => {});
            } else if (jobData.status === 'failed') {
                setToastMessage(`Personalizer failed: ${jobData.error || 'Unknown error'}`);
                setToastVisible(true);
            }
        }, (error) => {
            console.error("Personalizer job subscription error:", error);
        });

        return () => unsubscribe();
    }, [user, clientId, personalizerJobId]);

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
        } else if (jobState.status === "failed") {
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
            const resp = await fetchWithRetry(`/api/clients/${encodeURIComponent(clientId)}/campaigns`, {
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
        setDomainCheckStats(null);

        // Reset mappings when a new file is chosen
        setCsvColumns([]);
        setDomainColumn("");
        setFounderColumn("");
        setEmailColumn("");

        if (!file) return;

        try {
            const text = await file.text();
            const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
            if (!lines.length) return;
            
            const headerLine = lines[0];
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
                
                // Extract domains from CSV and check against database
                const domainColumnIndex = columns.indexOf(detectedDomain);
                if (domainColumnIndex >= 0 && user && clientId) {
                    setCheckingDomains(true);
                    
                    try {
                        // Parse domains from all rows
                        const domains = lines.slice(1) // Skip header
                            .map(line => {
                                const values = line.split(",").map(v => v.trim().replace(/^"|"$/g, ""));
                                return values[domainColumnIndex];
                            })
                            .filter(Boolean);

                        // Check domains against database
                        const token = await user.getIdToken();
                        const response = await fetch(
                            `${getPipelineBaseUrl()}/api/jobs/check-domains`,
                            {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'Authorization': `Bearer ${token}`
                                },
                                body: JSON.stringify({
                                    domains,
                                    clientId,
                                    agencyId: user.uid
                                })
                            }
                        );

                        if (response.ok) {
                            const data = await response.json();
                            setDomainCheckStats({
                                total: data.totalDomains,
                                unique: data.uniqueDomains ?? data.totalDomains,
                                existing: data.existingDomains,
                                new: data.newDomains,
                                run: data.run || 0,
                                notRun: data.notRun || 0,
                                withFounders: data.withFounders || 0,
                                withEmails: data.withEmails || 0,
                                withPersonalization: data.withPersonalization || 0
                            });
                        }
                    } catch (error) {
                        console.error('Error checking domains:', error);
                    } finally {
                        setCheckingDomains(false);
                    }
                }
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
        userDeselectedRef.current = false;
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
            const selectedProductPromptVersion: 'old' | 'new_gpt5mini' | undefined =
                clientIndustry === 'ecom' && personalizeFirstLine
                    ? (productPromptUseNew ? 'new_gpt5mini' : 'old')
                    : undefined;
            const selectedProductPromptProducts =
                clientIndustry === 'ecom' && personalizeFirstLine && productPromptUseNew
                    ? productPromptProducts
                    : undefined;
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
                skipDomainCheck: !runDomainCheck,
                personalizeFirstLine,
                productPromptVersion: selectedProductPromptVersion,
                productPromptProducts: selectedProductPromptProducts,
                domainColumn,
                founderColumn,
                emailColumn,
            });

            const freshJob = response.job;
            setJobState(freshJob);
            setJobStatusMessage("Job queued.");

            // Show toast with deduplication stats
            if (freshJob.dedupeStats) {
                const { total, skipped, new: newCount, existing, unique } = freshJob.dedupeStats as any;
                const uniqueCount = typeof unique === 'number' ? unique : total;
                const existingCount = typeof existing === 'number' ? existing : Math.max(0, uniqueCount - newCount);

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
                    const msg = `✓ Normalized & validated. Processing ${uniqueCount} unique domain${uniqueCount !== 1 ? 's' : ''} (${newCount} new, ${existingCount} existing). Existing domains will merge non-empty updates.`;
                    setToastMessage(msg);
                    setToastVisible(true);
                } else {
                    const msg = `✓ Filtered ${existingCount} already-processed + ${Math.max(0, total - uniqueCount)} duplicate${Math.max(0, total - uniqueCount) !== 1 ? 's' : ''}. Processing ${newCount} unique domain${newCount !== 1 ? 's' : ''}.`;
                    setToastMessage(msg);
                    setToastVisible(true);
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
        if (emailProvider === 'self_hosted') {
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

    const handlePersonalizerSubmit = async () => {
        if (!personalizerFile || !user || !clientId) {
            return;
        }

        setUploadingPersonalizer(true);
        try {
            const idToken = await getIdToken(user);
            const formData = new FormData();
            formData.append('file', personalizerFile);
            formData.append('idToken', idToken);
            formData.append('clientId', clientId);
            formData.append('productsToPull', productsToPull.toString());
            formData.append('checkKlaviyo', checkKlaviyo.toString());
            formData.append('removeB2B', removeB2B.toString());

            const response = await fetchWithRetry(`${getPipelineBaseUrl()}/api/jobs/personalizer`, {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                const data = await response.json().catch(() => ({}));
                throw new Error(data.error || `Failed to start personalizer (${response.status})`);
            }

            const data = await response.json();
            setPersonalizerJobId(data.jobId);
            setToastMessage('Personalizer job started!');
            setToastVisible(true);

            // Reset wizard
            setPersonalizerWizardStep(1);
            setPersonalizerFile(null);
            setPersonalizerDomainStats(null);
        } catch (error) {
            setToastMessage(error instanceof Error ? error.message : 'Failed to start personalizer');
            setToastVisible(true);
        } finally {
            setUploadingPersonalizer(false);
        }
    };

    const handleDownloadResults = (scope: 'all' | 'valid') => {
        if (!jobState || jobState.status !== "completed") {
            return;
        }
        const url = getJobResultUrl(jobState.id, scope);
        window.open(url, "_blank", "noopener,noreferrer");
        setDownloadModalOpen(false);
    };

    const handlePersonalizerFileUpload = async (file: File) => {
        setPersonalizerFile(file);
        setProcessingPersonalizerFile(true);
        setPersonalizerDomainStats(null);

        try {
            const text = await file.text();
            const lines = text.split('\n').filter(line => line.trim());
            
            if (lines.length === 0) {
                throw new Error('CSV file is empty');
            }

            // Parse CSV header to find domain column
            const header = lines[0].split(',').map(col => col.trim().replace(/^"|"$/g, ''));
            const domainColumnIndex = header.findIndex(col => 
                col.toLowerCase().includes('domain') || 
                col.toLowerCase().includes('website') ||
                col.toLowerCase().includes('url')
            );

            if (domainColumnIndex === -1) {
                setToastMessage('⚠️ No domain column found. Looking for columns with "domain", "website", or "url"');
                setToastVisible(true);
                setProcessingPersonalizerFile(false);
                return;
            }

            // Extract and normalize domains
            let totalDomains = 0;
            let normalizedCount = 0;
            const domains: string[] = [];

            for (let i = 1; i < lines.length; i++) {
                const cells = lines[i].split(',').map(cell => cell.trim().replace(/^"|"$/g, ''));
                if (cells.length > domainColumnIndex) {
                    let domain = cells[domainColumnIndex].trim();
                    if (domain) {
                        totalDomains++;
                        // Normalize: remove protocol, www., trailing slashes
                        const original = domain;
                        domain = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase();
                        
                        if (original !== domain && original.toLowerCase().includes('www.')) {
                            normalizedCount++;
                        }
                        domains.push(domain);
                    }
                }
            }

            const uniqueDomains = [...new Set(domains)];

            // Call backend to get enriched domain statistics
            if (user && clientId && uniqueDomains.length > 0) {
                const idToken = await getIdToken(user);
                const response = await fetchWithRetry(`${getPipelineBaseUrl()}/api/domains/analyze`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${idToken}`
                    },
                    body: JSON.stringify({
                        clientId,
                        domains: uniqueDomains
                    })
                });

                if (response.ok) {
                    const data = await response.json();
                    setPersonalizerDomainStats({
                        total: totalDomains,
                        normalized: uniqueDomains.length,
                        withWww: normalizedCount,
                        run: data.run || 0,
                        notRun: data.notRun || 0,
                        withFounders: data.withFounders || 0,
                        withEmails: data.withEmails || 0,
                        withPersonalization: data.withPersonalization || 0
                    });
                } else {
                    // Fallback to basic stats if backend call fails
                    setPersonalizerDomainStats({
                        total: totalDomains,
                        normalized: uniqueDomains.length,
                        withWww: normalizedCount,
                        run: 0,
                        notRun: uniqueDomains.length,
                        withFounders: 0,
                        withEmails: 0,
                        withPersonalization: 0
                    });
                }
            } else {
                // No domains or no user - show basic stats only
                setPersonalizerDomainStats({
                    total: totalDomains,
                    normalized: uniqueDomains.length,
                    withWww: normalizedCount,
                    run: 0,
                    notRun: uniqueDomains.length,
                    withFounders: 0,
                    withEmails: 0,
                    withPersonalization: 0
                });
            }

        } catch (error) {
            console.error('Error processing personalizer file:', error);
            setToastMessage('Failed to process CSV file');
            setToastVisible(true);
        } finally {
            setProcessingPersonalizerFile(false);
        }
    };

    const handleStopJob = async () => {
        if (!jobState || !user) return;
        setStoppingJob(true);
        setJobStatusMessage('Stopping job...');
        try {
            const idToken = await getIdToken(user);
            const resp = await fetchWithRetry(`${getPipelineBaseUrl()}/api/jobs/${jobState.id}/stop`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ idToken, clientId })
            });
            if (!resp.ok) {
                const data = await resp.json().catch(() => ({}));
                throw new Error(data.error || `Failed to stop job (${resp.status})`);
            }
            
            const data = await resp.json();
            
            closeJobStream();
            
            // Handle stale job cleanup
            if (data.status === 'cleaned') {
                setJobState(null);
                setJobStatusMessage('');
                setToastMessage(data.message || 'Stale job reference cleared.');
                setToastVisible(true);
            } else {
                setJobState((prev) => prev ? { ...prev, status: 'failed', paused: false, cancelled: true, error: 'Cancelled by user' } : prev);
                setJobStatusMessage('Job cancelled.');
            }
        } catch (error) {
            setToastMessage(error instanceof Error ? error.message : 'Failed to stop job');
            setToastVisible(true);
        } finally {
            setStoppingJob(false);
        }
    };

    const handlePauseResumeJob = async () => {
        if (!user || !jobState?.id || !clientId) return;
        
        const isPaused = jobState.paused === true;
        const endpoint = isPaused ? 'resume' : 'pause';
        
        setPausingJob(true);
        try {
            const idToken = await getIdToken(user);
            const resp = await fetchWithRetry(`${getPipelineBaseUrl()}/api/jobs/${jobState.id}/${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ idToken, clientId })
            });
            if (!resp.ok) {
                const data = await resp.json().catch(() => ({}));
                throw new Error(data.error || `Failed to ${endpoint} job (${resp.status})`);
            }
            setJobState((prev) => prev ? { ...prev, paused: !isPaused } : prev);
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

    const handleOpenSegmentModal = (segment?: Segment) => {
        if (segment) {
            setEditingSegment(segment);
            setSegmentName(segment.name);
            setSegmentDescription(segment.description || "");
            setSegmentFullName(segment.filters.fullName || "");
            setSegmentFounder(segment.filters.founder || '');
            setSegmentEmail(segment.filters.email || '');
            setSegmentEmailStatus(segment.filters.emailStatus || []);
            setSegmentCreatedAfter(segment.filters.createdAfter || "");
            setSegmentCreatedBefore(segment.filters.createdBefore || "");
        } else {
            setEditingSegment(null);
            setSegmentName("");
            setSegmentDescription("");
            setSegmentFullName("");
            setSegmentFounder('');
            setSegmentEmail('');
            setSegmentEmailStatus([]);
            setSegmentCreatedAfter("");
            setSegmentCreatedBefore("");
        }
        setSegmentModalOpen(true);
    };

    const handleSaveSegment = async () => {
        if (!user || !clientId || !segmentName.trim()) {
            setToastMessage('Segment name is required');
            setToastVisible(true);
            return;
        }

        setSavingSegment(true);
        try {
            const segmentData = {
                name: segmentName.trim(),
                description: segmentDescription.trim(),
                filters: {
                    ...(segmentFullName && { fullName: segmentFullName }),
                    ...(segmentFounder && { founder: segmentFounder }),
                    ...(segmentEmail && { email: segmentEmail }),
                    ...(segmentEmailStatus.length > 0 && { emailStatus: segmentEmailStatus }),
                    ...(segmentCreatedAfter && { createdAfter: segmentCreatedAfter }),
                    ...(segmentCreatedBefore && { createdBefore: segmentCreatedBefore }),
                },
                updatedAt: serverTimestamp(),
                ...(editingSegment ? {} : { createdAt: serverTimestamp() })
            };

            const segmentId = editingSegment?.id || Date.now().toString();
            const segmentRef = doc(firestore, "users", user.uid, "clients", clientId, "segments", segmentId);
            await setDoc(segmentRef, segmentData, { merge: true });

            setToastMessage(editingSegment ? 'Segment updated' : 'Segment created');
            setToastVisible(true);
            setSegmentModalOpen(false);
        } catch (error) {
            setToastMessage(error instanceof Error ? error.message : 'Failed to save segment');
            setToastVisible(true);
        } finally {
            setSavingSegment(false);
        }
    };

    const handleDeleteSegment = async (segmentId: string) => {
        if (!user || !clientId) return;
        const confirmDelete = window.confirm("Delete this segment?");
        if (!confirmDelete) return;

        setDeletingSegmentId(segmentId);
        try {
            // Remove from Firestore entirely
            const segmentRef = doc(firestore, "users", user.uid, "clients", clientId, "segments", segmentId);
            await deleteDoc(segmentRef);
            
            setToastMessage('Segment deleted');
            setToastVisible(true);
            if (selectedSegmentId === segmentId) {
                setSelectedSegmentId("");
                setSegmentLeads([]);
            }
        } catch (error) {
            setToastMessage(error instanceof Error ? error.message : 'Failed to delete segment');
            setToastVisible(true);
        } finally {
            setDeletingSegmentId(null);
        }
    };

    const handleDownloadSegmentCSV = async (segmentId: string) => {
        const segment = segments.find(s => s.id === segmentId);
        if (!user || !clientId || !segment) return;

        setDownloadingSegmentId(segmentId);
        try {
            const idToken = await getIdToken(user);
            const params = new URLSearchParams();
            params.append('clientId', clientId);
            params.append('limit', '500');

            // Apply segment filters
            if (segment.filters.fullName) params.append('fullName', segment.filters.fullName);
            if (segment.filters.founder === 'exists') params.append('founderFilter', 'exists');
            else if (segment.filters.founder === 'not_found') params.append('founderFilter', 'not_found');
            if (segment.filters.email === 'found') params.append('emailFilter', 'exists');
            else if (segment.filters.email === 'not_found') params.append('emailFilter', 'not_found');
            else if (segment.filters.email === 'not_run') params.append('emailFilter', 'not_run');
            if (segment.filters.emailStatus && segment.filters.emailStatus.length > 0) {
                params.append('emailStatusMulti', segment.filters.emailStatus.join(','));
            }
            if (segment.filters.createdAfter) params.append('createdAfter', segment.filters.createdAfter);
            if (segment.filters.createdBefore) params.append('createdBefore', segment.filters.createdBefore);

            // Fetch all leads for this segment
            const response = await fetchWithRetry(`${getPipelineBaseUrl()}/api/leads?${params.toString()}`, {
                headers: { 'Authorization': `Bearer ${idToken}` }
            });

            if (!response.ok) {
                throw new Error(`Failed to fetch segment leads: ${response.statusText}`);
            }

            const data = await response.json();
            const leads: Lead[] = data.leads.map((row: any) => ({
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

            // Generate CSV
            const headers = ['Founder Name', 'Email', 'Status', 'Domain', 'First Line', 'Personalization URL', 'Personalization Title', 'Created At'];
            const csvRows = [headers.join(',')];

            leads.forEach((lead) => {
                const row = [
                    lead.founderName || '',
                    lead.email || '',
                    lead.status || '',
                    lead.domain || '',
                    (lead.firstLine || '').replace(/"/g, '""'),
                    lead.personalizationUrl || '',
                    (lead.personalizationTitle || '').replace(/"/g, '""'),
                    lead.updatedAt || ''
                ];
                csvRows.push(row.map(val => `"${val}"`).join(','));
            });

            const csvContent = csvRows.join('\n');
            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
            const link = document.createElement('a');
            const url = URL.createObjectURL(blob);
            link.setAttribute('href', url);
            link.setAttribute('download', `${segment.name.replace(/[^a-z0-9]/gi, '_')}_${new Date().toISOString().split('T')[0]}.csv`);
            link.style.visibility = 'hidden';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);

            setToastMessage(`Downloaded ${leads.length} leads`);
            setToastVisible(true);
        } catch (error) {
            console.error('CSV download failed:', error);
            setToastMessage(error instanceof Error ? error.message : 'Failed to download CSV');
            setToastVisible(true);
        } finally {
            setDownloadingSegmentId(null);
        }
    };

    const handleLoadSegmentLeads = async (segmentId: string) => {
        const segment = segments.find(s => s.id === segmentId);
        if (!user || !clientId || !segment) return;

        setSelectedSegmentId(segmentId);
        setSegmentLeadsLoading(true);
        setSegmentLeads([]);

        try {
            const idToken = await getIdToken(user);
            const params = new URLSearchParams();
            params.append('clientId', clientId);
            params.append('limit', '500');

            // Apply segment filters
            if (segment.filters.fullName) {
                params.append('fullName', segment.filters.fullName);
            }
            if (segment.filters.email === 'found') {
                params.append('emailFilter', 'exists');
            } else if (segment.filters.email === 'not_found') {
                params.append('emailFilter', 'not_found');
            } else if (segment.filters.email === 'not_run') {
                params.append('emailFilter', 'not_run');
            }
            if (segment.filters.emailStatus && segment.filters.emailStatus.length > 0) {
                params.append('emailStatusMulti', segment.filters.emailStatus.join(','));
            }
            if (segment.filters.createdAfter) {
                params.append('createdAfter', segment.filters.createdAfter);
            }
            if (segment.filters.createdBefore) {
                params.append('createdBefore', segment.filters.createdBefore);
            }

            const response = await fetchWithRetry(`${getPipelineBaseUrl()}/api/leads?${params.toString()}`, {
                headers: {
                    'Authorization': `Bearer ${idToken}`
                }
            });
            
            if (!response.ok) {
                throw new Error(`Failed to fetch segment leads: ${response.statusText}`);
            }

            const data = await response.json();
            const mapped: Lead[] = data.leads.map((row: any) => ({
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
                jobId: row.jobId || "",
                campaigns: row.campaigns || []
            }));

            setSegmentLeads(mapped);
        } catch (error) {
            console.error('Failed to fetch segment leads:', error);
            setToastMessage(error instanceof Error ? error.message : 'Failed to load segment leads');
            setToastVisible(true);
        } finally {
            setSegmentLeadsLoading(false);
        }
    };

    const handleDeleteClient = async () => {
        if (!user || !clientId) return;
        const confirmed = window.confirm("Delete this client? This removes the client record and related leads.");
        if (!confirmed) return;

        setIsDeletingClient(true);
        try {
            const idToken = await getIdToken(user);
            const resp = await fetchWithRetry(`/api/clients/${encodeURIComponent(clientId)}/delete`, {
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
            const response = await fetchWithRetry(`${getPipelineBaseUrl()}/api/jobs/${currentJobId}/csv-preview`, {
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

        // Require email mapping to a column (non-custom)
        const emailMapping = columnMapping.email;
        if (!emailMapping || !emailMapping.column || emailMapping.isCustom) {
            alert('Please map Email to a CSV column.');
            return;
        }

        try {
            setUploading(true);
            // Build separate payloads: standard mappings and custom variables
            const customVariablesPayload = Object.entries(columnMapping)
                .filter(([_, v]) => v?.isCustom && v.customName && v.column)
                .map(([_, v]) => ({ name: v.customName!.trim(), column: v.column }));

            const standardMapping = Object.entries(columnMapping).reduce((acc, [key, val]) => {
                if (!val || val.isCustom) return acc;
                acc[key] = { column: val.column, isCustom: false };
                return acc;
            }, {} as Record<string, { column: string; isCustom: boolean }>);

            const idToken = await getIdToken(user);
            const response = await fetchWithRetry(`${getPipelineBaseUrl()}/api/jobs/${currentJobId}/upload-to-instantly`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    idToken,
                    clientId,
                    campaignId: selectedCampaignId,
                    columnMapping: standardMapping,
                    customVariables: customVariablesPayload,
                    skipOptions: {
                        skip_if_in_workspace: skipWorkspaceDupes,
                        skip_if_in_campaign: skipCampaignDupes,
                        skip_if_in_list: skipListDupes
                    }
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
            const resp = await fetchWithRetry(`${getPipelineBaseUrl()}/api/jobs/${encodeURIComponent(jobId)}/delete`, {
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

    // Manual upload handlers
    const fetchSqlCampaignList = async () => {
        const token = await user?.getIdToken();
        const campaignsResponse = await fetch(
            `${getPipelineBaseUrl()}/api/clients/${clientId}/campaigns/list?agencyId=${user?.uid}`,
            { headers: { Authorization: `Bearer ${token}` } }
        );

        if (!campaignsResponse.ok) {
            throw new Error(`Failed to fetch campaigns: ${campaignsResponse.status}`);
        }

        const campaignsData = await campaignsResponse.json();
        return (campaignsData.campaigns || []) as Campaign[];
    };

    const handleOpenInstantlyCsvImportModal = async () => {
        setShowInstantlyCsvImportModal(true);
        setInstantlyCsvImportFile(null);
        setInstantlyCsvImportNotes('');
        setInstantlyCsvImportResult(null);
        setInstantlyCsvCampaignOverrides({});
        setInstantlyCsvCampaignsLoading(true);

        try {
            const campaigns = await fetchSqlCampaignList();
            setInstantlyCsvOverrideCampaigns(campaigns);
        } catch (error) {
            console.error('Error loading campaigns for Instantly CSV import:', error);
            setToastMessage('Failed to load campaigns for manual override');
            setToastVisible(true);
        } finally {
            setInstantlyCsvCampaignsLoading(false);
        }
    };

    const fetchQualifiedCount = async (jobId: string) => {
        try {
            const token = await user?.getIdToken();
            const response = await fetch(
                `${getPipelineBaseUrl()}/api/jobs/${jobId}/qualified-count?clientId=${clientId}&agencyId=${user?.uid}`,
                { headers: { Authorization: `Bearer ${token}` } }
            );
            const data = await response.json();
            return data;
        } catch (error) {
            console.error('Error fetching qualified count:', error);
            return { qualifiedCount: 0, totalCount: 0 };
        }
    };

    const handleOpenManualUpload = async (job: any) => {
        setSelectedJobForManual(job);
        setShowManualUploadModal(true);
        setManualUploadLoading(true);
        
        try {
            const campaigns = await fetchSqlCampaignList();
            setManualUploadCampaigns(campaigns);
            
            const countData = await fetchQualifiedCount(job.id);
            setQualifiedContactsCount(countData);
            
        } catch (error) {
            console.error('Error loading manual upload data:', error);
            setToastMessage('Failed to load campaigns. Please try again.');
            setToastVisible(true);
        } finally {
            setManualUploadLoading(false);
        }
    };

    const handleConfirmManualUpload = async () => {
        if (!selectedManualCampaign) {
            setToastMessage('Please select a campaign');
            setToastVisible(true);
            return;
        }
        
        if (!qualifiedContactsCount) {
            setToastMessage('No qualified contacts to mark');
            setToastVisible(true);
            return;
        }

        try {
            setManualUploadLoading(true);
            const token = await user?.getIdToken();
            
            const response = await fetch(
                `${getPipelineBaseUrl()}/api/jobs/${selectedJobForManual.id}/mark-manual-upload`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${token}`
                    },
                    body: JSON.stringify({
                        idToken: token,
                        campaignId: selectedManualCampaign,
                        notes: manualUploadNotes,
                        clientId
                    })
                }
            );

            const data = await response.json();
            
            if (data.success) {
                setToastMessage(`✅ Marked ${data.contactCount} contacts as uploaded to ${data.campaignName}`);
                setToastVisible(true);
                setShowManualUploadModal(false);
                setSelectedManualCampaign('');
                setManualUploadNotes('');
                setQualifiedContactsCount(null);
                fetchJobsUploadStatus();
            } else {
                setToastMessage(`❌ ${data.error || 'Failed to mark manual upload'}`);
                setToastVisible(true);
            }
        } catch (error) {
            console.error('Error marking manual upload:', error);
            setToastMessage('❌ Failed to mark manual upload');
            setToastVisible(true);
        } finally {
            setManualUploadLoading(false);
        }
    };

    const handleRevertManualUpload = async (jobId: string, campaignId: string, campaignName: string) => {
        if (!confirm(`Are you sure you want to revert the manual upload to "${campaignName}"?`)) {
            return;
        }

        try {
            const token = await user?.getIdToken();
            
            const response = await fetch(
                `${getPipelineBaseUrl()}/api/jobs/${jobId}/revert-manual-upload`,
                {
                    method: 'DELETE',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${token}`
                    },
                    body: JSON.stringify({
                        idToken: token,
                        campaignId,
                        clientId
                    })
                }
            );

            const data = await response.json();
            
            if (data.success) {
                setToastMessage(`✅ Reverted ${data.removedCount} manual uploads from ${campaignName}`);
                setToastVisible(true);
                fetchJobsUploadStatus();
            } else {
                setToastMessage(`❌ ${data.error || 'Failed to revert'}`);
                setToastVisible(true);
            }
        } catch (error) {
            console.error('Error reverting manual upload:', error);
            setToastMessage('❌ Failed to revert manual upload');
            setToastVisible(true);
        }
    };

    const handleSubmitInstantlyCsvMergeImport = async () => {
        if (!user || !clientId) return;
        if (!instantlyCsvImportFile) {
            setToastMessage('Please choose a CSV file to import');
            setToastVisible(true);
            return;
        }

        try {
            setInstantlyCsvImportLoading(true);
            const idToken = await getIdToken(user);
            const formData = new FormData();
            formData.append('idToken', idToken);
            formData.append('file', instantlyCsvImportFile);
            if (instantlyCsvImportNotes.trim()) {
                formData.append('notes', instantlyCsvImportNotes.trim());
            }
            const selectedOverrides = Object.entries(instantlyCsvCampaignOverrides).reduce((acc, [campaignName, sqlCampaignId]) => {
                const name = campaignName.trim();
                const id = sqlCampaignId.trim();
                if (!name || !id) return acc;
                acc[name] = id;
                return acc;
            }, {} as Record<string, string>);
            if (Object.keys(selectedOverrides).length > 0) {
                formData.append('campaignNameOverrides', JSON.stringify(selectedOverrides));
            }

            const response = await fetchWithRetry(
                `${getPipelineBaseUrl()}/api/clients/${encodeURIComponent(clientId)}/instantly-import/merge`,
                {
                    method: 'POST',
                    body: formData
                }
            );

            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(data?.error || `Import failed (${response.status})`);
            }

            setInstantlyCsvImportResult(data as InstantlyCsvMergeResult);
            setToastMessage(`Imported CSV: ${data?.summary?.linksInserted ?? 0} campaign links added`);
            setToastVisible(true);
            fetchLeads(true);
        } catch (error) {
            console.error('Error importing Instantly CSV merge:', error);
            setToastMessage(error instanceof Error ? error.message : 'Failed to import Instantly CSV');
            setToastVisible(true);
        } finally {
            setInstantlyCsvImportLoading(false);
        }
    };

    const handleDownloadJobCsv = async (jobId: string, scope: 'all' | 'valid' = 'valid') => {
        try {
            const url = `${getPipelineBaseUrl()}/api/jobs/${jobId}/result?scope=${scope}`;
            const link = document.createElement('a');
            link.href = url;
            link.download = `job-${jobId}-${scope}.csv`;
            link.style.display = 'none';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            
            setToastMessage('Downloading CSV...');
            setToastVisible(true);
        } catch (error) {
            console.error('Failed to download CSV:', error);
            setToastMessage('Failed to download CSV');
            setToastVisible(true);
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
                            className={`tab-nav__button ${activeTab === "segments" ? "tab-nav__button--active" : ""}`}
                            onClick={() => setActiveTab("segments")}
                        >
                            Segments
                        </button>
                        <button
                            className={`tab-nav__button ${activeTab === "personalizer" ? "tab-nav__button--active" : ""}`}
                            onClick={() => setActiveTab("personalizer")}
                        >
                            🧠 Personalizer
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
                                            setRunDomainCheck(true);
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

                            {/* Pipeline Panel */}
                            {pipelineVisible && jobState && (
                                <div style={{ 
                                    marginTop: '2rem',
                                    background: 'rgba(255, 255, 255, 0.03)',
                                    border: '1px solid rgba(255, 255, 255, 0.08)',
                                    borderRadius: '16px',
                                    padding: '2rem',
                                    position: 'relative'
                                }}>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            userDeselectedRef.current = true;
                                            setSelectedJobId(null);
                                            setJobState(null);
                                            closeJobStream();
                                        }}
                                        aria-label="Deselect job"
                                        style={{
                                            position: 'absolute',
                                            top: '1rem',
                                            right: '1rem',
                                            background: 'rgba(255, 255, 255, 0.05)',
                                            border: '1px solid rgba(255, 255, 255, 0.1)',
                                            borderRadius: '8px',
                                            width: '32px',
                                            height: '32px',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            cursor: 'pointer',
                                            color: 'rgba(255, 255, 255, 0.6)',
                                            fontSize: '1.25rem',
                                            transition: 'all 0.2s ease',
                                            padding: 0
                                        }}
                                        onMouseEnter={(e) => {
                                            e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)';
                                            e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.2)';
                                            e.currentTarget.style.color = 'rgba(255, 255, 255, 0.9)';
                                        }}
                                        onMouseLeave={(e) => {
                                            e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)';
                                            e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)';
                                            e.currentTarget.style.color = 'rgba(255, 255, 255, 0.6)';
                                        }}
                                    >
                                        ×
                                    </button>
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
                                                Valid leads: {validLeadsCompleted.toLocaleString()} · Job ID: {jobState.id}
                                            </p>
                                        )}
                                        {jobState && (
                                            <div className="pipeline-status-row">
                                                <p className="pipeline-panel__subtitle pipeline-panel__subtitle--status">
                                                    Viewing job: {jobState.fileName || jobState.id} · {jobState.paused ? 'Paused' : JOB_STATUS_LABELS[jobState.status]}
                                                </p>
                                                {(jobState.status === 'running' || jobState.status === 'queued' || jobState.paused) && (
                                                    <div style={{ display: 'flex', gap: '0.5rem', marginLeft: 'auto' }}>
                                                        {(jobState.status === 'running' || jobState.paused) && (
                                                            <button
                                                                type="button"
                                                                className="primary-button"
                                                                onClick={handlePauseResumeJob}
                                                                disabled={pausingJob}
                                                                style={{ 
                                                                    minWidth: '120px',
                                                                    display: 'flex',
                                                                    alignItems: 'center',
                                                                    justifyContent: 'center',
                                                                    gap: '0.5rem'
                                                                }}
                                                            >
                                                                {pausingJob ? (
                                                                    jobState.paused ? 'Resuming...' : 'Pausing...'
                                                                ) : (
                                                                    <>
                                                                        {jobState.paused ? (
                                                                            <>
                                                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="black" stroke="none">
                                                                                    <polygon points="5 3 19 12 5 21 5 3"/>
                                                                                </svg>
                                                                                Resume
                                                                            </>
                                                                        ) : (
                                                                            <>
                                                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="black" stroke="none">
                                                                                    <rect x="6" y="4" width="4" height="16"/>
                                                                                    <rect x="14" y="4" width="4" height="16"/>
                                                                                </svg>
                                                                                Pause
                                                                            </>
                                                                        )}
                                                                    </>
                                                                )}
                                                            </button>
                                                        )}
                                                        <button
                                                            type="button"
                                                            className="destructive-button"
                                                            onClick={handleStopJob}
                                                            disabled={stoppingJob}
                                                            style={{ minWidth: '100px' }}
                                                        >
                                                            {stoppingJob
                                                                ? (jobState.paused ? 'Cancelling...' : 'Stopping...')
                                                                : (jobState.paused ? 'Cancel run' : 'Stop run')}
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
                                    {(jobState?.status === 'completed' || canUploadToInstantly) && (
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
                                            const dedupedTotal = deriveDedupedDomainBaseline(jobState);
                                            const foundersProcessedRaw = deriveStageTotals(jobState.stages.founders).total ?? 0;
                                            const foundersProcessed = foundersProcessedRaw > 0 ? foundersProcessedRaw : (dedupedTotal ?? 0);
                                            const foundersFoundDisplay = foundersProcessed > 0 ? Math.min(foundersFound, foundersProcessed) : foundersFound;
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
                                                    <span style={{ fontWeight: '600' }}>{foundersFoundDisplay.toLocaleString()}</span>
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
                                            
                                            if (stageKey === "domainPrep") {
                                                const domainCheckSkipped = summary?.domainCheckSkipped === true;
                                                const checked = (summary?.checked as number) ?? (summary?.normalized as number) ?? total ?? 0;
                                                const live = (summary?.live as number) ?? 0;
                                                const dead = (summary?.dead as number) ?? 0;
                                                const unknown = (summary?.unknown as number) ?? 0;
                                                const processable = (summary?.processable as number) ?? throughputNum ?? live;
                                                heroNumber = processable;
                                                heroLabel = "Processable";
                                                subtext = domainCheckSkipped
                                                    ? `${processable.toLocaleString()} processable • domain check skipped`
                                                    : checked > 0
                                                    ? `${checked.toLocaleString()} checked • ${live.toLocaleString()} live • ${dead.toLocaleString()} dead${unknown > 0 ? ` • ${unknown.toLocaleString()} unknown` : ""}`
                                                    : "Awaiting...";
                                            } else if (stageKey === "founders") {
                                                const dedupedTotal = deriveDedupedDomainBaseline(jobState);
                                                const processedRaw = total ?? 0;
                                                const processed = processedRaw > 0 ? processedRaw : (dedupedTotal ?? 0);
                                                const found = processed > 0 ? Math.min(throughputNum ?? 0, processed) : (throughputNum ?? 0);
                                                const cost = summary?.cost || stats?.cost;
                                                heroNumber = found;
                                                heroLabel = "Found";
                                                subtext = processed > 0 ? `${processed.toLocaleString()} processed • ${((found / processed) * 100).toFixed(0)}% yield` : "Awaiting...";
                                                if (typeof cost === "number") costFooter = `Cost $${cost.toFixed(2)}`;
                                            } else if (stageKey === "emailDiscovery") {
                                                const found = (summary?.Found as number) ?? (summary?.found as number) ?? throughputNum ?? 0;
                                                const attempted = typeof stage?.progress?.processed === "number"
                                                    ? stage.progress.processed
                                                    : total ?? 0;
                                                heroNumber = found;
                                                heroLabel = "Emails Found";
                                                subtext = attempted > 0 ? `${attempted.toLocaleString()} checked • ${((found / attempted) * 100).toFixed(1)}% hit rate` : "Awaiting...";
                                            } else if (stageKey === "verification") {
                                                const safe = (summary?.Valid as number) ?? (summary?.valid as number) ?? 0;
                                                const risky = (summary?.["Valid-Risky"] as number) ?? (summary?.["valid-risky"] as number) ?? 0;
                                                const verified = total ?? 0;
                                                heroNumber = verified;
                                                heroLabel = "Verfified";
                                                const riskyText = risky > 0 ? ` • ${risky} Risky` : "";
                                                subtext = safe > 0 ? `${safe.toLocaleString()} safe${riskyText}` : "Awaiting...";
                                            } else if (stageKey === "personalization") {
                                                const personalized = (summary?.Personalized as number) ?? (summary?.personalized as number) ?? (stats?.personalized as number) ?? throughputNum ?? 0;
                                                const candidates = total ?? 0;
                                                const failed = (summary?.failed as number) ?? (stats?.failed as number) ?? 0;
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
                                                    
                                                    {stage?.error === 'Add Credits to TryKitt' ? (
                                                        <div style={{
                                                            marginTop: '0.75rem',
                                                            padding: '1rem',
                                                            background: 'rgba(239, 68, 68, 0.15)',
                                                            border: '1px solid rgba(239, 68, 68, 0.5)',
                                                            borderRadius: '8px',
                                                            color: '#ef4444',
                                                            fontWeight: 600,
                                                            fontSize: '0.95rem',
                                                            textAlign: 'center'
                                                        }}>
                                                            ⚠️ Add Credits to TryKitt
                                                        </div>
                                                    ) : stage?.error ? (
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
                                </div>
                            )}

                            {!pipelineVisible && jobState && (
                                <div style={{ marginTop: '2rem', textAlign: 'center' }}>
                                    <button
                                        type="button"
                                        onClick={() => setPipelineVisible(true)}
                                        className="secondary-button secondary-button--active"
                                        style={{
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            gap: '0.5rem'
                                        }}
                                    >
                                        <span>Show Pipeline</span>
                                        <span style={{ fontSize: '0.75rem', opacity: 0.7 }}>({jobState.fileName || jobState.id})</span>
                                    </button>
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
                                                const isExpanded = expandedErrorJobId === job.id;
                                                
                                                // Calculate metrics
                                                const totalProcessed = job.dedupeStats?.total
                                                    || job.stages?.verification?.progress?.total
                                                    || job.stages?.founders?.progress?.total
                                                    || 0;
                                                const validLeads = (job.stages?.verification?.summary as any)?.valid
                                                    || (job.stages?.verification?.summary as any)?.Valid
                                                    || (job.stages?.emailDiscovery?.summary as any)?.found
                                                    || (job.stages?.emailDiscovery?.summary as any)?.Found
                                                    || 0;
                                                const invalidLeads = totalProcessed - validLeads;
                                                
                                                // Calculate progress for running jobs
                                                const progress = calculateJobProgress(job);
                                                
                                                return (
                                                    <div key={job.id}>
                                                        <div
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
                                                                display: 'flex',
                                                                flexDirection: 'column',
                                                                padding: '1.25rem',
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
                                                            {/* Top row: Filename + Badge */}
                                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
                                                                <div style={{ flex: 1, minWidth: 0 }}>
                                                                    <p style={{
                                                                        margin: 0,
                                                                        fontWeight: 700,
                                                                        color: '#ffffff',
                                                                        fontSize: '1.05rem',
                                                                        overflow: 'hidden',
                                                                        textOverflow: 'ellipsis',
                                                                        whiteSpace: 'nowrap'
                                                                    }}>{job.fileName || job.id}</p>
                                                                    <p style={{
                                                                        margin: '0.4rem 0 0',
                                                                        fontSize: '0.8rem',
                                                                        color: 'rgba(255, 255, 255, 0.55)'
                                                                    }}>Started {formatJobDate(job.createdAt)}</p>
                                                                </div>
                                                                
                                                                {/* Lifecycle badge */}
                                                                <span style={{
                                                                    display: 'inline-flex',
                                                                    alignItems: 'center',
                                                                    justifyContent: 'center',
                                                                    padding: '0.4rem 0.9rem',
                                                                    borderRadius: '999px',
                                                                    fontSize: '0.75rem',
                                                                    fontWeight: 700,
                                                                    letterSpacing: '0.04em',
                                                                    textTransform: 'uppercase',
                                                                    background: `${statusColor}22`,
                                                                    color: statusColor,
                                                                    border: `1.5px solid ${statusColor}`,
                                                                    flexShrink: 0
                                                                }}>{JOB_STATUS_LABELS[job.status]}</span>
                                                            </div>

                                                            {/* Progress bar for running jobs */}
                                                            {job.status === 'running' && progress.total > 0 && (
                                                                <div style={{ marginTop: '1rem' }}>
                                                                    <div style={{
                                                                        display: 'flex',
                                                                        justifyContent: 'space-between',
                                                                        alignItems: 'baseline',
                                                                        marginBottom: '0.4rem'
                                                                    }}>
                                                                        <span style={{ fontSize: '0.8rem', color: 'rgba(255, 255, 255, 0.7)' }}>
                                                                            Processing: {progress.processed.toLocaleString()} / {progress.total.toLocaleString()} rows
                                                                        </span>
                                                                        <span style={{ fontSize: '0.85rem', fontWeight: 600, color: statusColor }}>
                                                                            {progress.percent}%
                                                                        </span>
                                                                    </div>
                                                                    <div style={{
                                                                        width: '100%',
                                                                        height: '6px',
                                                                        background: 'rgba(255, 255, 255, 0.1)',
                                                                        borderRadius: '999px',
                                                                        overflow: 'hidden'
                                                                    }}>
                                                                        <div style={{
                                                                            width: `${progress.percent}%`,
                                                                            height: '100%',
                                                                            background: statusColor,
                                                                            transition: 'width 0.3s ease'
                                                                        }}/>
                                                                    </div>
                                                                </div>
                                                            )}

                                                            {/* Pipeline Stages - Show when selected */}
                                                            {isSelected && (
                                                                <div style={{
                                                                    marginTop: '1.5rem',
                                                                    paddingTop: '1.5rem',
                                                                    borderTop: '1px solid rgba(255, 255, 255, 0.1)'
                                                                }}>
                                                                    <p style={{
                                                                        margin: '0 0 1rem 0',
                                                                        fontSize: '0.7rem',
                                                                        textTransform: 'uppercase',
                                                                        letterSpacing: '0.05em',
                                                                        color: 'rgba(255, 255, 255, 0.5)',
                                                                        fontWeight: 600
                                                                    }}>Live Pipeline</p>
                                                                    
                                                                    {/* Pipeline flow summary */}
                                                                    {(() => {
                                                                        const foundersFound = deriveStageTotals(job.stages.founders).throughputNum ?? 0;
                                                                        const dedupedTotal = deriveDedupedDomainBaseline(job);
                                                                        const foundersProcessedRaw = deriveStageTotals(job.stages.founders).total ?? 0;
                                                                        const foundersProcessed = foundersProcessedRaw > 0 ? foundersProcessedRaw : (dedupedTotal ?? 0);
                                                                        const emailsFound = (job.stages.emailDiscovery?.summary as any)?.Found ?? (job.stages.emailDiscovery?.summary as any)?.found ?? deriveStageTotals(job.stages.emailDiscovery).throughputNum ?? 0;
                                                                        const safe = (job.stages.verification?.summary as any)?.Valid ?? (job.stages.verification?.summary as any)?.valid ?? 0;
                                                                        const personalized = (job.stages.personalization?.summary as any)?.Personalized ?? (job.stages.personalization?.summary as any)?.personalized ?? (job.stages.personalization?.progress?.stats as any)?.personalized ?? 0;
                                                                        
                                                                        return (
                                                                            <div style={{ 
                                                                                display: 'flex', 
                                                                                alignItems: 'center', 
                                                                                gap: '0.75rem',
                                                                                padding: '0.75rem 1rem',
                                                                                background: 'rgba(255, 255, 255, 0.03)',
                                                                                borderRadius: '8px',
                                                                                border: '1px solid rgba(255, 255, 255, 0.08)',
                                                                                marginBottom: '1rem',
                                                                                fontSize: '0.8rem',
                                                                                fontVariantNumeric: 'tabular-nums',
                                                                                flexWrap: 'wrap'
                                                                            }}>
                                                                                <span style={{ opacity: 0.5, fontSize: '0.7rem' }}>Flow:</span>
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
                                                                    
                                                                    <div className="stage-grid" style={{ gap: '0.75rem' }}>
                                                                        {[...STAGE_ORDER].map((stageKey) => {
                                                                            const stage = job.stages[stageKey];
                                                                            const meta = STAGE_METADATA[stageKey];
                                                                            const { throughputNum, total } = deriveStageTotals(stage);
                                                                            const summary = stage?.summary as Record<string, unknown> | null;
                                                                            const stats = stage?.progress?.stats as Record<string, unknown> | undefined;
                                                                            
                                                                            // Simplified metrics based on stage type
                                                                            let heroNumber = null;
                                                                            let heroLabel = "";
                                                                            let subtext = "";
                                                                            let costFooter = "";
                                                                            
                                                                            if (stageKey === "domainPrep") {
                                                                                const domainCheckSkipped = summary?.domainCheckSkipped === true;
                                                                                const checked = (summary?.checked as number) ?? (summary?.normalized as number) ?? total ?? 0;
                                                                                const live = (summary?.live as number) ?? 0;
                                                                                const dead = (summary?.dead as number) ?? 0;
                                                                                const unknown = (summary?.unknown as number) ?? 0;
                                                                                const processable = (summary?.processable as number) ?? throughputNum ?? live;
                                                                                heroNumber = processable;
                                                                                heroLabel = "Processable";
                                                                                subtext = domainCheckSkipped
                                                                                    ? `${processable.toLocaleString()} processable • domain check skipped`
                                                                                    : checked > 0
                                                                                    ? `${checked.toLocaleString()} checked • ${live.toLocaleString()} live • ${dead.toLocaleString()} dead${unknown > 0 ? ` • ${unknown.toLocaleString()} unknown` : ""}`
                                                                                    : "Awaiting...";
                                                                            } else if (stageKey === "founders") {
                                                                                const dedupedTotal = deriveDedupedDomainBaseline(job);
                                                                                const processedRaw = total ?? 0;
                                                                                const processed = processedRaw > 0 ? processedRaw : (dedupedTotal ?? 0);
                                                                                const found = processed > 0 ? Math.min(throughputNum ?? 0, processed) : (throughputNum ?? 0);
                                                                                const cost = summary?.cost || stats?.cost;
                                                                                heroNumber = found;
                                                                                heroLabel = "Found";
                                                                                subtext = processed > 0 ? `${processed.toLocaleString()} processed • ${((found / processed) * 100).toFixed(0)}% yield` : "Awaiting...";
                                                                                if (typeof cost === "number") costFooter = `Cost $${cost.toFixed(2)}`;
                                                                            } else if (stageKey === "emailDiscovery") {
                                                                                const found = (summary?.Found as number) ?? (summary?.found as number) ?? throughputNum ?? 0;
                                                                                const dedupedTotal = (job?.dedupeStats?.new ?? job?.dedupeStats?.total ?? null);
                                                                                const attemptedRaw = typeof stage?.progress?.processed === "number"
                                                                                    ? stage.progress.processed
                                                                                    : total ?? 0;
                                                                                const attempted = dedupedTotal ?? attemptedRaw;
                                                                                heroNumber = found;
                                                                                heroLabel = "Emails Found";
                                                                                subtext = attempted > 0 ? `${attempted.toLocaleString()} checked • ${((found / attempted) * 100).toFixed(1)}% hit rate` : "Awaiting...";
                                                                            } else if (stageKey === "verification") {
                                                                                const safe = (summary?.Valid as number) ?? (summary?.valid as number) ?? 0;
                                                                                const risky = (summary?.["Valid-Risky"] as number) ?? (summary?.["valid-risky"] as number) ?? 0;
                                                                                const verified = total ?? 0;
                                                                                heroNumber = safe;
                                                                                heroLabel = "Safe";
                                                                                const riskyText = risky > 0 ? ` • ${risky} Risky` : "";
                                                                                subtext = verified > 0 ? `${verified.toLocaleString()} verified${riskyText}` : "Awaiting...";
                                                                            } else if (stageKey === "personalization") {
                                                                                const personalized = (summary?.Personalized as number) ?? (summary?.personalized as number) ?? (stats?.personalized as number) ?? throughputNum ?? 0;
                                                                                const candidates = total ?? 0;
                                                                                const failed = (summary?.failed as number) ?? (stats?.failed as number) ?? 0;
                                                                                heroNumber = personalized;
                                                                                heroLabel = "Ready";
                                                                                subtext = candidates > 0 ? `${candidates.toLocaleString()} total` : "Awaiting...";
                                                                                if (failed > 0) subtext += ` • ${failed} failed`;
                                                                            }
                                                                            
                                                                            return (
                                                                                <article
                                                                                    key={stageKey}
                                                                                    className={`stage-card stage-card--${stage?.status ?? "pending"} ${stage?.status === "running" ? "stage-card--running" : ""}`}
                                                                                    style={{ padding: '0.875rem' }}
                                                                                >
                                                                                    <div className="stage-card__head">
                                                                                        <div>
                                                                                            <p className="stage-card__label" style={{ fontSize: '0.8rem' }}>{meta.title}</p>
                                                                                        </div>
                                                                                        <span className="stage-card__status" style={{ fontSize: '0.65rem' }}>{formatStageStatus(stage?.status)}</span>
                                                                                    </div>
                                                                                    
                                                                                    {stage?.error === 'Add Credits to TryKitt' ? (
                                                                                        <div style={{
                                                                                            marginTop: '0.5rem',
                                                                                            padding: '0.75rem',
                                                                                            background: 'rgba(239, 68, 68, 0.15)',
                                                                                            border: '1px solid rgba(239, 68, 68, 0.5)',
                                                                                            borderRadius: '8px',
                                                                                            color: '#ef4444',
                                                                                            fontWeight: 600,
                                                                                            fontSize: '0.75rem',
                                                                                            textAlign: 'center'
                                                                                        }}>
                                                                                            ⚠️ Add Credits to TryKitt
                                                                                        </div>
                                                                                    ) : stage?.error ? (
                                                                                        <p className="stage-card__error" style={{ fontSize: '0.75rem' }}>{stage.error}</p>
                                                                                    ) : heroNumber !== null ? (
                                                                                        <>
                                                                                            <div style={{ marginTop: '0.5rem' }}>
                                                                                                <div style={{ fontSize: '1.75rem', fontWeight: '700', lineHeight: '1' }}>
                                                                                                    {heroNumber.toLocaleString()}
                                                                                                    <span style={{ fontSize: '0.8rem', fontWeight: '500', marginLeft: '0.4rem', opacity: 0.7 }}>{heroLabel}</span>
                                                                                                </div>
                                                                                                <div style={{ fontSize: '0.75rem', marginTop: '0.4rem', opacity: 0.65 }}>
                                                                                                    {subtext}
                                                                                                </div>
                                                                                            </div>
                                                                                            {costFooter && (
                                                                                                <div style={{ fontSize: '0.65rem', marginTop: '0.5rem', opacity: 0.5 }}>
                                                                                                    {costFooter}
                                                                                                </div>
                                                                                            )}
                                                                                        </>
                                                                                    ) : (
                                                                                        <p className="stage-card__progress" style={{ marginTop: '0.5rem', opacity: 0.6, fontSize: '0.75rem' }}>
                                                                                            {describeStageProgress(stage)}
                                                                                        </p>
                                                                                    )}
                                                                                </article>
                                                                            );
                                                                        })}
                                                                    </div>
                                                                </div>
                                                            )}

                                                            {/* Upload Status Badges */}
                                                            {jobUploadStatus[job.id] && jobUploadStatus[job.id].length > 0 && (
                                                                <div style={{
                                                                    marginTop: '1rem',
                                                                    paddingTop: '1rem',
                                                                    borderTop: '1px solid rgba(255, 255, 255, 0.06)'
                                                                }}>
                                                                    <p style={{
                                                                        margin: '0 0 0.75rem 0',
                                                                        fontSize: '0.7rem',
                                                                        textTransform: 'uppercase',
                                                                        letterSpacing: '0.05em',
                                                                        color: 'rgba(255, 255, 255, 0.5)',
                                                                        fontWeight: 600
                                                                    }}>Instantly Uploads</p>
                                                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                                                                        {jobUploadStatus[job.id].map((upload, idx) => (
                                                                            <div
                                                                                key={idx}
                                                                                style={{
                                                                                    display: 'inline-flex',
                                                                                    alignItems: 'center',
                                                                                    gap: '0.5rem',
                                                                                    padding: '0.5rem 0.75rem',
                                                                                    borderRadius: '6px',
                                                                                    fontSize: '0.75rem',
                                                                                    fontWeight: 500,
                                                                                    backgroundColor: upload.upload_source === 'manual' ? '#1e3a8a' : '#065f46',
                                                                                    color: '#fff',
                                                                                    border: `1px solid ${upload.upload_source === 'manual' ? '#3b82f6' : '#10b981'}`
                                                                                }}
                                                                            >
                                                                                <span>{upload.upload_source === 'manual' ? '📝' : '🤖'}</span>
                                                                                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                                                                                    <span style={{ fontWeight: 600 }}>{upload.campaign_name}</span>
                                                                                    <span style={{ fontSize: '0.65rem', opacity: 0.8 }}>
                                                                                        {upload.contact_count} contact{upload.contact_count !== 1 ? 's' : ''}
                                                                                    </span>
                                                                                </div>
                                                                                {upload.upload_source === 'manual' && (
                                                                                    <button
                                                                                        onClick={(e) => {
                                                                                            e.stopPropagation();
                                                                                            handleRevertManualUpload(job.id, upload.campaign_id, upload.campaign_name);
                                                                                        }}
                                                                                        style={{
                                                                                            padding: '2px 6px',
                                                                                            fontSize: '0.65rem',
                                                                                            fontWeight: 600,
                                                                                            backgroundColor: '#dc2626',
                                                                                            color: '#fff',
                                                                                            border: 'none',
                                                                                            borderRadius: '4px',
                                                                                            cursor: 'pointer',
                                                                                            transition: 'background-color 0.2s'
                                                                                        }}
                                                                                        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#b91c1c'}
                                                                                        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#dc2626'}
                                                                                    >
                                                                                        Undo
                                                                                    </button>
                                                                                )}
                                                                            </div>
                                                                        ))}
                                                                    </div>
                                                                </div>
                                                            )}

                                                            {/* Manual Upload Button - Only for completed jobs */}
                                                            {job.status === 'completed' && (
                                                                <div
                                                                    style={{
                                                                        marginTop: '1rem',
                                                                        display: 'flex',
                                                                        justifyContent: 'flex-end'
                                                                    }}
                                                                >
                                                                    <button
                                                                        type="button"
                                                                        className="primary-button"
                                                                        onClick={(e) => {
                                                                            e.stopPropagation();
                                                                            handleOpenManualUpload(job);
                                                                        }}
                                                                        style={{
                                                                            flex: '0 0 auto',
                                                                            width: 'auto',
                                                                            minWidth: '260px',
                                                                            height: '40px',
                                                                            minHeight: '40px',
                                                                            fontSize: '0.8rem',
                                                                            whiteSpace: 'nowrap'
                                                                        }}
                                                                    >
                                                                        📝 Confirm Manual Upload to Instantly
                                                                    </button>
                                                                </div>
                                                            )}

                                                            {/* Delete button */}
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
                                                                    fontSize: '0.7rem',
                                                                    borderRadius: '8px',
                                                                    boxShadow: 'none',
                                                                    opacity: 0.6,
                                                                    transition: 'opacity 0.2s ease'
                                                                }}
                                                                onMouseEnter={(e) => e.currentTarget.style.opacity = '1'}
                                                                onMouseLeave={(e) => e.currentTarget.style.opacity = '0.6'}
                                                            >
                                                                {deletingJobId === job.id ? 'Deleting...' : 'Delete'}
                                                            </button>
                                                        </div>

                                                        {/* Expandable error panel for failed jobs */}
                                                        {job.status === 'failed' && (
                                                            <>
                                                                <button
                                                                    type="button"
                                                                    onClick={(e) => {
                                                                        e.stopPropagation();
                                                                        setExpandedErrorJobId(isExpanded ? null : job.id);
                                                                    }}
                                                                    style={{
                                                                        width: '100%',
                                                                        padding: '0.75rem',
                                                                        marginTop: '0.5rem',
                                                                        background: 'rgba(239, 68, 68, 0.1)',
                                                                        border: '1px solid rgba(239, 68, 68, 0.3)',
                                                                        borderRadius: '8px',
                                                                        color: '#ef4444',
                                                                        fontSize: '0.85rem',
                                                                        fontWeight: 600,
                                                                        cursor: 'pointer',
                                                                        display: 'flex',
                                                                        alignItems: 'center',
                                                                        justifyContent: 'space-between',
                                                                        transition: 'background 0.2s ease'
                                                                    }}
                                                                    onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(239, 68, 68, 0.15)'}
                                                                    onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(239, 68, 68, 0.1)'}
                                                                >
                                                                    <span>❌ View Error Details</span>
                                                                    <span style={{ fontSize: '1rem' }}>{isExpanded ? '▼' : '▶'}</span>
                                                                </button>
                                                                
                                                                {isExpanded && (
                                                                    <div style={{
                                                                        marginTop: '0.5rem',
                                                                        padding: '1.25rem',
                                                                        background: 'rgba(239, 68, 68, 0.05)',
                                                                        border: '1px solid rgba(239, 68, 68, 0.2)',
                                                                        borderRadius: '8px'
                                                                    }}>
                                                                        <p style={{
                                                                            margin: 0,
                                                                            fontSize: '0.9rem',
                                                                            fontWeight: 700,
                                                                            color: '#ef4444',
                                                                            marginBottom: '0.75rem'
                                                                        }}>
                                                                            Job failed during {job.errorStage ? STAGE_METADATA[job.errorStage]?.title || job.errorStage : 'processing'}
                                                                        </p>
                                                                        <p style={{
                                                                            margin: 0,
                                                                            fontSize: '0.85rem',
                                                                            color: 'rgba(255, 255, 255, 0.8)',
                                                                            marginBottom: '1rem',
                                                                            lineHeight: 1.5
                                                                        }}>
                                                                            <strong>Reason:</strong><br/>
                                                                            {job.error || 'Unknown error occurred'}
                                                                        </p>
                                                                        
                                                                        {/* TODO: Add retry actions once backend support is ready */}
                                                                        <div style={{
                                                                            display: 'flex',
                                                                            gap: '0.75rem',
                                                                            paddingTop: '1rem',
                                                                            borderTop: '1px solid rgba(255, 255, 255, 0.1)'
                                                                        }}>
                                                                            <button
                                                                                type="button"
                                                                                className="secondary-button"
                                                                                disabled
                                                                                style={{ fontSize: '0.8rem', opacity: 0.5 }}
                                                                                title="Retry functionality coming soon"
                                                                            >
                                                                                Retry Failed Rows
                                                                            </button>
                                                                            <button
                                                                                type="button"
                                                                                className="secondary-button"
                                                                                disabled
                                                                                style={{ fontSize: '0.8rem', opacity: 0.5 }}
                                                                                title="Restart functionality coming soon"
                                                                            >
                                                                                Restart Job
                                                                            </button>
                                                                        </div>
                                                                    </div>
                                                                )}
                                                            </>
                                                        )}
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
                                {campaignFilterId || leadSearch.trim() || jobIdFilter.trim() ? (
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
                                        disabled={instantlyCampaignsLoading}
                                    >
                                        <option value="">All campaigns</option>
                                        {instantlyCampaigns.map((c) => (
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
                                <label className="settings-field" style={{ flex: '1 1 220px', minWidth: '220px' }}>
                                    <span className="settings-field__label">Job ID</span>
                                    <input
                                        type="text"
                                        value={jobIdFilter}
                                        onChange={(e) => setJobIdFilter(e.target.value)}
                                        placeholder="Filter by exact job ID"
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
                                        <option value="not_run">Not Run</option>
                                    </select>
                                </label>
                                <label className="settings-field" style={{ flex: '1 1 180px', minWidth: '180px' }}>
                                    <span className="settings-field__label">Email Status</span>
                                    <select
                                        value={emailStatusFilter}
                                        onChange={(e) => setEmailStatusFilter(e.target.value)}
                                    >
                                        <option value="">All</option>
                                        <option value="not_run">Not Run</option>
                                        <option value="not_found">Not Found</option>
                                        <option value="valid">Valid</option>
                                        <option value="valid-risky">Valid-Risky</option>
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
                                            
                                            // If we haven't cached all leads yet, fetch them all now from SQL
                                            if (!allLeadsCached && user && clientId) {
                                                const idToken = await getIdToken(user);
                                                const params = new URLSearchParams();
                                                params.append('clientId', clientId);
                                                params.append('limit', '500');
                                                
                                                // Apply filters to API request
                                                if (campaignFilterId) {
                                                    params.append('instantlyCampaignId', campaignFilterId);
                                                }
                                                if (emailStatusFilter) {
                                                    params.append('emailStatus', emailStatusFilter);
                                                }
                                                if (leadSearch.trim()) {
                                                    params.append('search', leadSearch.trim());
                                                }
                                                if (jobIdFilter.trim()) {
                                                    params.append('jobId', jobIdFilter.trim());
                                                }
                                                if (founderFilter) {
                                                    params.append('founderFilter', founderFilter);
                                                }
                                                if (emailFilter) {
                                                    params.append('emailFilter', emailFilter);
                                                }
                                                
                                                const collected: Lead[] = [];
                                                let offset = 0;
                                                let hasMore = true;
                                                
                                                // Fetch all pages
                                                while (hasMore) {
                                                    params.set('offset', String(offset));
                                                    
                                                    const response = await fetchWithRetry(`${getPipelineBaseUrl()}/api/leads?${params.toString()}`, {
                                                        headers: {
                                                            'Authorization': `Bearer ${idToken}`
                                                        }
                                                    });
                                                    
                                                    if (!response.ok) {
                                                        throw new Error(`Failed to fetch leads: ${response.statusText}`);
                                                    }
                                                    
                                                    const data = await response.json();
                                                    const { leads: apiLeads, hasMore: more } = data;
                                                    
                                                    // Map API response to Lead type
                                                    const mapped: Lead[] = apiLeads.map((row: any) => ({
                                                        id: row.id,
                                                        domain: row.domain || "",
                                                        email: row.email || "",
                                                        status: row.status || "",
                                                        verified: row.verified,
                                                        firstLine: row.firstLine || "",
                                                        founderName: row.founderName || "",
                                                        roleType: row.roleType || "",
                                                        personalizationUrl: row.personalizationUrl || "",
                                                        personalizationTitle: row.personalizationTitle || "",
                                                        updatedAt: row.updatedAt || "",
                                                        createdAt: row.createdAt || "",
                                                        lastVerifiedAt: row.lastVerifiedAt || "",
                                                        jobId: row.jobId || "",
                                                        campaigns: row.campaigns || [],
                                                        campaignsData: row.campaignsData || []
                                                    }));
                                                    
                                                    collected.push(...mapped);
                                                    offset += mapped.length;
                                                    hasMore = more && mapped.length > 0;
                                                    
                                                    // Safety limit
                                                    if (collected.length >= 50000) {
                                                        console.warn('Reached max export limit of 50,000 leads');
                                                        break;
                                                    }
                                                }
                                                
                                                leadsToExport = collected;
                                            }
                                            
                                            // Filters are already applied by the SQL API, just use the data directly
                                            const filtered = leadsToExport;
                                            
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
                                {(founderFilter || emailFilter || emailStatusFilter || leadSearch.trim() || jobIdFilter.trim() || campaignFilterId) && (
                                    <button
                                        type="button"
                                        className="secondary-button secondary-button--active"
                                        onClick={() => {
                                            setFounderFilter("");
                                            setEmailFilter("");
                                            setEmailStatusFilter("");
                                            setLeadSearch("");
                                            setJobIdFilter("");
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
                                                            }}>{displayEmail(lead.email, lead.status)}</td>
                                                            <td style={{
                                                                padding: '0.75rem 1rem',
                                                                minWidth: '140px'
                                                            }}>
                                                                {(() => {
                                                                    const meta = getLeadStatusChipMeta(lead.status);
                                                                    return (
                                                                        <span className={`lead-pastel-chip lead-pastel-chip--status-${meta.variant}`}>
                                                                            {meta.label}
                                                                        </span>
                                                                    );
                                                                })()}
                                                            </td>
                                                            <td style={{
                                                                padding: '0.75rem 1rem',
                                                                maxWidth: '220px',
                                                                overflow: 'hidden',
                                                                textOverflow: 'ellipsis',
                                                                whiteSpace: 'nowrap'
                                                            }}>{lead.domain || '—'}</td>
                                                            <td style={{
                                                                padding: '0.75rem 1rem',
                                                                minWidth: '200px'
                                                            }}>
                                                                {(() => {
                                                                    const names = getCampaignNamesForLead(lead);
                                                                    if (!names.length) return '—';
                                                                    const visibleNames = names.slice(0, 2);
                                                                    const hiddenCount = names.length - visibleNames.length;
                                                                    return (
                                                                        <div className="lead-pastel-chip-list">
                                                                            {visibleNames.map((name, chipIndex) => (
                                                                                <span key={`${name}-${chipIndex}`} className="lead-pastel-chip lead-pastel-chip--campaign">
                                                                                    {name}
                                                                                </span>
                                                                            ))}
                                                                            {hiddenCount > 0 && (
                                                                                <span className="lead-pastel-chip lead-pastel-chip--campaign-more">
                                                                                    +{hiddenCount}
                                                                                </span>
                                                                            )}
                                                                        </div>
                                                                    );
                                                                })()}
                                                            </td>
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

                    {/* Segments Tab */}
                    {activeTab === "segments" && (
                        <>
                            <div style={{ marginTop: '2rem', display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
                                <button
                                    type="button"
                                    className="primary-button"
                                    onClick={() => handleOpenSegmentModal()}
                                >
                                    ➕ Create Segment
                                </button>
                            </div>

                            {segments.length === 0 ? (
                                <div className="pipeline-panel__empty" style={{ marginTop: '2rem' }}>
                                    <p>No segments yet.</p>
                                    <p className="pipeline-panel__subtitle">Create segments to filter leads with custom criteria.</p>
                                </div>
                            ) : (
                                <div style={{ marginTop: '2rem' }}>
                                    <p className="eyebrow eyebrow--muted">Saved Segments</p>
                                    <div style={{
                                        marginTop: '1rem',
                                        display: 'grid',
                                        gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
                                        gap: '1rem'
                                    }}>
                                        {segments.map((segment) => (
                                            <div
                                                key={segment.id}
                                                style={{
                                                    border: selectedSegmentId === segment.id ? '2px solid #3b82f6' : '1px solid rgba(255, 255, 255, 0.15)',
                                                    borderRadius: '16px',
                                                    padding: '1.25rem',
                                                    background: selectedSegmentId === segment.id ? 'rgba(59, 130, 246, 0.1)' : 'rgba(255, 255, 255, 0.05)',
                                                    transition: 'all 0.2s ease',
                                                    cursor: 'pointer'
                                                }}
                                                onClick={() => handleLoadSegmentLeads(segment.id)}
                                            >
                                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: '0.5rem', marginBottom: '0.5rem' }}>
                                                    <h3 style={{
                                                        margin: 0,
                                                        fontSize: '1.1rem',
                                                        fontWeight: 600,
                                                        color: '#ffffff'
                                                    }}>{segment.name}</h3>
                                                    <span style={{
                                                        display: 'inline-flex',
                                                        alignItems: 'center',
                                                        padding: '0.25rem 0.65rem',
                                                        borderRadius: '999px',
                                                        fontSize: '0.75rem',
                                                        fontWeight: 600,
                                                        background: 'rgba(59, 130, 246, 0.15)',
                                                        color: '#60a5fa',
                                                        border: '1px solid rgba(59, 130, 246, 0.3)',
                                                        whiteSpace: 'nowrap'
                                                    }}>
                                                        {segmentCounts[segment.id] !== undefined ? segmentCounts[segment.id].toLocaleString() : '...'} leads
                                                    </span>
                                                </div>
                                                <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
                                                    <button
                                                        type="button"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            handleDownloadSegmentCSV(segment.id);
                                                        }}
                                                        disabled={downloadingSegmentId === segment.id}
                                                        style={{
                                                            background: 'rgba(34, 197, 94, 0.1)',
                                                            border: '1px solid rgba(34, 197, 94, 0.3)',
                                                            borderRadius: '6px',
                                                            padding: '0.35rem 0.5rem',
                                                            fontSize: '0.8rem',
                                                            cursor: 'pointer',
                                                            color: '#22c55e'
                                                        }}
                                                    >
                                                        {downloadingSegmentId === segment.id ? '⏳' : '📥'} CSV
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            handleOpenSegmentModal(segment);
                                                        }}
                                                        style={{
                                                            background: 'rgba(255, 255, 255, 0.1)',
                                                            border: '1px solid rgba(255, 255, 255, 0.2)',
                                                            borderRadius: '6px',
                                                            padding: '0.35rem 0.5rem',
                                                            fontSize: '0.8rem',
                                                            cursor: 'pointer',
                                                            color: '#fff'
                                                        }}
                                                    >
                                                        Edit
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            handleDeleteSegment(segment.id);
                                                        }}
                                                        disabled={deletingSegmentId === segment.id}
                                                        style={{
                                                            background: 'rgba(239, 68, 68, 0.1)',
                                                            border: '1px solid rgba(239, 68, 68, 0.3)',
                                                            borderRadius: '6px',
                                                            padding: '0.35rem 0.5rem',
                                                            fontSize: '0.8rem',
                                                            cursor: 'pointer',
                                                            color: '#ef4444'
                                                        }}
                                                    >
                                                        {deletingSegmentId === segment.id ? '...' : 'Delete'}
                                                    </button>
                                                </div>
                                                {segment.description && (
                                                    <p style={{
                                                        margin: '0 0 0.75rem 0',
                                                        fontSize: '0.9rem',
                                                        color: 'rgba(255, 255, 255, 0.7)'
                                                    }}>{segment.description}</p>
                                                )}
                                                <div style={{
                                                    display: 'flex',
                                                    flexDirection: 'column',
                                                    gap: '0.35rem',
                                                    fontSize: '0.85rem',
                                                    color: 'rgba(255, 255, 255, 0.6)',
                                                    marginTop: '0.75rem',
                                                    paddingTop: '0.75rem',
                                                    borderTop: '1px solid rgba(255, 255, 255, 0.1)'
                                                }}>
                                                    {segment.filters.fullName && (
                                                        <div><strong>Name contains:</strong> {segment.filters.fullName}</div>
                                                    )}
                                                    {segment.filters.founder && (
                                                        <div><strong>Founder:</strong> {segment.filters.founder === 'exists' ? 'Exists' : 'Not Found'}</div>
                                                    )}
                                                    {segment.filters.email && (
                                                        <div><strong>Email:</strong> {segment.filters.email === 'found' ? 'Found' : segment.filters.email === 'not_found' ? 'Not Found' : 'Not Run'}</div>
                                                    )}
                                                    {segment.filters.emailStatus && segment.filters.emailStatus.length > 0 && (
                                                        <div><strong>Status:</strong> {segment.filters.emailStatus.join(', ')}</div>
                                                    )}
                                                    {segment.filters.createdAfter && (
                                                        <div><strong>After:</strong> {new Date(segment.filters.createdAfter).toLocaleDateString()}</div>
                                                    )}
                                                    {segment.filters.createdBefore && (
                                                        <div><strong>Before:</strong> {new Date(segment.filters.createdBefore).toLocaleDateString()}</div>
                                                    )}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Segment Leads Display */}
                            {selectedSegmentId && (
                                <div style={{ marginTop: '2rem' }}>
                                    <p className="eyebrow eyebrow--muted">
                                        Segment Results: {segments.find(s => s.id === selectedSegmentId)?.name}
                                    </p>
                                    {segmentLeadsLoading ? (
                                        <div className="pipeline-panel__empty" style={{ marginTop: '1rem' }}>
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
                                                <p>Loading segment leads...</p>
                                            </div>
                                        </div>
                                    ) : segmentLeads.length === 0 ? (
                                        <div className="pipeline-panel__empty" style={{ marginTop: '1rem' }}>
                                            <p>No leads match this segment.</p>
                                        </div>
                                    ) : (
                                        <div style={{
                                            marginTop: '1rem',
                                            overflowX: 'auto',
                                            border: '1px solid rgba(255, 255, 255, 0.1)',
                                            borderRadius: '8px',
                                            backgroundColor: 'rgba(0, 0, 0, 0.2)',
                                            maxHeight: '520px',
                                            overflowY: 'auto'
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
                                                        }}>Created</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {segmentLeads.map((lead, index) => (
                                                        <tr
                                                            key={lead.id}
                                                            onClick={() => setSelectedLead(lead)}
                                                            style={{
                                                                backgroundColor: index % 2 === 0 ? 'transparent' : 'rgba(255, 255, 255, 0.03)',
                                                                borderBottom: index < segmentLeads.length - 1 ? '1px solid rgba(255, 255, 255, 0.05)' : 'none',
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
                                                            }}>{displayEmail(lead.email, lead.status)}</td>
                                                            <td style={{
                                                                padding: '0.75rem 1rem',
                                                                maxWidth: '140px',
                                                                overflow: 'hidden',
                                                                textOverflow: 'ellipsis',
                                                                whiteSpace: 'nowrap'
                                                            }}>{displayEmailStatus(lead.status)}</td>
                                                            <td style={{
                                                                padding: '0.75rem 1rem',
                                                                maxWidth: '220px',
                                                                overflow: 'hidden',
                                                                textOverflow: 'ellipsis',
                                                                whiteSpace: 'nowrap'
                                                            }}>{lead.domain || '—'}</td>
                                                            <td style={{
                                                                padding: '0.75rem 1rem',
                                                                maxWidth: '180px',
                                                                overflow: 'hidden',
                                                                textOverflow: 'ellipsis',
                                                                whiteSpace: 'nowrap'
                                                            }}>{lead.updatedAt || '—'}</td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    )}
                                </div>
                            )}
                        </>
                    )}

                    {/* Personalizer Tab */}
                    {activeTab === "personalizer" && (
                        <div style={{ marginTop: '2rem', maxWidth: '720px' }}>
                            {/* Show wizard if no active job */}
                            {!personalizerJobState && (
                                <>
                                    <p className="eyebrow eyebrow--muted">Step {personalizerWizardStep} / 2</p>
                                    <h2 className="pipeline-panel__title" style={{ fontSize: '1.5rem', marginTop: '0.5rem' }}>
                                        {personalizerWizardStep === 1 ? '📤 Upload CSV' : '⚙️ Configure Options'}
                                    </h2>
                            <p style={{ color: 'rgba(255, 255, 255, 0.7)', fontSize: '0.95rem', marginTop: '0.5rem' }}>
                                {personalizerWizardStep === 1 
                                    ? 'Upload a CSV file with your leads to personalize' 
                                    : 'Configure personalization settings for your Shopify store'}
                            </p>

                            {/* Step Progress Indicator */}
                            <div style={{
                                display: 'flex',
                                gap: '0.5rem',
                                marginTop: '1.5rem',
                                marginBottom: '2rem'
                            }}>
                                {[1, 2].map((step) => (
                                    <div
                                        key={step}
                                        style={{
                                            flex: 1,
                                            height: '4px',
                                            borderRadius: '2px',
                                            background: step <= personalizerWizardStep ? '#3b82f6' : 'rgba(255, 255, 255, 0.15)',
                                            transition: 'background 0.3s ease'
                                        }}
                                    />
                                ))}
                            </div>

                            {/* Step 1: Upload CSV */}
                            {personalizerWizardStep === 1 && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                                    <label className="upload-area">
                                        <span className="upload-area__title">Drop CSV or click to browse</span>
                                        <span className="upload-area__hint">Must contain domain or company data</span>
                                        {personalizerFile && (
                                            <span className="upload-area__file" title={personalizerFile.name}>
                                                📄 {personalizerFile.name}
                                            </span>
                                        )}
                                        <input
                                            type="file"
                                            accept=".csv"
                                            className="sr-only"
                                            onChange={(e) => {
                                                const file = e.target.files?.[0];
                                                if (file) {
                                                    handlePersonalizerFileUpload(file);
                                                }
                                            }}
                                        />
                                    </label>

                                    {personalizerFile && (
                                        <div style={{
                                            padding: '1rem',
                                            background: 'rgba(34, 197, 94, 0.1)',
                                            border: '1px solid rgba(34, 197, 94, 0.3)',
                                            borderRadius: '8px',
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '0.75rem'
                                        }}>
                                            <span style={{ fontSize: '1.25rem' }}>✅</span>
                                            <div style={{ flex: 1 }}>
                                                <div style={{ fontWeight: 600, color: 'rgba(255, 255, 255, 0.9)' }}>
                                                    {processingPersonalizerFile ? 'Analyzing domains...' : 'File ready'}
                                                </div>
                                                <div style={{ fontSize: '0.875rem', color: 'rgba(255, 255, 255, 0.6)', marginTop: '0.25rem' }}>
                                                    {personalizerFile.name} ({(personalizerFile.size / 1024).toFixed(2)} KB)
                                                </div>
                                                {personalizerDomainStats && (
                                                    <div style={{ fontSize: '0.875rem', marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px solid rgba(255, 255, 255, 0.1)' }}>
                                                        <div style={{ fontWeight: 600, marginBottom: '0.5rem', color: 'rgba(255, 255, 255, 0.9)' }}>
                                                            📊 Domain Analysis
                                                        </div>
                                                        
                                                        {/* Row 1: Basic counts */}
                                                        <div style={{ display: 'flex', gap: '1rem', color: 'rgba(255, 255, 255, 0.7)', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
                                                            <span>
                                                                <strong style={{ color: 'rgba(255, 255, 255, 0.9)' }}>
                                                                    {personalizerDomainStats.total.toLocaleString()}
                                                                </strong> total
                                                            </span>
                                                            <span>
                                                                <strong style={{ color: '#60a5fa' }}>
                                                                    {personalizerDomainStats.normalized.toLocaleString()}
                                                                </strong> unique
                                                            </span>
                                                            {personalizerDomainStats.withWww > 0 && (
                                                                <span>
                                                                    <strong style={{ color: '#f59e0b' }}>
                                                                        {personalizerDomainStats.withWww.toLocaleString()}
                                                                    </strong> normalized
                                                                </span>
                                                            )}
                                                        </div>

                                                        {/* Row 2: Run status */}
                                                        <div style={{ display: 'flex', gap: '1rem', color: 'rgba(255, 255, 255, 0.7)', flexWrap: 'wrap', paddingTop: '0.5rem', borderTop: '1px solid rgba(255, 255, 255, 0.08)', marginBottom: '0.5rem' }}>
                                                            <span>
                                                                <strong style={{ color: '#22c55e' }}>
                                                                    {personalizerDomainStats.run.toLocaleString()}
                                                                </strong> run
                                                            </span>
                                                            <span>
                                                                <strong style={{ color: '#94a3b8' }}>
                                                                    {personalizerDomainStats.notRun.toLocaleString()}
                                                                </strong> not run
                                                            </span>
                                                        </div>

                                                        {/* Row 3: Data enrichment */}
                                                        <div style={{ display: 'flex', gap: '1rem', color: 'rgba(255, 255, 255, 0.7)', flexWrap: 'wrap', paddingTop: '0.5rem', borderTop: '1px solid rgba(255, 255, 255, 0.08)' }}>
                                                            <span>
                                                                <strong style={{ color: '#8b5cf6' }}>
                                                                    {personalizerDomainStats.withFounders.toLocaleString()}
                                                                </strong> w/ founders
                                                            </span>
                                                            <span>
                                                                <strong style={{ color: '#ec4899' }}>
                                                                    {personalizerDomainStats.withEmails.toLocaleString()}
                                                                </strong> w/ emails
                                                            </span>
                                                            <span>
                                                                <strong style={{ color: '#06b6d4' }}>
                                                                    {personalizerDomainStats.withPersonalization.toLocaleString()}
                                                                </strong> w/ personalization
                                                            </span>
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                            <button
                                                type="button"
                                                className="secondary-button secondary-button--active"
                                                onClick={() => {
                                                    setPersonalizerFile(null);
                                                    setPersonalizerDomainStats(null);
                                                }}
                                                style={{ fontSize: '0.85rem' }}
                                                disabled={processingPersonalizerFile}
                                            >
                                                Remove
                                            </button>
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Step 2: Configuration Options */}
                            {personalizerWizardStep === 2 && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                                    {/* Platform - Shopify (unchangeable) */}
                                    <label className="settings-field">
                                        <span className="settings-field__label">Platform</span>
                                        <div style={{
                                            padding: '0.75rem 1rem',
                                            background: 'rgba(255, 255, 255, 0.05)',
                                            border: '1px solid rgba(255, 255, 255, 0.15)',
                                            borderRadius: '8px',
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '0.5rem',
                                            color: 'rgba(255, 255, 255, 0.9)',
                                            fontWeight: 500
                                        }}>
                                            <span style={{ fontSize: '1.25rem' }}>🛍️</span>
                                            Shopify
                                            <span style={{
                                                marginLeft: 'auto',
                                                fontSize: '0.8rem',
                                                padding: '0.25rem 0.5rem',
                                                background: 'rgba(59, 130, 246, 0.2)',
                                                borderRadius: '4px',
                                                color: '#93c5fd'
                                            }}>Required</span>
                                        </div>
                                        <span className="settings-field__hint">Currently only Shopify stores are supported</span>
                                    </label>

                                    {/* Check Klaviyo */}
                                    <label className="settings-field">
                                        <div style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '0.75rem',
                                            cursor: 'pointer',
                                            padding: '0.75rem',
                                            background: checkKlaviyo ? 'rgba(59, 130, 246, 0.1)' : 'transparent',
                                            border: '1px solid ' + (checkKlaviyo ? 'rgba(59, 130, 246, 0.3)' : 'rgba(255, 255, 255, 0.1)'),
                                            borderRadius: '8px',
                                            transition: 'all 0.2s ease'
                                        }}>
                                            <input
                                                type="checkbox"
                                                checked={checkKlaviyo}
                                                onChange={(e) => setCheckKlaviyo(e.target.checked)}
                                                style={{ width: '20px', height: '20px', cursor: 'pointer' }}
                                            />
                                            <div style={{ flex: 1 }}>
                                                <div style={{ fontWeight: 500, color: 'rgba(255, 255, 255, 0.9)', fontSize: '1rem' }}>
                                                    Check Klaviyo Integration
                                                </div>
                                                <div style={{ fontSize: '0.875rem', color: 'rgba(255, 255, 255, 0.6)', marginTop: '0.25rem' }}>
                                                    Verify if the store has Klaviyo email marketing installed
                                                </div>
                                            </div>
                                        </div>
                                    </label>

                                    {/* Products to Pull */}
                                    <label className="settings-field">
                                        <span className="settings-field__label">Products to Pull</span>
                                        <div style={{ display: 'flex', gap: '0.5rem' }}>
                                            {[1, 2, 3, 4, 5].map((num) => (
                                                <button
                                                    key={num}
                                                    type="button"
                                                    onClick={() => setProductsToPull(num)}
                                                    style={{
                                                        flex: 1,
                                                        padding: '0.75rem',
                                                        background: productsToPull === num ? 'rgba(59, 130, 246, 0.2)' : 'rgba(255, 255, 255, 0.05)',
                                                        border: '1px solid ' + (productsToPull === num ? 'rgba(59, 130, 246, 0.5)' : 'rgba(255, 255, 255, 0.15)'),
                                                        borderRadius: '6px',
                                                        color: productsToPull === num ? '#93c5fd' : 'rgba(255, 255, 255, 0.7)',
                                                        cursor: 'pointer',
                                                        fontWeight: 600,
                                                        fontSize: '1rem',
                                                        transition: 'all 0.2s ease'
                                                    }}
                                                >
                                                    {num}
                                                </button>
                                            ))}
                                        </div>
                                        <span className="settings-field__hint">Number of products to extract from each store (1-5)</span>
                                    </label>

                                    {/* Remove B2B Content */}
                                    <label className="settings-field">
                                        <div style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '0.75rem',
                                            cursor: 'pointer',
                                            padding: '0.75rem',
                                            background: removeB2B ? 'rgba(59, 130, 246, 0.1)' : 'transparent',
                                            border: '1px solid ' + (removeB2B ? 'rgba(59, 130, 246, 0.3)' : 'rgba(255, 255, 255, 0.1)'),
                                            borderRadius: '8px',
                                            transition: 'all 0.2s ease'
                                        }}>
                                            <input
                                                type="checkbox"
                                                checked={removeB2B}
                                                onChange={(e) => setRemoveB2B(e.target.checked)}
                                                style={{ width: '20px', height: '20px', cursor: 'pointer' }}
                                            />
                                            <div style={{ flex: 1 }}>
                                                <div style={{ fontWeight: 500, color: 'rgba(255, 255, 255, 0.9)', fontSize: '1rem' }}>
                                                    Remove B2B Content
                                                </div>
                                                <div style={{ fontSize: '0.875rem', color: 'rgba(255, 255, 255, 0.6)', marginTop: '0.25rem' }}>
                                                    Filter out business-to-business products and focus on B2C items
                                                </div>
                                            </div>
                                        </div>
                                    </label>
                                </div>
                            )}

                            {/* Navigation Buttons */}
                            <div className="modal__actions" style={{ marginTop: '2rem' }}>
                                {personalizerWizardStep > 1 && (
                                    <button
                                        type="button"
                                        className="secondary-button secondary-button--active"
                                        onClick={() => setPersonalizerWizardStep(1)}
                                    >
                                        Back
                                    </button>
                                )}
                                {personalizerWizardStep < 2 ? (
                                    <button
                                        type="button"
                                        className="primary-button"
                                        disabled={!personalizerFile || processingPersonalizerFile}
                                        onClick={() => setPersonalizerWizardStep(2)}
                                    >
                                        {processingPersonalizerFile ? 'Processing...' : 'Next'}
                                    </button>
                                ) : (
                                    <button
                                        type="button"
                                        className="primary-button"
                                        disabled={uploadingPersonalizer}
                                        onClick={handlePersonalizerSubmit}
                                    >
                                        {uploadingPersonalizer ? 'Starting...' : 'Start Processing'}
                                    </button>
                                )}
                            </div>
                                </>
                            )}

                            {/* Show pipeline view if job exists */}
                            {personalizerJobState && (
                                <div style={{ marginTop: '2rem' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.5rem' }}>
                                        <div>
                                            <p className="eyebrow eyebrow--muted">Personalizer Pipeline</p>
                                            <h2 className="pipeline-panel__title" style={{ fontSize: '1.5rem', marginTop: '0.5rem' }}>
                                                {personalizerJobState.status === 'completed' ? 'Completed' : 
                                                 personalizerJobState.status === 'failed' ? 'Failed' : 'Processing...'}
                                            </h2>
                                            <p style={{ fontSize: '0.875rem', color: 'rgba(255, 255, 255, 0.6)', marginTop: '0.25rem' }}>
                                                {personalizerJobState.fileName}
                                            </p>
                                        </div>
                                        <button
                                            type="button"
                                            className="secondary-button secondary-button--active"
                                            onClick={() => {
                                                setPersonalizerJobState(null);
                                                setPersonalizerJobId(null);
                                            }}
                                        >
                                            New Job
                                        </button>
                                    </div>

                                    {/* Pipeline stages */}
                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '1rem' }}>
                                        {['shopifyDetection', 'klaviyoDetection', 'productFetch', 'personalization'].map((stageKey) => {
                                            const stage = personalizerJobState.stages?.[stageKey];
                                            if (!stage) return null;
                                            
                                            const stageNames: Record<string, string> = {
                                                shopifyDetection: '1. Shopify Detection',
                                                klaviyoDetection: '2. Klaviyo Detection',
                                                productFetch: '3. Product Fetch',
                                                personalization: '4. AI Personalization'
                                            };

                                            return (
                                                <div
                                                    key={stageKey}
                                                    style={{
                                                        padding: '1.25rem',
                                                        background: 'rgba(255, 255, 255, 0.03)',
                                                        border: '1px solid rgba(255, 255, 255, 0.08)',
                                                        borderRadius: '12px'
                                                    }}
                                                >
                                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                                                        <h3 style={{ fontSize: '1rem', fontWeight: 600, margin: 0 }}>
                                                            {stageNames[stageKey] || stageKey}
                                                        </h3>
                                                        <span style={{
                                                            padding: '0.25rem 0.5rem',
                                                            borderRadius: '4px',
                                                            fontSize: '0.75rem',
                                                            fontWeight: 600,
                                                            textTransform: 'uppercase',
                                                            background: stage.status === 'completed' ? 'rgba(34, 197, 94, 0.2)' :
                                                                       stage.status === 'running' ? 'rgba(59, 130, 246, 0.2)' :
                                                                       stage.status === 'failed' ? 'rgba(239, 68, 68, 0.2)' :
                                                                       'rgba(255, 255, 255, 0.1)',
                                                            color: stage.status === 'completed' ? '#22c55e' :
                                                                   stage.status === 'running' ? '#3b82f6' :
                                                                   stage.status === 'failed' ? '#ef4444' :
                                                                   'rgba(255, 255, 255, 0.6)'
                                                        }}>
                                                            {stage.status}
                                                        </span>
                                                    </div>
                                                    {stage.summary?.skipped && (
                                                        <div style={{ fontSize: '0.875rem', color: 'rgba(255, 255, 255, 0.6)', fontStyle: 'italic' }}>
                                                            Skipped: {stage.summary.reason || 'N/A'}
                                                        </div>
                                                    )}
                                                    {stage.progress && !stage.summary?.skipped && (
                                                        <div style={{ fontSize: '0.875rem', color: 'rgba(255, 255, 255, 0.7)' }}>
                                                            Progress: {stage.progress.processed || 0} / {stage.progress.total || 0}
                                                        </div>
                                                    )}
                                                    {stage.summary && !stage.summary.skipped && (
                                                        <div style={{ fontSize: '0.875rem', color: 'rgba(255, 255, 255, 0.7)', marginTop: '0.5rem' }}>
                                                            {stage.summary.total && <div>Total: {stage.summary.total}</div>}
                                                            {stage.summary.shopifyStores !== undefined && <div>Shopify Stores: {stage.summary.shopifyStores}</div>}
                                                            {stage.summary.klaviyoStores !== undefined && <div>Klaviyo Stores: {stage.summary.klaviyoStores}</div>}
                                                            {stage.summary.fetched !== undefined && <div>Fetched: {stage.summary.fetched}</div>}
                                                            {stage.summary.failed !== undefined && <div>Failed: {stage.summary.failed}</div>}
                                                            {stage.summary.personalized !== undefined && <div>Personalized: {stage.summary.personalized}</div>}
                                                        </div>
                                                    )}
                                                    {stage.error && (
                                                        <div style={{ marginTop: '0.5rem', padding: '0.75rem', background: 'rgba(239, 68, 68, 0.1)', borderRadius: '6px', fontSize: '0.875rem', color: '#ef4444' }}>
                                                            {stage.error}
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>

                                    {/* Results summary */}
                                    {personalizerJobState.status === 'completed' && personalizerJobState.result && (
                                        <div style={{
                                            marginTop: '1.5rem',
                                            padding: '1.25rem',
                                            background: 'rgba(34, 197, 94, 0.1)',
                                            border: '1px solid rgba(34, 197, 94, 0.3)',
                                            borderRadius: '12px'
                                        }}>
                                            <h3 style={{ fontSize: '1rem', fontWeight: 600, margin: '0 0 1rem 0', color: '#22c55e' }}>
                                                ✓ Results
                                            </h3>
                                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.75rem', fontSize: '0.875rem' }}>
                                                <div>
                                                    <span style={{ color: 'rgba(255, 255, 255, 0.6)' }}>Shopify Stores:</span>
                                                    <strong style={{ marginLeft: '0.5rem', color: '#fff' }}>
                                                        {personalizerJobState.result.shopifyStores}
                                                    </strong>
                                                </div>
                                                {personalizerJobState.config?.checkKlaviyo && (
                                                    <div>
                                                        <span style={{ color: 'rgba(255, 255, 255, 0.6)' }}>Klaviyo Stores:</span>
                                                        <strong style={{ marginLeft: '0.5rem', color: '#fff' }}>
                                                            {personalizerJobState.result.klaviyoStores}
                                                        </strong>
                                                    </div>
                                                )}
                                                <div>
                                                    <span style={{ color: 'rgba(255, 255, 255, 0.6)' }}>Products Fetched:</span>
                                                    <strong style={{ marginLeft: '0.5rem', color: '#fff' }}>
                                                        {personalizerJobState.result.productsFetched}
                                                    </strong>
                                                </div>
                                                <div>
                                                    <span style={{ color: 'rgba(255, 255, 255, 0.6)' }}>Personalized:</span>
                                                    <strong style={{ marginLeft: '0.5rem', color: '#22c55e' }}>
                                                        {personalizerJobState.result.personalized}
                                                    </strong>
                                                </div>
                                                {personalizerJobState.result.estimatedCost && (
                                                    <div>
                                                        <span style={{ color: 'rgba(255, 255, 255, 0.6)' }}>Estimated Cost:</span>
                                                        <strong style={{ marginLeft: '0.5rem', color: '#fff' }}>
                                                            ${personalizerJobState.result.estimatedCost.toFixed(4)}
                                                        </strong>
                                                    </div>
                                                )}
                                            </div>
                                            
                                            {/* Download button */}
                                            <div style={{ marginTop: '1rem', display: 'flex', gap: '0.75rem' }}>
                                                <button
                                                    type="button"
                                                    className="primary-button"
                                                    onClick={() => {
                                                        const url = `${getPipelineBaseUrl()}/api/jobs/personalizer/${personalizerJobState.id}/result`;
                                                        window.open(url, '_blank', 'noopener,noreferrer');
                                                    }}
                                                    style={{ fontSize: '0.875rem' }}
                                                >
                                                    📥 Download CSV
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
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
                            <div className="settings-field">
                                <span className="settings-field__label">Instantly CSV Merge Import</span>
                                <span className="settings-field__hint" style={{ marginBottom: '0.5rem' }}>
                                    Upload an Instantly export CSV. The importer only merges and links; it never clears existing lead fields.
                                </span>
                                <button
                                    type="button"
                                    className="secondary-button"
                                    onClick={handleOpenInstantlyCsvImportModal}
                                    disabled={instantlyCsvImportLoading}
                                >
                                    📥 Import Instantly CSV
                                </button>
                            </div>
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
                                    
                                    {/* Domain Check Stats */}
                                    {selectedFile && (
                                        <div style={{
                                            marginTop: '1rem',
                                            padding: '0.75rem 1rem',
                                            background: 'rgba(59, 130, 246, 0.1)',
                                            border: '1px solid rgba(59, 130, 246, 0.3)',
                                            borderRadius: '8px',
                                            fontSize: '0.875rem'
                                        }}>
                                            {checkingDomains ? (
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'rgba(255, 255, 255, 0.7)' }}>
                                                    <div style={{
                                                        width: '14px',
                                                        height: '14px',
                                                        border: '2px solid rgba(255, 255, 255, 0.3)',
                                                        borderTopColor: '#3b82f6',
                                                        borderRadius: '50%',
                                                        animation: 'spin 0.8s linear infinite'
                                                    }} />
                                                    Checking domains...
                                                </div>
                                            ) : domainCheckStats ? (
                                                <div style={{ color: 'rgba(255, 255, 255, 0.9)' }}>
                                                    <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>
                                                        📊 Domain Analysis
                                                    </div>
                                                    
                                                    {/* Row 1: Basic counts */}
                                                    <div style={{ display: 'flex', gap: '1.25rem', color: 'rgba(255, 255, 255, 0.7)', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
                                                        <span>
                                                            <strong style={{ color: 'rgba(255, 255, 255, 0.9)' }}>{domainCheckStats.total.toLocaleString()}</strong> total
                                                        </span>
                                                        <span>
                                                            <strong style={{ color: '#60a5fa' }}>{domainCheckStats.unique.toLocaleString()}</strong> unique
                                                        </span>
                                                        <span>
                                                            <strong style={{ color: '#f59e0b' }}>{domainCheckStats.existing.toLocaleString()}</strong> existing
                                                        </span>
                                                        <span>
                                                            <strong style={{ color: '#10b981' }}>{domainCheckStats.new.toLocaleString()}</strong> new
                                                        </span>
                                                    </div>

                                                    {/* Row 2: Run status */}
                                                    <div style={{ display: 'flex', gap: '1.25rem', color: 'rgba(255, 255, 255, 0.7)', flexWrap: 'wrap', paddingTop: '0.5rem', borderTop: '1px solid rgba(255, 255, 255, 0.08)', marginBottom: '0.5rem' }}>
                                                        <span>
                                                            <strong style={{ color: '#22c55e' }}>{domainCheckStats.run.toLocaleString()}</strong> run
                                                        </span>
                                                        <span>
                                                            <strong style={{ color: '#94a3b8' }}>{domainCheckStats.notRun.toLocaleString()}</strong> not run
                                                        </span>
                                                    </div>

                                                    {/* Row 3: Data enrichment */}
                                                    <div style={{ display: 'flex', gap: '1.25rem', color: 'rgba(255, 255, 255, 0.7)', flexWrap: 'wrap', paddingTop: '0.5rem', borderTop: '1px solid rgba(255, 255, 255, 0.08)' }}>
                                                        <span>
                                                            <strong style={{ color: '#8b5cf6' }}>{domainCheckStats.withFounders.toLocaleString()}</strong> w/ founders
                                                        </span>
                                                        <span>
                                                            <strong style={{ color: '#ec4899' }}>{domainCheckStats.withEmails.toLocaleString()}</strong> w/ emails
                                                        </span>
                                                        <span>
                                                            <strong style={{ color: '#06b6d4' }}>{domainCheckStats.withPersonalization.toLocaleString()}</strong> w/ personalization
                                                        </span>
                                                    </div>
                                                </div>
                                            ) : null}
                                        </div>
                                    )}
                                    
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
                                            <option value="include">Re-process existing domains (merge non-empty updates)</option>
                                        </select>
                                        <span className="settings-field__hint">
                                            {dedupeStrategy === 'include'
                                                ? 'Existing leads are reprocessed and only non-empty incoming fields are merged into SQL.'
                                                : 'Deduplication is scoped to this client.'}
                                        </span>
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
                                            padding: '0.5rem'
                                        }}>
                                            <input
                                                type="checkbox"
                                                checked={runDomainCheck}
                                                onChange={(e) => setRunDomainCheck(e.target.checked)}
                                                style={{
                                                    width: '16px',
                                                    height: '16px',
                                                    cursor: 'pointer',
                                                    accentColor: '#3b82f6',
                                                    flexShrink: 0
                                                }}
                                            />
                                            <div style={{ flex: 1 }}>
                                                <div style={{ fontWeight: 500, color: 'rgba(255, 255, 255, 0.9)' }}>
                                                    Run domain DNS check
                                                </div>
                                                <div style={{ fontSize: '0.8rem', color: 'rgba(255, 255, 255, 0.6)', marginTop: '0.15rem' }}>
                                                    {runDomainCheck
                                                        ? 'Filters obviously dead domains during Domain Prep.'
                                                        : 'Skips DNS filtering; domains still get normalized and deduped.'}
                                                </div>
                                            </div>
                                        </label>

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
                                                            ? 'Validate emails from your CSV with TryKitt'
                                                            : 'Validate discovered email addresses with TryKitt'}
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
                                                alignItems: 'flex-start',
                                                gap: '0.75rem',
                                                cursor: 'pointer',
                                                padding: '0.5rem'
                                            }}>
                                                <input
                                                    type="checkbox"
                                                    checked={personalizeFirstLine}
                                                    onChange={(e) => setPersonalizeFirstLine(e.target.checked)}
                                                    style={{ width: '18px', height: '18px', cursor: 'pointer', marginTop: '0.15rem' }}
                                                />
                                                <div style={{ flex: 1 }}>
                                                    <div style={{ fontWeight: 500, color: 'rgba(255, 255, 255, 0.9)' }}>
                                                        Personalize with Product Data
                                                    </div>
                                                    <div style={{ fontSize: '0.875rem', color: 'rgba(255, 255, 255, 0.6)', marginTop: '0.125rem' }}>
                                                        Generate first line based on Shopify products
                                                    </div>
                                                    {personalizeFirstLine && (
                                                        <div style={{
                                                            marginTop: '0.75rem',
                                                            display: 'flex',
                                                            flexDirection: 'column',
                                                            gap: '0.625rem',
                                                            padding: '0.75rem',
                                                            borderRadius: '8px',
                                                            background: 'rgba(255, 255, 255, 0.04)',
                                                            border: '1px solid rgba(255, 255, 255, 0.12)'
                                                        }}>
                                                            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                                                                <input
                                                                    type="checkbox"
                                                                    checked={productPromptUseNew}
                                                                    onChange={(e) => {
                                                                        const checked = e.target.checked;
                                                                        setProductPromptUseNew(checked);
                                                                        if (checked) {
                                                                            setProductPromptUseOld(false);
                                                                        } else if (!productPromptUseOld) {
                                                                            setProductPromptUseOld(true);
                                                                        }
                                                                    }}
                                                                    style={{ width: '16px', height: '16px', cursor: 'pointer' }}
                                                                />
                                                                <span style={{ fontSize: '0.875rem', color: 'rgba(255, 255, 255, 0.9)' }}>
                                                                    New Prompt (gpt-5-mini)
                                                                </span>
                                                            </label>

                                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginLeft: '1.5rem' }}>
                                                                <span style={{ fontSize: '0.8rem', color: 'rgba(255, 255, 255, 0.65)' }}>Products:</span>
                                                                <select
                                                                    value={productPromptProducts}
                                                                    onChange={(e) => setProductPromptProducts(Number(e.target.value))}
                                                                    disabled={!productPromptUseNew}
                                                                    style={{
                                                                        width: '80px',
                                                                        opacity: productPromptUseNew ? 1 : 0.6
                                                                    }}
                                                                >
                                                                    {[1, 2, 3, 4, 5].map((num) => (
                                                                        <option key={num} value={num}>{num}</option>
                                                                    ))}
                                                                </select>
                                                            </div>

                                                            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                                                                <input
                                                                    type="checkbox"
                                                                    checked={productPromptUseOld}
                                                                    onChange={(e) => {
                                                                        const checked = e.target.checked;
                                                                        setProductPromptUseOld(checked);
                                                                        if (checked) {
                                                                            setProductPromptUseNew(false);
                                                                        } else if (!productPromptUseNew) {
                                                                            setProductPromptUseNew(true);
                                                                        }
                                                                    }}
                                                                    style={{ width: '16px', height: '16px', cursor: 'pointer' }}
                                                                />
                                                                <span style={{ fontSize: '0.875rem', color: 'rgba(255, 255, 255, 0.9)' }}>
                                                                    Old Prompt
                                                                </span>
                                                            </label>
                                                        </div>
                                                    )}
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
                                    {(instantlyCampaigns.length ? instantlyCampaigns : campaigns).map((campaign) => (
                                        <option key={campaign.id} value={campaign.id}>{campaign.name}</option>
                                    ))}
                                </select>
                            </label>

                            <div style={{ marginBottom: '2rem' }}>
                                <h3 style={{ fontSize: '1rem', marginBottom: '1rem', color: 'rgba(255, 255, 255, 0.9)' }}>Standard Variables</h3>
                                {['email', 'personalization', 'lastName', 'firstName', 'companyName', 'assignedTo'].map((field) => {
                                    const displayName =
                                        field === 'firstName' ? 'First Name' :
                                        field === 'lastName' ? 'Last Name' :
                                        field === 'companyName' ? 'Company Name' :
                                        field === 'assignedTo' ? 'Assigned To' :
                                        field.charAt(0).toUpperCase() + field.slice(1);
                                    return (
                                        <div key={field} style={{ marginBottom: '1.5rem' }}>
                                            <label className="settings-field">
                                                <span className="settings-field__label">{displayName} {field === 'email' && '*'}</span>
                                                <select
                                                    value={
                                                        columnMapping[field]?.isCustom
                                                            ? '__custom__'
                                                            : columnMapping[field]?.column || ''
                                                    }
                                                    onChange={(e) => {
                                                        const val = e.target.value;
                                                        if (val === '__custom__') {
                                                            setColumnMapping({
                                                                ...columnMapping,
                                                                [field]: { column: '', isCustom: true, customName: columnMapping[field]?.customName || '' }
                                                            });
                                                        } else {
                                                            setColumnMapping({
                                                                ...columnMapping,
                                                                [field]: { column: val, isCustom: false, customName: undefined }
                                                            });
                                                        }
                                                    }}
                                                >
                                                    <option value="">-- Not mapped --</option>
                                                    <option value="__custom__">🔧 Use custom variable name</option>
                                                    {csvHeaders.map((header) => (<option key={header} value={header}>{header}</option>))}
                                                </select>
                                            </label>
                                            {columnMapping[field]?.isCustom && (
                                                <div style={{ marginTop: '0.75rem', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                                                    <label className="settings-field">
                                                        <span className="settings-field__label">Custom variable label</span>
                                                        <input
                                                            className="input"
                                                            type="text"
                                                            placeholder="e.g., Unique Opener"
                                                            value={columnMapping[field]?.customName || ''}
                                                            onChange={(e) => setColumnMapping({
                                                                ...columnMapping,
                                                                [field]: { ...(columnMapping[field] || { isCustom: true, column: '' }), customName: e.target.value }
                                                            })}
                                                        />
                                                    </label>
                                                    <label className="settings-field">
                                                        <span className="settings-field__label">Map to column</span>
                                                        <select
                                                            value={columnMapping[field]?.column || ''}
                                                            onChange={(e) => setColumnMapping({
                                                                ...columnMapping,
                                                                [field]: { ...(columnMapping[field] || { isCustom: true }), column: e.target.value }
                                                            })}
                                                        >
                                                            <option value="">-- Not mapped --</option>
                                                            {csvHeaders.map((header) => (<option key={header} value={header}>{header}</option>))}
                                                        </select>
                                                    </label>
                                                </div>
                                            )}
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

                            <div style={{ marginBottom: '1.5rem', paddingTop: '0.75rem', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                                <div style={{ fontWeight: 600, marginBottom: '0.5rem', color: 'rgba(255,255,255,0.9)' }}>Duplicate handling</div>
                                <label className="settings-field" style={{ flexDirection: 'row', alignItems: 'center', gap: '0.5rem' }}>
                                    <input
                                        type="checkbox"
                                        checked={skipWorkspaceDupes}
                                        onChange={(e) => setSkipWorkspaceDupes(e.target.checked)}
                                    />
                                    <span className="settings-field__label" style={{ margin: 0 }}>Skip if in workspace (recommended)</span>
                                </label>
                                <label className="settings-field" style={{ flexDirection: 'row', alignItems: 'center', gap: '0.5rem' }}>
                                    <input
                                        type="checkbox"
                                        checked={skipCampaignDupes}
                                        onChange={(e) => setSkipCampaignDupes(e.target.checked)}
                                    />
                                    <span className="settings-field__label" style={{ margin: 0 }}>Skip if in any campaign</span>
                                </label>
                                <label className="settings-field" style={{ flexDirection: 'row', alignItems: 'center', gap: '0.5rem' }}>
                                    <input
                                        type="checkbox"
                                        checked={skipListDupes}
                                        onChange={(e) => setSkipListDupes(e.target.checked)}
                                    />
                                    <span className="settings-field__label" style={{ margin: 0 }}>Skip if in any list</span>
                                </label>
                            </div>

                            {/* Custom variables are handled inline per field via the custom option */}
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
                                disabled={!jobState || jobState.status !== 'completed'}
                                onClick={() => handleDownloadResults(downloadScope)}
                            >
                                Download
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Instantly CSV Merge Import Modal */}
            {showInstantlyCsvImportModal && (
                <div
                    className="modal-overlay"
                    role="dialog"
                    aria-modal="true"
                    onClick={() => {
                        if (instantlyCsvImportLoading) return;
                        setShowInstantlyCsvImportModal(false);
                    }}
                >
                    <div
                        className="modal"
                        onClick={(event) => event.stopPropagation()}
                        style={{ maxWidth: '760px', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}
                    >
                        <div className="modal__header">
                            <div>
                                <h2 className="modal__title">Import Instantly CSV (Merge-Only)</h2>
                                <p className="modal__description">
                                    Campaign IDs are resolved from Instantly API by campaign name. Existing lead fields are never deleted.
                                </p>
                            </div>
                        </div>

                        <div className="modal__body" style={{ display: 'flex', flexDirection: 'column', gap: '1rem', overflowY: 'auto' }}>
                            <label className="settings-field">
                                <span className="settings-field__label">CSV File *</span>
                                <input
                                    type="file"
                                    accept=".csv,text/csv"
                                    onChange={(e) => {
                                        setInstantlyCsvImportFile(e.target.files?.[0] || null);
                                        setInstantlyCsvImportResult(null);
                                        setInstantlyCsvCampaignOverrides({});
                                    }}
                                    disabled={instantlyCsvImportLoading}
                                />
                                <span className="settings-field__hint">
                                    Required column: Campaign Name. Matching prefers Email, then Domain + Name fallback.
                                </span>
                            </label>

                            <label className="settings-field">
                                <span className="settings-field__label">Notes (Optional)</span>
                                <textarea
                                    value={instantlyCsvImportNotes}
                                    onChange={(e) => setInstantlyCsvImportNotes(e.target.value)}
                                    placeholder="Optional note stored with campaign link records..."
                                    rows={3}
                                    disabled={instantlyCsvImportLoading}
                                    style={{ resize: 'vertical', fontFamily: 'inherit', fontSize: 'inherit' }}
                                />
                            </label>
                            {instantlyCsvCampaignsLoading && (
                                <div style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.65)' }}>
                                    Loading campaign options for manual mapping...
                                </div>
                            )}

                            {instantlyCsvImportResult && (
                                <div style={{
                                    padding: '1rem',
                                    borderRadius: '10px',
                                    border: '1px solid rgba(255,255,255,0.1)',
                                    background: 'rgba(255,255,255,0.03)',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    gap: '0.85rem'
                                }}>
                                    <div style={{ fontWeight: 600, color: '#fff' }}>Last Import Result</div>
                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '0.5rem', fontSize: '0.9rem' }}>
                                        <div>Rows: <strong>{instantlyCsvImportResult.summary.rowsTotal}</strong></div>
                                        <div>Matched: <strong>{instantlyCsvImportResult.summary.rowsMatched}</strong></div>
                                        <div>Inserted: <strong>{instantlyCsvImportResult.summary.linksInserted}</strong></div>
                                        <div>Already linked: <strong>{instantlyCsvImportResult.summary.linksAlreadyPresent}</strong></div>
                                        <div>Contacts not found: <strong>{instantlyCsvImportResult.summary.contactsNotFound}</strong></div>
                                        <div>Unresolved campaigns: <strong>{instantlyCsvImportResult.summary.campaignNamesUnresolved}</strong></div>
                                    </div>

                                    {instantlyCsvImportResult.unresolvedCampaignNames.length > 0 && (
                                        <div>
                                            <div style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.7)', marginBottom: '0.25rem' }}>
                                                Unresolved campaign names
                                            </div>
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                                                {instantlyCsvImportResult.unresolvedCampaignNames.slice(0, 10).map((campaignName) => (
                                                    <div key={campaignName} style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: '0.5rem', alignItems: 'center' }}>
                                                        <span style={{ fontSize: '0.85rem', color: '#fca5a5', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                            {campaignName}
                                                        </span>
                                                        <select
                                                            value={instantlyCsvCampaignOverrides[campaignName] || ''}
                                                            onChange={(e) => {
                                                                const value = e.target.value;
                                                                setInstantlyCsvCampaignOverrides((prev) => ({
                                                                    ...prev,
                                                                    [campaignName]: value
                                                                }));
                                                            }}
                                                            disabled={instantlyCsvImportLoading || instantlyCsvCampaignsLoading}
                                                            style={{
                                                                width: '100%',
                                                                padding: '0.4rem 0.5rem',
                                                                borderRadius: '6px',
                                                                background: 'rgba(0,0,0,0.2)',
                                                                color: '#fff',
                                                                border: '1px solid rgba(255,255,255,0.2)'
                                                            }}
                                                        >
                                                            <option value="">Map manually...</option>
                                                            {instantlyCsvOverrideCampaigns.map((campaign) => (
                                                                <option key={campaign.id} value={campaign.id}>
                                                                    {campaign.name}
                                                                </option>
                                                            ))}
                                                        </select>
                                                    </div>
                                                ))}
                                                {!instantlyCsvCampaignsLoading && instantlyCsvOverrideCampaigns.length === 0 && (
                                                    <div style={{ fontSize: '0.8rem', color: '#fca5a5' }}>
                                                        No campaigns available in SQL cache. Sync campaigns first.
                                                    </div>
                                                )}
                                                {instantlyCsvImportResult.unresolvedCampaignNames.length > 10 && (
                                                    <div style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.6)' }}>
                                                        +{instantlyCsvImportResult.unresolvedCampaignNames.length - 10} more unresolved names
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    )}

                                    {instantlyCsvImportResult.skippedRows.length > 0 && (
                                        <div>
                                            <div style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.7)', marginBottom: '0.25rem' }}>
                                                Skipped rows (first 12)
                                            </div>
                                            <div style={{ fontSize: '0.82rem', color: 'rgba(255,255,255,0.85)', lineHeight: 1.45 }}>
                                                {instantlyCsvImportResult.skippedRows.slice(0, 12).map((item) => (
                                                    <div key={`${item.row}-${item.reason}`}>Row {item.row}: {item.reason}</div>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        <div className="modal__actions">
                            <button
                                type="button"
                                className="secondary-button secondary-button--active"
                                onClick={() => setShowInstantlyCsvImportModal(false)}
                                disabled={instantlyCsvImportLoading}
                            >
                                Close
                            </button>
                            <button
                                type="button"
                                className="primary-button"
                                onClick={handleSubmitInstantlyCsvMergeImport}
                                disabled={instantlyCsvImportLoading || !instantlyCsvImportFile}
                            >
                                {instantlyCsvImportLoading ? 'Importing...' : (instantlyCsvImportResult ? 'Re-run Import' : 'Import CSV')}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Segment Modal */}
            {segmentModalOpen && (
                <div
                    className="modal-overlay"
                    role="dialog"
                    aria-modal="true"
                    onClick={() => setSegmentModalOpen(false)}
                >
                    <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '700px', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
                        <div className="modal__header" style={{ flexShrink: 0 }}>
                            <div>
                                <h2 className="modal__title">
                                    {editingSegment ? 'Edit Segment' : 'Create Segment'}
                                </h2>
                                <p className="modal__description">
                                    Define filters to create a reusable lead segment.
                                </p>
                            </div>
                        </div>

                        <div className="modal__body" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', overflowY: 'auto', flex: 1 }}>
                            <label className="settings-field">
                                <span className="settings-field__label">Segment Name *</span>
                                <input
                                    type="text"
                                    value={segmentName}
                                    onChange={(e) => setSegmentName(e.target.value)}
                                    placeholder="e.g., High Quality Leads"
                                />
                            </label>

                            <label className="settings-field">
                                <span className="settings-field__label">Description (optional)</span>
                                <textarea
                                    value={segmentDescription}
                                    onChange={(e) => setSegmentDescription(e.target.value)}
                                    placeholder="Describe this segment..."
                                    rows={2}
                                    style={{
                                        resize: 'vertical',
                                        fontFamily: 'inherit',
                                        fontSize: 'inherit'
                                    }}
                                />
                            </label>

                            <div style={{
                                padding: '1.25rem',
                                background: 'rgba(255, 255, 255, 0.03)',
                                borderRadius: '8px',
                                border: '1px solid rgba(255, 255, 255, 0.1)'
                            }}>
                                <p className="eyebrow eyebrow--muted" style={{ marginBottom: '1rem' }}>Filters</p>

                                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                                    <label className="settings-field">
                                        <span className="settings-field__label">Full Name Contains</span>
                                        <input
                                            type="text"
                                            value={segmentFullName}
                                            onChange={(e) => setSegmentFullName(e.target.value)}
                                            placeholder="Search in founder name..."
                                        />
                                        <span className="settings-field__hint">Case-insensitive partial match</span>
                                    </label>

                                    <label className="settings-field">
                                        <span className="settings-field__label">Founder</span>
                                        <select
                                            value={segmentFounder}
                                            onChange={(e) => setSegmentFounder(e.target.value as '' | 'exists' | 'not_found')}
                                        >
                                            <option value="">Any</option>
                                            <option value="exists">Founder Exists</option>
                                            <option value="not_found">Founder Not Found</option>
                                        </select>
                                    </label>

                                    <label className="settings-field">
                                        <span className="settings-field__label">Email Status</span>
                                        <select
                                            value={segmentEmail}
                                            onChange={(e) => setSegmentEmail(e.target.value as '' | 'found' | 'not_found' | 'not_run')}
                                        >
                                            <option value="">Any</option>
                                            <option value="found">Email Found</option>
                                            <option value="not_found">Email Not Found</option>
                                            <option value="not_run">Email Not Run</option>
                                        </select>
                                    </label>

                                    <label className="settings-field">
                                        <span className="settings-field__label">Email Verification</span>
                                        <div style={{
                                            display: 'flex',
                                            flexDirection: 'column',
                                            gap: '0.5rem',
                                            marginTop: '0.5rem'
                                        }}>
                                            {['valid', 'valid-risky', 'invalid'].map((status) => (
                                                <label
                                                    key={status}
                                                    style={{
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        gap: '0.5rem',
                                                        cursor: 'pointer',
                                                        padding: '0.5rem',
                                                        borderRadius: '6px',
                                                        background: segmentEmailStatus.includes(status) ? 'rgba(59, 130, 246, 0.1)' : 'transparent'
                                                    }}
                                                >
                                                    <input
                                                        type="checkbox"
                                                        checked={segmentEmailStatus.includes(status)}
                                                        onChange={(e) => {
                                                            if (e.target.checked) {
                                                                setSegmentEmailStatus([...segmentEmailStatus, status]);
                                                            } else {
                                                                setSegmentEmailStatus(segmentEmailStatus.filter(s => s !== status));
                                                            }
                                                        }}
                                                        style={{ cursor: 'pointer' }}
                                                    />
                                                    <span style={{ textTransform: 'capitalize' }}>{status}</span>
                                                </label>
                                            ))}
                                        </div>
                                        <span className="settings-field__hint">Select one or more verification statuses</span>
                                    </label>

                                    <label className="settings-field">
                                        <span className="settings-field__label">Created After</span>
                                        <input
                                            type="date"
                                            value={segmentCreatedAfter}
                                            onChange={(e) => setSegmentCreatedAfter(e.target.value)}
                                        />
                                    </label>

                                    <label className="settings-field">
                                        <span className="settings-field__label">Created Before</span>
                                        <input
                                            type="date"
                                            value={segmentCreatedBefore}
                                            onChange={(e) => setSegmentCreatedBefore(e.target.value)}
                                        />
                                    </label>
                                </div>
                            </div>
                        </div>

                        <div className="modal__actions" style={{ flexShrink: 0, borderTop: '1px solid rgba(255, 255, 255, 0.1)', paddingTop: '1rem', marginTop: '1rem' }}>
                            <button
                                type="button"
                                className="secondary-button secondary-button--active"
                                onClick={() => setSegmentModalOpen(false)}
                                disabled={savingSegment}
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                className="primary-button"
                                onClick={handleSaveSegment}
                                disabled={savingSegment || !segmentName.trim()}
                            >
                                {savingSegment ? 'Saving...' : (editingSegment ? 'Update Segment' : 'Create Segment')}
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
                                <div style={{ 
                                    display: 'flex', 
                                    alignItems: 'center', 
                                    gap: '0.75rem',
                                    flexWrap: 'wrap'
                                }}>
                                    {selectedLead.domain && (
                                        <img 
                                            src={`https://www.google.com/s2/favicons?domain=${selectedLead.domain}&sz=64`}
                                            alt={`${selectedLead.domain} favicon`}
                                            style={{
                                                width: '32px',
                                                height: '32px',
                                                borderRadius: '6px',
                                                background: 'rgba(255, 255, 255, 0.1)',
                                                padding: '4px',
                                                flexShrink: 0
                                            }}
                                            onError={(e) => {
                                                // Hide image on error
                                                e.currentTarget.style.display = 'none';
                                            }}
                                        />
                                    )}
                                    <h2 style={{ 
                                        margin: 0, 
                                        wordBreak: 'break-word',
                                        fontSize: '1.5rem',
                                        fontWeight: 600,
                                        color: '#ffffff',
                                        flex: '1 1 auto'
                                    }}>
                                        {selectedLead.domain}
                                    </h2>
                                </div>
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
                                    {displayEmail(selectedLead.email, selectedLead.status)}
                                </div>
                            </label>

                            <label className="settings-field">
                                <span className="settings-field__label">Email Status</span>
                                <div style={{
                                    padding: '0.625rem 0',
                                    color: selectedLead.verified ? '#16a34a' : 'rgba(255, 255, 255, 0.7)'
                                }}>
                                    {displayEmailStatus(selectedLead.status)}
                                </div>
                            </label>

                            <label className="settings-field">
                                <span className="settings-field__label">Role</span>
                                <div style={{ padding: '0.625rem 0', color: 'rgba(255, 255, 255, 0.9)' }}>
                                    {selectedLead.roleType === 'founder' ? 'Founder' : selectedLead.roleType === 'dm' ? 'Decision Maker' : selectedLead.roleType || '—'}
                                </div>
                            </label>

                            {selectedLead.createdAt && (
                                <label className="settings-field">
                                    <span className="settings-field__label">Created At</span>
                                    <div style={{ padding: '0.625rem 0', color: 'rgba(255, 255, 255, 0.6)', fontSize: '0.875rem' }}>
                                        {new Date(selectedLead.createdAt).toLocaleString()}
                                    </div>
                                </label>
                            )}

                            {selectedLead.lastVerifiedAt && (
                                <label className="settings-field">
                                    <span className="settings-field__label">Last Verified At</span>
                                    <div style={{ padding: '0.625rem 0', color: 'rgba(255, 255, 255, 0.6)', fontSize: '0.875rem' }}>
                                        {new Date(selectedLead.lastVerifiedAt).toLocaleString()}
                                    </div>
                                </label>
                            )}

                            {selectedLead.campaignsData && selectedLead.campaignsData.length > 0 && (
                                <label className="settings-field">
                                    <span className="settings-field__label">Instantly Campaigns</span>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem' }}>
                                        {selectedLead.campaignsData.map((campaign, idx) => (
                                            <div
                                                key={idx}
                                                style={{
                                                    padding: '0.75rem',
                                                    background: 'rgba(59, 130, 246, 0.1)',
                                                    borderRadius: '8px',
                                                    border: '1px solid rgba(59, 130, 246, 0.25)'
                                                }}
                                            >
                                                <div style={{ fontWeight: 600, color: '#bfdbfe', marginBottom: '0.25rem' }}>
                                                    {campaign.campaignName}
                                                </div>
                                                <div style={{ fontSize: '0.8rem', color: 'rgba(255, 255, 255, 0.5)' }}>
                                                    Added: {new Date(campaign.addedAt).toLocaleString()}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </label>
                            )}

                            {selectedLead.firstLine && (
                                <label className="settings-field">
                                    <span className="settings-field__label">Personalization First Line</span>
                                    <div style={{
                                        padding: '0.75rem',
                                        backgroundColor: 'rgba(34, 197, 94, 0.1)',
                                        borderRadius: '6px',
                                        borderLeft: '3px solid rgba(34, 197, 94, 0.5)',
                                        fontStyle: 'italic',
                                        color: 'rgba(255, 255, 255, 0.9)',
                                        marginTop: '0.5rem'
                                    }}>
                                        "{selectedLead.firstLine}"
                                    </div>
                                </label>
                            )}

                            {(selectedLead.personalizationTitle || selectedLead.personalizationUrl) && (
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

                            <label className="settings-field">
                                <span className="settings-field__label">Job ID</span>
                                <div style={{
                                    padding: '0.625rem 0',
                                    color: 'rgba(255, 255, 255, 0.6)',
                                    fontFamily: 'monospace',
                                    fontSize: '0.875rem'
                                }}>
                                    {selectedLead.jobId || '—'}
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

            {/* Manual Upload Modal */}
            {showManualUploadModal && selectedJobForManual && (
                <div
                    style={{
                        position: 'fixed',
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        backgroundColor: 'rgba(0, 0, 0, 0.5)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        zIndex: 10001,
                    }}
                    onClick={() => {
                        setShowManualUploadModal(false);
                        setSelectedJobForManual(null);
                        setSelectedManualCampaign('');
                        setManualUploadNotes('');
                        setQualifiedContactsCount(null);
                    }}
                >
                    <div
                        style={{
                            backgroundColor: '#1e1e1e',
                            borderRadius: '8px',
                            padding: '24px',
                            maxWidth: '500px',
                            width: '90%',
                            maxHeight: '80vh',
                            overflowY: 'auto',
                            boxShadow: '0 4px 20px rgba(0, 0, 0, 0.5)',
                        }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <h3 style={{ margin: '0 0 16px 0', fontSize: '18px', fontWeight: 600 }}>
                            Confirm Manual Instantly Upload
                        </h3>
                        
                        <p style={{ margin: '0 0 20px 0', color: '#888', fontSize: '14px' }}>
                            Job: <strong style={{ color: '#fff' }}>{selectedJobForManual.name}</strong>
                        </p>

                        {qualifiedContactsCount !== null && (
                            <div
                                style={{
                                    padding: '12px',
                                    backgroundColor: '#2a2a2a',
                                    borderRadius: '6px',
                                    marginBottom: '20px',
                                    fontSize: '14px',
                                }}
                            >
                                <strong>{qualifiedContactsCount.qualified || 0}</strong> qualified contact{qualifiedContactsCount.qualified !== 1 ? 's' : ''} will be marked as uploaded
                                <div style={{ marginTop: '6px', fontSize: '12px', color: '#888' }}>
                                    (Valid/Risky email + Valid personalization)
                                </div>
                            </div>
                        )}

                        <div style={{ marginBottom: '16px' }}>
                            <label style={{ display: 'block', marginBottom: '8px', fontSize: '14px', fontWeight: 500 }}>
                                Select Campaign *
                            </label>
                            <select
                                value={selectedManualCampaign}
                                onChange={(e) => setSelectedManualCampaign(e.target.value)}
                                disabled={manualUploadLoading}
                                style={{
                                    width: '100%',
                                    padding: '10px',
                                    backgroundColor: '#2a2a2a',
                                    border: '1px solid #444',
                                    borderRadius: '6px',
                                    color: '#fff',
                                    fontSize: '14px',
                                    cursor: manualUploadLoading ? 'not-allowed' : 'pointer',
                                }}
                            >
                                <option value="">-- Select a campaign --</option>
                                {manualUploadCampaigns.map((campaign) => (
                                    <option key={campaign.id} value={campaign.id}>
                                        {campaign.name}
                                    </option>
                                ))}
                            </select>
                        </div>

                        <div style={{ marginBottom: '20px' }}>
                            <label style={{ display: 'block', marginBottom: '8px', fontSize: '14px', fontWeight: 500 }}>
                                Notes (Optional)
                            </label>
                            <textarea
                                value={manualUploadNotes}
                                onChange={(e) => setManualUploadNotes(e.target.value)}
                                disabled={manualUploadLoading}
                                placeholder="Add any notes about this manual upload..."
                                rows={3}
                                style={{
                                    width: '100%',
                                    padding: '10px',
                                    backgroundColor: '#2a2a2a',
                                    border: '1px solid #444',
                                    borderRadius: '6px',
                                    color: '#fff',
                                    fontSize: '14px',
                                    fontFamily: 'inherit',
                                    resize: 'vertical',
                                    cursor: manualUploadLoading ? 'not-allowed' : 'text',
                                }}
                            />
                        </div>

                        <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
                            <button
                                onClick={() => {
                                    setShowManualUploadModal(false);
                                    setSelectedJobForManual(null);
                                    setSelectedManualCampaign('');
                                    setManualUploadNotes('');
                                    setQualifiedContactsCount(null);
                                }}
                                disabled={manualUploadLoading}
                                style={{
                                    padding: '10px 20px',
                                    backgroundColor: '#2a2a2a',
                                    border: '1px solid #444',
                                    borderRadius: '6px',
                                    color: '#fff',
                                    fontSize: '14px',
                                    fontWeight: 500,
                                    cursor: manualUploadLoading ? 'not-allowed' : 'pointer',
                                    opacity: manualUploadLoading ? 0.5 : 1,
                                }}
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleConfirmManualUpload}
                                disabled={manualUploadLoading || !selectedManualCampaign}
                                style={{
                                    padding: '10px 20px',
                                    backgroundColor: selectedManualCampaign && !manualUploadLoading ? '#4CAF50' : '#2a2a2a',
                                    border: 'none',
                                    borderRadius: '6px',
                                    color: '#fff',
                                    fontSize: '14px',
                                    fontWeight: 500,
                                    cursor: !selectedManualCampaign || manualUploadLoading ? 'not-allowed' : 'pointer',
                                    opacity: !selectedManualCampaign || manualUploadLoading ? 0.5 : 1,
                                }}
                            >
                                {manualUploadLoading ? 'Processing...' : 'Confirm Upload'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}

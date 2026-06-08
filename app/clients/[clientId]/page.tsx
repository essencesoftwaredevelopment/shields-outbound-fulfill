"use client";

import { ChangeEvent, FormEvent, ReactNode, UIEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { getAccessToken } from "@/lib/supabase/session";
import {
    useJobRealtime,
    useClientJobsRealtime,
    debounceFn,
    type JobRealtimeState,
} from "@/lib/hooks/useJobRealtime";
import { useIntervalWhenVisible } from "@/lib/hooks/useIntervalWhenVisible";
import { useAuth } from "@/hooks/use-auth";
import { useAgencyId } from "@/lib/hooks/useAgencyId";
import { apiFetch, apiJson } from "@/lib/api/http";
import { createPipelineJob, getJobResultUrl, getPipelineBaseUrl } from "@/lib/pipeline/client";
import AppShell from "@/components/app-shell";
import InstantlyEventAnalyticsChart from "@/components/instantly-event-analytics-chart";
import { CalendarCheck, MessageCircleCheck, MessageCircleReply, SendHorizontal } from "lucide-react";
import {
    PipelineJob,
    PipelineStageKey,
    PipelineStageState,
    PipelineStageStatus,
} from "@/lib/pipeline/types";

/** HTTP fallback for upload / discovery — not for live pipeline progress (useJobRealtime). */
const ACTIVE_JOB_POLL_MS = 10_000;
const ACTIVE_JOB_POLL_MIN_GAP_MS = 5_000;

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

function isSingleLeadEmailSearch(value: string) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
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
    emailFindCompletedAt?: string;
    emailVerifyCompletedAt?: string;
    lastContactedAt?: string;
    jobId?: string;
    campaignCountAllTime?: number | null;
    campaignCountActive?: number | null;
    lastCampaignAddedAt?: string | null;
    campaigns?: string[];
    campaignsData?: Array<{
        campaignId: string;
        campaignName: string;
        addedAt: string;
        active?: boolean;
        lastReplyAt?: string | null;
        lastReplyCategory?: string | null;
        leadStatus?: string | null;
        interestStatus?: string | null;
        lastSyncedAt?: string | null;
        lastBounceAt?: string | null;
        timestampLastInterestChange?: string | null;
    }>;
    latestEvent?: {
        eventType?: string | null;
        replyCategory?: string | null;
        messageText?: string | null;
        replyTextSnippet?: string | null;
        eventTimestamp?: string | null;
        emailAccount?: string | null;
    } | null;
    insights?: {
        annualRevenueText?: string | null;
        annualRevenueMin?: number | null;
        annualRevenueMax?: number | null;
        usesKlaviyo?: boolean | null;
        klaviyoPercent?: number | null;
        discoveryCallHeld?: boolean | null;
        lastDiscoveryCallAt?: string | null;
        source?: string | null;
        notes?: string | null;
        attributes?: Record<string, unknown>;
    };
};

type LeadStatusChipVariant =
    | "valid"
    | "valid-risky"
    | "invalid"
    | "not-found"
    | "not-run"
    | "skipped"
    | "default";

type LeadFilterOperator = {
    key: string;
    label: string;
};

type LeadFilterOption = {
    value: string;
    label: string;
};

type LeadFilterField = {
    key: string;
    label: string;
    type: "text" | "number" | "date" | "enum" | "boolean";
    operators: LeadFilterOperator[];
    options: LeadFilterOption[];
};

type LeadFilterClause = {
    id: string;
    field: string;
    op: string;
    value: string;
    joinOp: 'AND' | 'OR'; // connector after this clause (ignored for last clause)
};

type LeadExportFieldDef = {
    key: string;
    label: string;
    group: "Lead" | "Insights" | "Campaigns" | "Events";
    defaultSelected?: boolean;
};

type InstantlySyncRun = {
    id: number;
    status: string;
    progressMessage?: string | null;
    totalCampaigns: number;
    campaignsCompleted: number;
    currentCampaignId?: string | null;
    currentCampaignName?: string | null;
    totalLeadsSeen: number;
    matchedLeads: number;
    unmatchedLeads: number;
    phase?: string | null;
    currentCampaignFetchedLeads?: number | null;
    currentCampaignLeadTotal?: number | null;
    currentCampaignProcessedLeads?: number | null;
    currentCampaignMatchedLeads?: number | null;
    currentCampaignUnmatchedLeads?: number | null;
    error?: string | null;
    startedAt?: string | null;
    completedAt?: string | null;
    updatedAt?: string | null;
    triggerSource?: string;
};

type InstantlyEventAnalyticsSummary = {
    total_events: number;
    unique_contacts: number;
    unique_campaigns: number;
    emails_sent: number;
    contacts_emailed: number;
    positive_replies: number;
    meetings_booked: number;
    reply_events: number;
    bounce_events: number;
    first_event_at: string | null;
    last_event_at: string | null;
    follow_up_sent: number;
};

type InstantlyEventAnalyticsByHourRow = {
    bucket: string;
    label: string;
    count: number;
    emails_sent?: number;
    positive_replies?: number;
    meetings_booked?: number;
};

type InstantlyEventAnalyticsPeriod = "24h" | "7d" | "30d" | "90d";

type InstantlyEventAnalyticsWindow = {
    period: InstantlyEventAnalyticsPeriod;
    label: string;
    bucketUnit: "hour" | "day";
    startAt: string;
    endAt: string;
};

type InstantlyEventAnalyticsEventTypeOption = {
    value: string;
    label: string;
};

type InstantlyEventAnalyticsRecentEvent = {
    id: string;
    event_type: string;
    reply_category?: string | null;
    lead_email?: string | null;
    contact_id?: string | null;
    email_account?: string | null;
    message_text?: string | null;
    reply_text_snippet?: string | null;
    event_timestamp: string;
    campaign_name?: string | null;
};

type InstantlyEventRealtimeConfig = {
    websocketUrl: string;
    supabaseUrl: string;
    publishableKey: string;
};

type InstantlyEventAnalyticsPayload = {
    clientSqlId: number | null;
    realtimeConfig: InstantlyEventRealtimeConfig | null;
    window: InstantlyEventAnalyticsWindow;
    eventType: InstantlyEventAnalyticsEventTypeOption;
    availableEventTypes: InstantlyEventAnalyticsEventTypeOption[];
    summary: InstantlyEventAnalyticsSummary;
    byHour: InstantlyEventAnalyticsByHourRow[];
    recentEvents: InstantlyEventAnalyticsRecentEvent[];
};

type CollatableActivityEvent = {
    id: string;
    event_type: string;
    event_timestamp: string;
    campaign_name?: string | null;
    lead_email?: string | null;
    contact_id?: string | null;
    message_text?: string | null;
    reply_text_snippet?: string | null;
    reply_category?: string | null;
    displayLabel?: string | null;
    synthetic?: boolean;
};

type CollatedActivityEvent = CollatableActivityEvent & {
    displayLabel: string;
    secondaryLabel?: string | null;
    combined?: boolean;
};

const INSTANTLY_ANALYTICS_PERIOD_OPTIONS: Array<{ value: InstantlyEventAnalyticsPeriod; label: string }> = [
    { value: "24h", label: "Last 24 hours" },
    { value: "7d", label: "Last 7 days" },
    { value: "30d", label: "Last 30 days" },
    { value: "90d", label: "Last 90 days" }
];

const INTEREST_ACTIVITY_TYPES = new Set([
    "lead_interested",
    "lead_meeting_booked",
    "lead_meeting_completed",
    "lead_closed",
    "lead_not_interested",
    "lead_wrong_person",
    "lead_neutral",
    "lead_no_show",
    "lead_out_of_office",
    "interest_change"
]);

const ACTIVITY_COLLATION_WINDOW_MS = 60 * 1000;
const POSITIVE_ACTIVITY_LABELS = new Set(["interested", "meeting booked", "meeting completed", "closed won", "won"]);
const NEGATIVE_ACTIVITY_LABELS = new Set(["not interested", "wrong person", "lost", "bad fit", "risky", "bounced"]);
const NEUTRAL_ACTIVITY_LABELS = new Set(["out of office", "neutral", "no show", "unsubscribed"]);

const INTERESTED_PENDING_REVIEW_LAST_EVENT_TYPES = new Set([
    "lead_interested",
    "interested",
    "reply_received",
    "interested_reply_sent",
    "email_sent",
    "email_opened",
    "email_link_clicked",
    "state_sync",
]);

function isPendingReviewDraftCurrentlyInterested(draft: {
    interest_status?: number | null;
    last_event_type?: string | null;
}) {
    if (typeof draft.interest_status === "number" && draft.interest_status !== 1) {
        return false;
    }
    const lastEventType = String(draft.last_event_type || "").trim().toLowerCase();
    if (!lastEventType) return true;
    return INTERESTED_PENDING_REVIEW_LAST_EVENT_TYPES.has(lastEventType);
}

const ACTIVE_INSTANTLY_SYNC_STATUSES = new Set(['queued', 'running', 'cancelling']);
const INSTANTLY_SYNC_POLL_MS = 5000;

const LEAD_EXPORT_FIELDS: LeadExportFieldDef[] = [
    { key: 'founder_name', label: 'Founder Name', group: 'Lead', defaultSelected: true },
    { key: 'email', label: 'Email', group: 'Lead', defaultSelected: true },
    { key: 'status', label: 'Status', group: 'Lead', defaultSelected: true },
    { key: 'domain', label: 'Domain', group: 'Lead', defaultSelected: true },
    { key: 'first_line', label: 'First Line', group: 'Lead', defaultSelected: true },
    { key: 'created_at', label: 'Created At', group: 'Lead' },
    { key: 'updated_at', label: 'Updated At', group: 'Lead', defaultSelected: true },
    { key: 'email_find_completed_at', label: 'Email Find Completed', group: 'Lead' },
    { key: 'email_verify_completed_at', label: 'Email Verify Completed', group: 'Lead' },
    { key: 'last_contacted_at', label: 'Last Contacted At', group: 'Lead' },
    { key: 'role_type', label: 'Role Type', group: 'Lead' },
    { key: 'job_id', label: 'Job ID', group: 'Lead' },
    { key: 'annual_revenue_text', label: 'Annual Revenue Text', group: 'Insights' },
    { key: 'annual_revenue_min', label: 'Annual Revenue Min', group: 'Insights' },
    { key: 'annual_revenue_max', label: 'Annual Revenue Max', group: 'Insights' },
    { key: 'uses_klaviyo', label: 'Uses Klaviyo', group: 'Insights' },
    { key: 'klaviyo_percent', label: 'Klaviyo Percent', group: 'Insights' },
    { key: 'discovery_call_held', label: 'Discovery Call Held', group: 'Insights' },
    { key: 'last_discovery_call_at', label: 'Last Discovery Call At', group: 'Insights' },
    { key: 'insight_source', label: 'Insight Source', group: 'Insights' },
    { key: 'insight_notes', label: 'Insight Notes', group: 'Insights' },
    { key: 'campaign_names', label: 'Campaign Names', group: 'Campaigns', defaultSelected: true },
    { key: 'campaign_count_all_time', label: 'Campaign Count All Time', group: 'Campaigns' },
    { key: 'campaign_count_active', label: 'Active Campaign Count', group: 'Campaigns' },
    { key: 'added_to_campaign_at', label: 'Added To Campaign', group: 'Campaigns' },
    { key: 'latest_campaign_name', label: 'Latest Campaign Name', group: 'Campaigns' },
    { key: 'latest_campaign_lead_status', label: 'Latest Campaign Lead Status', group: 'Campaigns' },
    { key: 'latest_campaign_interest_status', label: 'Latest Campaign Interest Status', group: 'Campaigns' },
    { key: 'latest_campaign_last_reply_at', label: 'Latest Campaign Last Reply At', group: 'Campaigns' },
    { key: 'latest_campaign_last_bounce_at', label: 'Latest Campaign Last Bounce At', group: 'Campaigns' },
    { key: 'latest_event_type', label: 'Latest Event Type', group: 'Events' },
    { key: 'latest_event_at', label: 'Latest Event At', group: 'Events' },
    { key: 'latest_event_reply_category', label: 'Latest Event Reply Category', group: 'Events' },
    { key: 'latest_event_message_text', label: 'Latest Event Message Text', group: 'Events' },
    { key: 'latest_event_reply_text_snippet', label: 'Latest Event Reply Text Snippet', group: 'Events' },
    { key: 'latest_event_email_account', label: 'Latest Event Email Account', group: 'Events' }
];

const DEFAULT_LEAD_EXPORT_FIELD_KEYS = LEAD_EXPORT_FIELDS
    .filter((field) => field.defaultSelected)
    .map((field) => field.key);

const LEAD_EXPORT_ROW_LIMIT_PRESETS = [100, 500, 1000, 5000] as const;
const DEFAULT_LEAD_EXPORT_MAX_ROWS = 1000;
const LEAD_EXPORT_MAX_ROWS_CAP = 1_000_000;

function createLeadFilterId() {
    return `lead-filter-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function formatInstantlyActivityLabel(eventType: string, fallbackLabel?: string | null) {
    const normalized = String(fallbackLabel || eventType || "unknown").toLowerCase().replace(/[_ ]+/g, " ").trim();
    if (normalized === "reply received" || normalized === "reply" || normalized === "replied") return "Reply received";
    if (normalized === "interested reply sent") return "Autoresponder reply";
    if (normalized === "email sent") return "Email sent";
    if (normalized === "email opened") return "Email opened";
    if (normalized === "email link clicked") return "Link clicked";
    if (normalized === "email bounced") return "Email bounced";
    if (normalized === "lead unsubscribed") return "Unsubscribed";
    if (normalized === "lead interested") return "Interested";
    if (normalized === "lead meeting booked") return "Meeting booked";
    if (normalized === "meeting booked") return "Meeting booked";
    if (normalized === "meeting canceled" || normalized === "meeting cancelled") return "Meeting canceled";
    if (normalized === "lead meeting completed") return "Meeting completed";
    if (normalized === "lead closed") return "Closed won";
    if (normalized === "lead out of office") return "Out of office";
    if (normalized === "lead not interested") return "Not interested";
    if (normalized === "lead wrong person") return "Wrong person";
    if (normalized === "lead neutral") return "Neutral";
    if (normalized === "lead no show") return "No show";
    if (normalized === "warm follow up") return "Marked as warm follow up";
    if (String(eventType || "").toLowerCase() === "interest_change") {
        return `Marked as ${normalized}`;
    }
    if (normalized === "state sync") return "State sync";
    return normalized.replace(/\b(\w)/g, (match) => match.toUpperCase());
}

function getActivityDisplayTone(label?: string | null) {
    const normalized = String(label || "").toLowerCase().replace(/[_ ]+/g, " ").trim();
    if (POSITIVE_ACTIVITY_LABELS.has(normalized)) return "positive";
    if (NEGATIVE_ACTIVITY_LABELS.has(normalized)) return "negative";
    if (NEUTRAL_ACTIVITY_LABELS.has(normalized)) return "neutral";
    if (normalized === "warm follow up" || normalized === "marked as warm follow up") return "manual";
    return "default";
}

function getInstantlyActivityColor(eventType: string, fallbackLabel?: string | null) {
    const normalized = String(eventType || "").toLowerCase();
    const displayLabel = formatInstantlyActivityLabel(eventType, fallbackLabel);
    const displayTone = getActivityDisplayTone(displayLabel);
    if (normalized === "interested_reply_sent") return "var(--app-event-auto-reply)";
    if (normalized === "email_sent") return "var(--app-event-email-sent)";
    if (normalized === "email_opened") return "var(--app-event-email-opened)";
    if (normalized === "email_link_clicked") return "var(--app-event-link-clicked)";
    if (normalized === "warm follow up" || normalized === "warm_follow_up" || displayTone === "manual") return "var(--app-event-warm-followup)";
    if (normalized === "reply_received" || normalized === "lead_interested" || normalized === "lead_meeting_booked" || normalized === "lead_meeting_completed" || normalized === "lead_closed" || normalized === "meeting_booked") {
        return "var(--app-event-positive)";
    }
    if (normalized === "email_bounced" || normalized === "lead_not_interested" || normalized === "lead_wrong_person" || normalized === "lead_no_show") {
        return "var(--app-event-negative)";
    }
    if (normalized === "lead_unsubscribed" || normalized === "lead_out_of_office") {
        return "var(--app-event-warning)";
    }
    if (normalized === "lead_neutral") {
        return "var(--app-event-neutral)";
    }
    if (normalized === "interest_change") {
        if (displayTone === "positive") return "var(--app-event-positive)";
        if (displayTone === "negative") return "var(--app-event-negative)";
        if (displayTone === "neutral") return "var(--app-event-neutral)";
    }
    return "var(--app-event-default)";
}

function isReplyActivityEvent(eventType: string) {
    const normalized = String(eventType || "").toLowerCase();
    return normalized === "reply_received" || normalized === "reply" || normalized === "replied";
}

function isInterestActivityEvent(event: CollatableActivityEvent) {
    const normalized = String(event.event_type || "").toLowerCase();
    if (INTEREST_ACTIVITY_TYPES.has(normalized)) return true;
    return normalized === "interest_change" || Boolean(event.synthetic && event.displayLabel);
}

function getActivityEventTimeMs(event: CollatableActivityEvent) {
    const ts = new Date(event.event_timestamp).getTime();
    return Number.isNaN(ts) ? null : ts;
}

function getActivityEventGroupKey(event: CollatableActivityEvent) {
    const email = String(event.lead_email || "").trim().toLowerCase();
    const campaign = String(event.campaign_name || "").trim().toLowerCase();
    return `${email}::${campaign}`;
}

function buildCollatedActivityEvents<T extends CollatableActivityEvent>(events: T[]) {
    if (!Array.isArray(events) || events.length === 0) return [] as Array<T & CollatedActivityEvent>;

    const dedupedEvents = events.filter((event) => {
        if (!event.synthetic || !isInterestActivityEvent(event)) return true;

        const eventMs = getActivityEventTimeMs(event);
        if (eventMs === null) return true;

        return !events.some((candidate) => {
            if (candidate.id === event.id || candidate.synthetic || !isInterestActivityEvent(candidate)) return false;
            if (getActivityEventGroupKey(candidate) !== getActivityEventGroupKey(event)) return false;
            const candidateMs = getActivityEventTimeMs(candidate);
            if (candidateMs === null) return false;
            return Math.abs(candidateMs - eventMs) <= ACTIVITY_COLLATION_WINDOW_MS;
        });
    });

    const usedIds = new Set<string>();
    const collatedEvents: Array<T & CollatedActivityEvent> = [];
    const sortedEvents = [...dedupedEvents].sort((a, b) => {
        const timeDiff = (getActivityEventTimeMs(b) || 0) - (getActivityEventTimeMs(a) || 0);
        if (timeDiff !== 0) return timeDiff;
        return String(b.id).localeCompare(String(a.id));
    });

    for (const event of sortedEvents) {
        if (usedIds.has(event.id)) continue;

        const eventMs = getActivityEventTimeMs(event);
        const canPair = eventMs !== null && (isReplyActivityEvent(event.event_type) || isInterestActivityEvent(event));

        if (canPair) {
            const counterpart = sortedEvents
                .filter((candidate) => {
                    if (candidate.id === event.id || usedIds.has(candidate.id)) return false;
                    const candidateMs = getActivityEventTimeMs(candidate);
                    if (candidateMs === null) return false;
                    if (getActivityEventGroupKey(candidate) !== getActivityEventGroupKey(event)) return false;
                    if (Math.abs(candidateMs - eventMs) > ACTIVITY_COLLATION_WINDOW_MS) return false;

                    const eventIsReply = isReplyActivityEvent(event.event_type);
                    const candidateIsReply = isReplyActivityEvent(candidate.event_type);
                    const eventIsInterest = isInterestActivityEvent(event);
                    const candidateIsInterest = isInterestActivityEvent(candidate);
                    return (eventIsReply && candidateIsInterest) || (eventIsInterest && candidateIsReply);
                })
                .sort((a, b) => {
                    const aMs = getActivityEventTimeMs(a) || 0;
                    const bMs = getActivityEventTimeMs(b) || 0;
                    const diffA = Math.abs(aMs - eventMs);
                    const diffB = Math.abs(bMs - eventMs);
                    if (diffA !== diffB) return diffA - diffB;
                    if (Boolean(a.synthetic) !== Boolean(b.synthetic)) return a.synthetic ? 1 : -1;
                    return String(a.id).localeCompare(String(b.id));
                })[0];

            if (counterpart) {
                usedIds.add(event.id);
                usedIds.add(counterpart.id);

                const replyEvent = isReplyActivityEvent(event.event_type) ? event : counterpart;
                const interestEvent = isInterestActivityEvent(event) ? event : counterpart;
                const mergedTimestamp = new Date(
                    Math.max(getActivityEventTimeMs(replyEvent) || 0, getActivityEventTimeMs(interestEvent) || 0)
                ).toISOString();
                const primaryEvent = interestEvent;
                const displayLabel = formatInstantlyActivityLabel(primaryEvent.event_type, primaryEvent.displayLabel);
                const secondaryLabel = formatInstantlyActivityLabel(replyEvent.event_type, replyEvent.displayLabel);

                collatedEvents.push({
                    ...(primaryEvent as T),
                    id: `${primaryEvent.id}::${replyEvent.id}`,
                    event_type: primaryEvent.event_type,
                    event_timestamp: mergedTimestamp,
                    campaign_name: primaryEvent.campaign_name || replyEvent.campaign_name || null,
                    lead_email: primaryEvent.lead_email || replyEvent.lead_email || null,
                    message_text: replyEvent.message_text || primaryEvent.message_text || null,
                    reply_text_snippet: replyEvent.reply_text_snippet || primaryEvent.reply_text_snippet || null,
                    reply_category: replyEvent.reply_category || primaryEvent.reply_category || null,
                    displayLabel,
                    secondaryLabel: secondaryLabel === displayLabel ? null : secondaryLabel,
                    combined: true
                });
                continue;
            }
        }

        usedIds.add(event.id);
        collatedEvents.push({
            ...(event as T),
            displayLabel: formatInstantlyActivityLabel(event.event_type, event.displayLabel)
        });
    }

    return collatedEvents.sort((a, b) => {
        const timeDiff = (getActivityEventTimeMs(b) || 0) - (getActivityEventTimeMs(a) || 0);
        if (timeDiff !== 0) return timeDiff;
        return String(b.id).localeCompare(String(a.id));
    });
}

function getLeadCampaignNames(lead: Lead): string[] {
    if (Array.isArray(lead.campaignsData) && lead.campaignsData.length > 0) {
        return lead.campaignsData
            .map((campaign) => campaign.campaignName)
            .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    }
    if (Array.isArray(lead.campaigns) && lead.campaigns.length > 0) {
        return lead.campaigns.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    }
    return [];
}

function csvEscape(value: unknown): string {
    const normalized = value == null ? "" : String(value);
    return `"${normalized.replace(/"/g, '""')}"`;
}

function getLeadExportValue(lead: Lead, key: string): unknown {
    const latestCampaign = Array.isArray(lead.campaignsData) && lead.campaignsData.length > 0
        ? lead.campaignsData[0]
        : null;

    switch (key) {
    case 'founder_name':
        return lead.founderName || '';
    case 'email':
        return lead.email || '';
    case 'status':
        return lead.status || '';
    case 'domain':
        return lead.domain || '';
    case 'first_line':
        return lead.firstLine || '';
    case 'created_at':
        return lead.createdAt || '';
    case 'updated_at':
        return lead.updatedAt || '';
    case 'email_find_completed_at':
        return lead.emailFindCompletedAt || '';
    case 'email_verify_completed_at':
        return lead.emailVerifyCompletedAt || '';
    case 'last_contacted_at':
        return lead.lastContactedAt || '';
    case 'role_type':
        return lead.roleType || '';
    case 'job_id':
        return lead.jobId || '';
    case 'annual_revenue_text':
        return lead.insights?.annualRevenueText || '';
    case 'annual_revenue_min':
        return lead.insights?.annualRevenueMin ?? '';
    case 'annual_revenue_max':
        return lead.insights?.annualRevenueMax ?? '';
    case 'uses_klaviyo':
        return lead.insights?.usesKlaviyo == null ? '' : (lead.insights.usesKlaviyo ? 'Yes' : 'No');
    case 'klaviyo_percent':
        return lead.insights?.klaviyoPercent ?? '';
    case 'discovery_call_held':
        return lead.insights?.discoveryCallHeld == null ? '' : (lead.insights.discoveryCallHeld ? 'Yes' : 'No');
    case 'last_discovery_call_at':
        return lead.insights?.lastDiscoveryCallAt || '';
    case 'insight_source':
        return lead.insights?.source || '';
    case 'insight_notes':
        return lead.insights?.notes || '';
    case 'campaign_names':
        return getLeadCampaignNames(lead).join('; ');
    case 'campaign_count_all_time':
        return lead.campaignCountAllTime ?? '';
    case 'campaign_count_active':
        return lead.campaignCountActive ?? '';
    case 'added_to_campaign_at':
        return lead.lastCampaignAddedAt || '';
    case 'latest_campaign_name':
        return latestCampaign?.campaignName || '';
    case 'latest_campaign_lead_status':
        return latestCampaign?.leadStatus || '';
    case 'latest_campaign_interest_status':
        return latestCampaign?.interestStatus || '';
    case 'latest_campaign_last_reply_at':
        return latestCampaign?.lastReplyAt || '';
    case 'latest_campaign_last_bounce_at':
        return latestCampaign?.lastBounceAt || '';
    case 'latest_event_type':
        return lead.latestEvent?.eventType || '';
    case 'latest_event_at':
        return lead.latestEvent?.eventTimestamp || '';
    case 'latest_event_reply_category':
        return lead.latestEvent?.replyCategory || '';
    case 'latest_event_message_text':
        return lead.latestEvent?.messageText || '';
    case 'latest_event_reply_text_snippet':
        return lead.latestEvent?.replyTextSnippet || '';
    case 'latest_event_email_account':
        return lead.latestEvent?.emailAccount || '';
    default:
        return '';
    }
}

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

type FollowUpScript = {
    id: number;
    client_id: number;
    active: boolean;
    script_order: number;
    html_template: string;
    text_template: string | null;
    created_at: string;
    updated_at: string;
};

type InterestedAutoResponderPrompt = {
    id: number;
    agency_id: string;
    client_id: number;
    campaign_id: number;
    campaign_name: string;
    version: string;
    system_prompt: string;
    active: boolean;
    created_at: string;
    updated_at: string;
};

type FollowUpPreviewPayload = {
    contactId: number;
    contactEmail: string;
    campaignId: number;
    vars: Record<string, string>;
    renderedHtml: string;
    renderedText: string;
};

type InstantlyCsvMergeResult = {    summary: {
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

const formatInstantlySyncPhase = (phase?: string | null) => {
    if (!phase) return null;
    switch (phase) {
        case "fetching_campaigns":
            return "Fetching campaign list";
        case "processing_campaigns":
            return "Preparing campaign sync";
        case "fetching_campaign_leads":
            return "Fetching campaign leads";
        case "processing_campaign_leads":
            return "Processing campaign leads";
        case "campaign_completed":
            return "Campaign completed";
        case "completed":
            return "Completed";
        case "cancelled":
            return "Cancelled";
        case "failed":
            return "Failed";
        default:
            return humanizeKey(phase);
    }
};

const describeStageProgress = (stage?: PipelineStageState) => {
    if (!stage) {
        return "Awaiting scheduler.";
    }
    const processed = typeof stage.progress?.processed === "number" ? stage.progress.processed : null;
    const total = typeof stage.progress?.total === "number" ? stage.progress.total : null;

    if (processed !== null && total) {
        const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
        return `${processed.toLocaleString()} / ${total.toLocaleString()} (${pct}%)`;
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
    // Once a stage is completed, `summary` is canonical. `progress` can still
    // hold stale or sub-step values written before completion (e.g. founders
    // briefly using batch counters), so prefer summary in that case to avoid
    // displaying numbers that were never the user-facing totals.
    const preferSummary = stage?.status === "completed" || stage?.status === "error";
    const progressTotal = typeof progress?.total === "number" && Number.isFinite(progress.total) ? progress.total : null;
    const summaryTotal = extractNumberFrom(summary, ["total", "queued", "attempted"]);
    const statsTotal = extractNumberFrom(stats, ["total", "queued", "attempted"]);

    // if it's the founders stage, or email find stage, use found
    // if it's the verification stage, use verified/valid
    const throughputNum =
        stageName === "domainPrep" ?
            extractNumberFrom(summary, ["processable", "live"])
            ?? extractNumberFrom(stats, ["processable", "live"])
            : stageName === "founders" || stageName === "emailDiscovery" ?
            (preferSummary
                ? (extractNumberFrom(summary, ["Found", "found"])
                    ?? extractNumberFrom(stats, ["Found", "found"])
                    ?? (typeof progress?.found === "number" && Number.isFinite(progress.found) ? progress.found : null))
                : (extractNumberFrom(stats, ["Found", "found"])
                    ?? (typeof progress?.found === "number" && Number.isFinite(progress.found) ? progress.found : null)
                    ?? extractNumberFrom(summary, ["Found", "found", "processed", "completed", "personalized"])))
            : stageName === "verification" ?
                extractNumberFrom(summary, ["Valid", "valid"])
                ?? extractNumberFrom(stats, ["valid"])
                : stageName === "personalization" ?
                    extractNumberFrom(stats, ["personalized", "Personalized"])
                    ?? (typeof progress?.processed === "number" && Number.isFinite(progress.processed)
                        ? progress.processed
                        : null)
                    ?? extractNumberFrom(summary, ["personalized", "Personalized"]) : null;

    const total = preferSummary
        ? (summaryTotal ?? statsTotal ?? progressTotal)
        : (progressTotal ?? statsTotal ?? summaryTotal);

    return { throughputNum, total };
};

const parseCostValue = (value: unknown): number | null => {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === "string") {
        const parsed = parseFloat(value.replace(/[^0-9.-]/g, ""));
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
};

/** Stage cost from summary and/or in-flight progress (Realtime while running). */
const stageCostFromStage = (stage?: PipelineStageState): number | null => {
    if (!stage) return null;
    const summary = stage.summary as Record<string, unknown> | null | undefined;
    const progress = stage.progress;
    const stats = progress?.stats as Record<string, unknown> | undefined;
    const candidates = [
        summary?.cost,
        progress?.cost,
        summary?.["Estimated Cost"],
        progress?.["Estimated Cost"],
        summary?.Cost,
        progress?.Cost,
        stats?.cost,
        stats?.Cost,
    ];
    for (const value of candidates) {
        const parsed = parseCostValue(value);
        if (parsed !== null && parsed >= 0) return parsed;
    }
    return null;
};

/** Stages that participate in the per-stage ETA estimator. Domain prep is excluded
 *  (it completes too quickly and has no meaningful per-item rate). */
const ETA_STAGES: PipelineStageKey[] = ["founders", "emailDiscovery", "verification", "personalization"];
/** Max number of (timestamp, processed) samples retained per stage. */
const STAGE_ETA_WINDOW = 300;

const formatEtaShort = (ms: number): string => {
    if (!Number.isFinite(ms) || ms <= 0) return "";
    const totalSeconds = Math.round(ms / 1000);
    const seconds = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    if (totalMinutes < 1) return `${seconds}s`;
    const minutes = totalMinutes % 60;
    const hours = Math.floor(totalMinutes / 60);
    if (hours < 1) return `${minutes}m ${seconds}s`;
    return `${hours}h ${minutes}m ${seconds}s`;
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
    const dedupedTotal = deriveDedupedDomainBaseline(job);
    let processed = 0;
    let total = dedupedTotal ?? 0;

    // Prefer the active stage; otherwise the last stage with progress in pipeline order.
    const activeKey =
        STAGE_ORDER.find((key) => job.stages?.[key]?.status === "running")
        ?? [...STAGE_ORDER].reverse().find((key) => {
            const stage = job.stages?.[key];
            return (
                stage
                && (stage.status === "completed" || stage.status === "running")
                && (
                    typeof stage.progress?.total === "number"
                    || deriveStageTotals(stage).total
                )
            );
        });

    if (activeKey) {
        const stage = job.stages[activeKey];
        const stageTotals = deriveStageTotals(stage);
        if (stageTotals.total) {
            total = stageTotals.total;
        } else if (typeof stage.progress?.total === "number" && stage.progress.total > 0) {
            total = stage.progress.total;
        }
        if (typeof stage.progress?.processed === "number") {
            processed = stage.progress.processed;
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
    const { agencyId } = useAgencyId();
    const allowedTabs = ["analytics", "info", "campaigns", "leads", "personalizer", "follow-ups"] as const;
    type ClientTab = typeof allowedTabs[number];
    const initialTab = searchParams?.get("tab");

    const [activeTab, setActiveTab] = useState<ClientTab>(
        initialTab && allowedTabs.includes(initialTab as ClientTab) ? (initialTab as ClientTab) : "analytics"
    );
    const [clientName, setClientName] = useState<string>(clientId);
    const [clientIndustry, setClientIndustry] = useState<Niche["id"]>("ecom");
    const [clientInstantlyKey, setClientInstantlyKey] = useState<string>("");
    const [clientNtfyTopic, setClientNtfyTopic] = useState<string>("");
    const [clientSqlId, setClientSqlId] = useState<number | null>(null);
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

    // Follow-up scripts state
    const [followUpScripts, setFollowUpScripts] = useState<FollowUpScript[]>([]);
    const [followUpScriptsLoading, setFollowUpScriptsLoading] = useState(false);
    const [followUpScriptModalOpen, setFollowUpScriptModalOpen] = useState(false);
    const [editingFollowUpScript, setEditingFollowUpScript] = useState<FollowUpScript | null>(null);
    const [savingFollowUpScript, setSavingFollowUpScript] = useState(false);
    const [updatingFollowUpScriptId, setUpdatingFollowUpScriptId] = useState<number | null>(null);
    const [deletingFollowUpScriptId, setDeletingFollowUpScriptId] = useState<number | null>(null);
    const [followUpPreviewModalOpen, setFollowUpPreviewModalOpen] = useState(false);
    const [previewingFollowUpScript, setPreviewingFollowUpScript] = useState<FollowUpScript | null>(null);
    // Follow-up schedule (DOW: 0=Sun … 6=Sat). Weekdays by default.
    const [followUpSendDays, setFollowUpSendDays] = useState<number[]>([1, 2, 3, 4, 5]);
    const [savingFollowUpSchedule, setSavingFollowUpSchedule] = useState(false);
    const [followUpPreviewLeadSearch, setFollowUpPreviewLeadSearch] = useState('');
    const [debouncedFollowUpPreviewLeadSearch, setDebouncedFollowUpPreviewLeadSearch] = useState('');
    const [followUpPreviewLeadResults, setFollowUpPreviewLeadResults] = useState<Lead[]>([]);
    const [followUpPreviewSearching, setFollowUpPreviewSearching] = useState(false);
    const [followUpPreviewSelectedLead, setFollowUpPreviewSelectedLead] = useState<Lead | null>(null);
    const [followUpPreviewLoading, setFollowUpPreviewLoading] = useState(false);
    const [followUpPreviewResult, setFollowUpPreviewResult] = useState<FollowUpPreviewPayload | null>(null);
    const [fuScriptOrder, setFuScriptOrder] = useState(1);
    const [fuScriptActive, setFuScriptActive] = useState(true);
    const [fuScriptHtml, setFuScriptHtml] = useState('');
    const [fuScriptText, setFuScriptText] = useState('');
    const [interestedAutoResponderPrompts, setInterestedAutoResponderPrompts] = useState<InterestedAutoResponderPrompt[]>([]);
    const [interestedAutoResponderPromptsLoading, setInterestedAutoResponderPromptsLoading] = useState(false);
    const [autoResponderCampaigns, setAutoResponderCampaigns] = useState<Campaign[]>([]);
    const [autoResponderPromptModalOpen, setAutoResponderPromptModalOpen] = useState(false);
    const [editingAutoResponderPrompt, setEditingAutoResponderPrompt] = useState<InterestedAutoResponderPrompt | null>(null);
    const [savingAutoResponderPrompt, setSavingAutoResponderPrompt] = useState(false);
    const [deletingAutoResponderPromptId, setDeletingAutoResponderPromptId] = useState<number | null>(null);
    const [autoResponderPromptCampaignId, setAutoResponderPromptCampaignId] = useState('');
    const [autoResponderPromptVersion, setAutoResponderPromptVersion] = useState('v1');
    const [autoResponderPromptSystemPrompt, setAutoResponderPromptSystemPrompt] = useState('');
    const [autoResponderPromptActive, setAutoResponderPromptActive] = useState(true);
    const [autoResponderTestModalOpen, setAutoResponderTestModalOpen] = useState(false);
    const [testingAutoResponderPrompt, setTestingAutoResponderPrompt] = useState<InterestedAutoResponderPrompt | null>(null);
    const [autoResponderTestLeadSearch, setAutoResponderTestLeadSearch] = useState('');
    const [debouncedAutoResponderTestLeadSearch, setDebouncedAutoResponderTestLeadSearch] = useState('');
    const [autoResponderTestLeadResults, setAutoResponderTestLeadResults] = useState<Lead[]>([]);
    const [autoResponderTestLeadSearching, setAutoResponderTestLeadSearching] = useState(false);
    const [autoResponderTestSelectedLead, setAutoResponderTestSelectedLead] = useState<Lead | null>(null);
    const [autoResponderTestLoading, setAutoResponderTestLoading] = useState(false);
    const [autoResponderTestResult, setAutoResponderTestResult] = useState<{
        renderedText: string;
        model: string;
        promptVersion: string;
        reviewUrl?: string;
        debug?: {
            lead: { email: string; name?: string | null; firstName?: string | null; companyDomain?: string | null; roleType?: string | null };
            sender: { eaccount?: string | null; firstName?: string | null; lastName?: string | null };
            threadSubject?: string | null;
            renderedSystemPrompt?: string | null;
            contextSentToAI?: { campaignName?: string; leadEmail?: string; threadSubject?: string | null; previousLeadMessage?: string | null };
        };
    } | null>(null);
    const [autoResponderTestMessage, setAutoResponderTestMessage] = useState('');
    const [autoResponderTestExpandedSteps, setAutoResponderTestExpandedSteps] = useState<Set<number>>(new Set());

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
    const lastWatchedJobIdRef = useRef<string | null>(null);
    const lastActiveStatusRef = useRef<string | null>(null);
    const previousJobIdRef = useRef<string | null>(null);
    const lastUploadErrorRef = useRef<string | null>(null);
    const lastActiveJobSnapshotRef = useRef<string | null>(null);
    const activeJobPollInFlightRef = useRef(false);
    const lastActiveJobPollAtRef = useRef(0);
    const pollActiveJobRef = useRef<((force?: boolean) => Promise<void>) | null>(null);
    const jobStateRef = useRef<PipelineJob | null>(null);
    const lastFetchTimeRef = useRef<number>(0);
    const isFetchingRef = useRef<boolean>(false);
    const currentJobStatusRef = useRef<string | null>(null);
    /** Per-job, per-stage rolling buffer of (timestamp, processed) samples for the ETA estimator. */
    const stageEtaSamplesRef = useRef<{
        jobId: string | null;
        buffers: Partial<Record<PipelineStageKey, Array<{ t: number; processed: number }>>>;
    }>({ jobId: null, buffers: {} });
    const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
    const [realtimeJobId, setRealtimeJobId] = useState<string | null>(null);
    const [activeJobStatus, setActiveJobStatus] = useState<string | null>(null);

    const [uploadMetrics, setUploadMetrics] = useState<{ count: number; total: number } | null>(null);
    const [instantlyUploadError, setInstantlyUploadError] = useState<string | null>(null);
    const [isSavingClient, setIsSavingClient] = useState(false);
    const [isDeletingClient, setIsDeletingClient] = useState(false);
    const [deletingJobId, setDeletingJobId] = useState<string | null>(null);
    const [pausingJob, setPausingJob] = useState(false);
    const pendingPauseControlRef = useRef<'pause' | 'resume' | null>(null);
    const [stoppingJob, setStoppingJob] = useState(false);
    const [pipelineVisible, setPipelineVisible] = useState(true);
    const [expandedErrorJobId, setExpandedErrorJobId] = useState<string | null>(null);
    const [downloadScope, setDownloadScope] = useState<'all' | 'valid'>('valid');
    const [downloadModalOpen, setDownloadModalOpen] = useState(false);
    const [jobPendingUpload, setJobPendingUpload] = useState<string | null>(null);

    const [jobUploadStatus, setJobUploadStatus] = useState<Record<string, any[]>>({});
    // Verification CSV import state
    const [verificationImportModalOpen, setVerificationImportModalOpen] = useState(false);
    const [verificationImportFile, setVerificationImportFile] = useState<File | null>(null);
    const [verificationImportStep, setVerificationImportStep] = useState<1 | 2>(1);
    const [verificationImportHeaders, setVerificationImportHeaders] = useState<string[]>([]);
    const [verificationImportPreviewRows, setVerificationImportPreviewRows] = useState<Record<string, string>[]>([]);
    const [verificationImportTotalRows, setVerificationImportTotalRows] = useState<number>(0);
    const [verificationImportEmailCol, setVerificationImportEmailCol] = useState('');
    const [verificationImportStatusCol, setVerificationImportStatusCol] = useState('');
    const [verificationImportVerifiedAtCol, setVerificationImportVerifiedAtCol] = useState('');
    const [verificationImportParsing, setVerificationImportParsing] = useState(false);
    const [verificationImportLoading, setVerificationImportLoading] = useState(false);
    const [verificationImportResult, setVerificationImportResult] = useState<{
        totalRows: number;
        matched: number;
        updated: number;
        skipped: number;
        notFound: number;
    } | null>(null);

    const [showInstantlyCsvImportModal, setShowInstantlyCsvImportModal] = useState(false);
    const [instantlyCsvImportFile, setInstantlyCsvImportFile] = useState<File | null>(null);
    const [instantlyCsvImportNotes, setInstantlyCsvImportNotes] = useState('');
    const [instantlyCsvImportLoading, setInstantlyCsvImportLoading] = useState(false);
    const [instantlyCsvImportResult, setInstantlyCsvImportResult] = useState<InstantlyCsvMergeResult | null>(null);
    const [instantlyCsvOverrideCampaigns, setInstantlyCsvOverrideCampaigns] = useState<Campaign[]>([]);
    const [instantlyCsvCampaignOverrides, setInstantlyCsvCampaignOverrides] = useState<Record<string, string>>({});
    const [instantlyCsvCampaignsLoading, setInstantlyCsvCampaignsLoading] = useState(false);
    const [registeringInstantlyWebhook, setRegisteringInstantlyWebhook] = useState(false);
    const [instantlySyncCampaignId, setInstantlySyncCampaignId] = useState('');
    const [syncingInstantlyState, setSyncingInstantlyState] = useState(false);
    const [syncingInstantlyEmailAccounts, setSyncingInstantlyEmailAccounts] = useState(false);
    const [stoppingInstantlySync, setStoppingInstantlySync] = useState(false);
    const [clientInstantlyWebhookStatus, setClientInstantlyWebhookStatus] = useState<number | null>(null);
    const [clientInstantlyWebhookUpdatedAt, setClientInstantlyWebhookUpdatedAt] = useState<string | null>(null);
    const [instantlySyncRun, setInstantlySyncRun] = useState<InstantlySyncRun | null>(null);
    const instantlySyncPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const previousInstantlySyncStatusRef = useRef<string | null>(null);
    const [instantlyEventAnalytics, setInstantlyEventAnalytics] = useState<InstantlyEventAnalyticsPayload | null>(null);
    const [instantlyEventAnalyticsPeriod, setInstantlyEventAnalyticsPeriod] = useState<InstantlyEventAnalyticsPeriod>("24h");
    const [instantlyEventAnalyticsEventType, setInstantlyEventAnalyticsEventType] = useState<string>("all");
    const [animatedRecentEventIds, setAnimatedRecentEventIds] = useState<Set<string>>(new Set());
    const [expandedRecentEventId, setExpandedRecentEventId] = useState<string | null>(null);
    const [instantlyEventAnalyticsLoading, setInstantlyEventAnalyticsLoading] = useState(false);
    const [instantlyEventAnalyticsError, setInstantlyEventAnalyticsError] = useState<string | null>(null);
    const [instantlyEventRealtimeError, setInstantlyEventRealtimeError] = useState<string | null>(null);
    const previousRecentEventIdsRef = useRef<Set<string> | null>(null);
    const recentEventAnimationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    type PendingReviewDraft = {
        id: number;
        lead_email: string;
        eaccount: string | null;
        thread_subject: string | null;
        rendered_text: string | null;
        review_token: string | null;
        campaign_name: string | null;
        interest_status?: number | null;
        interest_status_label?: string | null;
        last_event_type?: string | null;
        created_at: string;
        updated_at: string;
    };
    const [pendingReviewDrafts, setPendingReviewDrafts] = useState<PendingReviewDraft[]>([]);
    const [pendingReviewDraftsLoading, setPendingReviewDraftsLoading] = useState(false);
    const [expandedDraftId, setExpandedDraftId] = useState<number | null>(null);
    const [animatedPendingDraftIds, setAnimatedPendingDraftIds] = useState<Set<number>>(new Set());
    const previousPendingDraftIdsRef = useRef<Set<number> | null>(null);
    const pendingDraftAnimationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const instantlyWebhookUrl = useMemo(() => {
        if (!user || !clientId || !agencyId) return "";
        return `https://api.shieldsoutboundserver.org/webhook/instantly/events/${agencyId}/${clientId}`;
    }, [user, clientId, agencyId]);
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

    /** Forward pipeline rank: pending < running < completed | error */
    const stageLifecycleRank = (status?: string) => {
        switch (status) {
            case "completed":
            case "error":
                return 3;
            case "running":
                return 2;
            default:
                return 1;
        }
    };

    const pickStageStatus = (
        a?: PipelineStageState["status"],
        b?: PipelineStageState["status"],
    ): PipelineStageState["status"] => {
        const rankA = stageLifecycleRank(a);
        const rankB = stageLifecycleRank(b);
        if (rankA >= rankB) {
            return a || b || "pending";
        }
        return b || a || "pending";
    };

    const mergeStageProgress = (
        key: PipelineStageKey,
        prior?: PipelineStageState,
        next?: PipelineStageState,
    ): PipelineStageState["progress"] => {
        const priorProgress = prior?.progress;
        const nextProgress = next?.progress;
        if (!priorProgress && !nextProgress) {
            return null;
        }

        const maxCounter = (a: number | null, b: number | null): number | null => {
            if (a === null && b === null) return null;
            return Math.max(a ?? 0, b ?? 0);
        };

        // Incoming Realtime row last; then lift monotonic counters so stale prior cannot rewind.
        const merged: NonNullable<PipelineStageState["progress"]> = {
            ...(priorProgress || {}),
            ...(nextProgress || {}),
            stage: key,
        };

        const priorProcessed =
            typeof priorProgress?.processed === "number" ? priorProgress.processed : null;
        const nextProcessed =
            typeof nextProgress?.processed === "number" ? nextProgress.processed : null;
        const mergedProcessed = maxCounter(priorProcessed, nextProcessed);
        if (mergedProcessed !== null) {
            merged.processed = mergedProcessed;
        }

        const priorFound =
            typeof priorProgress?.found === "number" ? priorProgress.found : null;
        const nextFound = typeof nextProgress?.found === "number" ? nextProgress.found : null;
        const mergedFound = maxCounter(priorFound, nextFound);
        if (mergedFound !== null) {
            merged.found = mergedFound;
        }

        const priorTotal = typeof priorProgress?.total === "number" ? priorProgress.total : null;
        const nextTotal = typeof nextProgress?.total === "number" ? nextProgress.total : null;
        const mergedTotal = maxCounter(priorTotal, nextTotal);
        if (mergedTotal !== null && mergedTotal > 0) {
            merged.total = mergedTotal;
        }

        const priorCost = typeof priorProgress?.cost === "number" ? priorProgress.cost : null;
        const nextCost = typeof nextProgress?.cost === "number" ? nextProgress.cost : null;
        const mergedCost = maxCounter(priorCost, nextCost);
        if (mergedCost !== null) {
            merged.cost = mergedCost;
        }

        const priorStats = (priorProgress?.stats || {}) as Record<string, unknown>;
        const nextStats = (nextProgress?.stats || {}) as Record<string, unknown>;
        const mergedStats: Record<string, unknown> = { ...priorStats, ...nextStats };
        for (const statKey of new Set([...Object.keys(priorStats), ...Object.keys(nextStats)])) {
            const p = priorStats[statKey];
            const n = nextStats[statKey];
            if (typeof p === "number" && typeof n === "number") {
                mergedStats[statKey] = Math.max(p, n);
            } else if (typeof p === "number" || typeof n === "number") {
                mergedStats[statKey] = Math.max(
                    typeof p === "number" ? p : 0,
                    typeof n === "number" ? n : 0,
                );
            }
        }
        if (Object.keys(mergedStats).length > 0) {
            merged.stats = mergedStats as Record<string, number>;
        }

        return merged;
    };

    const pipelineStatusRank = (status?: string) => {
        switch (status) {
            case "completed":
            case "failed":
            case "cancelled":
                return 4;
            case "running":
            case "paused":
                return 3;
            case "queued":
                return 2;
            default:
                return 1;
        }
    };

    /** Realtime can deliver out-of-order rows; keep furthest lifecycle + highest progress. */
    const mergeJobState = useCallback(
        (prev: PipelineJob | null, incoming: Partial<PipelineJob> & { id: string }): PipelineJob => {
            const stages = normalizeStages(incoming.stages ?? prev?.stages);
            if (prev?.stages) {
                for (const key of STAGE_ORDER) {
                    const prior = prev.stages[key];
                    const next = stages[key];
                    const status = pickStageStatus(prior?.status, next?.status);
                    const nextSummary =
                        next?.summary && Object.keys(next.summary).length > 0
                            ? next.summary
                            : null;
                    const priorSummary =
                        prior?.summary && Object.keys(prior.summary).length > 0
                            ? prior.summary
                            : null;
                    stages[key] = {
                        ...next,
                        status,
                        startedAt: prior?.startedAt ?? next.startedAt,
                        completedAt:
                            status === "completed" || status === "error"
                                ? next?.completedAt ?? prior?.completedAt
                                : next?.completedAt ?? prior?.completedAt ?? null,
                        summary: nextSummary ?? priorSummary,
                        error: next?.error ?? prior?.error ?? null,
                        progress: mergeStageProgress(key, prior, next),
                    };
                }
            }

            const runningWithProgress = STAGE_ORDER.find((key) => {
                const stage = stages[key];
                return (
                    stage?.status === "running"
                    && typeof stage.progress?.processed === "number"
                    && typeof stage.progress?.total === "number"
                    && stage.progress.total > 0
                );
            });

            let activityMessage =
                incoming.activityMessage !== undefined
                    ? incoming.activityMessage
                    : prev?.activityMessage ?? null;
            if (runningWithProgress) {
                activityMessage = null;
            }

            const incomingStatus = (incoming.status as PipelineJob["status"]) || prev?.status || "queued";
            const prevStatus = prev?.status || "queued";
            const mergedStatus =
                pipelineStatusRank(incoming.status as string) >= pipelineStatusRank(prev?.status)
                    ? incomingStatus
                    : prevStatus;

            return {
                ...(prev || {}),
                ...incoming,
                id: incoming.id,
                status: mergedStatus,
                stages,
                cost:
                    typeof incoming.cost === "number" && Number.isFinite(incoming.cost) && incoming.cost > 0
                        ? incoming.cost
                        : typeof prev?.cost === "number" && prev.cost > 0
                          ? prev.cost
                          : incoming.cost ?? prev?.cost,
                activityMessage,
                activityUpdatedAt:
                    incoming.activityUpdatedAt !== undefined
                        ? incoming.activityUpdatedAt
                        : prev?.activityUpdatedAt ?? null,
            } as PipelineJob;
        },
        [normalizeStages]
    );

    const onJobRealtimeUpdate = useCallback(
        (state: JobRealtimeState) => {
            setJobState((prev) => {
                if (prev?.id && state.id && prev.id !== state.id) {
                    return prev;
                }
                return mergeJobState(prev, state as Partial<PipelineJob> & { id: string });
            });
        },
        [mergeJobState],
    );

    useJobRealtime(realtimeJobId, onJobRealtimeUpdate);

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
    const [includeValidEmails, setIncludeValidEmails] = useState<boolean>(true);
    const [includeRiskyEmails, setIncludeRiskyEmails] = useState<boolean>(true);
    const [uploadEmailStatusCounts, setUploadEmailStatusCounts] = useState<{ valid: number; risky: number } | null>(null);

    // Leads state
    const [leads, setLeads] = useState<Lead[]>([]);
    const [allLeadsCached, setAllLeadsCached] = useState(false); // Track if we've fetched all leads for filtering
    const [stats, setStats] = useState<{ total: number | null; verified: number; unverified: number }>(() => ({ total: null, verified: 0, unverified: 0 }));
    const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
    const [leadModalTab, setLeadModalTab] = useState<'detail' | 'insights'>('detail');
    const [emailCopied, setEmailCopied] = useState(false);
    const [showLeadAdvanced, setShowLeadAdvanced] = useState(false);
    const [leadEvents, setLeadEvents] = useState<Array<{ id: string; event_type: string; campaign_name?: string; lead_email?: string; email_account?: string; step?: number; event_timestamp: string; message_text?: string; reply_text_snippet?: string; reply_category?: string }>>([]);
    const [leadEventsLoading, setLeadEventsLoading] = useState(false);
    const [activityReplyPopup, setActivityReplyPopup] = useState<{ html: string; isHtml: boolean; x: number; y: number } | null>(null);
    const [leadsLoading, setLeadsLoading] = useState(false);
    const [leadsHasMore, setLeadsHasMore] = useState(true);
    const [leadsCursor, setLeadsCursor] = useState<number>(0);
    const [campaignFilterId, setCampaignFilterId] = useState<string>("");
    const [leadSearch, setLeadSearch] = useState<string>("");
    const [debouncedLeadSearch, setDebouncedLeadSearch] = useState<string>("");
    const [clientTotalLeads, setClientTotalLeads] = useState<number>(0);
    const [leadFilterFields, setLeadFilterFields] = useState<LeadFilterField[]>([]);
    const [leadFilterFieldsLoading, setLeadFilterFieldsLoading] = useState(false);
    const [leadFilters, setLeadFilters] = useState<LeadFilterClause[]>([]);
    const [appliedLeadFilters, setAppliedLeadFilters] = useState<Array<{ field: string; op: string; value: string; joinOp: 'AND' | 'OR' }>>([]);
    // Bumped on each "Run Query" press so the query re-runs even when filters are unchanged (underlying data is dynamic)
    const [leadQueryNonce, setLeadQueryNonce] = useState(0);
    const [checkingKlaviyo, setCheckingKlaviyo] = useState(false);
    const [exportingCsv, setExportingCsv] = useState(false);
    const [leadExportModalOpen, setLeadExportModalOpen] = useState(false);
    const [selectedLeadExportFields, setSelectedLeadExportFields] = useState<string[]>(DEFAULT_LEAD_EXPORT_FIELD_KEYS);
    const [leadExportLimitEnabled, setLeadExportLimitEnabled] = useState(false);
    const [leadExportMaxRows, setLeadExportMaxRows] = useState(DEFAULT_LEAD_EXPORT_MAX_ROWS);

    useEffect(() => {
        setLeadModalTab('detail');
        setShowLeadAdvanced(false);
        setEmailCopied(false);
    }, [selectedLead?.id]);

    useEffect(() => {
        if (!selectedLead || !user || !selectedLead.id) {
            setLeadEvents([]);
            return;
        }
        let cancelled = false;
        (async () => {
            setLeadEventsLoading(true);
            try {
                const idToken = await getAccessToken();
            if (!idToken) return;
                const res = await fetchWithRetry(`${getPipelineBaseUrl()}/api/leads/${selectedLead.id}/events?limit=50`, {
                    headers: { Authorization: `Bearer ${idToken}` }
                });
                if (!res.ok) throw new Error(`Failed to fetch events: ${res.statusText}`);
                const data = await res.json();
                if (!cancelled) setLeadEvents(data.events || []);
            } catch (err) {
                console.error('Failed to fetch lead events:', err);
                if (!cancelled) setLeadEvents([]);
            } finally {
                if (!cancelled) setLeadEventsLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [selectedLead?.id, user]);

    useEffect(() => {
        const timeoutId = window.setTimeout(() => {
            setDebouncedLeadSearch(leadSearch);
        }, 350);

        return () => {
            window.clearTimeout(timeoutId);
        };
    }, [leadSearch]);

    useEffect(() => {
        const timeoutId = window.setTimeout(() => {
            setDebouncedFollowUpPreviewLeadSearch(followUpPreviewLeadSearch);
        }, 250);

        return () => {
            window.clearTimeout(timeoutId);
        };
    }, [followUpPreviewLeadSearch]);

    useEffect(() => {
        const timeoutId = window.setTimeout(() => {
            setDebouncedAutoResponderTestLeadSearch(autoResponderTestLeadSearch);
        }, 250);
        return () => { window.clearTimeout(timeoutId); };
    }, [autoResponderTestLeadSearch]);

    useEffect(() => {
        if (!user) return;
        let cancelled = false;

        (async () => {
            setLeadFilterFieldsLoading(true);
            try {
                const idToken = await getAccessToken();
            if (!idToken) return;
                const response = await fetchWithRetry(`${getPipelineBaseUrl()}/api/leads/filter-fields`, {
                    headers: { Authorization: `Bearer ${idToken}` }
                });
                if (!response.ok) {
                    throw new Error(`Failed to fetch filter fields: ${response.statusText}`);
                }
                const data = await response.json();
                if (!cancelled) {
                    setLeadFilterFields(Array.isArray(data.fields) ? data.fields : []);
                }
            } catch (error) {
                console.error('Failed to fetch lead filter fields:', error);
                if (!cancelled) {
                    setLeadFilterFields([]);
                }
            } finally {
                if (!cancelled) {
                    setLeadFilterFieldsLoading(false);
                }
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [user?.id]);

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
    const displayJobCost = useMemo(() => {
        if (!jobState) return null;
        if (typeof jobState.cost === "number" && jobState.cost > 0) {
            return jobState.cost;
        }
        let sum = 0;
        for (const key of STAGE_ORDER) {
            const stageCost = stageCostFromStage(jobState.stages[key]);
            if (stageCost !== null) sum += stageCost;
        }
        return sum > 0 ? sum : null;
    }, [jobState]);

    /** Per-stage "time to finish" estimate, derived from the rolling window of
     *  (timestamp, processed) samples in `stageEtaSamplesRef`. Only computed for
     *  stages currently running; skipped for `domainPrep` (too fast/lumpy to be
     *  useful). Returns an empty string when not enough data is available. */
    const stageEtas = useMemo(() => {
        const result: Partial<Record<PipelineStageKey, string>> = {};
        if (!jobState) return result;

        const store = stageEtaSamplesRef.current;
        if (store.jobId !== jobState.id) {
            store.jobId = jobState.id;
            store.buffers = {};
        }

        const now = Date.now();
        for (const stageKey of ETA_STAGES) {
            const stage = jobState.stages[stageKey];
            const processed = typeof stage?.progress?.processed === "number" ? stage.progress.processed : null;
            const total = typeof stage?.progress?.total === "number" ? stage.progress.total : null;

            // Reset the buffer outside the active window so a fresh run gets a fresh ETA.
            if (!stage || stage.status !== "running" || processed === null || total === null || total <= 0) {
                store.buffers[stageKey] = [];
                continue;
            }

            const buf = store.buffers[stageKey] ?? [];
            const last = buf[buf.length - 1];
            if (!last || last.processed !== processed) {
                buf.push({ t: now, processed });
                if (buf.length > STAGE_ETA_WINDOW) buf.splice(0, buf.length - STAGE_ETA_WINDOW);
                store.buffers[stageKey] = buf;
            }

            if (buf.length < 2) continue;
            const first = buf[0];
            const latest = buf[buf.length - 1];
            const dProcessed = latest.processed - first.processed;
            const dt = latest.t - first.t;
            if (dProcessed <= 0 || dt <= 0) continue;
            const remaining = total - latest.processed;
            if (remaining <= 0) continue;
            const etaMs = remaining * (dt / dProcessed);
            const formatted = formatEtaShort(etaMs);
            if (formatted) result[stageKey] = formatted;
        }
        return result;
    }, [jobState]);

    const stageCompletionPercent = useMemo(() => {
        if (!jobState) return 0;
        const stageWeight = 100 / STAGE_ORDER.length;
        let percent = 0;
        for (const key of STAGE_ORDER) {
            const stage = jobState.stages[key];
            if (stage?.status === "completed" || stage?.status === "error") {
                percent += stageWeight;
                continue;
            }
            if (stage?.status === "running") {
                const total = typeof stage.progress?.total === "number" ? stage.progress.total : null;
                const processed =
                    typeof stage.progress?.processed === "number" ? stage.progress.processed : null;
                if (total && total > 0 && processed !== null) {
                    percent += stageWeight * Math.min(1, processed / total);
                }
            }
        }
        return Math.min(100, Math.round(percent));
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
        if (jobState.status === 'running' || jobState.status === 'queued') {
            const runningStage = STAGE_ORDER.find(k => jobState.stages[k]?.status === 'running');
            if (runningStage) {
                const stage = jobState.stages[runningStage];
                const processed = stage?.progress?.processed;
                const total = stage?.progress?.total;
                const title = STAGE_METADATA[runningStage]?.title || runningStage;
                if (typeof processed === 'number' && typeof total === 'number' && total > 0) {
                    return `${title}: ${processed.toLocaleString()} / ${total.toLocaleString()}`;
                }
                return `Running ${title}…`;
            }
            if (jobState.activityMessage) {
                return jobState.activityMessage;
            }
            const nextPending = STAGE_ORDER.find(k => jobState.stages[k]?.status === 'pending');
            if (nextPending) {
                return `Preparing ${STAGE_METADATA[nextPending]?.title || nextPending}…`;
            }
        }
        return null;
    }, [jobState]);

    const recentJobLogLines = useMemo(() => {
        if (!jobState?.activityMessage) return [];
        const headline = activeStatusLabel?.replace(/\s+/g, " ").trim().toLowerCase();
        const line = jobState.activityMessage.replace(/\s+/g, " ").trim();
        if (!line) return [];
        const norm = line.toLowerCase();
        if (headline && (norm === headline || headline.includes(norm) || norm.includes(headline))) {
            return [];
        }
        return [line];
    }, [jobState?.activityMessage, activeStatusLabel]);

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

    const stopInstantlySyncPolling = useCallback(() => {
        if (instantlySyncPollRef.current) {
            clearInterval(instantlySyncPollRef.current);
            instantlySyncPollRef.current = null;
        }
    }, []);

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
        if (!user) {
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                const token = await getAccessToken();
                if (!token || cancelled) {
                    return;
                }
                const response = await fetch(`${getPipelineBaseUrl()}/api/agency/settings`, {
                    headers: { Authorization: `Bearer ${token}` },
                });
                if (!response.ok || cancelled) {
                    return;
                }
                const data = (await response.json()) as { email_verification_provider?: string };
                setEmailProvider(
                    data.email_verification_provider === "self_hosted" ? "self_hosted" : "trykitt",
                );
            } catch {
                /* keep default */
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [user?.id]);

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

    const isLegacyNotFoundEmail = (email: string) => {
        const emailLower = email.toLowerCase().trim();
        return emailLower === 'not found' || emailLower === 'not_found' || emailLower.includes('not found');
    };

    /** Raw contacts.email value for table/detail — null/empty stays empty (—). */
    const formatRawEmailValue = (email: string | undefined | null) => {
        const trimmed = String(email ?? '').trim();
        if (!trimmed || isLegacyNotFoundEmail(trimmed)) return '—';
        return trimmed;
    };

    const hasDiscoveredEmail = (email: string | undefined | null) => {
        const trimmed = String(email ?? '').trim();
        return Boolean(trimmed && !isLegacyNotFoundEmail(trimmed));
    };

    const formatLeadStageTimestamp = (value?: string | null) => {
        if (!value || !String(value).trim()) return null;
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) return null;
        return parsed.toLocaleString('en-GB', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    };

    type EmailStageDisplay = {
        label: string;
        detail?: string;
        variant: LeadStatusChipVariant;
    };

    const getEmailFindDisplay = (
        email: string | undefined | null,
        emailFindCompletedAt: string | undefined | null
    ): EmailStageDisplay => {
        if (hasDiscoveredEmail(email)) {
            const when = formatLeadStageTimestamp(emailFindCompletedAt);
            return {
                label: 'Found',
                detail: when ? `Discovered ${when}` : undefined,
                variant: 'valid'
            };
        }
        if (emailFindCompletedAt) {
            const when = formatLeadStageTimestamp(emailFindCompletedAt);
            return {
                label: 'No email found',
                detail: when ? `Searched ${when}` : 'Discovery completed',
                variant: 'not-found'
            };
        }
        return {
            label: 'Not searched',
            detail: 'Email discovery has not run for this lead',
            variant: 'not-run'
        };
    };

    const getEmailVerifyDisplay = (
        email: string | undefined | null,
        emailStatus: string | undefined,
        emailVerifyCompletedAt: string | undefined | null,
        emailFindCompletedAt: string | undefined | null
    ): EmailStageDisplay => {
        if (!hasDiscoveredEmail(email)) {
            if (emailFindCompletedAt) {
                return {
                    label: 'Skipped',
                    detail: 'Nothing to verify — discovery found no address',
                    variant: 'skipped'
                };
            }
            return {
                label: 'Not run',
                detail: 'Run email discovery first',
                variant: 'not-run'
            };
        }

        const normalized = (emailStatus || '').trim().toLowerCase();
        const when = formatLeadStageTimestamp(emailVerifyCompletedAt);

        if (!normalized) {
            if (emailVerifyCompletedAt) {
                return {
                    label: 'Unknown',
                    detail: when ? `Checked ${when}` : 'Verification completed with unknown result',
                    variant: 'default'
                };
            }
            return {
                label: 'Pending',
                detail: 'Address found — SMTP verification not run yet',
                variant: 'not-run'
            };
        }
        if (normalized === 'valid') {
            return { label: 'Valid', detail: when ? `Verified ${when}` : undefined, variant: 'valid' };
        }
        if (normalized === 'valid-risky' || normalized === 'risky') {
            return { label: 'Valid-Risky', detail: when ? `Verified ${when}` : undefined, variant: 'valid-risky' };
        }
        if (normalized === 'invalid') {
            return { label: 'Invalid', detail: when ? `Verified ${when}` : undefined, variant: 'invalid' };
        }
        if (normalized === 'not_found' || normalized.includes('not found')) {
            return { label: 'Not found', detail: when ? `Checked ${when}` : undefined, variant: 'not-found' };
        }
        if (normalized === 'skipped_no_founder') {
            return { label: 'Skipped', detail: 'No founder to verify', variant: 'skipped' };
        }

        return {
            label: emailStatus || 'Unknown',
            detail: when ? `Checked ${when}` : undefined,
            variant: 'default'
        };
    };

    /** @deprecated use getEmailFindDisplay().label */
    const displayEmailFindState = (
        email: string | undefined | null,
        emailFindCompletedAt: string | undefined | null
    ) => getEmailFindDisplay(email, emailFindCompletedAt).label;

    const displayEmailStatus = (
        emailStatus: string | undefined,
        emailVerifyCompletedAt: string | undefined,
        leadEmail?: string | null,
        emailFindCompletedAt?: string | null
    ) =>
        getEmailVerifyDisplay(leadEmail ?? null, emailStatus, emailVerifyCompletedAt, emailFindCompletedAt).label;

    const getLeadEmailHeaderChip = (lead: {
        email?: string;
        status?: string;
        emailFindCompletedAt?: string;
        emailVerifyCompletedAt?: string;
    }) => {
        const find = getEmailFindDisplay(lead.email, lead.emailFindCompletedAt);
        const verify = getEmailVerifyDisplay(
            lead.email,
            lead.status,
            lead.emailVerifyCompletedAt,
            lead.emailFindCompletedAt
        );

        if (verify.variant !== 'not-run' && verify.variant !== 'skipped') {
            return { label: verify.label, variant: verify.variant };
        }
        if (find.variant === 'not-found') {
            return { label: 'No email', variant: 'not-found' };
        }
        if (find.variant === 'valid' && verify.variant === 'not-run') {
            return { label: 'Unverified', variant: 'not-run' };
        }
        if (find.variant === 'not-run') {
            return { label: 'Not searched', variant: 'not-run' };
        }
        return { label: verify.label, variant: verify.variant };
    };

    const renderEmailFindChip = (
        email: string | undefined | null,
        emailFindCompletedAt: string | undefined | null
    ) => {
        const find = getEmailFindDisplay(email, emailFindCompletedAt);
        return (
            <span
                className={`lead-pastel-chip lead-pastel-chip--status-${find.variant}`}
                style={{ flexShrink: 0 }}
            >
                {find.label}
            </span>
        );
    };

    const renderEmailStageRow = (
        title: string,
        stage: EmailStageDisplay,
        options?: { showChip?: boolean }
    ) => (
        <>
            <span style={{ color: 'var(--app-text-faint)' }}>{title}</span>
            <span style={{ color: 'var(--app-text-high)' }}>
                {options?.showChip !== false ? (
                    <span
                        className={`lead-pastel-chip lead-pastel-chip--status-${stage.variant}`}
                        style={{ marginRight: stage.detail ? '0.5rem' : 0 }}
                    >
                        {stage.label}
                    </span>
                ) : null}
                {stage.detail ? (
                    <span style={{ color: 'var(--app-text-muted)', fontSize: '0.85rem' }}>{stage.detail}</span>
                ) : null}
            </span>
        </>
    );

    const formatInstantlyStateLabel = (value?: string | null) => {
        if (!value || !value.trim()) return '—';
        return value
            .split('_')
            .filter(Boolean)
            .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
            .join(' ');
    };

    const leadFilterFieldMap = useMemo(() => {
        return new Map(leadFilterFields.map((field) => [field.key, field]));
    }, [leadFilterFields]);

    const doesLeadFilterRequireValue = useCallback((fieldKey: string, operatorKey: string) => {
        const field = leadFilterFieldMap.get(fieldKey);
        if (!field) return false;
        if (!field.operators.some((operator) => operator.key === operatorKey)) return false;
        const noValueOps = ['is_empty', 'not_empty', 'is_true', 'is_false'];
        return !noValueOps.includes(operatorKey);
    }, [leadFilterFieldMap]);

    const getLeadFilterInputMode = useCallback((fieldKey: string, operatorKey: string): string | null => {
        const field = leadFilterFieldMap.get(fieldKey);
        if (!field) return null;
        if (!doesLeadFilterRequireValue(fieldKey, operatorKey)) return null;
        if (operatorKey === 'older_than_days') return 'number';
        if (operatorKey === 'between') return 'between';
        if (operatorKey === 'in' || operatorKey === 'not_in') return 'multi';
        return field.type;
    }, [doesLeadFilterRequireValue, leadFilterFieldMap]);

    const normalizedLeadFilters = useMemo(() => {
        return leadFilters
            .filter((filter) => {
                const field = leadFilterFieldMap.get(filter.field);
                if (!field) return false;
                if (!field.operators.some((operator) => operator.key === filter.op)) return false;
                if (!doesLeadFilterRequireValue(filter.field, filter.op)) return true;
                return String(filter.value || '').trim() !== '';
            })
            .map((filter) => ({
                field: filter.field,
                op: filter.op,
                value: filter.value,
                joinOp: filter.joinOp
            }));
    }, [doesLeadFilterRequireValue, leadFilterFieldMap, leadFilters]);

    const leadFiltersDirty = useMemo(() => (
        JSON.stringify(normalizedLeadFilters) !== JSON.stringify(appliedLeadFilters)
    ), [appliedLeadFilters, normalizedLeadFilters]);

    const addLeadFilter = useCallback(() => {
        setLeadFilters((prev) => {
            const firstField = leadFilterFields[0];
            if (!firstField) return prev;
            return [
                ...prev,
                {
                    id: createLeadFilterId(),
                    field: firstField.key,
                    op: firstField.operators[0]?.key || '',
                    value: '',
                    joinOp: 'AND'
                }
            ];
        });
    }, [leadFilterFields]);

    const updateLeadFilter = useCallback((filterId: string, updates: Partial<LeadFilterClause>) => {
        setLeadFilters((prev) => prev.map((item) => (
            item.id === filterId ? { ...item, ...updates } : item
        )));
    }, []);

    const removeLeadFilter = useCallback((filterId: string) => {
        setLeadFilters((prev) => prev.filter((item) => item.id !== filterId));
    }, []);

    const applyLeadFilters = useCallback(() => {
        setAppliedLeadFilters(normalizedLeadFilters);
        // Force a refetch even when the filters haven't changed
        setLeadQueryNonce((nonce) => nonce + 1);
    }, [normalizedLeadFilters]);

    const leadFilterContent = useMemo(() => {
        if (leadFilterFieldsLoading) {
            return (
                <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--app-text-faint)' }}>
                    Loading filter fields...
                </p>
            );
        }

        // Split leadFilters into AND-groups (split wherever a preceding clause has joinOp 'OR')
        type FilterGroup = { clauses: LeadFilterClause[]; groupIndex: number };
        const groups: FilterGroup[] = [];
        let current: LeadFilterClause[] = [];
        for (let i = 0; i < leadFilters.length; i++) {
            current.push(leadFilters[i]);
            // The connector AFTER clause i lives in leadFilters[i].joinOp
            // If it's OR (and there is a next clause), close this group
            if (i < leadFilters.length - 1 && leadFilters[i].joinOp === 'OR') {
                groups.push({ clauses: current, groupIndex: groups.length });
                current = [];
            }
        }
        if (current.length > 0) groups.push({ clauses: current, groupIndex: groups.length });

        const hasMultipleGroups = groups.length > 1;

        const renderClauseRow = (filter: LeadFilterClause) => {
            const field = leadFilterFieldMap.get(filter.field) || leadFilterFields[0];
            const operators = field?.operators || [];
            const selectedOperator = operators.find((operator) => operator.key === filter.op) || operators[0];
            const valueMode = getLeadFilterInputMode(filter.field, selectedOperator?.key || '');

            const parsedArrayValue: string[] = (() => {
                try { return JSON.parse(filter.value || '[]'); } catch { return []; }
            })();
            const setArrayValue = (arr: string[]) => updateLeadFilter(filter.id, { value: JSON.stringify(arr) });

            return (
                <div
                    key={filter.id}
                    style={{
                        display: 'grid',
                        gridTemplateColumns: 'minmax(180px, 1.2fr) minmax(180px, 1fr) minmax(220px, 1.4fr) auto',
                        gap: '0.75rem',
                        alignItems: 'end'
                    }}
                >
                    <label className="settings-field">
                        <span className="settings-field__label">Field</span>
                        <select
                            value={filter.field}
                            onChange={(e) => {
                                const nextField = leadFilterFieldMap.get(e.target.value) || leadFilterFields[0];
                                updateLeadFilter(filter.id, {
                                    field: nextField?.key || '',
                                    op: nextField?.operators[0]?.key || '',
                                    value: ''
                                });
                            }}
                        >
                            {leadFilterFields.map((item) => (
                                <option key={item.key} value={item.key}>{item.label}</option>
                            ))}
                        </select>
                    </label>

                    <label className="settings-field">
                        <span className="settings-field__label">Operator</span>
                        <select
                            value={filter.op}
                            onChange={(e) => {
                                const nextOp = e.target.value;
                                updateLeadFilter(filter.id, {
                                    op: nextOp,
                                    value: doesLeadFilterRequireValue(filter.field, nextOp) ? filter.value : ''
                                });
                            }}
                        >
                            {operators.map((operator) => (
                                <option key={operator.key} value={operator.key}>{operator.label}</option>
                            ))}
                        </select>
                    </label>

                    <label className="settings-field">
                        <span className="settings-field__label">Value</span>
                        {!valueMode ? (
                            <div style={{
                                minHeight: '42px',
                                display: 'flex',
                                alignItems: 'center',
                                padding: '0 0.9rem',
                                borderRadius: '10px',
                                border: '1px solid var(--app-border)',
                                background: 'var(--app-surface-3)',
                                color: 'var(--app-text-faint)',
                                fontSize: '0.9rem'
                            }}>
                                No value needed
                            </div>
                        ) : valueMode === 'enum' ? (
                            <select
                                value={filter.value}
                                onChange={(e) => updateLeadFilter(filter.id, { value: e.target.value })}
                            >
                                <option value="">Select value</option>
                                {(field?.options || []).map((option) => (
                                    <option key={option.value} value={option.value}>{option.label}</option>
                                ))}
                            </select>
                        ) : valueMode === 'multi' ? (
                            <select
                                multiple
                                value={parsedArrayValue}
                                onChange={(e) => {
                                    const selected = Array.from(e.target.selectedOptions).map((o) => o.value);
                                    setArrayValue(selected);
                                }}
                                style={{ minHeight: '80px' }}
                            >
                                {(field?.options || []).map((option) => (
                                    <option key={option.value} value={option.value}>{option.label}</option>
                                ))}
                            </select>
                        ) : valueMode === 'between' ? (
                            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                                <input
                                    type="date"
                                    value={parsedArrayValue[0] || ''}
                                    onChange={(e) => setArrayValue([e.target.value, parsedArrayValue[1] || ''])}
                                    style={{ flex: 1 }}
                                />
                                <span style={{ color: 'var(--app-text-faint)', fontSize: '0.8rem' }}>to</span>
                                <input
                                    type="date"
                                    value={parsedArrayValue[1] || ''}
                                    onChange={(e) => setArrayValue([parsedArrayValue[0] || '', e.target.value])}
                                    style={{ flex: 1 }}
                                />
                            </div>
                        ) : (
                            <input
                                type={valueMode === 'number' ? 'number' : valueMode === 'date' ? 'date' : 'text'}
                                value={filter.value}
                                onChange={(e) => updateLeadFilter(filter.id, { value: e.target.value })}
                                placeholder={valueMode === 'number'
                                    ? 'Enter number'
                                    : valueMode === 'date'
                                        ? ''
                                        : 'Enter value'}
                            />
                        )}
                    </label>

                    <button
                        type="button"
                        className="secondary-button secondary-button--active"
                        onClick={() => removeLeadFilter(filter.id)}
                    >
                        Remove
                    </button>
                </div>
            );
        };

        // Pill toggle for the connector after a clause (AND / OR)
        const renderConnector = (afterClause: LeadFilterClause, label: 'AND' | 'OR') => (
            <div style={{ display: 'flex', alignItems: 'center', padding: '0.15rem 0' }}>
                <div style={{
                    display: 'inline-flex',
                    background: 'var(--app-surface-2)',
                    border: '1px solid var(--app-border-mid)',
                    borderRadius: '6px',
                    padding: '2px',
                    gap: '2px'
                }}>
                    {(['AND', 'OR'] as const).map((opt) => {
                        const selected = afterClause.joinOp === opt;
                        return (
                            <button
                                key={opt}
                                type="button"
                                onClick={() => updateLeadFilter(afterClause.id, { joinOp: opt })}
                                style={{
                                    padding: '2px 10px',
                                    fontSize: '0.7rem',
                                    fontWeight: selected ? 600 : 400,
                                    letterSpacing: '0.04em',
                                    lineHeight: 1,
                                    height: '22px',
                                    border: 'none',
                                    borderRadius: '4px',
                                    cursor: 'pointer',
                                    transition: 'background 0.15s, color 0.15s',
                                    background: selected ? 'var(--app-surface-hover)' : 'transparent',
                                    color: selected ? 'var(--app-text)' : 'var(--app-text-ghost)',
                                    boxShadow: selected ? '0 1px 3px rgba(0,0,0,0.3)' : 'none',
                                }}
                            >
                                {opt}
                            </button>
                        );
                    })}
                </div>
            </div>
        );

        return groups.map(({ clauses, groupIndex }) => {
            const isLastGroup = groupIndex === groups.length - 1;
            // The OR connector that PRECEDES this group lives on the last clause of the previous group
            // We render it ABOVE this group (except for the first group)
            const precedingOrClause = groupIndex > 0 ? groups[groupIndex - 1].clauses[groups[groupIndex - 1].clauses.length - 1] : null;

            return (
                <div key={`group-${groupIndex}`} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {/* OR separator between groups */}
                    {precedingOrClause && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.25rem 0' }}>
                            <div style={{ flex: 1, height: '1px', background: 'var(--app-border)' }} />
                            {renderConnector(precedingOrClause, 'OR')}
                            <div style={{ flex: 1, height: '1px', background: 'var(--app-border)' }} />
                        </div>
                    )}

                    {/* Group container — bordered when there are multiple groups */}
                    <div style={hasMultipleGroups ? {
                        border: '1px solid var(--app-border-mid)',
                        borderRadius: '10px',
                        padding: '0.75rem',
                        background: 'var(--app-surface-3)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '0.5rem'
                    } : { display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                        {clauses.map((clause, clauseIdx) => {
                            const isLastInGroup = clauseIdx === clauses.length - 1;
                            return (
                                <div key={clause.id} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                                    {renderClauseRow(clause)}
                                    {/* AND connector within the group (not after the last clause in the group) */}
                                    {!isLastInGroup && renderConnector(clause, 'AND')}
                                    {/* OR connector toggle — shown after last clause in group, unless it's the last group */}
                                    {isLastInGroup && !isLastGroup && null /* rendered above next group as precedingOrClause */}
                                    {/* Allow changing last clause connector to OR (shown only when not last group already handled) */}
                                    {isLastInGroup && isLastGroup && leadFilters.length > 1 && (
                                        // Still show connector on last clause so user can switch to OR
                                        // only if there's a next filter to connect to — i.e. this clause is not the very last filter
                                        leadFilters[leadFilters.length - 1].id !== clause.id
                                            ? null
                                            : null
                                    )}
                                </div>
                            );
                        })}
                    </div>

                    {/* Connector after this group (shown when not the last group — handled as precedingOrClause above)
                        But we also need to show it on the last clause of the last group so user can add an OR to the next filter */}
                </div>
            );
        });
    }, [
        doesLeadFilterRequireValue,
        getLeadFilterInputMode,
        leadFilterFieldMap,
        leadFilterFields,
        leadFilterFieldsLoading,
        leadFilters,
        removeLeadFilter,
        updateLeadFilter
    ]);

    const getLeadStatusChipMeta = (
        emailStatus: string | undefined,
        emailVerifyCompletedAt: string | undefined,
        email?: string | null,
        emailFindCompletedAt?: string | null
    ): { label: string; variant: LeadStatusChipVariant } => {
        const stage = getEmailVerifyDisplay(email, emailStatus, emailVerifyCompletedAt, emailFindCompletedAt);
        return { label: stage.label, variant: stage.variant };
    };

    useEffect(() => {
        if (!user || !clientId || !agencyId) return;
        let cancelled = false;

        (async () => {
            try {
                const clientPayload = await apiJson<{
                    client: {
                        sqlId?: number;
                        name?: string;
                        industry?: string;
                        instantly_key?: string;
                        ntfy_topic?: string;
                        instantlyWebhookStatus?: number | null;
                        instantlyWebhookUpdatedAt?: string | null;
                    };
                }>(`/api/clients/${encodeURIComponent(clientId)}`);

                const campaignsPayload = await apiFetch(
                    `/api/clients/${encodeURIComponent(clientId)}/campaigns/list?agencyId=${encodeURIComponent(agencyId)}`
                ).then((r) => r.json());

                const segmentsPayload = await apiJson<{ segments: Segment[] }>(
                    `/api/clients/${encodeURIComponent(clientId)}/segments`
                );

                if (cancelled) return;

                const c = clientPayload.client;
                setClientSqlId(c.sqlId ?? null);
                setClientName(c.name || clientId);
                setClientIndustry((c.industry as Niche["id"]) || "ecom");
                setClientInstantlyKey(c.instantly_key || "");
                setClientNtfyTopic(c.ntfy_topic || "");
                setClientInstantlyWebhookStatus(
                    typeof c.instantlyWebhookStatus === "number" ? c.instantlyWebhookStatus : null
                );
                setClientInstantlyWebhookUpdatedAt(
                    c.instantlyWebhookUpdatedAt
                        ? new Date(c.instantlyWebhookUpdatedAt).toLocaleString()
                        : null
                );

                const campaignRows = (campaignsPayload.campaigns || []).map((row: { id: string | number; name: string; status?: number }) => ({
                    id: String(row.id),
                    name: row.name || String(row.id),
                    status: Number(row.status ?? 0),
                    createdAt: "",
                    totalLeads: 0,
                })) as Campaign[];
                setCampaigns(campaignRows);

                setSegments(
                    (segmentsPayload.segments || []).sort((a, b) =>
                        (b.updatedAt || "").localeCompare(a.updatedAt || "")
                    )
                );
            } catch {
                if (!cancelled) {
                    setClientName(clientId);
                    setClientIndustry("ecom");
                    setClientInstantlyKey("");
                    setClientNtfyTopic("");
                    setClientSqlId(null);
                    setCampaigns([]);
                    setSegments([]);
                }
            }
        })();

        return () => {
            cancelled = true;
            stopInstantlySyncPolling();
        };
    }, [user?.id, clientId, agencyId, stopInstantlySyncPolling]);

    useEffect(() => {
        if (!user || !clientId) return;
        const shouldSkipTotalForSingleLeadSearch = isSingleLeadEmailSearch(debouncedLeadSearch)
            && !campaignFilterId
            && appliedLeadFilters.length === 0;
        
        // Reset and refetch when applied lead filters change
        setLeads([]);
        setLeadsCursor(0);
        setLeadsHasMore(true);
        fetchLeads(true);
        if (!shouldSkipTotalForSingleLeadSearch) {
            fetchLeadTotal();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user?.id, clientId, debouncedLeadSearch, campaignFilterId, appliedLeadFilters, leadQueryNonce]);

    // Fetch instantly campaigns for filtering
    useEffect(() => {
        if (!user || !clientId) return;

        const fetchInstantlyCampaigns = async () => {
            setInstantlyCampaignsLoading(true);
            try {
                const idToken = await getAccessToken();
            if (!idToken) return;
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
    }, [user, clientId, uploadModalOpen, activeTab]);

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
            const idToken = await getAccessToken();
            if (!idToken) return;
            const counts: Record<string, number> = {};

            await Promise.all(
                segments.map(async (segment) => {
                    try {
                        const params = new URLSearchParams();
                        params.append('clientId', clientId);
                        params.append('limit', '1');
                        // Count-only: skips row hydration + campaign JSON aggregation and
                        // returns the matching total directly (the row payload omits it).
                        params.append('countOnly', 'true');
                        params.append('includeTotal', 'true');

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

    const stopJobWatch = useCallback(() => {
        lastWatchedJobIdRef.current = null;
        setRealtimeJobId(null);
    }, []);

    const campaignIdToName = useMemo(() => {
        const map = new Map<string, string>();
        campaigns.forEach((c) => map.set(c.id, c.name));
        return map;
    }, [campaigns]);

    const getCampaignNamesForLead = useCallback((lead: Lead) => {
        if (lead.campaignsData && lead.campaignsData.length > 0) {
            return lead.campaignsData
                .map((campaign) => campaign.campaignName)
                .filter((name): name is string => Boolean(name));
        }
        if (!lead.campaigns || lead.campaigns.length === 0) return [];
        return lead.campaigns.map((id) => campaignIdToName.get(id) || id);
    }, [campaignIdToName]);

    const mapApiJobToJob = useCallback((data: Record<string, unknown>): PipelineJob => {
        const id = String(data.id || "");
        const toIso = (value: unknown) => {
            if (typeof value === "string" && value) return value;
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
            fileName: (data.fileName as string) || String(data.file_name || id),
            createdAt: toIso(data.createdAt),
            completedAt: data.completedAt == null ? null : toIso(data.completedAt),
            stages: normalizeStages(data.stages),
            activityMessage: typeof data.activityMessage === 'string' ? data.activityMessage : null,
            activityUpdatedAt: typeof data.activityUpdatedAt === 'string' ? data.activityUpdatedAt : null,
            dedupeStats: dedupe
                ? {
                    total: Number.isFinite(totalVal) ? totalVal : 0,
                    skipped: Number.isFinite(skippedVal) ? skippedVal : 0,
                    new: Number.isFinite(newVal) ? newVal : 0,
                }
                : null,
            paused: data.paused === true,
            queueStatus: typeof data.queueStatus === 'string' ? data.queueStatus : null,
            workerActive: data.workerActive === true,
        };
    }, [normalizeStages]);

    const refreshJobHistory = useCallback(async () => {
        if (!clientId) return;
        try {
            const data = await apiJson<{ jobs: Array<Record<string, unknown>> }>(
                `/api/jobs?clientId=${encodeURIComponent(clientId)}`
            );
            const rows = (data.jobs || []).map(mapApiJobToJob);
            setJobHistory(rows);
        } catch (error) {
            console.error("Job history fetch error:", error);
            setJobHistory([]);
        }
    }, [clientId, mapApiJobToJob]);

    /** Stable key so list refetches are not tied to every Realtime stage tick. */
    const jobHistoryIdsKey = useMemo(
        () => jobHistory.map((job) => job.id).filter(Boolean).sort().join("|"),
        [jobHistory]
    );

    const refreshJobHistoryRef = useRef(refreshJobHistory);
    refreshJobHistoryRef.current = refreshJobHistory;

    const debouncedRefreshJobHistory = useMemo(
        () =>
            debounceFn(() => {
                void refreshJobHistoryRef.current();
            }, 1500),
        []
    );

    const realtimeJobIdRef = useRef(realtimeJobId);
    realtimeJobIdRef.current = realtimeJobId;

    const onClientJobsTableChange = useCallback(() => {
        // Live job panel uses useJobRealtime; skip hammering GET /jobs on every persist tick.
        if (realtimeJobIdRef.current) return;
        debouncedRefreshJobHistory();
    }, [debouncedRefreshJobHistory]);

    const buildLeadQueryParams = useCallback(({ limit, offset, includeTotal, countOnly, includeLatestEvent }: { limit: number; offset?: number; includeTotal?: boolean; countOnly?: boolean; includeLatestEvent?: boolean }) => {
        const params = new URLSearchParams();
        params.append('clientId', clientId);
        params.append('limit', String(limit));

        if (campaignFilterId) {
            params.append('instantlyCampaignId', campaignFilterId);
        }

        if (debouncedLeadSearch.trim()) {
            params.append('search', debouncedLeadSearch.trim());
        }

        if (appliedLeadFilters.length > 0) {
            params.append('filters', JSON.stringify({ clauses: appliedLeadFilters }));
        }

        if (typeof offset === 'number' && Number.isFinite(offset) && offset > 0) {
            params.append('offset', String(offset));
        }

        if (includeTotal) {
            params.append('includeTotal', 'true');
        }

        if (countOnly) {
            params.append('countOnly', 'true');
        }

        if (includeLatestEvent) {
            params.append('includeLatestEvent', 'true');
        }

        return params;
    }, [appliedLeadFilters, campaignFilterId, clientId, debouncedLeadSearch]);

    const mapApiLeadRow = useCallback((row: any): Lead => ({
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
        emailFindCompletedAt: row.emailFindCompletedAt || "",
        emailVerifyCompletedAt: row.emailVerifyCompletedAt || "",
        lastContactedAt: row.lastContactedAt || "",
        jobId: row.jobId || "",
        campaignCountAllTime: typeof row.campaignCountAllTime === "number" ? row.campaignCountAllTime : null,
        campaignCountActive: typeof row.campaignCountActive === "number" ? row.campaignCountActive : null,
        lastCampaignAddedAt: row.lastCampaignAddedAt || "",
        campaigns: row.campaigns || [],
        campaignsData: row.campaignsData || [],
        insights: row.insights || undefined,
        latestEvent: row.latestEvent || null
    }), []);

    const openLeadDetail = useCallback(async ({ email, contactId }: { email?: string; contactId?: string }) => {
        const trimmedEmail = email?.trim() || '';
        const normalizedEmail = trimmedEmail.toLowerCase();
        const normalizedContactId = contactId?.trim() || '';
        if ((!trimmedEmail && !normalizedContactId) || !user || !clientId) return;

        const cachedLead = leads.find((lead) => (
            (normalizedContactId && lead.id === normalizedContactId)
            || (normalizedEmail && lead.email?.toLowerCase() === normalizedEmail)
        ));
        if (cachedLead) {
            setSelectedLead(cachedLead);
            setLeadModalTab('detail');
            setShowLeadAdvanced(false);
            return;
        }

        setSelectedLead({
            id: normalizedContactId,
            email: trimmedEmail,
            domain: '',
            status: '',
            verified: false,
            firstLine: '',
            founderName: '',
        });
        setLeadModalTab('detail');
        setShowLeadAdvanced(false);

        try {
            const idToken = await getAccessToken();
            if (!idToken) return;
            const params = new URLSearchParams({ clientId });
            if (normalizedContactId) {
                params.append('contactId', normalizedContactId);
            } else {
                params.append('email', trimmedEmail);
            }
            const response = await fetchWithRetry(`${getPipelineBaseUrl()}/api/leads/lookup?${params.toString()}`, {
                headers: { Authorization: `Bearer ${idToken}` }
            });
            if (!response.ok) {
                throw new Error(`Failed to fetch lead (${response.status})`);
            }
            const data = await response.json();
            if (!data?.lead) {
                setSelectedLead(null);
                setToastMessage(trimmedEmail ? `No lead found for ${trimmedEmail}` : 'Lead not found.');
                return;
            }
            setSelectedLead(mapApiLeadRow(data.lead));
        } catch (error) {
            console.error('Error opening lead detail:', error);
            setSelectedLead(null);
            setToastMessage('Failed to open lead detail.');
        }
    }, [clientId, leads, mapApiLeadRow, user]);

    const fetchLeadTotal = useCallback(async () => {
        if (!user || !clientId) return;
        try {
            const idToken = await getAccessToken();
            if (!idToken) return;
            const params = buildLeadQueryParams({
                limit: 1,
                includeTotal: true,
                countOnly: true
            });

            const response = await fetchWithRetry(`${getPipelineBaseUrl()}/api/leads?${params.toString()}`, {
                headers: {
                    'Authorization': `Bearer ${idToken}`
                }
            });
            if (!response.ok) {
                throw new Error(`Failed to fetch lead total: ${response.statusText}`);
            }

            const data = await response.json();
            const total = Number.isFinite(Number(data?.total)) ? Number(data.total) : null;
            setStats((prev) => ({
                total,
                verified: prev.verified,
                unverified: total === null ? 0 : Math.max(0, total - prev.verified),
            }));
        } catch (error) {
            console.error('Failed to fetch lead total:', error);
            setStats((prev) => ({
                total: null,
                verified: prev.verified,
                unverified: 0,
            }));
        }
    }, [buildLeadQueryParams, clientId, user]);

    const fetchLeads = useCallback(async (reset = false) => {
        if (!user || !clientId) return;
        if (reset) {
            setStats((prev) => ({
                total: null,
                verified: prev.verified,
                unverified: 0,
            }));
        }
        setLeadsLoading(true);
        try {
            // Get Firebase ID token for authentication
            const idToken = await getAccessToken();
            if (!idToken) return;
            
            // Build query parameters
            const params = buildLeadQueryParams({
                limit: 100,
                offset: !reset && leadsCursor ? leadsCursor : undefined
            });

            const response = await fetchWithRetry(`${getPipelineBaseUrl()}/api/leads?${params.toString()}`, {
                headers: {
                    'Authorization': `Bearer ${idToken}`
                }
            });
            if (!response.ok) {
                throw new Error(`Failed to fetch leads: ${response.statusText}`);
            }

            const data = await response.json();
            const { leads: apiLeads, hasMore } = data;

            const mapped: Lead[] = apiLeads.map(mapApiLeadRow);

            // Deduplicate leads by ID to prevent React key conflicts
            setLeads(reset ? mapped : (prev) => {
                const existingIds = new Set(prev.map(l => l.id));
                const newLeads = mapped.filter(l => !existingIds.has(l.id));
                return [...prev, ...newLeads];
            });
            
            // Use server-provided total count
            const verifiedCount = apiLeads.filter((r: any) => r.verified).length;
            const shouldUseResultCountAsTotal = reset
                && isSingleLeadEmailSearch(debouncedLeadSearch)
                && !campaignFilterId
                && appliedLeadFilters.length === 0;
            setStats((prev) => ({
                total: shouldUseResultCountAsTotal ? mapped.length : prev.total,
                verified: verifiedCount,
                unverified: shouldUseResultCountAsTotal
                    ? Math.max(0, mapped.length - verifiedCount)
                    : prev.total === null ? 0 : Math.max(0, prev.total - verifiedCount),
            }));

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
    }, [
        user,
        clientId,
        leadsCursor,
        buildLeadQueryParams,
        mapApiLeadRow,
        debouncedLeadSearch,
        campaignFilterId,
        appliedLeadFilters.length
    ]);

    useEffect(() => {
        if (!followUpPreviewModalOpen || !user || !clientId) return;

        const query = debouncedFollowUpPreviewLeadSearch.trim();
        if (!query) {
            setFollowUpPreviewLeadResults([]);
            setFollowUpPreviewSearching(false);
            return;
        }

        let cancelled = false;

        (async () => {
            setFollowUpPreviewSearching(true);
            try {
                const idToken = await getAccessToken();
            if (!idToken) return;
                const params = new URLSearchParams();
                params.append('clientId', clientId);
                params.append('limit', '12');
                params.append('search', query);
                const response = await fetchWithRetry(`${getPipelineBaseUrl()}/api/leads?${params.toString()}`, {
                    headers: {
                        Authorization: `Bearer ${idToken}`
                    }
                });
                if (!response.ok) {
                    throw new Error(`Failed to search leads: ${response.statusText}`);
                }
                const data = await response.json();
                if (!cancelled) {
                    const mapped: Lead[] = Array.isArray(data.leads) ? data.leads.map(mapApiLeadRow) : [];
                    setFollowUpPreviewLeadResults(mapped);
                }
            } catch (err) {
                console.error('Failed to search follow-up preview leads:', err);
                if (!cancelled) {
                    setFollowUpPreviewLeadResults([]);
                }
            } finally {
                if (!cancelled) {
                    setFollowUpPreviewSearching(false);
                }
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [clientId, debouncedFollowUpPreviewLeadSearch, followUpPreviewModalOpen, mapApiLeadRow, user]);

    useEffect(() => {
        if (!autoResponderTestModalOpen || !user || !clientId) return;
        const query = debouncedAutoResponderTestLeadSearch.trim();
        if (!query) {
            setAutoResponderTestLeadResults([]);
            setAutoResponderTestLeadSearching(false);
            return;
        }
        let cancelled = false;
        (async () => {
            setAutoResponderTestLeadSearching(true);
            try {
                const idToken = await getAccessToken();
            if (!idToken) return;
                const params = new URLSearchParams();
                params.append('clientId', clientId);
                params.append('limit', '12');
                params.append('search', query);
                const response = await fetchWithRetry(`${getPipelineBaseUrl()}/api/leads?${params.toString()}`, {
                    headers: { Authorization: `Bearer ${idToken}` }
                });
                if (!response.ok) throw new Error('Failed to search leads');
                const data = await response.json();
                if (!cancelled) {
                    setAutoResponderTestLeadResults(Array.isArray(data.leads) ? data.leads.map(mapApiLeadRow) : []);
                }
            } catch (err) {
                console.error('Failed to search auto-responder test leads:', err);
                if (!cancelled) setAutoResponderTestLeadResults([]);
            } finally {
                if (!cancelled) setAutoResponderTestLeadSearching(false);
            }
        })();
        return () => { cancelled = true; };
    }, [clientId, debouncedAutoResponderTestLeadSearch, autoResponderTestModalOpen, mapApiLeadRow, user]);

    const handleCheckKlaviyo = useCallback(async () => {
        if (!user || !clientId) return;

        setCheckingKlaviyo(true);
        try {
            const idToken = await getAccessToken();
            if (!idToken) return;

            const response = await fetchWithRetry(`${getPipelineBaseUrl()}/api/leads/insights/klaviyo/query`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${idToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    clientId,
                    onlyNullUsesKlaviyo: true,
                    query: {
                        search: debouncedLeadSearch.trim() || undefined,
                        instantlyCampaignId: campaignFilterId || undefined,
                        filters: appliedLeadFilters.length > 0
                            ? { clauses: appliedLeadFilters }
                            : undefined
                    }
                })
            });

            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(data?.error || `Failed to check Klaviyo (${response.status})`);
            }

            const checkedDomainCount = Number(data?.checkedDomainCount || 0);
            const detectedCount = Number(data?.klaviyoDetectedCount || 0);
            const skippedCount = Number(data?.skippedAlreadyScoredCount || 0);
            const unresolvedCount = Array.isArray(data?.unresolvedDomains) ? data.unresolvedDomains.length : 0;

            setToastMessage(`Klaviyo check complete: ${detectedCount}/${checkedDomainCount} detected (${skippedCount} skipped, ${unresolvedCount} unresolved).`);
            setToastVisible(true);

            await fetchLeads(true);
            await fetchLeadTotal();
        } catch (error) {
            console.error('Failed to run Klaviyo check:', error);
            setToastMessage(error instanceof Error ? error.message : 'Failed to run Klaviyo check');
            setToastVisible(true);
        } finally {
            setCheckingKlaviyo(false);
        }
    }, [appliedLeadFilters, campaignFilterId, clientId, debouncedLeadSearch, fetchLeadTotal, fetchLeads, user]);

    const fetchInstantlySyncRun = useCallback(async (runId: number) => {
        if (!user || !clientId || !runId) return null;
                const idToken = await getAccessToken();
                if (!idToken) return;
        const response = await fetchWithRetry(
            `${getPipelineBaseUrl()}/api/clients/${encodeURIComponent(clientId)}/instantly/sync-runs/${runId}`,
            {
                cache: 'no-store',
                headers: {
                    Authorization: `Bearer ${idToken}`
                }
            }
        );

        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.error || `Failed to fetch Instantly sync run (${response.status})`);
        }

        const data = await response.json();
        const run = (data.run || null) as InstantlySyncRun | null;
        setInstantlySyncRun(run);
        return run;
    }, [user, clientId]);

    const fetchLatestInstantlySyncRun = useCallback(async () => {
        if (!user || !clientId) return null;
                const idToken = await getAccessToken();
                if (!idToken) return;
        const response = await fetchWithRetry(
            `${getPipelineBaseUrl()}/api/clients/${encodeURIComponent(clientId)}/instantly/sync-runs/latest`,
            {
                cache: 'no-store',
                headers: {
                    Authorization: `Bearer ${idToken}`
                }
            }
        );

        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.error || `Failed to fetch latest Instantly sync run (${response.status})`);
        }

        const data = await response.json();
        const run = (data.run || null) as InstantlySyncRun | null;
        setInstantlySyncRun(run);
        return run;
    }, [user, clientId]);

    useEffect(() => {
        if (!user || !clientId) return;
        fetchLatestInstantlySyncRun().catch((error) => {
            console.error('Failed to fetch latest Instantly sync run:', error);
        });
    }, [user?.id, clientId, fetchLatestInstantlySyncRun]);

    useEffect(() => {
        const runId = instantlySyncRun?.id;
        const status = instantlySyncRun?.status;
        if (!runId || !ACTIVE_INSTANTLY_SYNC_STATUSES.has(status || '')) {
            stopInstantlySyncPolling();
            return;
        }

        const poll = async () => {
            if (typeof document !== 'undefined' && document.hidden) return;
            try {
                const run = await fetchInstantlySyncRun(runId);
                if (!run || !ACTIVE_INSTANTLY_SYNC_STATUSES.has(run.status || '')) {
                    stopInstantlySyncPolling();
                }
            } catch (error) {
                console.error('Failed to poll Instantly sync run:', error);
            }
        };

        stopInstantlySyncPolling();
        void poll();
        instantlySyncPollRef.current = setInterval(() => {
            void poll();
        }, INSTANTLY_SYNC_POLL_MS);

        const onVisibilityChange = () => {
            if (!document.hidden) void poll();
        };
        document.addEventListener('visibilitychange', onVisibilityChange);

        return () => {
            stopInstantlySyncPolling();
            document.removeEventListener('visibilitychange', onVisibilityChange);
        };
    }, [instantlySyncRun?.id, instantlySyncRun?.status, fetchInstantlySyncRun, stopInstantlySyncPolling]);

    const loadMoreLeads = useCallback(() => {
        if (leadsLoading || !leadsHasMore) return;
        fetchLeads(false);
    }, [fetchLeads, leadsHasMore, leadsLoading]);

    useEffect(() => {
        const currentStatus = instantlySyncRun?.status || null;
        const previousStatus = previousInstantlySyncStatusRef.current;
        previousInstantlySyncStatusRef.current = currentStatus;

        if (currentStatus === 'completed' && previousStatus && previousStatus !== 'completed') {
            setLeads([]);
            setLeadsCursor(0);
            setLeadsHasMore(true);
            fetchLeads(true);
            fetchLeadTotal();
        }
    }, [instantlySyncRun?.status, fetchLeadTotal, fetchLeads]);

    // All filters are now applied server-side
    const filteredLeads = useMemo(() => {
        return leads;
    }, [leads]);

    const displayedStats = useMemo(() => {
        // Stats come from server with filters applied
        return stats;
    }, [stats]);

    const displayedLeadTotal = displayedStats.total;
    const displayedLeadTotalLabel = displayedLeadTotal === null ? '...' : displayedLeadTotal.toLocaleString();

    useEffect(() => {
        return () => {
            stopJobWatch();
        };
    }, [stopJobWatch]);

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
            const idToken = await getAccessToken();
            if (!idToken) return;
            const response = await fetchWithRetry(`${getPipelineBaseUrl()}/api/jobs/${jobId}?clientId=${clientId}`, {
                cache: "no-store",
                headers: {
                    'Authorization': `Bearer ${idToken}`
                }
            });
            if (!response.ok || response.status === 304) return;
            const payload = await response.json();
            if (payload?.job) {
                const raw = payload.job as Record<string, unknown>;
                setJobState((prev) => mergeJobState(prev, mapApiJobToJob(raw)));
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
    }, [user, clientId, mergeJobState, mapApiJobToJob]);

    const startJobWatch = useCallback(
        (jobId: string) => {
            if (!jobId) return;
            if (lastWatchedJobIdRef.current === jobId) return;

            if (lastWatchedJobIdRef.current) {
                stopJobWatch();
            }
            setSelectedJobId(jobId);
            lastWatchedJobIdRef.current = jobId;
            setRealtimeJobId(jobId);
            void fetchJobSnapshot(jobId, true);
        },
        [stopJobWatch, fetchJobSnapshot],
    );

    const serializeActiveJobSnapshot = (active: {
        jobId?: string;
        status?: string;
        upload_status?: string | null;
        upload_error?: string | null;
        upload_metrics?: { count?: number; total?: number } | null;
        error?: string | null;
    } | null) => {
        if (!active?.jobId) return "none";
        const status = active.upload_status || active.status || "";
        const metrics = active.upload_metrics;
        return [
            active.jobId,
            status,
            active.upload_error || "",
            metrics?.count ?? "",
            metrics?.total ?? "",
            active.error || ""
        ].join("|");
    };

    const applyActiveJobPayload = useCallback((active: {
        jobId?: string;
        status?: string;
        upload_status?: string | null;
        upload_error?: string | null;
        upload_metrics?: { count?: number; total?: number } | null;
        error?: string | null;
    } | null) => {
        const snapshot = serializeActiveJobSnapshot(active);
        if (snapshot === lastActiveJobSnapshotRef.current) {
            return;
        }
        lastActiveJobSnapshotRef.current = snapshot;

        if (!active?.jobId) {
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

        const jobId = active.jobId;
        const status = (active.status || active.upload_status || null) as string | null;
        const uploadErrorMessage = active.upload_error || null;
        const errorMessage = active.error || uploadErrorMessage;
        const metricsRaw = active.upload_metrics || undefined;
        const parsedMetrics = metricsRaw
            ? {
                count: Number.isFinite(metricsRaw.count) ? Number(metricsRaw.count) : 0,
                total: Number.isFinite(metricsRaw.total ?? metricsRaw.count)
                    ? Number(metricsRaw.total ?? metricsRaw.count)
                    : 0,
            }
            : null;

        setActiveJobStatus(status);
        setUploadMetrics(parsedMetrics);
        setInstantlyUploadError(uploadErrorMessage);
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

        const shouldRestoreActiveJob = Boolean(
            jobId && (status === "running" || status === "queued" || status === "pending-upload")
        );

        if (jobId && shouldRestoreActiveJob) {
            setSelectedJobId(jobId);
            const compositeKey = `${jobId}:${status ?? ""}`;
            if (previousJobIdRef.current !== compositeKey) {
                previousJobIdRef.current = compositeKey;
                fetchJobSnapshot(jobId, false);
            }
        } else {
            previousJobIdRef.current = null;
        }

        const shouldWatch = status === "running" || status === "queued";
        const isWatching = jobId && lastWatchedJobIdRef.current === jobId;
        if (jobId && shouldWatch) {
            if (!isWatching) {
                startJobWatch(jobId);
            }
        } else if (
            isWatching
            && (!status || status === "completed" || status === "uploaded" || status === "failed" || status === "discarded")
        ) {
            stopJobWatch();
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
    }, [stopJobWatch, fetchJobSnapshot, startJobWatch]);

    const pollActiveJob = useCallback(async (force = false) => {
        if (!clientId || activeJobPollInFlightRef.current) return;
        const now = Date.now();
        if (!force && now - lastActiveJobPollAtRef.current < ACTIVE_JOB_POLL_MIN_GAP_MS) {
            return;
        }
        lastActiveJobPollAtRef.current = now;
        activeJobPollInFlightRef.current = true;
        try {
            const payload = await apiJson<{
                activeJob: {
                    jobId?: string;
                    status?: string;
                    upload_status?: string | null;
                    upload_error?: string | null;
                    upload_metrics?: { count?: number; total?: number } | null;
                    error?: string | null;
                } | null;
            }>(`/api/clients/${encodeURIComponent(clientId)}/active-job`);
            applyActiveJobPayload(payload.activeJob || null);
        } catch (error) {
            console.error("Active job poll error:", error);
        } finally {
            activeJobPollInFlightRef.current = false;
        }
    }, [clientId, applyActiveJobPayload]);

    pollActiveJobRef.current = pollActiveJob;

    const needsActiveJobPoll = useMemo(() => {
        if (!user?.id || !clientId) return false;

        const uploadStatus = activeJobStatus || currentJobStatusRef.current;
        const pipelineStatus = jobState?.status;

        // Running pipeline progress is driven by Supabase job realtime while watched.
        if (realtimeJobId) {
            const liveStatus = uploadStatus || pipelineStatus;
            if (
                liveStatus === "running"
                || liveStatus === "queued"
                || jobState?.paused
            ) {
                return false;
            }
        }

        if (uploadStatus === "pending-upload") {
            return true;
        }
        if (uploadStatus === "running" || uploadStatus === "queued") {
            return true;
        }
        if (pipelineStatus === "running" || pipelineStatus === "queued") {
            return true;
        }

        return false;
    }, [
        user?.id,
        clientId,
        realtimeJobId,
        activeJobStatus,
        jobState?.status,
        jobState?.paused
    ]);

    useEffect(() => {
        if (!user?.id || !clientId) return;
        void pollActiveJobRef.current?.(true);
    }, [user?.id, clientId]);

    useIntervalWhenVisible(
        () => {
            void pollActiveJobRef.current?.();
        },
        ACTIVE_JOB_POLL_MS,
        needsActiveJobPoll
    );

    useEffect(() => {
        if (!user || !clientId) return;
        refreshJobHistory();
    }, [user?.id, clientId, refreshJobHistory]);

    useClientJobsRealtime(clientSqlId, onClientJobsTableChange);

    useEffect(() => {
        const liveJob = jobStateRef.current;

        if (!jobHistory.length) {
            if (!liveJob) {
                setSelectedJobId(null);
            }
            return;
        }

        const selectedFromHistory = selectedJobId
            ? jobHistory.find((job) => job.id === selectedJobId) || null
            : null;

        // Supabase Realtime + snapshot own jobState while a live job is watched.
        if (realtimeJobId && realtimeJobId === selectedJobId) {
            return;
        }

        // Active job not in history yet (e.g. just uploaded) — keep current panel state.
        if (liveJob && !jobHistory.find((j) => j.id === liveJob.id)) {
            return;
        }

        // Selected job from history only (completed / not live-watched).
        if (selectedFromHistory) {
            setJobState((prev) => {
                if (prev?.id === selectedFromHistory.id) {
                    if (
                        pipelineStatusRank(selectedFromHistory.status)
                        < pipelineStatusRank(prev.status)
                    ) {
                        return prev;
                    }
                    const merged = mergeJobState(prev, selectedFromHistory);
                    if (
                        merged.status === prev.status
                        && merged.error === prev.error
                        && merged.paused === prev.paused
                    ) {
                        return prev;
                    }
                    return merged;
                }
                return selectedFromHistory;
            });
            return;
        }

        if (!selectedJobId) {
            return;
        }

        if (!selectedFromHistory) {
            setSelectedJobId(null);
            setJobState(null);
        }
    }, [jobHistory, realtimeJobId, selectedJobId, mergeJobState]);

    // Instantly upload badges on history cards (not pipeline progress — do not poll during runs).
    const fetchJobsUploadStatus = useCallback(async () => {
        if (!user || !clientId || !agencyId) return;

        const jobIds = jobHistoryIdsKey ? jobHistoryIdsKey.split("|").filter(Boolean) : [];
        if (jobIds.length === 0) {
            setJobUploadStatus({});
            return;
        }

        try {
            const data = await apiJson<{ statusMap?: Record<string, unknown[]> }>(
                `/api/jobs/batch/upload-status`,
                {
                    method: "POST",
                    body: JSON.stringify({ jobIds, clientId }),
                }
            );
            setJobUploadStatus(data.statusMap || {});
        } catch (error) {
            console.error("Error fetching upload status:", error);
        }
    }, [user?.id, clientId, agencyId, jobHistoryIdsKey]);

    const fetchInstantlyEventAnalytics = useCallback(async (showLoading = true) => {
        if (!user || !clientId) return;

        try {
            if (showLoading) {
                setInstantlyEventAnalyticsLoading(true);
            }
            setInstantlyEventAnalyticsError(null);

            const token = await getAccessToken();
            if (!token) return;
            const params = new URLSearchParams({
                period: instantlyEventAnalyticsPeriod,
                eventType: instantlyEventAnalyticsEventType
            });
            const response = await fetchWithRetry(
                `${getPipelineBaseUrl()}/api/clients/${encodeURIComponent(clientId)}/analytics/instantly-events?${params.toString()}`,
                {
                    headers: {
                        Authorization: `Bearer ${token}`
                    }
                }
            );

            const data = await response.json();
            if (!response.ok) {
                throw new Error(data?.error || `Failed to fetch analytics (${response.status})`);
            }

            const analyticsPayload = data as InstantlyEventAnalyticsPayload;
            const recentEventIds = (analyticsPayload.recentEvents || []).map((event) => event.id);
            const previousRecentEventIds = previousRecentEventIdsRef.current;

            if (recentEventAnimationTimeoutRef.current) {
                clearTimeout(recentEventAnimationTimeoutRef.current);
                recentEventAnimationTimeoutRef.current = null;
            }

            if (!previousRecentEventIds) {
                previousRecentEventIdsRef.current = new Set(recentEventIds);
                setAnimatedRecentEventIds(new Set());
            } else {
                const newRecentEventIds = recentEventIds.filter((id) => !previousRecentEventIds.has(id));
                previousRecentEventIdsRef.current = new Set(recentEventIds);

                if (newRecentEventIds.length > 0) {
                    setAnimatedRecentEventIds(new Set(newRecentEventIds));
                    recentEventAnimationTimeoutRef.current = setTimeout(() => {
                        setAnimatedRecentEventIds(new Set());
                        recentEventAnimationTimeoutRef.current = null;
                    }, 1800);
                } else {
                    setAnimatedRecentEventIds(new Set());
                }
            }

            setInstantlyEventAnalytics(analyticsPayload);
        } catch (error) {
            console.error('Error fetching Instantly event analytics:', error);
            setInstantlyEventAnalyticsError(error instanceof Error ? error.message : 'Failed to fetch Instantly event analytics.');
        } finally {
            if (showLoading) {
                setInstantlyEventAnalyticsLoading(false);
            }
        }
    }, [user, clientId, instantlyEventAnalyticsEventType, instantlyEventAnalyticsPeriod]);

    const fetchPendingReviewDrafts = useCallback(async (showLoading = true) => {
        if (!user || !clientId) return;
        try {
            if (showLoading) {
                setPendingReviewDraftsLoading(true);
            }
            const token = await getAccessToken();
            if (!token) return;
            const response = await fetchWithRetry(
                `${getPipelineBaseUrl()}/api/clients/${encodeURIComponent(clientId)}/interested-autoresponder/drafts/pending-review`,
                { headers: { Authorization: `Bearer ${token}` } }
            );
            const data = await response.json();
            if (!response.ok) throw new Error(data?.error || `Failed to fetch drafts (${response.status})`);

            const draftRows: PendingReviewDraft[] = (data.drafts || []).filter(
                (draft: PendingReviewDraft) => isPendingReviewDraftCurrentlyInterested(draft)
            );
            const draftIds = draftRows.map((draft) => draft.id);
            const previousDraftIds = previousPendingDraftIdsRef.current;

            if (pendingDraftAnimationTimeoutRef.current) {
                clearTimeout(pendingDraftAnimationTimeoutRef.current);
                pendingDraftAnimationTimeoutRef.current = null;
            }

            if (!previousDraftIds) {
                previousPendingDraftIdsRef.current = new Set(draftIds);
                setAnimatedPendingDraftIds(new Set());
            } else {
                const newDraftIds = draftIds.filter((id) => !previousDraftIds.has(id));
                previousPendingDraftIdsRef.current = new Set(draftIds);

                if (newDraftIds.length > 0) {
                    setAnimatedPendingDraftIds(new Set(newDraftIds));
                    pendingDraftAnimationTimeoutRef.current = setTimeout(() => {
                        setAnimatedPendingDraftIds(new Set());
                        pendingDraftAnimationTimeoutRef.current = null;
                    }, 1800);
                } else {
                    setAnimatedPendingDraftIds(new Set());
                }
            }

            setPendingReviewDrafts(draftRows);
        } catch (error) {
            console.error('Error fetching pending review drafts:', error);
        } finally {
            if (showLoading) {
                setPendingReviewDraftsLoading(false);
            }
        }
    }, [user, clientId]);

    useEffect(() => {
        if (jobState) {
            setSelectedJobId(jobState.id);
        }
    }, [jobState?.id]);

    useEffect(() => {
        if (activeTab !== "analytics" || !user || !clientId) {
            return;
        }

        fetchInstantlyEventAnalytics(true);
        fetchPendingReviewDrafts();
    }, [activeTab, user, clientId, instantlyEventAnalyticsEventType, instantlyEventAnalyticsPeriod, fetchInstantlyEventAnalytics, fetchPendingReviewDrafts]);

    useEffect(() => {
        if (activeTab !== 'follow-ups' || !user || !clientId) return;
        let cancelled = false;
        setFollowUpScriptsLoading(true);
        setInterestedAutoResponderPromptsLoading(true);
        (async () => {
            try {
                const idToken = await getAccessToken();
            if (!idToken) return;
                const [scriptsResponse, prompts, campaignOptions] = await Promise.all([
                    fetchWithRetry(`${getPipelineBaseUrl()}/api/clients/${encodeURIComponent(clientId)}/follow-up-scripts`, {
                        headers: { Authorization: `Bearer ${idToken}` }
                    }),
                    fetchInterestedAutoResponderPrompts(),
                    fetchSqlCampaignList()
                ]);
                const scriptData = await scriptsResponse.json();
                if (!cancelled) {
                    setFollowUpScripts(scriptData.scripts || []);
                    if (Array.isArray(scriptData.send_days) && scriptData.send_days.length > 0) {
                        setFollowUpSendDays(scriptData.send_days);
                    }
                    setInterestedAutoResponderPrompts(prompts || []);
                    setAutoResponderCampaigns(campaignOptions || []);
                }
            } catch (err) {
                console.error('Failed to fetch follow-up scripts:', err);
            } finally {
                if (!cancelled) {
                    setFollowUpScriptsLoading(false);
                    setInterestedAutoResponderPromptsLoading(false);
                }
            }
        })();
        return () => { cancelled = true; };
    }, [activeTab, user, clientId]);

    useEffect(() => {
        if (!instantlyEventAnalytics || instantlyEventAnalyticsEventType === "all") {
            return;
        }

        const stillAvailable = (instantlyEventAnalytics.availableEventTypes || []).some(
            (option) => option.value === instantlyEventAnalyticsEventType
        );
        if (!stillAvailable) {
            setInstantlyEventAnalyticsEventType("all");
        }
    }, [instantlyEventAnalytics, instantlyEventAnalyticsEventType]);

    useEffect(() => {
        previousRecentEventIdsRef.current = null;
        setAnimatedRecentEventIds(new Set());
        previousPendingDraftIdsRef.current = null;
        setAnimatedPendingDraftIds(new Set());

        if (recentEventAnimationTimeoutRef.current) {
            clearTimeout(recentEventAnimationTimeoutRef.current);
            recentEventAnimationTimeoutRef.current = null;
        }
        if (pendingDraftAnimationTimeoutRef.current) {
            clearTimeout(pendingDraftAnimationTimeoutRef.current);
            pendingDraftAnimationTimeoutRef.current = null;
        }
    }, [clientId, instantlyEventAnalyticsEventType, instantlyEventAnalyticsPeriod]);

    useEffect(() => () => {
        if (recentEventAnimationTimeoutRef.current) {
            clearTimeout(recentEventAnimationTimeoutRef.current);
        }
        if (pendingDraftAnimationTimeoutRef.current) {
            clearTimeout(pendingDraftAnimationTimeoutRef.current);
        }
    }, []);

    useEffect(() => {
        if (activeTab !== "analytics") {
            return;
        }

        if (instantlyEventAnalyticsLoading || !instantlyEventAnalytics) {
            return;
        }

        const websocketUrl = instantlyEventAnalytics?.realtimeConfig?.websocketUrl;
        if (!websocketUrl) {
            setInstantlyEventRealtimeError('Supabase Realtime connection details are unavailable.');
            return;
        }

        const sqlClientId = instantlyEventAnalytics?.clientSqlId;
        if (!sqlClientId) {
            return;
        }

        const topic = `realtime:analytics-contact-instantly-events-${sqlClientId}`;
        let messageRef = 0;
        let joinRef = "1";
        let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
        let refreshAnalyticsTimeout: ReturnType<typeof setTimeout> | null = null;
        let refreshDraftsTimeout: ReturnType<typeof setTimeout> | null = null;
        let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
        let socket: WebSocket | null = null;
        let closed = false;
        let reconnectAttempts = 0;
        const MAX_RECONNECT_ATTEMPTS = 5;

        const nextRef = () => {
            messageRef += 1;
            return String(messageRef);
        };

        const send = (message: Record<string, unknown>) => {
            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify(message));
            }
        };

        const scheduleAnalyticsRefresh = () => {
            if (refreshAnalyticsTimeout) {
                clearTimeout(refreshAnalyticsTimeout);
            }
            refreshAnalyticsTimeout = setTimeout(() => {
                fetchInstantlyEventAnalytics(false);
            }, 250);
        };

        const scheduleDraftsRefresh = () => {
            if (refreshDraftsTimeout) {
                clearTimeout(refreshDraftsTimeout);
            }
            refreshDraftsTimeout = setTimeout(() => {
                fetchPendingReviewDrafts(false);
            }, 250);
        };

        const clearHeartbeat = () => {
            if (heartbeatInterval) {
                clearInterval(heartbeatInterval);
                heartbeatInterval = null;
            }
        };

        const scheduleReconnect = (message?: string, delay = 1500) => {
            if (closed || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
                if (message && reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
                    setInstantlyEventRealtimeError(message);
                }
                return;
            }
            if (reconnectTimeout) {
                return;
            }
            reconnectAttempts += 1;
            reconnectTimeout = setTimeout(() => {
                reconnectTimeout = null;
                connectSocket();
            }, delay);
        };

        const connectSocket = () => {
            clearHeartbeat();
            socket = new WebSocket(websocketUrl);

            socket.onopen = () => {
                reconnectAttempts = 0;
                setInstantlyEventRealtimeError(null);
            joinRef = nextRef();
            send({
                topic,
                event: "phx_join",
                payload: {
                    config: {
                        broadcast: { ack: false, self: false },
                        presence: { enabled: false },
                        postgres_changes: [
                            {
                                event: "*",
                                schema: "public",
                                table: "contact_instantly_events",
                                filter: `client_id=eq.${sqlClientId}`
                            },
                            {
                                event: "*",
                                schema: "public",
                                table: "interested_autoresponder_drafts",
                                filter: `client_id=eq.${sqlClientId}`
                            }
                        ],
                        private: false
                    }
                },
                ref: joinRef,
                join_ref: joinRef
            });

            heartbeatInterval = setInterval(() => {
                send({
                    topic: "phoenix",
                    event: "heartbeat",
                    payload: {},
                    ref: nextRef(),
                    join_ref: null
                });
            }, 20000);
            };

            socket.onmessage = (event) => {
                try {
                    const payload = JSON.parse(event.data);
                    if (payload?.event === "postgres_changes" && payload?.topic === topic) {
                        scheduleAnalyticsRefresh();
                        scheduleDraftsRefresh();
                        return;
                    }
                    if (payload?.event === "system" && payload?.topic === topic) {
                        const systemMessage = String(payload?.payload?.message || "");
                        if (systemMessage.includes("InitializingProjectConnection")) {
                            clearHeartbeat();
                            socket?.close();
                            scheduleReconnect(undefined, 2000);
                        }
                        return;
                    }
                    if (payload?.event === "phx_reply" && payload?.topic === topic && payload?.payload?.status === "error") {
                        const reason = String(payload?.payload?.response?.reason || "Supabase Realtime join failed.");
                        if (reason.includes("InitializingProjectConnection")) {
                            clearHeartbeat();
                            socket?.close();
                            scheduleReconnect(undefined, 2000);
                            return;
                        }
                        setInstantlyEventRealtimeError(reason);
                        return;
                    }
                    if (payload?.event === "phx_error") {
                        scheduleReconnect("Supabase Realtime channel error.");
                    }
                } catch (error) {
                    console.error("Failed to parse Supabase Realtime payload:", error);
                }
            };

            socket.onerror = () => {
                scheduleReconnect("Supabase Realtime connection failed.");
            };

            socket.onclose = () => {
                clearHeartbeat();
                if (!closed) {
                    scheduleReconnect("Supabase Realtime disconnected.");
                }
            };
        };

        connectSocket();

        return () => {
            closed = true;
            if (refreshAnalyticsTimeout) {
                clearTimeout(refreshAnalyticsTimeout);
            }
            if (refreshDraftsTimeout) {
                clearTimeout(refreshDraftsTimeout);
            }
            if (reconnectTimeout) {
                clearTimeout(reconnectTimeout);
            }
            clearHeartbeat();
            if (socket?.readyState === WebSocket.OPEN) {
                send({
                    topic,
                    event: "phx_leave",
                    payload: {},
                    ref: nextRef(),
                    join_ref: joinRef
                });
            }
            socket?.close();
        };
    }, [activeTab, instantlyEventAnalytics, instantlyEventAnalyticsLoading, fetchInstantlyEventAnalytics, fetchPendingReviewDrafts]);

    // Instantly upload status: when job list membership changes, not on every pipeline UPDATE.
    useEffect(() => {
        if (!jobHistoryIdsKey) {
            setJobUploadStatus({});
            return;
        }
        if (jobState?.status === "running" || jobState?.status === "queued") {
            return;
        }
        void fetchJobsUploadStatus();
    }, [jobHistoryIdsKey, jobState?.status, fetchJobsUploadStatus]);

    const prevPipelineStatusRef = useRef<string | null>(null);
    useEffect(() => {
        const status = jobState?.status ?? null;
        const prev = prevPipelineStatusRef.current;
        if (
            prev === "running"
            && (status === "completed" || status === "failed")
        ) {
            void refreshJobHistory();
            void fetchJobsUploadStatus();
        }
        prevPipelineStatusRef.current = status;
    }, [jobState?.status, refreshJobHistory, fetchJobsUploadStatus]);

    useEffect(() => {
        if (!personalizerJobId) return;

        let cancelled = false;
        let toastShown = false;

        const poll = async () => {
            try {
                const payload = await apiJson<{ job: Record<string, unknown> }>(
                    `/api/jobs/personalizer/${encodeURIComponent(personalizerJobId)}/status`
                );
                if (cancelled) return;
                const jobData = payload.job || {};
                setPersonalizerJobState(jobData);

                if (jobData.status === "completed" && !toastShown) {
                    toastShown = true;
                    const personalized = (jobData.result as { personalized?: number })?.personalized || 0;
                    setToastMessage(`Personalizer complete! ${personalized} leads personalized`);
                    setToastVisible(true);
                } else if (jobData.status === "failed" && !toastShown) {
                    toastShown = true;
                    setToastMessage(`Personalizer failed: ${String(jobData.error || "Unknown error")}`);
                    setToastVisible(true);
                }
            } catch (error) {
                console.error("Personalizer status poll error:", error);
            }
        };

        poll();
        const timer = window.setInterval(() => {
            if (document.visibilityState === "visible") {
                void poll();
            }
        }, 2000);
        const onVisibility = () => {
            if (document.visibilityState === "visible") {
                void poll();
            }
        };
        document.addEventListener("visibilitychange", onVisibility);
        return () => {
            cancelled = true;
            window.clearInterval(timer);
            document.removeEventListener("visibilitychange", onVisibility);
        };
    }, [personalizerJobId]);

    useEffect(() => {
        if (!jobState || !user || !clientId) {
            return;
        }

        const isWatchedJob = lastWatchedJobIdRef.current === jobState.id;
        if (jobState.status === "completed") {
            if (!isWatchedJob) {
                return;
            }
            setJobStatusMessage("Pipeline finished.");
            stopJobWatch();
            setJobPendingUpload(jobState.id);
        } else if (jobState.status === "failed") {
            if (!isWatchedJob) {
                return;
            }
            setJobStatusMessage(jobState.error || "Pipeline failed.");
            stopJobWatch();
        }
    }, [jobState, stopJobWatch, user, clientId]);

    const handleRefreshCampaigns = useCallback(async () => {
        if (!user || !clientId) return;
        setSyncingCampaigns(true);
        setCampaignSyncMessage("");
        try {
            const idToken = await getAccessToken();
            if (!idToken) return;
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
                if (domainColumnIndex >= 0 && user && clientId && agencyId) {
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
                        const token = await getAccessToken();
            if (!token) return;
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
        setJobState(job);
        setSelectedJobId(job.id);

        if (job.status === "running" || job.status === "queued") {
            startJobWatch(job.id);
        } else {
            stopJobWatch();
        }

        void fetchJobSnapshot(job.id);
    }, [stopJobWatch, startJobWatch, fetchJobSnapshot]);

    const handleUploadClick = async () => {
        if (!selectedFile || !user) {
            return;
        }
        setUploadError("");
        setUploading(true);
        try {
            const idToken = await getAccessToken();
            if (!idToken) return;
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
            setJobHistory((prev) => {
                if (prev.some((job) => job.id === freshJob.id)) return prev;
                return [freshJob, ...prev];
            });
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

            startJobWatch(jobId);
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
            const idToken = await getAccessToken();
            if (!idToken) return;
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
                const idToken = await getAccessToken();
            if (!idToken) return;
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
            const idToken = await getAccessToken();
            if (!idToken) return;
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
            
            stopJobWatch();
            
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

    const waitForGracefulPause = useCallback(
        async (jobId: string) => {
            const deadline = Date.now() + 120_000;
            while (Date.now() < deadline) {
                const idToken = await getAccessToken();
                if (!idToken) return null;
                const response = await fetchWithRetry(
                    `${getPipelineBaseUrl()}/api/jobs/${jobId}?clientId=${encodeURIComponent(clientId)}`,
                    {
                        cache: 'no-store',
                        headers: { Authorization: `Bearer ${idToken}` },
                    }
                );
                if (!response.ok) {
                    await new Promise((resolve) => setTimeout(resolve, 500));
                    continue;
                }
                const payload = await response.json();
                const raw = payload?.job as Record<string, unknown> | undefined;
                if (!raw?.id) {
                    await new Promise((resolve) => setTimeout(resolve, 500));
                    continue;
                }
                const snapshot = mapApiJobToJob(raw);
                setJobState((prev) => mergeJobState(prev, snapshot));
                const pauseSettled =
                    snapshot.queueStatus === 'paused'
                    || (
                        snapshot.paused === true
                        && snapshot.workerActive !== true
                        && snapshot.queueStatus !== 'running'
                    );
                if (pauseSettled) {
                    return snapshot;
                }
                await new Promise((resolve) => setTimeout(resolve, 500));
            }
            return null;
        },
        [clientId, mapApiJobToJob, mergeJobState]
    );

    const handlePauseResumeJob = async () => {
        if (!user || !jobState?.id || !clientId) return;

        const isPaused = jobState.paused === true;
        const endpoint = isPaused ? 'resume' : 'pause';

        pendingPauseControlRef.current = isPaused ? 'resume' : 'pause';
        setPausingJob(true);
        try {
            const idToken = await getAccessToken();
            if (!idToken) return;
            const resp = await fetchWithRetry(`${getPipelineBaseUrl()}/api/jobs/${jobState.id}/${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ idToken, clientId }),
            });
            if (!resp.ok) {
                const data = await resp.json().catch(() => ({}));
                throw new Error(data.error || `Failed to ${endpoint} job (${resp.status})`);
            }

            if (isPaused) {
                setJobState((prev) => (prev ? { ...prev, paused: false } : prev));
                setJobStatusMessage('Job resumed.');
            } else {
                const snapshot = await waitForGracefulPause(jobState.id);
                setJobState((prev) =>
                    prev
                        ? {
                              ...prev,
                              paused: true,
                              queueStatus: snapshot?.queueStatus ?? 'paused',
                              workerActive: false,
                          }
                        : prev
                );
                setJobStatusMessage(
                    snapshot ? 'Job paused.' : 'Pause requested; worker may still be stopping.'
                );
            }
        } catch (error) {
            setToastMessage(error instanceof Error ? error.message : `Failed to ${endpoint} job`);
            setToastVisible(true);
        } finally {
            pendingPauseControlRef.current = null;
            setPausingJob(false);
        }
    };

    const persistClientInfo = useCallback(async () => {
        if (!user || !clientId) return;
        await apiJson(`/api/clients/${encodeURIComponent(clientId)}`, {
            method: "PATCH",
            body: JSON.stringify({
                name: clientName?.trim() || clientId,
                industry: clientIndustry,
                instantly_key: clientInstantlyKey?.trim() || "",
                ntfy_topic: clientNtfyTopic?.trim() || "",
            }),
        });
    }, [user, clientId, clientName, clientIndustry, clientInstantlyKey, clientNtfyTopic]);

    const handleSaveClientInfo = async () => {
        if (!user || !clientId) return;
        setIsSavingClient(true);
        try {
            await persistClientInfo();
            setToastMessage('Client info saved');
            setToastVisible(true);
        } catch (error) {
            setToastMessage(error instanceof Error ? error.message : 'Failed to save client info');
            setToastVisible(true);
        } finally {
            setIsSavingClient(false);
        }
    };

    const handleRegisterInstantlyWebhook = async () => {
        if (!user || !clientId) return;
        if (!clientInstantlyKey.trim()) {
            setToastMessage('Save an Instantly API key first.');
            setToastVisible(true);
            return;
        }

        setRegisteringInstantlyWebhook(true);
        try {
            await persistClientInfo();
            const idToken = await getAccessToken();
            if (!idToken) return;
            const response = await fetchWithRetry(
                `${getPipelineBaseUrl()}/api/clients/${encodeURIComponent(clientId)}/instantly/webhook`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ idToken })
                }
            );
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(data.error || `Failed to register Instantly webhook (${response.status})`);
            }

            setToastMessage(data.targetUrl ? 'Instantly webhook registered.' : 'Instantly webhook updated.');
            setToastVisible(true);
        } catch (error) {
            setToastMessage(error instanceof Error ? error.message : 'Failed to register Instantly webhook');
            setToastVisible(true);
        } finally {
            setRegisteringInstantlyWebhook(false);
        }
    };

    const handleSyncInstantlyState = async () => {
        if (!user || !clientId) return;
        if (!clientInstantlyKey.trim()) {
            setToastMessage('Save an Instantly API key first.');
            setToastVisible(true);
            return;
        }

        setSyncingInstantlyState(true);
        try {
            await persistClientInfo();
            const idToken = await getAccessToken();
            if (!idToken) return;
            const selectedCampaign = instantlySyncCampaignId
                ? instantlyCampaigns.find((c) => c.id === instantlySyncCampaignId)
                : null;
            const response = await fetchWithRetry(
                `${getPipelineBaseUrl()}/api/clients/${encodeURIComponent(clientId)}/instantly/sync`,
                {
                    method: 'POST',
                    cache: 'no-store',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        idToken,
                        ...(instantlySyncCampaignId ? { instantlyCampaignId: instantlySyncCampaignId } : {})
                    })
                }
            );
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(data.error || `Failed to sync Instantly state (${response.status})`);
            }

            setInstantlySyncRun((data.run || null) as InstantlySyncRun | null);
            const campaignLabel = selectedCampaign?.name || instantlySyncCampaignId;
            setToastMessage(
                data.alreadyRunning
                    ? 'Instantly sync is already running.'
                    : instantlySyncCampaignId
                        ? `Instantly sync started for ${campaignLabel}.`
                        : 'Instantly sync started for all campaigns.'
            );
            setToastVisible(true);
        } catch (error) {
            setToastMessage(error instanceof Error ? error.message : 'Failed to sync Instantly state');
            setToastVisible(true);
        } finally {
            setSyncingInstantlyState(false);
        }
    };

    const handleSyncInstantlyEmailAccounts = async () => {
        if (!user || !clientId) return;
        if (!clientInstantlyKey.trim()) {
            setToastMessage('Save an Instantly API key first.');
            setToastVisible(true);
            return;
        }

        setSyncingInstantlyEmailAccounts(true);
        try {
            await persistClientInfo();
            const idToken = await getAccessToken();
            if (!idToken) return;
            const response = await fetchWithRetry(
                `${getPipelineBaseUrl()}/api/clients/${encodeURIComponent(clientId)}/instantly/email-accounts/sync`,
                {
                    method: 'POST',
                    cache: 'no-store',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ idToken })
                }
            );
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(data.error || `Failed to sync Instantly email accounts (${response.status})`);
            }

            setToastMessage(`Synced ${data.syncedCount ?? 0} Instantly email account${data.syncedCount === 1 ? '' : 's'}.`);
            setToastVisible(true);
        } catch (error) {
            setToastMessage(error instanceof Error ? error.message : 'Failed to sync Instantly email accounts');
            setToastVisible(true);
        } finally {
            setSyncingInstantlyEmailAccounts(false);
        }
    };

    const handleSaveFollowUpSchedule = async (days: number[]) => {
        if (!user || !clientId) return;
        setSavingFollowUpSchedule(true);
        try {
            const idToken = await getAccessToken();
            if (!idToken) return;
            const response = await fetchWithRetry(
                `${getPipelineBaseUrl()}/api/clients/${encodeURIComponent(clientId)}/follow-up-schedule`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
                    body: JSON.stringify({ send_days: days })
                }
            );
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || 'Failed to save schedule');
            setFollowUpSendDays(data.send_days ?? days);
            setToastMessage('Follow-up schedule saved.');
            setToastVisible(true);
        } catch (error) {
            setToastMessage(error instanceof Error ? error.message : 'Failed to save schedule');
            setToastVisible(true);
        } finally {
            setSavingFollowUpSchedule(false);
        }
    };

    const openAutoResponderPromptModal = (prompt?: InterestedAutoResponderPrompt) => {
        if (prompt) {
            setEditingAutoResponderPrompt(prompt);
            setAutoResponderPromptCampaignId(String(prompt.campaign_id));
            setAutoResponderPromptVersion(prompt.version || 'v1');
            setAutoResponderPromptSystemPrompt(prompt.system_prompt || '');
            setAutoResponderPromptActive(prompt.active);
        } else {
            setEditingAutoResponderPrompt(null);
            setAutoResponderPromptCampaignId(autoResponderCampaigns[0]?.id || '');
            setAutoResponderPromptVersion('v1');
            setAutoResponderPromptSystemPrompt('');
            setAutoResponderPromptActive(true);
        }
        setAutoResponderPromptModalOpen(true);
    };

    const handleSaveAutoResponderPrompt = async () => {
        if (!user || !clientId) return;
        if (!autoResponderPromptCampaignId) {
            setToastMessage('Select a campaign first.');
            setToastVisible(true);
            return;
        }
        if (!autoResponderPromptVersion.trim()) {
            setToastMessage('Version is required.');
            setToastVisible(true);
            return;
        }
        if (!autoResponderPromptSystemPrompt.trim()) {
            setToastMessage('System prompt is required.');
            setToastVisible(true);
            return;
        }

        setSavingAutoResponderPrompt(true);
        try {
            const idToken = await getAccessToken();
            if (!idToken) return;
            const response = await fetchWithRetry(
                `${getPipelineBaseUrl()}/api/clients/${encodeURIComponent(clientId)}/interested-autoresponder/prompts${editingAutoResponderPrompt ? `/${editingAutoResponderPrompt.id}` : ''}`,
                {
                    method: editingAutoResponderPrompt ? 'PUT' : 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${idToken}`
                    },
                    body: JSON.stringify({
                        campaignId: Number(autoResponderPromptCampaignId),
                        version: autoResponderPromptVersion.trim(),
                        systemPrompt: autoResponderPromptSystemPrompt.trim(),
                        active: autoResponderPromptActive
                    })
                }
            );
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(data.error || `Failed to save auto-responder prompt (${response.status})`);
            }

            const savedPrompt = data.prompt as InterestedAutoResponderPrompt;
            setInterestedAutoResponderPrompts((prev) => {
                const next = prev
                    .filter((item) => item.id !== savedPrompt.id)
                    .map((item) => (
                        savedPrompt.active && item.campaign_id === savedPrompt.campaign_id
                            ? { ...item, active: false }
                            : item
                    ));
                return [...next, savedPrompt].sort((a, b) => {
                    if (a.active !== b.active) return a.active ? -1 : 1;
                    return a.campaign_name.localeCompare(b.campaign_name);
                });
            });
            setToastMessage(editingAutoResponderPrompt ? 'Auto-responder prompt updated.' : 'Auto-responder prompt created.');
            setToastVisible(true);
            setAutoResponderPromptModalOpen(false);
        } catch (error) {
            setToastMessage(error instanceof Error ? error.message : 'Failed to save auto-responder prompt');
            setToastVisible(true);
        } finally {
            setSavingAutoResponderPrompt(false);
        }
    };

    const handleDeleteAutoResponderPrompt = async (promptId: number) => {
        if (!user || !clientId) return;
        if (!window.confirm('Delete this auto-responder prompt?')) return;

        setDeletingAutoResponderPromptId(promptId);
        try {
            const idToken = await getAccessToken();
            if (!idToken) return;
            const response = await fetchWithRetry(
                `${getPipelineBaseUrl()}/api/clients/${encodeURIComponent(clientId)}/interested-autoresponder/prompts/${promptId}`,
                {
                    method: 'DELETE',
                    headers: { Authorization: `Bearer ${idToken}` }
                }
            );
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(data.error || `Failed to delete auto-responder prompt (${response.status})`);
            }
            setInterestedAutoResponderPrompts((prev) => prev.filter((prompt) => prompt.id !== promptId));
            setToastMessage('Auto-responder prompt deleted.');
            setToastVisible(true);
        } catch (error) {
            setToastMessage(error instanceof Error ? error.message : 'Failed to delete auto-responder prompt');
            setToastVisible(true);
        } finally {
            setDeletingAutoResponderPromptId(null);
        }
    };

    const openAutoResponderTestModal = (prompt: InterestedAutoResponderPrompt) => {
        setTestingAutoResponderPrompt(prompt);
        setAutoResponderTestLeadSearch('');
        setDebouncedAutoResponderTestLeadSearch('');
        setAutoResponderTestLeadResults([]);
        setAutoResponderTestSelectedLead(null);
        setAutoResponderTestResult(null);
        setAutoResponderTestMessage('');
        setAutoResponderTestExpandedSteps(new Set());
        setAutoResponderTestModalOpen(true);
    };

    const closeAutoResponderTestModal = () => {
        setAutoResponderTestModalOpen(false);
        setTestingAutoResponderPrompt(null);
    };

    const handleRunAutoResponderTest = async (lead?: Lead) => {
        const targetLead = lead ?? autoResponderTestSelectedLead;
        if (!user || !clientId || !testingAutoResponderPrompt || !targetLead) return;
        if (lead) setAutoResponderTestSelectedLead(lead);
        setAutoResponderTestLoading(true);
        setAutoResponderTestResult(null);
        setAutoResponderTestExpandedSteps(new Set());
        try {
            const idToken = await getAccessToken();
            if (!idToken) return;
            const response = await fetchWithRetry(
                `${getPipelineBaseUrl()}/api/clients/${encodeURIComponent(clientId)}/interested-autoresponder/prompts/${testingAutoResponderPrompt.id}/test`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
                    body: JSON.stringify({
                        contactId: targetLead.id,
                        testMessage: autoResponderTestMessage.trim() || undefined
                    })
                }
            );
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || `Failed to generate test reply (${response.status})`);
            setAutoResponderTestResult(data);
            setAutoResponderTestExpandedSteps(new Set([4]));
        } catch (error) {
            setToastMessage(error instanceof Error ? error.message : 'Failed to generate test reply');
            setToastVisible(true);
        } finally {
            setAutoResponderTestLoading(false);
        }
    };

    const handleStopInstantlySync = async () => {
        if (!user || !clientId || !instantlySyncRun?.id) return;

        setStoppingInstantlySync(true);
        try {
            const idToken = await getAccessToken();
            if (!idToken) return;
            const response = await fetchWithRetry(
                `${getPipelineBaseUrl()}/api/clients/${encodeURIComponent(clientId)}/instantly/sync-runs/${instantlySyncRun.id}/stop`,
                {
                    method: 'POST',
                    cache: 'no-store',
                    headers: {
                        Authorization: `Bearer ${idToken}`
                    }
                }
            );
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(data.error || `Failed to stop Instantly sync (${response.status})`);
            }

            setInstantlySyncRun((data.run || null) as InstantlySyncRun | null);
            setToastMessage('Instantly sync stop requested.');
            setToastVisible(true);
        } catch (error) {
            setToastMessage(error instanceof Error ? error.message : 'Failed to stop Instantly sync');
            setToastVisible(true);
        } finally {
            setStoppingInstantlySync(false);
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
            const filters = {
                ...(segmentFullName && { fullName: segmentFullName }),
                ...(segmentFounder && { founder: segmentFounder }),
                ...(segmentEmail && { email: segmentEmail }),
                ...(segmentEmailStatus.length > 0 && { emailStatus: segmentEmailStatus }),
                ...(segmentCreatedAfter && { createdAfter: segmentCreatedAfter }),
                ...(segmentCreatedBefore && { createdBefore: segmentCreatedBefore }),
            };

            await apiJson(`/api/clients/${encodeURIComponent(clientId)}/segments`, {
                method: "POST",
                body: JSON.stringify({
                    id: editingSegment?.id,
                    name: segmentName.trim(),
                    filters,
                }),
            });

            const segmentsPayload = await apiJson<{ segments: Segment[] }>(
                `/api/clients/${encodeURIComponent(clientId)}/segments`
            );
            setSegments(
                (segmentsPayload.segments || []).sort((a, b) =>
                    (b.updatedAt || "").localeCompare(a.updatedAt || "")
                )
            );

            setToastMessage(editingSegment ? "Segment updated" : "Segment created");
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
            await apiJson(`/api/clients/${encodeURIComponent(clientId)}/segments/${encodeURIComponent(segmentId)}`, {
                method: "DELETE",
            });
            setSegments((prev) => prev.filter((s) => s.id !== segmentId));

            setToastMessage("Segment deleted");
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
            const idToken = await getAccessToken();
            if (!idToken) return;
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
            const idToken = await getAccessToken();
            if (!idToken) return;
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
                campaigns: row.campaigns || [],
                campaignsData: row.campaignsData || [],
                insights: row.insights || undefined
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

    const openFollowUpScriptModal = (script?: FollowUpScript) => {
        if (script) {
            setEditingFollowUpScript(script);
            setFuScriptOrder(script.script_order);
            setFuScriptActive(script.active);
            setFuScriptHtml(script.html_template);
            setFuScriptText(script.text_template || '');
        } else {
            setEditingFollowUpScript(null);
            setFuScriptOrder(followUpScripts.length + 1);
            setFuScriptActive(true);
            setFuScriptHtml('');
            setFuScriptText('');
        }
        setFollowUpScriptModalOpen(true);
    };

    const openFollowUpPreviewModal = (script: FollowUpScript) => {
        setPreviewingFollowUpScript(script);
        setFollowUpPreviewLeadSearch('');
        setDebouncedFollowUpPreviewLeadSearch('');
        setFollowUpPreviewLeadResults([]);
        setFollowUpPreviewSelectedLead(null);
        setFollowUpPreviewResult(null);
        setFollowUpPreviewModalOpen(true);
    };

    const closeFollowUpPreviewModal = () => {
        setFollowUpPreviewModalOpen(false);
        setPreviewingFollowUpScript(null);
        setFollowUpPreviewLeadSearch('');
        setDebouncedFollowUpPreviewLeadSearch('');
        setFollowUpPreviewLeadResults([]);
        setFollowUpPreviewSelectedLead(null);
        setFollowUpPreviewResult(null);
        setFollowUpPreviewLoading(false);
        setFollowUpPreviewSearching(false);
    };

    const handleSaveFollowUpScript = async () => {
        if (!user || !clientId || !fuScriptHtml.trim()) return;
        setSavingFollowUpScript(true);
        try {
            const idToken = await getAccessToken();
            if (!idToken) return;
            const url = editingFollowUpScript
                ? `${getPipelineBaseUrl()}/api/clients/${encodeURIComponent(clientId)}/follow-up-scripts/${editingFollowUpScript.id}`
                : `${getPipelineBaseUrl()}/api/clients/${encodeURIComponent(clientId)}/follow-up-scripts`;
            const method = editingFollowUpScript ? 'PUT' : 'POST';
            const res = await fetchWithRetry(url, {
                method,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
                body: JSON.stringify({
                    active: fuScriptActive,
                    scriptOrder: fuScriptOrder,
                    htmlTemplate: fuScriptHtml.trim(),
                    textTemplate: fuScriptText.trim() || null,
                })
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || `Failed to save script (${res.status})`);
            }
            const data = await res.json();
            if (editingFollowUpScript) {
                setFollowUpScripts(prev => prev.map(s => s.id === data.script.id ? data.script : s));
            } else {
                setFollowUpScripts(prev => [...prev, data.script].sort((a, b) => a.script_order - b.script_order));
            }
            setFollowUpScriptModalOpen(false);
        } catch (err) {
            setToastMessage(err instanceof Error ? err.message : 'Failed to save script');
            setToastVisible(true);
        } finally {
            setSavingFollowUpScript(false);
        }
    };

    const handleDeleteFollowUpScript = async (id: number) => {
        if (!user || !clientId) return;
        const confirmed = window.confirm('Delete this follow-up script? This cannot be undone.');
        if (!confirmed) return;
        setDeletingFollowUpScriptId(id);
        try {
            const idToken = await getAccessToken();
            if (!idToken) return;
            const res = await fetchWithRetry(`${getPipelineBaseUrl()}/api/clients/${encodeURIComponent(clientId)}/follow-up-scripts/${id}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${idToken}` }
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || `Failed to delete script (${res.status})`);
            }
            setFollowUpScripts(prev => prev.filter(s => s.id !== id));
        } catch (err) {
            setToastMessage(err instanceof Error ? err.message : 'Failed to delete script');
            setToastVisible(true);
        } finally {
            setDeletingFollowUpScriptId(null);
        }
    };

    const handleRunFollowUpPreview = async (lead: Lead) => {
        if (!user || !clientId || !previewingFollowUpScript || !lead.email) return;
        setFollowUpPreviewSelectedLead(lead);
        setFollowUpPreviewLoading(true);
        setFollowUpPreviewResult(null);
        try {
            const idToken = await getAccessToken();
            if (!idToken) return;
            const response = await fetchWithRetry(`${getPipelineBaseUrl()}/api/clients/${encodeURIComponent(clientId)}/follow-up-preview`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${idToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    contactEmail: lead.email,
                    scriptId: previewingFollowUpScript.id
                })
            });
            if (!response.ok) {
                const data = await response.json().catch(() => ({}));
                throw new Error(data.error || `Failed to preview follow-up (${response.status})`);
            }
            const data = await response.json();
            setFollowUpPreviewResult(data.preview || null);
        } catch (err) {
            setToastMessage(err instanceof Error ? err.message : 'Failed to preview follow-up');
            setToastVisible(true);
        } finally {
            setFollowUpPreviewLoading(false);
        }
    };

    const handleToggleFollowUpScriptActive = async (script: FollowUpScript) => {
        if (!user || !clientId) return;
        setUpdatingFollowUpScriptId(script.id);
        try {
            const idToken = await getAccessToken();
            if (!idToken) return;
            const res = await fetchWithRetry(
                `${getPipelineBaseUrl()}/api/clients/${encodeURIComponent(clientId)}/follow-up-scripts/${script.id}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
                    body: JSON.stringify({
                        active: !script.active,
                        scriptOrder: script.script_order,
                        htmlTemplate: script.html_template,
                        textTemplate: script.text_template,
                    })
                }
            );
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || `Failed to update script (${res.status})`);
            }
            const data = await res.json();
            setFollowUpScripts(prev => prev.map(s => s.id === data.script.id ? data.script : s));
        } catch (err) {
            setToastMessage(err instanceof Error ? err.message : 'Failed to update script');
            setToastVisible(true);
        } finally {
            setUpdatingFollowUpScriptId(null);
        }
    };

    const handleDeleteClient = async () => {
        if (!user || !clientId) return;
        const confirmed = window.confirm("Delete this client? This removes the client record and related leads.");
        if (!confirmed) return;

        setIsDeletingClient(true);
        try {
            const idToken = await getAccessToken();
            if (!idToken) return;
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

    const lastLeadsScrollLoadRef = useRef(0);
    const handleLeadsScroll = (event: UIEvent<HTMLDivElement>) => {
        if (activeTab !== "leads") return;
        const target = event.currentTarget;
        if (target.scrollTop + target.clientHeight < target.scrollHeight - 50) return;
        const now = Date.now();
        if (now - lastLeadsScrollLoadRef.current < 400) return;
        lastLeadsScrollLoadRef.current = now;
        loadMoreLeads();
    };

    const uploadLeadCount = useMemo(() => {
        if (!uploadEmailStatusCounts) return null;
        let total = 0;
        if (includeValidEmails) total += uploadEmailStatusCounts.valid;
        if (includeRiskyEmails) total += uploadEmailStatusCounts.risky;
        return total;
    }, [includeValidEmails, includeRiskyEmails, uploadEmailStatusCounts]);

    const handleUploadToInstantly = async () => {
        const currentJobId = jobState?.id || jobPendingUpload;
        if (!currentJobId || !user) {
            setToastMessage('No completed job available to upload.');
            setToastVisible(true);
            return;
        }

        setIncludeValidEmails(true);
        setIncludeRiskyEmails(true);

        // Fetch CSV data for preview and mapping
        try {
            const idToken = await getAccessToken();
            if (!idToken) return;
            setUploading(true);
            const response = await fetchWithRetry(`${getPipelineBaseUrl()}/api/jobs/${currentJobId}/csv-preview`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    idToken,
                    clientId,
                    emailStatusInclude: {
                        includeValid: true,
                        includeRisky: true
                    }
                })
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
            setUploadEmailStatusCounts(data.emailStatusCounts || null);

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

        if (!includeValidEmails && !includeRiskyEmails) {
            alert('Select at least one email status to upload.');
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

            const idToken = await getAccessToken();
            if (!idToken) return;
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
                    },
                    emailStatusInclude: {
                        includeValid: includeValidEmails,
                        includeRisky: includeRiskyEmails
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
            await apiFetch(`/api/clients/${encodeURIComponent(clientId)}/active-job/discard`, {
                method: "POST",
                body: JSON.stringify({}),
            });
            setJobPendingUpload(null);
            setJobState(null);
            setActiveJobStatus("discarded");
        } catch (error) {
            console.error("Failed to discard job:", error);
        }
    };

    const handleDeleteJob = async (jobId: string) => {
        if (!user || !clientId) return;
        const confirmDelete = window.confirm("Delete this job? This removes the job record and cached files.");
        if (!confirmDelete) return;

        setDeletingJobId(jobId);
        try {
            const idToken = await getAccessToken();
            if (!idToken) return;
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
        const token = await getAccessToken();
        if (!token) return;
        const campaignsResponse = await fetch(
            `${getPipelineBaseUrl()}/api/clients/${clientId}/campaigns/list?agencyId=${encodeURIComponent(agencyId || "")}`,
            { headers: { Authorization: `Bearer ${token}` } }
        );

        if (!campaignsResponse.ok) {
            throw new Error(`Failed to fetch campaigns: ${campaignsResponse.status}`);
        }

        const campaignsData = await campaignsResponse.json();
        return (campaignsData.campaigns || []) as Campaign[];
    };

    const fetchInterestedAutoResponderPrompts = async () => {
        const token = await getAccessToken();
        if (!token) return;
        const response = await fetch(
            `${getPipelineBaseUrl()}/api/clients/${encodeURIComponent(clientId)}/interested-autoresponder/prompts`,
            { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!response.ok) {
            throw new Error(`Failed to fetch auto-responder prompts: ${response.status}`);
        }
        const data = await response.json();
        return (data.prompts || []) as InterestedAutoResponderPrompt[];
    };

    const handleOpenVerificationImportModal = () => {
        setVerificationImportModalOpen(true);
        setVerificationImportFile(null);
        setVerificationImportStep(1);
        setVerificationImportHeaders([]);
        setVerificationImportPreviewRows([]);
        setVerificationImportTotalRows(0);
        setVerificationImportEmailCol('');
        setVerificationImportStatusCol('');
        setVerificationImportVerifiedAtCol('');
        setVerificationImportResult(null);
    };

    const handleVerificationImportFileChange = async (file: File | null) => {
        setVerificationImportFile(file);
        setVerificationImportResult(null);
        if (!file) {
            setVerificationImportStep(1);
            setVerificationImportHeaders([]);
            setVerificationImportPreviewRows([]);
            setVerificationImportTotalRows(0);
            return;
        }
        try {
            setVerificationImportParsing(true);
            const idToken = await getAccessToken();
            if (!idToken) return;
            const formData = new FormData();
            formData.append('file', file);
            const response = await fetchWithRetry(
                `${getPipelineBaseUrl()}/api/leads/verification-import/preview`,
                { method: 'POST', headers: { Authorization: `Bearer ${idToken}` }, body: formData }
            );
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data?.error || `Parse failed (${response.status})`);
            const headers: string[] = data.headers || [];
            setVerificationImportHeaders(headers);
            setVerificationImportPreviewRows(data.previewRows || []);
            setVerificationImportTotalRows(data.totalRows || 0);
            // Auto-detect columns
            const emailGuess = headers.find((h) => /^email$/i.test(h)) || headers.find((h) => /email/i.test(h)) || '';
            const statusGuess = headers.find((h) => /^(email_status|status|result|verification_status|deliverability)$/i.test(h)) || headers.find((h) => /status|result|verif/i.test(h)) || '';
            const verifiedAtGuess = headers.find((h) => /verified_at|verified|checked_at/i.test(h)) || '';
            setVerificationImportEmailCol(emailGuess);
            setVerificationImportStatusCol(statusGuess);
            setVerificationImportVerifiedAtCol(verifiedAtGuess);
            setVerificationImportStep(2);
        } catch (error) {
            console.error('Error previewing verification CSV:', error);
            setToastMessage(error instanceof Error ? error.message : 'Failed to parse CSV');
            setToastVisible(true);
        } finally {
            setVerificationImportParsing(false);
        }
    };

    const handleSubmitVerificationImport = async () => {
        if (!user || !clientId || !verificationImportFile) return;
        if (!verificationImportEmailCol || !verificationImportStatusCol) {
            setToastMessage('Please map the Email and Email Status columns before importing.');
            setToastVisible(true);
            return;
        }
        try {
            setVerificationImportLoading(true);
            const idToken = await getAccessToken();
            if (!idToken) return;
            const formData = new FormData();
            formData.append('file', verificationImportFile);
            formData.append('clientId', clientId);
            formData.append('emailColumn', verificationImportEmailCol);
            formData.append('statusColumn', verificationImportStatusCol);
            if (verificationImportVerifiedAtCol) {
                formData.append('verifiedAtColumn', verificationImportVerifiedAtCol);
            }
            const response = await fetchWithRetry(
                `${getPipelineBaseUrl()}/api/leads/verification-import`,
                { method: 'POST', headers: { Authorization: `Bearer ${idToken}` }, body: formData }
            );
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data?.error || `Import failed (${response.status})`);
            setVerificationImportResult(data);
            setToastMessage(`Verification import complete: ${data.updated} leads updated.`);
            setToastVisible(true);
            fetchLeads(true);
        } catch (error) {
            console.error('Error running verification import:', error);
            setToastMessage(error instanceof Error ? error.message : 'Failed to import verification CSV');
            setToastVisible(true);
        } finally {
            setVerificationImportLoading(false);
        }
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
            setInstantlyCsvOverrideCampaigns(campaigns || []);
        } catch (error) {
            console.error('Error loading campaigns for Instantly CSV import:', error);
            setToastMessage('Failed to load campaigns for manual override');
            setToastVisible(true);
        } finally {
            setInstantlyCsvCampaignsLoading(false);
        }
    };

    const handleRevertManualUpload = async (jobId: string, campaignId: string, campaignName: string) => {
        if (!confirm(`Are you sure you want to revert the manual upload to "${campaignName}"?`)) {
            return;
        }

        try {
            const token = await getAccessToken();
        if (!token) return;
            
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
            const idToken = await getAccessToken();
            if (!idToken) return;
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
            fetchLeadTotal();
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

    const leadExportFieldGroups = useMemo(() => (
        LEAD_EXPORT_FIELDS.reduce<Record<string, LeadExportFieldDef[]>>((acc, field) => {
            if (!acc[field.group]) acc[field.group] = [];
            acc[field.group].push(field);
            return acc;
        }, {})
    ), []);

    const toggleLeadExportField = useCallback((fieldKey: string) => {
        setSelectedLeadExportFields((prev) => (
            prev.includes(fieldKey)
                ? prev.filter((key) => key !== fieldKey)
                : [...prev, fieldKey]
        ));
    }, []);

    const handleExportLeadsCsv = useCallback(async () => {
        if (selectedLeadExportFields.length === 0) {
            setToastMessage('Select at least one field to export.');
            setToastVisible(true);
            return;
        }
        if (!user || !clientId) {
            setToastMessage('You must be signed in to export leads.');
            setToastVisible(true);
            return;
        }

        setLeadExportModalOpen(false);
        setExportingCsv(true);
        try {
            const idToken = await getAccessToken();
            if (!idToken) return;
            const includeLatestEvent = selectedLeadExportFields.some((fieldKey) => (
                LEAD_EXPORT_FIELDS.find((field) => field.key === fieldKey)?.group === 'Events'
            ));
            const maxRows = leadExportLimitEnabled
                ? Math.max(1, Math.min(LEAD_EXPORT_MAX_ROWS_CAP, Math.floor(leadExportMaxRows) || 1))
                : null;
            const params = buildLeadQueryParams({ limit: 5000, includeLatestEvent });

            const collected: Lead[] = [];
            const seenLeadIds = new Set<string>();
            let offset = 0;
            let hasMore = true;
            let duplicateRowsSkipped = 0;

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
                const mapped: Lead[] = apiLeads.map(mapApiLeadRow);

                mapped.forEach((lead) => {
                    const leadKey = String(lead.id);
                    if (seenLeadIds.has(leadKey)) {
                        duplicateRowsSkipped += 1;
                        return;
                    }
                    seenLeadIds.add(leadKey);
                    collected.push(lead);
                });
                offset += mapped.length;
                hasMore = more && mapped.length > 0;

                if (maxRows !== null && collected.length >= maxRows) {
                    break;
                }

                if (collected.length >= LEAD_EXPORT_MAX_ROWS_CAP) {
                    console.warn(`Reached max export limit of ${LEAD_EXPORT_MAX_ROWS_CAP.toLocaleString()} leads`);
                    break;
                }
            }

            const rowsToExport = maxRows !== null ? collected.slice(0, maxRows) : collected;

            const orderedFields = LEAD_EXPORT_FIELDS.filter((field) => selectedLeadExportFields.includes(field.key));
            const csvRows = [
                orderedFields.map((field) => csvEscape(field.label)).join(',')
            ];

            rowsToExport.forEach((lead) => {
                csvRows.push(orderedFields.map((field) => csvEscape(getLeadExportValue(lead, field.key))).join(','));
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
            const exportMessage = duplicateRowsSkipped > 0
                ? `Exported ${rowsToExport.length.toLocaleString()} lead${rowsToExport.length === 1 ? '' : 's'} (${duplicateRowsSkipped.toLocaleString()} duplicate${duplicateRowsSkipped === 1 ? '' : 's'} removed)`
                : `Exported ${rowsToExport.length.toLocaleString()} lead${rowsToExport.length === 1 ? '' : 's'}`;
            if (duplicateRowsSkipped > 0) {
                console.warn(`CSV export removed ${duplicateRowsSkipped} duplicate lead row(s)`);
            }
            setToastMessage(exportMessage);
            setToastVisible(true);
        } catch (error) {
            console.error('CSV export failed:', error);
            setToastMessage(error instanceof Error ? error.message : 'Failed to export CSV');
            setToastVisible(true);
        } finally {
            setExportingCsv(false);
        }
    }, [buildLeadQueryParams, clientName, leadExportLimitEnabled, leadExportMaxRows, mapApiLeadRow, selectedLeadExportFields, user]);

    const uploadDisabled = !selectedFile || uploading;

    const leadTabContent = (
        <div>
            <div style={{
                display: 'flex',
                gap: '1rem',
                marginTop: '2rem',
                flexWrap: 'wrap'
            }}>
                {campaignFilterId || leadSearch.trim() || appliedLeadFilters.length > 0 ? (
                    <div className="metric-chip">
                        <span className="metric-chip__label">Filtered Total</span>
                        <span className="metric-chip__value">{displayedLeadTotalLabel}</span>
                    </div>
                ) : (
                    <div className="metric-chip">
                        <span className="metric-chip__label">Total Leads</span>
                        <span className="metric-chip__value">{displayedLeadTotalLabel}</span>
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
                <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-end', marginLeft: 'auto' }}>
                    <button
                        type="button"
                        className="secondary-button secondary-button--active"
                        onClick={handleCheckKlaviyo}
                        style={{ flex: '0 0 auto' }}
                        disabled={leadsLoading || checkingKlaviyo || leads.length === 0}
                    >
                        {checkingKlaviyo ? 'Checking Klaviyo...' : 'Check Klaviyo'}
                    </button>
                    <button
                        type="button"
                        className="secondary-button secondary-button--active"
                        onClick={handleOpenVerificationImportModal}
                        style={{ flex: '0 0 auto' }}
                        disabled={leadsLoading}
                    >
                        📋 Import Verification CSV
                    </button>
                    <button
                        type="button"
                        className="primary-button"
                        onClick={() => setLeadExportModalOpen(true)}
                        style={{ flex: '0 0 auto' }}
                        disabled={leadsLoading || exportingCsv || checkingKlaviyo}
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
                            `📥 Export CSV (${allLeadsCached ? filteredLeads.length : (displayedLeadTotal === null ? '...' : displayedLeadTotal)})`
                        )}
                    </button>
                    {(appliedLeadFilters.length > 0 || leadFilters.length > 0 || leadSearch.trim() || campaignFilterId) && (
                        <button
                            type="button"
                            className="secondary-button secondary-button--active"
                            onClick={() => {
                                setLeadFilters([]);
                                setAppliedLeadFilters([]);
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
            </div>

            <div style={{
                marginTop: '0.75rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.75rem'
            }}>
                <div style={{
                    padding: '1rem',
                    border: '1px solid var(--app-border)',
                    borderRadius: '10px',
                    background: 'var(--app-surface-3)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.75rem'
                }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
                        <div>
                            <div style={{ fontSize: '0.78rem', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--app-text-faint)' }}>
                                Filters
                            </div>
                            <div style={{ fontSize: '0.88rem', color: 'var(--app-text-muted)', marginTop: '0.2rem' }}>
                                Build lead filters locally, then run the query when you are ready.
                            </div>
                        </div>
                        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
                            {leadFiltersDirty && (
                                <span style={{ fontSize: '0.82rem', color: '#fbbf24', fontWeight: 600 }}>
                                    Unapplied changes
                                </span>
                            )}
                            <button
                                type="button"
                                className="secondary-button secondary-button--active"
                                onClick={addLeadFilter}
                                disabled={leadFilterFieldsLoading || leadFilterFields.length === 0}
                            >
                                + Add Filter
                            </button>
                            <button
                                type="button"
                                className="primary-button"
                                onClick={applyLeadFilters}
                                disabled={leadsLoading}
                            >
                                Run Query
                            </button>
                        </div>
                    </div>

                    {leadFilterContent}
                </div>

                <div style={{
                    display: 'flex',
                    gap: '0.75rem',
                    flexWrap: 'wrap',
                    alignItems: 'center'
                }}>
                    {leadsLoading && (
                        <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.5rem',
                            padding: '0.5rem 0.75rem',
                            fontSize: '0.875rem',
                            color: 'var(--app-text-muted)'
                        }}>
                            <svg className="spinner" style={{ width: '16px', height: '16px' }} viewBox="0 0 24 24" fill="none">
                                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25"/>
                                <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/>
                            </svg>
                            {allLeadsCached ? 'Filtering...' : 'Loading leads...'}
                        </div>
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
                            border: '1px solid var(--app-border)',
                            borderRadius: '8px',
                            backgroundColor: 'var(--app-bg-inset)',
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
                                        border: '1px solid var(--app-border)'
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
                                    borderCollapse: 'separate',
                                    borderSpacing: 0,
                                    fontSize: '0.875rem'
                                }}>
                                    <thead>
                                        <tr style={{
                                            backgroundColor: 'var(--app-surface-2)',
                                            borderBottom: '1px solid var(--app-border)'
                                        }}>
                                            <th style={{
                                                position: 'sticky',
                                                top: 0,
                                                zIndex: 2,
                                                backgroundColor: 'var(--app-bg)',
                                                textAlign: 'left',
                                                padding: '0.75rem 1rem',
                                                fontWeight: 600,
                                                color: 'var(--app-text-high)',
                                                borderBottom: '1px solid var(--app-border)'
                                            }}>Founder Name</th>
                                            <th style={{
                                                position: 'sticky',
                                                top: 0,
                                                zIndex: 2,
                                                backgroundColor: 'var(--app-bg)',
                                                textAlign: 'left',
                                                padding: '0.75rem 1rem',
                                                fontWeight: 600,
                                                color: 'var(--app-text-high)',
                                                borderBottom: '1px solid var(--app-border)'
                                            }}>Email</th>
                                            <th style={{
                                                position: 'sticky',
                                                top: 0,
                                                zIndex: 2,
                                                backgroundColor: 'var(--app-bg)',
                                                textAlign: 'left',
                                                padding: '0.75rem 1rem',
                                                fontWeight: 600,
                                                color: 'var(--app-text-high)',
                                                borderBottom: '1px solid var(--app-border)'
                                            }}>Verification</th>
                                            <th style={{
                                                position: 'sticky',
                                                top: 0,
                                                zIndex: 2,
                                                backgroundColor: 'var(--app-bg)',
                                                textAlign: 'left',
                                                padding: '0.75rem 1rem',
                                                fontWeight: 600,
                                                color: 'var(--app-text-high)',
                                                borderBottom: '1px solid var(--app-border)'
                                            }}>Lead Status</th>
                                            <th style={{
                                                position: 'sticky',
                                                top: 0,
                                                zIndex: 2,
                                                backgroundColor: 'var(--app-bg)',
                                                textAlign: 'left',
                                                padding: '0.75rem 1rem',
                                                fontWeight: 600,
                                                color: 'var(--app-text-high)',
                                                borderBottom: '1px solid var(--app-border)'
                                            }}>Domain</th>
                                            <th style={{
                                                position: 'sticky',
                                                top: 0,
                                                zIndex: 2,
                                                backgroundColor: 'var(--app-bg)',
                                                textAlign: 'left',
                                                padding: '0.75rem 1rem',
                                                fontWeight: 600,
                                                color: 'var(--app-text-high)',
                                                borderBottom: '1px solid var(--app-border)'
                                            }}>Campaign</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {filteredLeads.map((lead, index) => (
                                            <tr
                                                key={lead.id}
                                                onClick={() => setSelectedLead(lead)}
                                                style={{
                                                    backgroundColor: index % 2 === 0 ? 'transparent' : 'var(--app-surface-3)',
                                                    borderBottom: index < filteredLeads.length - 1 ? '1px solid var(--app-border)' : 'none',
                                                    cursor: 'pointer',
                                                    transition: 'background-color 0.15s ease'
                                                }}
                                                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--app-surface-2)'}
                                                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = index % 2 === 0 ? 'transparent' : 'var(--app-surface-3)'}
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
                                                    maxWidth: '320px'
                                                }}>
                                                    <div style={{
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        gap: '0.5rem',
                                                        flexWrap: 'wrap',
                                                        minWidth: 0
                                                    }}>
                                                        <span style={{
                                                            overflow: 'hidden',
                                                            textOverflow: 'ellipsis',
                                                            whiteSpace: 'nowrap',
                                                            minWidth: 0,
                                                            flex: '1 1 auto'
                                                        }}>
                                                            {formatRawEmailValue(lead.email)}
                                                        </span>
                                                        {!lead.email && renderEmailFindChip(lead.email, lead.emailFindCompletedAt)}
                                                    </div>
                                                </td>
                                                <td style={{
                                                    padding: '0.75rem 1rem',
                                                    minWidth: '140px'
                                                }}>
                                                    {(() => {
                                                        const meta = getLeadStatusChipMeta(
                                                            lead.status,
                                                            lead.emailVerifyCompletedAt,
                                                            lead.email,
                                                            lead.emailFindCompletedAt
                                                        );
                                                        return (
                                                            <span className={`lead-pastel-chip lead-pastel-chip--status-${meta.variant}`}>
                                                                {meta.label}
                                                            </span>
                                                        );
                                                    })()}
                                                </td>
                                                <td style={{
                                                    padding: '0.75rem 1rem',
                                                    minWidth: '140px'
                                                }}>
                                                    {(() => {
                                                        const latestCampaignData = lead.campaignsData?.[0];
                                                        const raw = latestCampaignData?.interestStatus || latestCampaignData?.leadStatus;
                                                        if (!raw) return <span style={{ color: 'var(--app-text-ghost)' }}>—</span>;
                                                        return (
                                                            <span className="lead-pastel-chip">
                                                                {formatInstantlyStateLabel(raw)}
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
                                                        const hiddenCount = names.length - 1;
                                                        return (
                                                            <div className="lead-pastel-chip-list">
                                                                <span
                                                                    className="lead-pastel-chip lead-pastel-chip--campaign"
                                                                    style={{ paddingInline: '0.75rem' }}
                                                                >
                                                                    {names[0]}
                                                                </span>
                                                                {hiddenCount > 0 && (
                                                                    <span
                                                                        className="lead-pastel-chip lead-pastel-chip--campaign-more"
                                                                        style={{ paddingInline: '0.75rem' }}
                                                                    >
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
                                    <div style={{ padding: '0.75rem 1rem', color: 'var(--app-text-muted)' }}>
                                        {leadsLoading ? 'Loading leads...' : 'Scroll to load more'}
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );

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
                            className={`tab-nav__button ${activeTab === "analytics" ? "tab-nav__button--active" : ""}`}
                            onClick={() => setActiveTab("analytics")}
                        >
                            Analytics
                        </button>
                        <button
                            className={`tab-nav__button ${activeTab === "campaigns" ? "tab-nav__button--active" : ""}`}
                            onClick={() => setActiveTab("campaigns")}
                        >
                            Pipeline
                        </button>
                        <button
                            className={`tab-nav__button ${activeTab === "leads" ? "tab-nav__button--active" : ""}`}
                            onClick={() => setActiveTab("leads")}
                        >
                            All Leads
                        </button>
                        <button
                            className={`tab-nav__button ${activeTab === "personalizer" ? "tab-nav__button--active" : ""}`}
                            onClick={() => setActiveTab("personalizer")}
                        >
                            Personalizer
                        </button>
                        <button
                            className={`tab-nav__button ${activeTab === "follow-ups" ? "tab-nav__button--active" : ""}`}
                            onClick={() => setActiveTab("follow-ups")}
                        >
                            Follow-Ups
                        </button>
                        <button
                            className={`tab-nav__button ${activeTab === "info" ? "tab-nav__button--active" : ""}`}
                            onClick={() => setActiveTab("info")}
                        >
                            Info
                        </button>
                    </div>

                    {activeTab === "analytics" && (
                        <div style={{ marginTop: "2rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
                            <div>
                                <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
                                    <h2 style={{ margin: 0, fontSize: "1.75rem", fontWeight: 700 }}>Analytics</h2>
                                    <span style={{
                                        display: "inline-flex",
                                        alignItems: "center",
                                        gap: "0.4rem",
                                        padding: "0.35rem 0.7rem",
                                        borderRadius: "999px",
                                        background: "rgba(34, 197, 94, 0.12)",
                                        border: "1px solid rgba(34, 197, 94, 0.28)",
                                        color: "#86efac",
                                        fontSize: "0.78rem",
                                        fontWeight: 600
                                    }}>
                                        <span style={{ width: "8px", height: "8px", borderRadius: "999px", background: "#22c55e" }} />
                                        Live
                                    </span>
                                    <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", marginLeft: "auto" }}>
                                        <label className="settings-field" style={{ minWidth: "180px" }}>
                                            <span className="settings-field__label">Event Type</span>
                                            <select
                                                value={instantlyEventAnalyticsEventType}
                                                onChange={(e) => setInstantlyEventAnalyticsEventType(e.target.value)}
                                                disabled={instantlyEventAnalyticsLoading}
                                            >
                                                {(instantlyEventAnalytics?.availableEventTypes || [{ value: "all", label: "All event types" }]).map((option) => (
                                                    <option key={option.value} value={option.value}>{option.label}</option>
                                                ))}
                                            </select>
                                        </label>
                                        <label className="settings-field" style={{ minWidth: "180px" }}>
                                            <span className="settings-field__label">Time Period</span>
                                            <select
                                                value={instantlyEventAnalyticsPeriod}
                                                onChange={(e) => setInstantlyEventAnalyticsPeriod(e.target.value as InstantlyEventAnalyticsPeriod)}
                                                disabled={instantlyEventAnalyticsLoading}
                                            >
                                                {INSTANTLY_ANALYTICS_PERIOD_OPTIONS.map((option) => (
                                                    <option key={option.value} value={option.value}>{option.label}</option>
                                                ))}
                                            </select>
                                        </label>
                                    </div>
                                </div>
                            </div>

                            {instantlyEventAnalyticsError && (
                                <div style={{
                                    padding: "1rem 1.25rem",
                                    borderRadius: "12px",
                                    border: "1px solid rgba(239, 68, 68, 0.35)",
                                    background: "rgba(239, 68, 68, 0.08)",
                                    color: "#fca5a5"
                                }}>
                                    {instantlyEventAnalyticsError}
                                </div>
                            )}

                            {instantlyEventRealtimeError && (
                                <div style={{
                                    padding: "1rem 1.25rem",
                                    borderRadius: "12px",
                                    border: "1px solid rgba(245, 158, 11, 0.35)",
                                    background: "rgba(245, 158, 11, 0.08)",
                                    color: "#fcd34d"
                                }}>
                                    {instantlyEventRealtimeError}
                                </div>
                            )}

                            {instantlyEventAnalyticsLoading && !instantlyEventAnalytics && (
                                <div className="pipeline-panel__empty" style={{ minHeight: "260px" }}>
                                    <svg className="spinner" style={{ width: "32px", height: "32px", color: "#3b82f6" }} viewBox="0 0 24 24" fill="none">
                                        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
                                        <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                                    </svg>
                                    <p style={{ margin: "0.9rem 0 0", fontSize: "0.95rem", color: "var(--app-text-muted)" }}>
                                        Loading Instantly analytics…
                                    </p>
                                </div>
                            )}

                            {(!instantlyEventAnalyticsLoading || instantlyEventAnalytics) && (
                                <>
                            {(() => {
                                type AnalyticsStatCard = {
                                    key: string;
                                    label: string;
                                    value: number;
                                    border: string;
                                    icon: ReactNode;
                                    secondaryLine?: {
                                        value: string;
                                        label: string;
                                    };
                                };

                                const analyticsMatchesFilters = instantlyEventAnalytics
                                    && instantlyEventAnalytics.eventType?.value === instantlyEventAnalyticsEventType
                                    && instantlyEventAnalytics.window?.period === instantlyEventAnalyticsPeriod;
                                const displayAnalytics = analyticsMatchesFilters ? instantlyEventAnalytics : null;
                                const summary = displayAnalytics?.summary;
                                const isFiltered = instantlyEventAnalyticsEventType !== "all";
                                const selectedEventLabel = (instantlyEventAnalytics?.availableEventTypes || []).find((option) => option.value === instantlyEventAnalyticsEventType)?.label
                                    || displayAnalytics?.eventType?.label
                                    || "Events";
                                const showAnalyticsLoading = instantlyEventAnalyticsLoading || !analyticsMatchesFilters;
                                const positiveReplyRatePercent = displayAnalytics && (displayAnalytics.summary.contacts_emailed ?? 0) > 0
                                    ? (displayAnalytics.summary.positive_replies / displayAnalytics.summary.contacts_emailed) * 100
                                    : 0;
                                const bookingRatePercent = displayAnalytics && (displayAnalytics.summary.positive_replies ?? 0) > 0
                                    ? ((displayAnalytics.summary.meetings_booked ?? 0) / displayAnalytics.summary.positive_replies) * 100
                                    : 0;
                                const analyticsStatCards: AnalyticsStatCard[] = isFiltered
                                    ? [
                                        {
                                            key: "total_events",
                                            label: selectedEventLabel,
                                            value: summary?.total_events ?? 0,
                                            border: "var(--app-border-mid)",
                                            icon: (
                                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                                    <path d="M3 3v18h18" />
                                                    <path d="M7 16l4-5 4 3 5-7" />
                                                </svg>
                                            )
                                        },
                                        {
                                            key: "unique_contacts",
                                            label: "Unique contacts",
                                            value: summary?.unique_contacts ?? 0,
                                            border: "var(--app-border-mid)",
                                            icon: (
                                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                                    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                                                    <circle cx="9" cy="7" r="4" />
                                                    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                                                    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                                                </svg>
                                            )
                                        },
                                        {
                                            key: "unique_campaigns",
                                            label: "Campaigns",
                                            value: summary?.unique_campaigns ?? 0,
                                            border: "var(--app-border-mid)",
                                            icon: (
                                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                                    <path d="M4 6h16" />
                                                    <path d="M4 12h10" />
                                                    <path d="M4 18h14" />
                                                </svg>
                                            )
                                        }
                                    ]
                                    : [
                                        {
                                            key: "emails_sent",
                                            label: "Emails sent",
                                            value: summary?.emails_sent ?? 0,
                                            secondaryLine: {
                                                value: (summary?.contacts_emailed ?? 0).toLocaleString(),
                                                label: "Contacts Emailed",
                                            },
                                            border: "var(--app-border-mid)",
                                            icon: <SendHorizontal width={18} height={18} strokeWidth={1.8} />
                                        },
                                        {
                                            key: "positive_replies",
                                            label: "Positive replies",
                                            value: summary?.positive_replies ?? 0,
                                            secondaryLine: {
                                                value: `${positiveReplyRatePercent.toFixed(2)}%`,
                                                label: "PRR",
                                            },
                                            border: "var(--app-border-mid)",
                                            icon: <MessageCircleCheck width={18} height={18} strokeWidth={1.8} />
                                        },
                                        {
                                            key: "meetings_booked",
                                            label: "Meetings booked",
                                            value: summary?.meetings_booked ?? 0,
                                            secondaryLine: {
                                                value: `${bookingRatePercent.toFixed(2)}%`,
                                                label: "Booking Rate",
                                            },
                                            border: "var(--app-border-mid)",
                                            icon: <CalendarCheck width={18} height={18} strokeWidth={1.8} />
                                        }
                                    ];

                                const followUpCard: AnalyticsStatCard = {
                                    key: "follow_up_sent",
                                    label: "Warm Follow-ups",
                                    value: summary?.follow_up_sent ?? 0,
                                    secondaryLine: displayAnalytics?.window?.label
                                        ? { value: displayAnalytics.window.label, label: "" }
                                        : undefined,
                                    border: "rgba(234, 179, 8, 0.28)",
                                    icon: <MessageCircleReply width={18} height={18} strokeWidth={1.8} />
                                };

                                const statCardPadding = "1.35rem 1.2rem";
                                const statCardSecondarySlotStyle = {
                                    margin: "0.45rem 0 0",
                                    minHeight: "1.32rem",
                                    lineHeight: 1.1,
                                } as const;

                                return (
                            <div style={{
                                display: "grid",
                                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                                gap: "1rem"
                            }}>
                                {[...analyticsStatCards, followUpCard].map((card) => (
                                    <div
                                        key={card.key}
                                        style={{
                                            padding: statCardPadding,
                                            borderRadius: "16px",
                                            background: "transparent",
                                            border: `1px solid ${card.border}`,
                                            display: "flex",
                                            flexDirection: "column",
                                            justifyContent: "flex-start"
                                        }}
                                    >
                                        <div>
                                            {showAnalyticsLoading ? (
                                                <>
                                                    <div className="analytics-skeleton" style={{ width: "72px", height: "48px" }} />
                                                    <div className="analytics-skeleton" style={{ width: "88px", height: "22px", marginTop: "0.45rem" }} />
                                                    <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-start", gap: "0.45rem", marginTop: "0.55rem" }}>
                                                        <div className="analytics-skeleton" style={{ width: "18px", height: "18px", borderRadius: "999px", flexShrink: 0 }} />
                                                        <div className="analytics-skeleton" style={{ width: "112px", height: "14px" }} />
                                                    </div>
                                                </>
                                            ) : (
                                                <>
                                                    <p style={{ margin: 0, fontSize: "3rem", lineHeight: 1, fontWeight: 700 }}>
                                                        {card.value.toLocaleString()}
                                                    </p>
                                                    <div style={statCardSecondarySlotStyle}>
                                                        {card.secondaryLine && (
                                                            <p style={{
                                                                margin: 0,
                                                                fontSize: card.secondaryLine.label ? "1.2rem" : "0.75rem",
                                                                fontWeight: card.secondaryLine.label ? 300 : 500,
                                                                color: card.secondaryLine.label ? "var(--app-text-muted)" : "var(--app-text-ghost)",
                                                                fontVariantNumeric: "tabular-nums",
                                                            }}>
                                                                {card.secondaryLine.value}
                                                                {card.secondaryLine.label ? (
                                                                    <span style={{ marginLeft: "0.3rem", fontSize: "0.78rem", fontWeight: 500, color: "var(--app-text-ghost)" }}>
                                                                        {card.secondaryLine.label}
                                                                    </span>
                                                                ) : null}
                                                            </p>
                                                        )}
                                                    </div>
                                                    <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-start", gap: "0.45rem", marginTop: "0.55rem" }}>
                                                        <div style={{
                                                            display: "inline-flex",
                                                            alignItems: "center",
                                                            justifyContent: "center",
                                                            color: "var(--app-text)",
                                                            flexShrink: 0
                                                        }}>
                                                            {card.icon}
                                                        </div>
                                                        <p style={{ margin: 0, fontSize: "0.86rem", color: "var(--app-text-muted)" }}>
                                                            {card.label}
                                                        </p>
                                                    </div>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                                );
                            })()}

                            <InstantlyEventAnalyticsChart
                                rows={
                                    instantlyEventAnalytics
                                    && instantlyEventAnalytics.eventType?.value === instantlyEventAnalyticsEventType
                                    && instantlyEventAnalytics.window?.period === instantlyEventAnalyticsPeriod
                                        ? instantlyEventAnalytics.byHour
                                        : []
                                }
                                bucketUnit={instantlyEventAnalytics?.window.bucketUnit || "hour"}
                                windowLabel={
                                    INSTANTLY_ANALYTICS_PERIOD_OPTIONS.find((option) => option.value === instantlyEventAnalyticsPeriod)?.label
                                    || instantlyEventAnalytics?.window.label
                                    || "Last 24 hours"
                                }
                                eventTypeLabel={
                                    (instantlyEventAnalytics?.availableEventTypes || []).find((option) => option.value === instantlyEventAnalyticsEventType)?.label
                                    || instantlyEventAnalytics?.eventType?.label
                                    || "All event types"
                                }
                                showPositiveReplies={instantlyEventAnalyticsEventType === "all"}
                                showMeetingsBooked={instantlyEventAnalyticsEventType === "all"}
                                loading={instantlyEventAnalyticsLoading || !(
                                    instantlyEventAnalytics
                                    && instantlyEventAnalytics.eventType?.value === instantlyEventAnalyticsEventType
                                    && instantlyEventAnalytics.window?.period === instantlyEventAnalyticsPeriod
                                )}
                            />

                            <div style={{ display: "flex", gap: "1rem", alignItems: "flex-start" }}>

                            <div style={{
                                padding: "1.25rem",
                                borderRadius: "16px",
                                background: "var(--app-surface-3)",
                                border: "1px solid var(--app-border)",
                                flex: 1,
                                minWidth: 0
                            }}>
                                <p className="eyebrow eyebrow--muted" style={{ paddingBottom: "15px" }}>Recent Events</p>

                                {(() => {
                                    const recentEvents = buildCollatedActivityEvents(instantlyEventAnalytics?.recentEvents || []).slice(0, 25);
                                    if (recentEvents.length === 0) {
                                        return (
                                            <div className="pipeline-panel__empty">
                                                <p>No recent events found for the current filters.</p>
                                            </div>
                                        );
                                    }

                                    // Group events by day bucket for separators
                                    const now = new Date();
                                    const todayStr = now.toDateString();
                                    const yesterdayStr = new Date(now.getTime() - 86400000).toDateString();

                                    function getDayLabel(ts: string) {
                                        const d = new Date(ts);
                                        if (Number.isNaN(d.getTime())) return null;
                                        const ds = d.toDateString();
                                        if (ds === todayStr) return `Today · ${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;
                                        if (ds === yesterdayStr) return `Yesterday · ${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;
                                        return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
                                    }

                                    // Step 1: Group consecutive email_sent by same campaign into one row
                                    type OrigEvt = typeof recentEvents[0];
                                    type GroupedEvt = OrigEvt & { batchCount: number; batchItems: OrigEvt[] };
                                    const grouped: GroupedEvt[] = [];
                                    for (const evt of recentEvents) {
                                        const isEmailSent = String(evt.event_type).toLowerCase() === "email_sent";
                                        const last = grouped[grouped.length - 1];
                                        if (
                                            isEmailSent && last &&
                                            String(last.event_type).toLowerCase() === "email_sent" &&
                                            last.campaign_name === evt.campaign_name &&
                                            new Date(last.event_timestamp).toDateString() === new Date(evt.event_timestamp).toDateString()
                                        ) {
                                            last.batchCount += 1;
                                            last.batchItems.push(evt);
                                        } else {
                                            grouped.push({ ...evt, batchCount: 1, batchItems: [evt] });
                                        }
                                    }

                                    // Step 2: Group all events for the same lead together (preserve first-appearance order)
                                    type LeadGroup = { email: string; items: GroupedEvt[] };
                                    const leadGroupMap = new Map<string, LeadGroup>();
                                    const leadGroupOrder: string[] = [];
                                    for (const evt of grouped) {
                                        const key = (evt.lead_email || "").toLowerCase() || evt.id;
                                        if (leadGroupMap.has(key)) {
                                            leadGroupMap.get(key)!.items.push(evt);
                                        } else {
                                            leadGroupMap.set(key, { email: evt.lead_email || "", items: [evt] });
                                            leadGroupOrder.push(key);
                                        }
                                    }
                                    const leadGroups = leadGroupOrder.map(k => leadGroupMap.get(k)!);

                                    // Helper: color dot for a sub-event
                                    function subDotColor(et: string, dl?: string | null): string {
                                        const n = String(et).toLowerCase();
                                        if (n === "email_sent") return "#3b82f6";
                                        if (n === "reply_received" || n === "lead_interested" || n === "lead_meeting_booked" || n === "lead_meeting_completed" || n === "lead_closed") return "#22c55e";
                                        if (n === "email_bounced" || n === "lead_not_interested" || n === "lead_wrong_person" || n === "lead_no_show") return "#ef4444";
                                        return getInstantlyActivityColor(et, dl);
                                    }

                                    let lastDayLabel: string | null = null;

                                    return (
                                        <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                                            {leadGroups.map((group, idx) => {
                                                const primaryEvt = group.items[0];
                                                const isFirst = idx === 0;
                                                const hasMultiple = group.items.length > 1;
                                                const isBatch = primaryEvt.batchCount > 1;

                                                const eventTypeNorm = String(primaryEvt.event_type).toLowerCase();
                                                const isEmailSent = eventTypeNorm === "email_sent";
                                                const isAutoReply = eventTypeNorm === "interested_reply_sent";
                                                const isReply = eventTypeNorm === "reply_received";
                                                const isBounce = eventTypeNorm === "email_bounced";
                                                const isNotInterested = eventTypeNorm === "lead_not_interested" || eventTypeNorm === "lead_wrong_person" || eventTypeNorm === "lead_no_show";
                                                const isPositive = eventTypeNorm === "lead_interested" || eventTypeNorm === "lead_meeting_booked" || eventTypeNorm === "lead_meeting_completed" || eventTypeNorm === "lead_closed" || isReply;
                                                const isNegative = isBounce || isNotInterested;

                                                // Color family (based on primary event)
                                                const colorFamily = isAutoReply
                                                    ? { dot: "#8b5cf6", pill: "rgba(139,92,246,0.15)", pillText: "var(--app-evtpill-purple)", pillBorder: "rgba(139,92,246,0.25)", rowBg: "rgba(139,92,246,0.04)" }
                                                    : isEmailSent
                                                        ? { dot: "#3b82f6", pill: "rgba(59,130,246,0.15)", pillText: "var(--app-evtpill-blue)", pillBorder: "rgba(59,130,246,0.25)", rowBg: "transparent" }
                                                        : isPositive
                                                            ? { dot: "#22c55e", pill: "rgba(34,197,94,0.15)", pillText: "var(--app-evtpill-green)", pillBorder: "rgba(34,197,94,0.25)", rowBg: "rgba(34,197,94,0.04)" }
                                                            : isNegative
                                                                ? { dot: "#ef4444", pill: "rgba(239,68,68,0.15)", pillText: "var(--app-evtpill-red)", pillBorder: "rgba(239,68,68,0.25)", rowBg: "transparent" }
                                                                : { dot: getInstantlyActivityColor(primaryEvt.event_type, primaryEvt.displayLabel), pill: "var(--app-evtrow-default-pill)", pillText: "var(--app-evtrow-default-text)", pillBorder: "var(--app-evtrow-default-border)", rowBg: "transparent" };

                                                const evtDate = new Date(primaryEvt.event_timestamp);
                                                const timeStr = Number.isNaN(evtDate.getTime()) ? "" : evtDate.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

                                                // Day separator
                                                const dayLabel = getDayLabel(primaryEvt.event_timestamp);
                                                const showSeparator = dayLabel !== lastDayLabel;
                                                if (showSeparator) lastDayLabel = dayLabel;

                                                const email = primaryEvt.lead_email || "";

                                                const snippet = primaryEvt.reply_text_snippet
                                                    || (primaryEvt.message_text ? primaryEvt.message_text.split("\n").find((l) => l.trim()) || null : null);
                                                const fullContent = primaryEvt.message_text || snippet || "";
                                                const isExpanded = expandedRecentEventId === primaryEvt.id;
                                                const hasExpandable = hasMultiple || isBatch || Boolean(fullContent && fullContent.length > 80);

                                                const isAnimated = animatedRecentEventIds.has(primaryEvt.id);
                                                const pillLabel = isBatch
                                                    ? `${primaryEvt.batchCount}× ${primaryEvt.displayLabel}`
                                                    : primaryEvt.displayLabel;

                                                // Total individual events across this lead group
                                                const totalEvtCount = group.items.reduce((sum, g) => sum + g.batchCount, 0);

                                                return (
                                                    <div key={primaryEvt.id}>
                                                        {showSeparator && dayLabel && (
                                                            <div style={{
                                                                padding: "0.45rem 0 0.35rem",
                                                                marginTop: idx > 0 ? "0.25rem" : 0,
                                                                fontSize: "0.7rem",
                                                                fontWeight: 600,
                                                                textTransform: "uppercase",
                                                                letterSpacing: "0.07em",
                                                                color: "var(--app-text-ghost)",
                                                                borderTop: idx > 0 ? "1px solid var(--app-border)" : "none",
                                                            }}>
                                                                {dayLabel}
                                                            </div>
                                                        )}
                                                        <div
                                                            className={isAnimated ? "are-event are-event--new" : "are-event"}
                                                            style={{
                                                                background: colorFamily.rowBg,
                                                                cursor: hasExpandable ? "pointer" : "default",
                                                            }}
                                                            onClick={() => {
                                                                if (hasExpandable) {
                                                                    setExpandedRecentEventId(isExpanded ? null : primaryEvt.id);
                                                                    setActivityReplyPopup(null);
                                                                }
                                                            }}
                                                        >
                                                            {/* Dot */}
                                                            <div style={{ position: "relative", flexShrink: 0, width: "20px", display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "2px" }}>
                                                                <div
                                                                    className={isFirst ? "are-dot are-dot--pulse" : "are-dot"}
                                                                    style={{ background: colorFamily.dot, boxShadow: isFirst ? `0 0 0 3px ${colorFamily.dot}33` : "none" }}
                                                                />
                                                            </div>

                                                            {/* Content */}
                                                            <div style={{ flex: 1, minWidth: 0 }}>
                                                                {/* Row 1: email + count badge + pill + time + modal button */}
                                                                <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "nowrap" }}>
                                                                    <span style={{ fontSize: "0.83rem", fontWeight: 500, color: "var(--app-text-high)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "180px", flexShrink: 1 }}>
                                                                        {email || "—"}
                                                                    </span>
                                                                    {totalEvtCount > 1 && (
                                                                        <span style={{ fontSize: "0.68rem", fontWeight: 600, color: "var(--app-text-ghost)", background: "var(--app-surface-3)", borderRadius: "999px", padding: "0.05rem 0.35rem", flexShrink: 0 }}>
                                                                            {totalEvtCount}
                                                                        </span>
                                                                    )}
                                                                    <div style={{ flex: 1 }} />
                                                                    <span style={{
                                                                        display: "inline-flex",
                                                                        alignItems: "center",
                                                                        padding: "0.1rem 0.45rem",
                                                                        borderRadius: "999px",
                                                                        border: `1px solid ${colorFamily.pillBorder}`,
                                                                        background: colorFamily.pill,
                                                                        fontSize: "0.7rem",
                                                                        fontWeight: 600,
                                                                        color: colorFamily.pillText,
                                                                        whiteSpace: "nowrap",
                                                                        flexShrink: 0,
                                                                        textTransform: "capitalize",
                                                                    }}>
                                                                        {pillLabel}
                                                                    </span>
                                                                    <span style={{
                                                                        fontSize: "0.7rem",
                                                                        color: "var(--app-text-ghost)",
                                                                        flexShrink: 0,
                                                                        fontVariantNumeric: "tabular-nums",
                                                                    }}>
                                                                        {timeStr}
                                                                    </span>
                                                                    {email && (
                                                                        <button
                                                                            type="button"
                                                                            title="Open lead detail"
                                                                            onClick={(e) => {
                                                                                e.stopPropagation();
                                                                                void openLeadDetail({
                                                                                    email,
                                                                                    contactId: primaryEvt.contact_id || undefined,
                                                                                });
                                                                            }}
                                                                            style={{
                                                                                flexShrink: 0,
                                                                                display: "inline-flex",
                                                                                alignItems: "center",
                                                                                gap: "0.2rem",
                                                                                padding: "0.1rem 0.35rem",
                                                                                borderRadius: "4px",
                                                                                border: "1px solid var(--app-border-mid)",
                                                                                background: "var(--app-surface-2)",
                                                                                color: "var(--app-text-faint)",
                                                                                fontSize: "0.68rem",
                                                                                fontWeight: 600,
                                                                                cursor: "pointer",
                                                                                lineHeight: 1,
                                                                            }}
                                                                        >
                                                                            Open
                                                                            <svg
                                                                                width="11"
                                                                                height="11"
                                                                                viewBox="0 0 24 24"
                                                                                fill="none"
                                                                                stroke="currentColor"
                                                                                strokeWidth="2"
                                                                                strokeLinecap="round"
                                                                                strokeLinejoin="round"
                                                                                aria-hidden="true"
                                                                            >
                                                                                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                                                                                <polyline points="15 3 21 3 21 9" />
                                                                                <line x1="10" y1="14" x2="21" y2="3" />
                                                                            </svg>
                                                                        </button>
                                                                    )}
                                                                </div>

                                                                {/* Row 2: snippet (hidden when expanded) */}
                                                                {snippet && !isExpanded && (
                                                                    <p style={{ margin: "0.15rem 0 0", fontSize: "0.76rem", color: "var(--app-text-faint)", lineHeight: 1.45, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                                                                        {snippet}
                                                                    </p>
                                                                )}
                                                                {isExpanded && !hasMultiple && !isBatch && fullContent && (
                                                                    <div style={{ marginTop: "0.3rem", fontSize: "0.76rem", color: "var(--app-text-muted)", lineHeight: 1.55, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                                                                        {fullContent}
                                                                    </div>
                                                                )}
                                                                {primaryEvt.secondaryLabel && (
                                                                    <p style={{ margin: "0.1rem 0 0", fontSize: "0.7rem", color: "var(--app-text-muted)" }}>
                                                                        Includes {primaryEvt.secondaryLabel.toLowerCase()}
                                                                    </p>
                                                                )}
                                                            </div>
                                                        </div>

                                                        {/* Expanded: show all events for this lead, or batch items */}
                                                        {isExpanded && (hasMultiple || isBatch) && (
                                                            <div style={{ marginLeft: "9px", paddingLeft: "1rem", borderLeft: "1px solid var(--app-border)", marginBottom: "0.25rem" }}>
                                                                {hasMultiple
                                                                    ? group.items.map((item) => {
                                                                        const itemDate = new Date(item.event_timestamp);
                                                                        const itemTime = Number.isNaN(itemDate.getTime()) ? "" : itemDate.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
                                                                        const itemLabel = item.batchCount > 1 ? `${item.batchCount}× ${item.displayLabel}` : item.displayLabel;
                                                                        const itemColor = subDotColor(item.event_type, item.displayLabel);
                                                                        const itemSnippet = item.reply_text_snippet || (item.message_text ? item.message_text.split("\n").find((l) => l.trim()) || null : null);
                                                                        return (
                                                                            <div key={item.id} style={{ display: "flex", alignItems: "center", gap: "0.4rem", padding: "0.25rem 0.5rem" }}>
                                                                                <div className="are-dot" style={{ background: itemColor, flexShrink: 0 }} />
                                                                                <span style={{ fontSize: "0.78rem", fontWeight: 500, color: "var(--app-text-mid)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "140px", flexShrink: 0, textTransform: "capitalize" }}>{itemLabel}</span>
                                                                                <div style={{ flex: 1 }} />
                                                                                {itemSnippet && (
                                                                                    <span style={{ fontSize: "0.72rem", color: "var(--app-text-ghost)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100px", flexShrink: 1 }}>{itemSnippet}</span>
                                                                                )}
                                                                                <span style={{ fontSize: "0.7rem", color: "var(--app-text-ghost)", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{itemTime}</span>
                                                                            </div>
                                                                        );
                                                                    })
                                                                    : primaryEvt.batchItems.map((item) => {
                                                                        const itemDate = new Date(item.event_timestamp);
                                                                        const itemTime = Number.isNaN(itemDate.getTime()) ? "" : itemDate.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
                                                                        const itemEmail = item.lead_email || "";
                                                                        const itemSnippet = item.reply_text_snippet || (item.message_text ? item.message_text.split("\n").find((l) => l.trim()) || null : null);
                                                                        return (
                                                                            <div key={item.id} style={{ display: "flex", alignItems: "center", gap: "0.4rem", padding: "0.25rem 0.5rem" }}>
                                                                                <div className="are-dot" style={{ background: "#3b82f6", flexShrink: 0 }} />
                                                                                <span style={{ fontSize: "0.78rem", color: "var(--app-text-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "160px", flexShrink: 0 }}>{itemEmail || "—"}</span>
                                                                                <div style={{ flex: 1 }} />
                                                                                {itemSnippet && (
                                                                                    <span style={{ fontSize: "0.72rem", color: "var(--app-text-ghost)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100px", flexShrink: 1 }}>{itemSnippet}</span>
                                                                                )}
                                                                                <span style={{ fontSize: "0.7rem", color: "var(--app-text-ghost)", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{itemTime}</span>
                                                                            </div>
                                                                        );
                                                                    })
                                                                }
                                                            </div>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    );
                                })()}
                            </div>

                            {/* Pending Review Drafts column */}
                            <div style={{
                                width: "340px",
                                flexShrink: 0,
                                padding: "1.25rem",
                                borderRadius: "16px",
                                background: "var(--app-surface-3)",
                                border: "1px solid var(--app-border)"
                            }}>
                                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingBottom: "15px" }}>
                                    <p className="eyebrow eyebrow--muted" style={{ margin: 0 }}>Pending Review</p>
                                    {pendingReviewDrafts.length > 0 && (
                                        <span style={{
                                            fontSize: "0.7rem",
                                            fontWeight: 600,
                                            color: "var(--app-evtpill-purple)",
                                            background: "rgba(139,92,246,0.12)",
                                            border: "1px solid rgba(139,92,246,0.25)",
                                            borderRadius: "999px",
                                            padding: "0.1rem 0.5rem",
                                        }}>
                                            {pendingReviewDrafts.length}
                                        </span>
                                    )}
                                </div>
                                {pendingReviewDraftsLoading && pendingReviewDrafts.length === 0 ? (
                                    <div className="pipeline-panel__empty">
                                        <svg className="spinner" style={{ width: "24px", height: "24px", color: "#8b5cf6" }} viewBox="0 0 24 24" fill="none">
                                            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
                                            <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                                        </svg>
                                    </div>
                                ) : pendingReviewDrafts.length === 0 ? (
                                    <div className="pipeline-panel__empty">
                                        <p>No drafts pending review.</p>
                                    </div>
                                ) : (
                                    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                                        {pendingReviewDrafts.map((draft, idx) => {
                                            const isExpanded = expandedDraftId === draft.id;
                                            const isAnimated = animatedPendingDraftIds.has(draft.id);
                                            const draftDate = new Date(draft.created_at);
                                            const timeStr = Number.isNaN(draftDate.getTime()) ? "" : draftDate.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
                                            const dateStr = Number.isNaN(draftDate.getTime()) ? "" : draftDate.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
                                            const plainText = draft.rendered_text
                                                ? draft.rendered_text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
                                                : null;
                                            const snippet = plainText ? plainText.slice(0, 120) + (plainText.length > 120 ? "…" : "") : null;
                                            const reviewUrl = draft.review_token
                                                ? `/interested-autoresponder/${encodeURIComponent(draft.review_token)}`
                                                : null;

                                            return (
                                                <div
                                                    key={draft.id}
                                                    className={isAnimated ? "are-event are-event--new" : undefined}
                                                    style={{ borderTop: idx > 0 ? "1px solid var(--app-border)" : "none" }}
                                                >
                                                    <div
                                                        style={{
                                                            padding: "0.6rem 0.25rem",
                                                            cursor: plainText ? "pointer" : "default",
                                                            display: "flex",
                                                            flexDirection: "column",
                                                            gap: "0.2rem",
                                                        }}
                                                        onClick={() => plainText && setExpandedDraftId(isExpanded ? null : draft.id)}
                                                    >
                                                        <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                                                            <div style={{
                                                                width: "8px",
                                                                height: "8px",
                                                                borderRadius: "50%",
                                                                background: "#8b5cf6",
                                                                flexShrink: 0
                                                            }} />
                                                            <span style={{ fontSize: "0.83rem", fontWeight: 500, color: "var(--app-text-high)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                                                {draft.lead_email}
                                                            </span>
                                                            <span style={{ fontSize: "0.7rem", color: "var(--app-text-ghost)", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
                                                                {dateStr} {timeStr}
                                                            </span>
                                                        </div>
                                                        {draft.campaign_name && (
                                                            <p style={{ margin: 0, fontSize: "0.72rem", color: "var(--app-text-ghost)", paddingLeft: "16px" }}>
                                                                {draft.campaign_name}
                                                            </p>
                                                        )}
                                                        {snippet && !isExpanded && (
                                                            <p style={{ margin: 0, fontSize: "0.76rem", color: "var(--app-text-faint)", lineHeight: 1.45, paddingLeft: "16px", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                                                                {snippet}
                                                            </p>
                                                        )}
                                                        {isExpanded && plainText && (
                                                            <div style={{ margin: "0.2rem 0 0", fontSize: "0.76rem", color: "var(--app-text-muted)", lineHeight: 1.55, paddingLeft: "16px", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                                                                {plainText}
                                                            </div>
                                                        )}
                                                        {reviewUrl && (
                                                            <div style={{ paddingLeft: "16px", marginTop: "0.4rem" }}>
                                                                <a
                                                                    href={reviewUrl}
                                                                    target="_blank"
                                                                    rel="noopener noreferrer"
                                                                    onClick={(e) => e.stopPropagation()}
                                                                    style={{
                                                                        fontSize: "0.75rem",
                                                                        fontWeight: 600,
                                                                        color: "var(--app-evtpill-purple)",
                                                                        textDecoration: "none",
                                                                        display: "inline-flex",
                                                                        alignItems: "center",
                                                                        gap: "0.2rem",
                                                                    }}
                                                                >
                                                                    Review draft ↗
                                                                </a>
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>

                            </div>{/* end flex row */}
                                </>
                            )}
                        </div>
                    )}

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
                                        <span style={{ color: 'var(--app-text-muted)', fontSize: '0.9rem' }}>
                                            {campaignSyncMessage}
                                        </span>
                                    )}
                                </div>
                            </div>

                            {/* Pipeline Panel */}
                            {pipelineVisible && jobState && (
                                <div style={{ 
                                    marginTop: '2rem',
                                    background: 'var(--app-surface-3)',
                                    border: '1px solid var(--app-border)',
                                    borderRadius: '16px',
                                    padding: '2rem',
                                    position: 'relative'
                                }}>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setSelectedJobId(null);
                                            setJobState(null);
                                            stopJobWatch();
                                        }}
                                        aria-label="Deselect job"
                                        style={{
                                            position: 'absolute',
                                            top: '1rem',
                                            right: '1rem',
                                            background: 'var(--app-surface-3)',
                                            border: '1px solid var(--app-border)',
                                            borderRadius: '8px',
                                            width: '32px',
                                            height: '32px',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            cursor: 'pointer',
                                            color: 'var(--app-text-muted)',
                                            fontSize: '1.25rem',
                                            transition: 'all 0.2s ease',
                                            padding: 0
                                        }}
                                        onMouseEnter={(e) => {
                                            e.currentTarget.style.background = 'var(--app-surface-hover)';
                                            e.currentTarget.style.borderColor = 'var(--app-border-mid)';
                                            e.currentTarget.style.color = 'var(--app-text)';
                                        }}
                                        onMouseLeave={(e) => {
                                            e.currentTarget.style.background = 'var(--app-surface-3)';
                                            e.currentTarget.style.borderColor = 'var(--app-border)';
                                            e.currentTarget.style.color = 'var(--app-text-muted)';
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
                                            <p className="pipeline-panel__subtitle" style={{ marginTop: '0.35rem', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
                                                <span>Valid leads: {validLeadsCompleted.toLocaleString()} · Job ID: {jobState.id}</span>
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        const currentJobId = jobState.id;
                                                        if (!currentJobId) return;
                                                        const clause = {
                                                            field: 'job_id',
                                                            op: 'contains',
                                                            value: currentJobId,
                                                            joinOp: 'AND' as const
                                                        };
                                                        setLeadFilters([{ id: createLeadFilterId(), ...clause }]);
                                                        setAppliedLeadFilters([clause]);
                                                        setLeadSearch("");
                                                        setCampaignFilterId("");
                                                        setActiveTab("leads");
                                                    }}
                                                    title="View leads for this job"
                                                    aria-label="View leads for this job"
                                                    style={{
                                                        display: 'inline-flex',
                                                        alignItems: 'center',
                                                        gap: '0.35rem',
                                                        padding: '0.2rem 0.6rem',
                                                        fontSize: '0.75rem',
                                                        fontWeight: 500,
                                                        lineHeight: 1.2,
                                                        color: 'var(--app-text-muted)',
                                                        background: 'var(--app-surface-2)',
                                                        border: '1px solid var(--app-border)',
                                                        borderRadius: '6px',
                                                        cursor: 'pointer',
                                                        transition: 'all 0.15s ease'
                                                    }}
                                                    onMouseEnter={(e) => {
                                                        e.currentTarget.style.background = 'var(--app-surface-hover)';
                                                        e.currentTarget.style.borderColor = 'var(--app-border-mid)';
                                                        e.currentTarget.style.color = 'var(--app-text)';
                                                    }}
                                                    onMouseLeave={(e) => {
                                                        e.currentTarget.style.background = 'var(--app-surface-2)';
                                                        e.currentTarget.style.borderColor = 'var(--app-border)';
                                                        e.currentTarget.style.color = 'var(--app-text-muted)';
                                                    }}
                                                >
                                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                                        <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
                                                    </svg>
                                                    View leads
                                                </button>
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
                                                                    pendingPauseControlRef.current === 'resume'
                                                                        ? 'Resuming...'
                                                                        : 'Pausing...'
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
                                        {(jobState?.status === 'running' || jobState?.status === 'queued') && recentJobLogLines.length > 0 && (
                                            <ul
                                                className="pipeline-panel__subtitle"
                                                style={{
                                                    marginTop: '0.5rem',
                                                    marginBottom: 0,
                                                    paddingLeft: '1.1rem',
                                                    fontSize: '0.8rem',
                                                    opacity: 0.75,
                                                    lineHeight: 1.45
                                                }}
                                            >
                                                {recentJobLogLines.map((line, index) => (
                                                    <li key={`${line}-${index}`}>{line}</li>
                                                ))}
                                            </ul>
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
                                                    background: 'var(--app-surface-3)',
                                                    borderRadius: '8px',
                                                    border: '1px solid var(--app-border)',
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

                                        {displayJobCost !== null && displayJobCost > 0 && (
                                            <div style={{
                                                marginTop: "1rem",
                                                padding: "0.75rem 1rem",
                                                background: "var(--app-surface-3)",
                                                borderRadius: "8px",
                                                border: "1px solid var(--app-border)",
                                                fontSize: "0.875rem",
                                                fontVariantNumeric: "tabular-nums",
                                            }}>
                                                <span style={{ opacity: 0.65 }}>Estimated run cost </span>
                                                <strong>${displayJobCost.toFixed(2)}</strong>
                                            </div>
                                        )}
                                        
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
                                                const cost = stageCostFromStage(stage);
                                                heroNumber = found;
                                                heroLabel = "Found";
                                                subtext = processed > 0 ? `${processed.toLocaleString()} processed • ${((found / processed) * 100).toFixed(0)}% yield` : "Awaiting...";
                                                if (cost !== null && cost > 0) costFooter = `Cost $${cost.toFixed(2)}`;
                                            } else if (stageKey === "emailDiscovery") {
                                                const found =
                                                    extractNumberFrom(stats, ["Found", "found"])
                                                    ?? (typeof stage?.progress?.found === "number"
                                                        ? stage.progress.found
                                                        : null)
                                                    ?? extractNumberFrom(summary, ["Found", "found"])
                                                    ?? throughputNum
                                                    ?? 0;
                                                // `stage.progress.processed` is job-wide: it includes the offset for
                                                // founders that had no name (or were already done) and were never
                                                // actually email-checked. Using it as the denominator inflates "checked"
                                                // and crushes the hit rate. The lookup outcomes (Found / Not Found /
                                                // errors) are scoped to THIS run — the same scope as `found` — so they
                                                // give the true number of emails checked this run.
                                                const notFound =
                                                    extractNumberFrom(stats, ["Not Found", "not_found", "notFound"])
                                                    ?? extractNumberFrom(summary, ["Not Found", "not_found", "notFound"])
                                                    ?? 0;
                                                const errored =
                                                    extractNumberFrom(stats, ["errors", "Errors"])
                                                    ?? extractNumberFrom(summary, ["errors", "Errors"])
                                                    ?? 0;
                                                const checkedThisRun = found + notFound + errored;
                                                const attempted = checkedThisRun > 0
                                                    ? checkedThisRun
                                                    : (typeof stage?.progress?.processed === "number"
                                                        ? stage.progress.processed
                                                        : total ?? 0);
                                                heroNumber = found;
                                                heroLabel = "Emails Found";
                                                subtext = attempted > 0
                                                    ? `${attempted.toLocaleString()} checked • ${((found / attempted) * 100).toFixed(1)}% hit rate`
                                                    : "Awaiting...";
                                                const emailCost = stageCostFromStage(stage);
                                                if (emailCost !== null && emailCost > 0) {
                                                    costFooter = `Cost $${emailCost.toFixed(2)}`;
                                                }
                                            } else if (stageKey === "verification") {
                                                const safe =
                                                    extractNumberFrom(summary, ["Valid", "valid"])
                                                    ?? extractNumberFrom(stats, ["valid", "Valid"])
                                                    ?? 0;
                                                const risky =
                                                    extractNumberFrom(summary, ["Valid-Risky", "valid-risky"])
                                                    ?? extractNumberFrom(stats, ["valid-risky", "Valid-Risky"])
                                                    ?? 0;
                                                const verified =
                                                    typeof stage?.progress?.processed === "number"
                                                        ? stage.progress.processed
                                                        : total ?? 0;
                                                heroNumber = verified;
                                                heroLabel = "Verfified";
                                                const riskyText = risky > 0 ? ` • ${risky} Risky` : "";
                                                subtext =
                                                    verified > 0
                                                        ? `${safe.toLocaleString()} safe • ${verified.toLocaleString()} checked${riskyText}`
                                                        : "Awaiting...";
                                                const verifyCost = stageCostFromStage(stage);
                                                if (verifyCost !== null && verifyCost > 0) {
                                                    costFooter = `Cost $${verifyCost.toFixed(2)}`;
                                                }
                                            } else if (stageKey === "personalization") {
                                                const personalized =
                                                    extractNumberFrom(stats, ["personalized", "Personalized"])
                                                    ?? (typeof stage?.progress?.processed === "number"
                                                        ? stage.progress.processed
                                                        : null)
                                                    ?? extractNumberFrom(summary, ["personalized", "Personalized"])
                                                    ?? throughputNum
                                                    ?? 0;
                                                const candidates =
                                                    total
                                                    ?? extractNumberFrom(summary, ["total", "queued", "attempted"])
                                                    ?? 0;
                                                const processedNow =
                                                    typeof stage?.progress?.processed === "number"
                                                        ? stage.progress.processed
                                                        : personalized;
                                                const failed = (summary?.failed as number) ?? (stats?.failed as number) ?? 0;
                                                const skipped = summary?.skipped === true;
                                                const shopifyStores = (summary?.shopifyStores as number) ?? (summary?.["Shopify Stores"] as number) ?? 0;
                                                heroNumber = personalized;
                                                heroLabel = "Ready";
                                                if (stage?.status === "completed" && skipped) {
                                                    subtext =
                                                        shopifyStores > 0
                                                            ? `Skipped — ${shopifyStores.toLocaleString()} Shopify, 0 personalized`
                                                            : "Skipped — no Shopify stores / no eligible leads";
                                                } else if (
                                                    stage?.status === "running"
                                                    && candidates > 0
                                                ) {
                                                    subtext = `${processedNow.toLocaleString()} / ${candidates.toLocaleString()} personalized`;
                                                } else if (candidates > 0) {
                                                    subtext = `${candidates.toLocaleString()} total`;
                                                } else if (stage?.status === "completed") {
                                                    subtext = "Completed — none personalized";
                                                } else {
                                                    subtext = "Awaiting...";
                                                }
                                                if (failed > 0) subtext += ` • ${failed} failed`;
                                                const personalizationCost = stageCostFromStage(stage);
                                                if (personalizationCost !== null && personalizationCost > 0) {
                                                    costFooter = `Cost $${personalizationCost.toFixed(2)}`;
                                                }
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
                                                                {stageEtas[stageKey] && (
                                                                    <div style={{ fontSize: '0.75rem', marginTop: '0.35rem', opacity: 0.5, fontVariantNumeric: 'tabular-nums' }}>
                                                                        ~{stageEtas[stageKey]} remaining
                                                                    </div>
                                                                )}
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
                                            <span style={{ fontSize: '0.75rem', color: 'var(--app-text-faint)' }}>
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
                                                                border: `1px solid ${isSelected ? 'rgba(59, 130, 246, 0.65)' : 'var(--app-border)'}`,
                                                                background: isSelected ? 'rgba(59, 130, 246, 0.12)' : 'var(--app-surface-3)',
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
                                                                event.currentTarget.style.borderColor = isSelected ? 'rgba(59, 130, 246, 0.65)' : 'var(--app-border)';
                                                            }}
                                                        >
                                                            {/* Top row: Filename + Badge */}
                                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
                                                                <div style={{ flex: 1, minWidth: 0 }}>
                                                                    <p style={{
                                                                        margin: 0,
                                                                        fontWeight: 700,
                                                                        color: 'var(--app-text-high)',
                                                                        fontSize: '1.05rem',
                                                                        overflow: 'hidden',
                                                                        textOverflow: 'ellipsis',
                                                                        whiteSpace: 'nowrap'
                                                                    }}>{job.fileName || job.id}</p>
                                                                    <p style={{
                                                                        margin: '0.4rem 0 0',
                                                                        fontSize: '0.8rem',
                                                                        color: 'var(--app-text-faint)'
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
                                                                        <span style={{ fontSize: '0.8rem', color: 'var(--app-text-muted)' }}>
                                                                            Processing: {progress.processed.toLocaleString()} / {progress.total.toLocaleString()} rows
                                                                        </span>
                                                                        <span style={{ fontSize: '0.85rem', fontWeight: 600, color: statusColor }}>
                                                                            {progress.percent}%
                                                                        </span>
                                                                    </div>
                                                                    <div style={{
                                                                        width: '100%',
                                                                        height: '6px',
                                                                        background: 'var(--app-surface-2)',
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

                                                            {/* Upload Status Badges */}
                                                            {jobUploadStatus[job.id] && jobUploadStatus[job.id].length > 0 && (
                                                                <div style={{
                                                                    marginTop: '1rem',
                                                                    paddingTop: '1rem',
                                                                    borderTop: '1px solid var(--app-border)'
                                                                }}>
                                                                    <p style={{
                                                                        margin: '0 0 0.75rem 0',
                                                                        fontSize: '0.7rem',
                                                                        textTransform: 'uppercase',
                                                                        letterSpacing: '0.05em',
                                                                        color: 'var(--app-text-ghost)',
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
                                                                            color: 'var(--app-text-high)',
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
                                                                            borderTop: '1px solid var(--app-border)'
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
                    {activeTab === "leads" && leadTabContent}

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
                            <p style={{ color: 'var(--app-text-muted)', fontSize: '0.95rem', marginTop: '0.5rem' }}>
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
                                            background: step <= personalizerWizardStep ? '#3b82f6' : 'var(--app-surface-2)',
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
                                                <div style={{ fontWeight: 600, color: 'var(--app-text)' }}>
                                                    {processingPersonalizerFile ? 'Analyzing domains...' : 'File ready'}
                                                </div>
                                                <div style={{ fontSize: '0.875rem', color: 'var(--app-text-muted)', marginTop: '0.25rem' }}>
                                                    {personalizerFile.name} ({(personalizerFile.size / 1024).toFixed(2)} KB)
                                                </div>
                                                {personalizerDomainStats && (
                                                    <div style={{ fontSize: '0.875rem', marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px solid var(--app-border)' }}>
                                                        <div style={{ fontWeight: 600, marginBottom: '0.5rem', color: 'var(--app-text)' }}>
                                                            📊 Domain Analysis
                                                        </div>
                                                        
                                                        {/* Row 1: Basic counts */}
                                                        <div style={{ display: 'flex', gap: '1rem', color: 'var(--app-text-muted)', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
                                                            <span>
                                                                <strong style={{ color: 'var(--app-text)' }}>
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
                                                        <div style={{ display: 'flex', gap: '1rem', color: 'var(--app-text-muted)', flexWrap: 'wrap', paddingTop: '0.5rem', borderTop: '1px solid var(--app-border)', marginBottom: '0.5rem' }}>
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
                                                        <div style={{ display: 'flex', gap: '1rem', color: 'var(--app-text-muted)', flexWrap: 'wrap', paddingTop: '0.5rem', borderTop: '1px solid var(--app-border)' }}>
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
                                            background: 'var(--app-surface-3)',
                                            border: '1px solid var(--app-border-mid)',
                                            borderRadius: '8px',
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '0.5rem',
                                            color: 'var(--app-text)',
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
                                            border: '1px solid ' + (checkKlaviyo ? 'rgba(59, 130, 246, 0.3)' : 'var(--app-border)'),
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
                                                <div style={{ fontWeight: 500, color: 'var(--app-text)', fontSize: '1rem' }}>
                                                    Check Klaviyo Integration
                                                </div>
                                                <div style={{ fontSize: '0.875rem', color: 'var(--app-text-muted)', marginTop: '0.25rem' }}>
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
                                                        background: productsToPull === num ? 'rgba(59, 130, 246, 0.2)' : 'var(--app-surface-3)',
                                                        border: '1px solid ' + (productsToPull === num ? 'rgba(59, 130, 246, 0.5)' : 'var(--app-border)'),
                                                        borderRadius: '6px',
                                                        color: productsToPull === num ? '#93c5fd' : 'var(--app-text-muted)',
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
                                            border: '1px solid ' + (removeB2B ? 'rgba(59, 130, 246, 0.3)' : 'var(--app-border)'),
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
                                                <div style={{ fontWeight: 500, color: 'var(--app-text)', fontSize: '1rem' }}>
                                                    Remove B2B Content
                                                </div>
                                                <div style={{ fontSize: '0.875rem', color: 'var(--app-text-muted)', marginTop: '0.25rem' }}>
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
                                            <p style={{ fontSize: '0.875rem', color: 'var(--app-text-muted)', marginTop: '0.25rem' }}>
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
                                                        background: 'var(--app-surface-3)',
                                                        border: '1px solid var(--app-border)',
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
                                                                       'var(--app-surface-2)',
                                                            color: stage.status === 'completed' ? '#22c55e' :
                                                                   stage.status === 'running' ? '#3b82f6' :
                                                                   stage.status === 'failed' ? '#ef4444' :
                                                                   'var(--app-text-muted)'
                                                        }}>
                                                            {stage.status}
                                                        </span>
                                                    </div>
                                                    {stage.summary?.skipped && (
                                                        <div style={{ fontSize: '0.875rem', color: 'var(--app-text-muted)', fontStyle: 'italic' }}>
                                                            Skipped: {stage.summary.reason || 'N/A'}
                                                        </div>
                                                    )}
                                                    {stage.progress && !stage.summary?.skipped && (
                                                        <div style={{ fontSize: '0.875rem', color: 'var(--app-text-muted)' }}>
                                                            Progress: {stage.progress.processed || 0} / {stage.progress.total || 0}
                                                        </div>
                                                    )}
                                                    {stage.summary && !stage.summary.skipped && (
                                                        <div style={{ fontSize: '0.875rem', color: 'var(--app-text-muted)', marginTop: '0.5rem' }}>
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
                                                    <span style={{ color: 'var(--app-text-muted)' }}>Shopify Stores:</span>
                                                    <strong style={{ marginLeft: '0.5rem', color: 'var(--app-text-high)' }}>
                                                        {personalizerJobState.result.shopifyStores}
                                                    </strong>
                                                </div>
                                                {personalizerJobState.config?.checkKlaviyo && (
                                                    <div>
                                                        <span style={{ color: 'var(--app-text-muted)' }}>Klaviyo Stores:</span>
                                                        <strong style={{ marginLeft: '0.5rem', color: 'var(--app-text-high)' }}>
                                                            {personalizerJobState.result.klaviyoStores}
                                                        </strong>
                                                    </div>
                                                )}
                                                <div>
                                                    <span style={{ color: 'var(--app-text-muted)' }}>Products Fetched:</span>
                                                    <strong style={{ marginLeft: '0.5rem', color: 'var(--app-text-high)' }}>
                                                        {personalizerJobState.result.productsFetched}
                                                    </strong>
                                                </div>
                                                <div>
                                                    <span style={{ color: 'var(--app-text-muted)' }}>Personalized:</span>
                                                    <strong style={{ marginLeft: '0.5rem', color: '#22c55e' }}>
                                                        {personalizerJobState.result.personalized}
                                                    </strong>
                                                </div>
                                                {personalizerJobState.result.estimatedCost && (
                                                    <div>
                                                        <span style={{ color: 'var(--app-text-muted)' }}>Estimated Cost:</span>
                                                        <strong style={{ marginLeft: '0.5rem', color: 'var(--app-text-high)' }}>
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
                                            border: '1px solid var(--app-border-mid)',
                                            background: 'var(--app-surface-3)',
                                            color: 'var(--app-text)'
                                        }}
                                    >
                                        {copiedWebhook ? '✓' : '📋'}
                                    </button>
                                </div>
                                <span className="settings-field__hint">
                                    This is the live Instantly event endpoint for this client.
                                </span>
                                <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginTop: '0.5rem', fontSize: '0.875rem', color: 'var(--app-text-muted)' }}>
                                    <span>Webhook status: {clientInstantlyWebhookStatus === null ? 'Not registered' : String(clientInstantlyWebhookStatus)}</span>
                                    {clientInstantlyWebhookUpdatedAt && <span>Registered: {clientInstantlyWebhookUpdatedAt}</span>}
                                </div>
                                {instantlySyncRun && (
                                    <div style={{
                                        marginTop: '0.75rem',
                                        padding: '0.9rem',
                                        borderRadius: '10px',
                                        background: 'var(--app-surface-3)',
                                        border: '1px solid var(--app-border)'
                                    }}>
                                        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', fontSize: '0.875rem', color: 'var(--app-text-muted)' }}>
                                            <span>Status: <strong style={{ color: 'var(--app-text-high)' }}>{instantlySyncRun.status}</strong></span>
                                            {instantlySyncRun.updatedAt && <span>Updated: {new Date(instantlySyncRun.updatedAt).toLocaleString()}</span>}
                                            {instantlySyncRun.completedAt && <span>Completed: {new Date(instantlySyncRun.completedAt).toLocaleString()}</span>}
                                        </div>
                                        {formatInstantlySyncPhase(instantlySyncRun.phase) && (
                                            <div style={{ marginTop: '0.45rem', fontSize: '0.84rem', color: 'rgba(191,219,254,0.95)' }}>
                                                Phase: {formatInstantlySyncPhase(instantlySyncRun.phase)}
                                            </div>
                                        )}
                                        {instantlySyncRun.progressMessage && (
                                            <div style={{ marginTop: '0.5rem', color: 'var(--app-text)', fontSize: '0.95rem' }}>
                                                {instantlySyncRun.progressMessage}
                                            </div>
                                        )}
                                        {instantlySyncRun.currentCampaignName && (
                                            <div style={{
                                                marginTop: '0.65rem',
                                                padding: '0.75rem',
                                                borderRadius: '8px',
                                                background: 'rgba(15,23,42,0.45)',
                                                border: '1px solid rgba(148,163,184,0.18)'
                                            }}>
                                                <div style={{ fontSize: '0.85rem', color: '#bfdbfe' }}>
                                                    Current campaign: {instantlySyncRun.currentCampaignName}
                                                </div>
                                                {typeof instantlySyncRun.currentCampaignProcessedLeads === 'number' && typeof instantlySyncRun.currentCampaignLeadTotal === 'number' && (
                                                    <div style={{ marginTop: '0.4rem', color: 'var(--app-text)', fontSize: '0.95rem' }}>
                                                        {instantlySyncRun.currentCampaignProcessedLeads}/{instantlySyncRun.currentCampaignLeadTotal} leads processed in {instantlySyncRun.currentCampaignName}
                                                    </div>
                                                )}
                                                <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginTop: '0.45rem', fontSize: '0.82rem', color: 'var(--app-text-muted)' }}>
                                                    {typeof instantlySyncRun.currentCampaignFetchedLeads === 'number' && (
                                                        <span>Fetched: {instantlySyncRun.currentCampaignFetchedLeads}</span>
                                                    )}
                                                    {typeof instantlySyncRun.currentCampaignMatchedLeads === 'number' && (
                                                        <span>Matched: {instantlySyncRun.currentCampaignMatchedLeads}</span>
                                                    )}
                                                    {typeof instantlySyncRun.currentCampaignUnmatchedLeads === 'number' && (
                                                        <span>Unmatched: {instantlySyncRun.currentCampaignUnmatchedLeads}</span>
                                                    )}
                                                </div>
                                            </div>
                                        )}
                                        <div style={{ display: 'flex', gap: '0.9rem', flexWrap: 'wrap', marginTop: '0.6rem', fontSize: '0.85rem', color: 'var(--app-text-muted)' }}>
                                            <span>Campaigns: {instantlySyncRun.campaignsCompleted}/{instantlySyncRun.totalCampaigns}</span>
                                            <span>Seen: {instantlySyncRun.totalLeadsSeen}</span>
                                            <span>Matched: {instantlySyncRun.matchedLeads}</span>
                                            <span>Unmatched: {instantlySyncRun.unmatchedLeads}</span>
                                        </div>
                                        {instantlySyncRun.error && (
                                            <div style={{ marginTop: '0.5rem', color: '#fca5a5', fontSize: '0.875rem' }}>
                                                Error: {instantlySyncRun.error}
                                            </div>
                                        )}
                                    </div>
                                )}
                                <label className="settings-field" style={{ marginTop: '0.75rem' }}>
                                    <span className="settings-field__label">Sync scope</span>
                                    <select
                                        value={instantlySyncCampaignId}
                                        onChange={(e) => setInstantlySyncCampaignId(e.target.value)}
                                        disabled={instantlyCampaignsLoading || syncingInstantlyState || stoppingInstantlySync}
                                    >
                                        <option value="">All campaigns</option>
                                        {instantlyCampaigns.map((campaign) => (
                                            <option key={campaign.id} value={campaign.id}>
                                                {campaign.name}
                                            </option>
                                        ))}
                                    </select>
                                    <span className="settings-field__hint">
                                        {instantlyCampaignsLoading
                                            ? 'Loading campaigns...'
                                            : instantlySyncCampaignId
                                                ? 'Only the selected Instantly campaign will be synced.'
                                                : 'Syncs every Instantly campaign for this client.'}
                                    </span>
                                </label>
                                <div className="modal__actions" style={{ justifyContent: 'flex-start', marginTop: '0.75rem' }}>
                                    <button
                                        type="button"
                                        className="secondary-button"
                                        onClick={handleRegisterInstantlyWebhook}
                                        disabled={registeringInstantlyWebhook || isSavingClient || isDeletingClient}
                                    >
                                        {registeringInstantlyWebhook ? 'Registering...' : 'Register Webhook'}
                                    </button>
                                    <button
                                        type="button"
                                        className="secondary-button"
                                        onClick={handleSyncInstantlyState}
                                        disabled={syncingInstantlyState || syncingInstantlyEmailAccounts || stoppingInstantlySync || registeringInstantlyWebhook || isSavingClient || isDeletingClient}
                                    >
                                        {syncingInstantlyState
                                            ? 'Syncing...'
                                            : instantlySyncCampaignId
                                                ? 'Sync Selected Campaign'
                                                : 'Sync Instantly State'}
                                    </button>
                                    <button
                                        type="button"
                                        className="secondary-button"
                                        onClick={handleSyncInstantlyEmailAccounts}
                                        disabled={syncingInstantlyEmailAccounts || syncingInstantlyState || stoppingInstantlySync || registeringInstantlyWebhook || isSavingClient || isDeletingClient}
                                    >
                                        {syncingInstantlyEmailAccounts ? 'Syncing Accounts...' : 'Sync Email Accounts'}
                                    </button>
                                    {instantlySyncRun && ACTIVE_INSTANTLY_SYNC_STATUSES.has(instantlySyncRun.status) && (
                                        <button
                                            type="button"
                                            className="secondary-button"
                                            onClick={handleStopInstantlySync}
                                            disabled={
                                                stoppingInstantlySync
                                                || syncingInstantlyState
                                                || syncingInstantlyEmailAccounts
                                                || instantlySyncRun.status === 'cancelling'
                                                || registeringInstantlyWebhook
                                                || isSavingClient
                                                || isDeletingClient
                                            }
                                        >
                                            {stoppingInstantlySync || instantlySyncRun.status === 'cancelling' ? 'Stopping...' : 'Stop Sync'}
                                        </button>
                                    )}
                                </div>
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

                    {/* Follow-Ups Tab */}
                    {activeTab === "follow-ups" && (
                        <div style={{ marginTop: '2rem', display: 'flex', flexDirection: 'column', gap: '1.5rem', maxWidth: '800px' }}>
                            <div style={{ padding: '1rem 1.1rem', borderRadius: '12px', background: 'var(--app-surface-3)', border: '1px solid var(--app-border)' }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap' }}>
                                    <div>
                                        <p className="eyebrow eyebrow--muted">Interested Lead Auto-Responder</p>
                                        <p style={{ margin: '0.25rem 0 0', fontSize: '0.875rem', color: 'var(--app-text-faint)' }}>
                                            Create AI draft replies for <code style={{ background: 'var(--app-surface-3)', padding: '0.1rem 0.35rem', borderRadius: '4px', fontSize: '0.8rem' }}>lead_interested</code> events and send tokened review links via ntfy.
                                        </p>
                                    </div>
                                    <button
                                        type="button"
                                        className="primary-button"
                                        onClick={() => openAutoResponderPromptModal()}
                                        disabled={interestedAutoResponderPromptsLoading}
                                    >
                                        + Add Prompt
                                    </button>
                                </div>

                                <label className="settings-field" style={{ marginTop: '1rem' }}>
                                    <span className="settings-field__label">ntfy Topic / Channel</span>
                                    <input
                                        type="text"
                                        value={clientNtfyTopic}
                                        onChange={(event) => setClientNtfyTopic(event.target.value)}
                                        placeholder="essence-interested-leads"
                                    />
                                    <span className="settings-field__hint">Used for tokened review link notifications when a new AI draft is created.</span>
                                </label>

                                <div className="modal__actions" style={{ justifyContent: 'flex-start', marginTop: '0.75rem' }}>
                                    <button
                                        type="button"
                                        className="secondary-button"
                                        onClick={handleSaveClientInfo}
                                        disabled={isSavingClient}
                                    >
                                        {isSavingClient ? 'Saving...' : 'Save Notification Topic'}
                                    </button>
                                </div>

                                {interestedAutoResponderPromptsLoading ? (
                                    <p style={{ marginTop: '1rem', color: 'var(--app-text-faint)', fontSize: '0.875rem' }}>Loading auto-responder prompts…</p>
                                ) : interestedAutoResponderPrompts.length === 0 ? (
                                    <div style={{
                                        marginTop: '1rem',
                                        padding: '1rem',
                                        textAlign: 'center',
                                        border: '1px dashed var(--app-border-mid)',
                                        borderRadius: '10px',
                                        color: 'var(--app-text-ghost)',
                                        fontSize: '0.875rem'
                                    }}>
                                        No campaign prompts yet. Add one active prompt per campaign to enable AI draft generation.
                                    </div>
                                ) : (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '1rem' }}>
                                        {interestedAutoResponderPrompts.map((prompt) => (
                                            <div
                                                key={prompt.id}
                                                style={{
                                                    padding: '1rem',
                                                    borderRadius: '10px',
                                                    border: '1px solid var(--app-border)',
                                                    background: 'rgba(0,0,0,0.16)',
                                                    display: 'flex',
                                                    gap: '1rem',
                                                    alignItems: 'flex-start'
                                                }}
                                            >
                                                <div style={{ flex: 1, minWidth: 0 }}>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                                                        <span style={{ fontWeight: 600 }}>{prompt.campaign_name}</span>
                                                        <span style={{
                                                            fontSize: '0.72rem',
                                                            padding: '0.15rem 0.45rem',
                                                            borderRadius: '999px',
                                                            background: 'var(--app-surface-3)',
                                                            color: 'var(--app-text-muted)'
                                                        }}>
                                                            {prompt.version}
                                                        </span>
                                                        <span style={{
                                                            fontSize: '0.72rem',
                                                            fontWeight: 600,
                                                            textTransform: 'uppercase',
                                                            letterSpacing: '0.04em',
                                                            padding: '0.15rem 0.5rem',
                                                            borderRadius: '4px',
                                                            background: prompt.active ? 'rgba(34,197,94,0.15)' : 'var(--app-surface-3)',
                                                            color: prompt.active ? '#86efac' : 'var(--app-text-ghost)',
                                                        }}>
                                                            {prompt.active ? 'Active' : 'Inactive'}
                                                        </span>
                                                    </div>
                                                    <pre style={{
                                                        margin: '0.7rem 0 0',
                                                        padding: '0.85rem',
                                                        borderRadius: '8px',
                                                        border: '1px solid var(--app-border)',
                                                        background: 'var(--app-surface-3)',
                                                        color: 'var(--app-text-muted)',
                                                        fontSize: '0.78rem',
                                                        whiteSpace: 'pre-wrap',
                                                        overflow: 'hidden',
                                                        maxHeight: '180px'
                                                    }}>
                                                        {prompt.system_prompt}
                                                    </pre>
                                                </div>
                                                <div style={{ display: 'flex', gap: '0.5rem', flexShrink: 0 }}>
                                                    <button
                                                        type="button"
                                                        className="secondary-button"
                                                        style={{ padding: '0.35rem 0.75rem', fontSize: '0.8rem' }}
                                                        onClick={() => openAutoResponderTestModal(prompt)}
                                                    >
                                                        Test
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className="secondary-button"
                                                        style={{ padding: '0.35rem 0.75rem', fontSize: '0.8rem' }}
                                                        onClick={() => openAutoResponderPromptModal(prompt)}
                                                    >
                                                        Edit
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className="destructive-button"
                                                        style={{ padding: '0.35rem 0.75rem', fontSize: '0.8rem' }}
                                                        onClick={() => handleDeleteAutoResponderPrompt(prompt.id)}
                                                        disabled={deletingAutoResponderPromptId === prompt.id}
                                                    >
                                                        {deletingAutoResponderPromptId === prompt.id ? '…' : 'Delete'}
                                                    </button>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>

                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem' }}>
                                <div>
                                    <p className="eyebrow eyebrow--muted">Automated Follow-Ups</p>
                                    <p style={{ margin: '0.25rem 0 0', fontSize: '0.875rem', color: 'var(--app-text-faint)' }}>
                                        Configure same-thread follow-up body templates sent after Warm Follow Up events. The subject always reuses the existing thread subject. Use{' '}
                                        <code style={{ background: 'var(--app-surface-3)', padding: '0.1rem 0.35rem', borderRadius: '4px', fontSize: '0.8rem' }}>{'{{first_name}}'}</code>,{' '}
                                        <code style={{ background: 'var(--app-surface-3)', padding: '0.1rem 0.35rem', borderRadius: '4px', fontSize: '0.8rem' }}>{'{{company_domain}}'}</code>,{' '}
                                        <code style={{ background: 'var(--app-surface-3)', padding: '0.1rem 0.35rem', borderRadius: '4px', fontSize: '0.8rem' }}>{'{{campaign_name}}'}</code>.
                                    </p>
                                </div>
                                <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                                    <button
                                        type="button"
                                        className="primary-button"
                                        onClick={() => openFollowUpScriptModal()}
                                    >
                                        + Add Script
                                    </button>
                                </div>
                            </div>

                            {/* Send-day schedule picker */}
                            {(() => {
                                const DAYS = [
                                    { dow: 1, label: 'Mon' },
                                    { dow: 2, label: 'Tue' },
                                    { dow: 3, label: 'Wed' },
                                    { dow: 4, label: 'Thu' },
                                    { dow: 5, label: 'Fri' },
                                    { dow: 6, label: 'Sat' },
                                    { dow: 0, label: 'Sun' },
                                ];
                                const toggleDay = (dow: number) => {
                                    const next = followUpSendDays.includes(dow)
                                        ? followUpSendDays.filter((d) => d !== dow)
                                        : [...followUpSendDays, dow];
                                    setFollowUpSendDays(next);
                                };
                                return (
                                    <div style={{
                                        padding: '0.9rem 1rem',
                                        borderRadius: '10px',
                                        background: 'var(--app-surface-3)',
                                        border: '1px solid var(--app-border)',
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '1rem',
                                        flexWrap: 'wrap'
                                    }}>
                                        <span style={{ fontSize: '0.8rem', color: 'var(--app-text-ghost)', fontWeight: 500, flexShrink: 0 }}>
                                            Send days
                                        </span>
                                        <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                                            {DAYS.map(({ dow, label }) => {
                                                const active = followUpSendDays.includes(dow);
                                                return (
                                                    <button
                                                        key={dow}
                                                        type="button"
                                                        onClick={() => toggleDay(dow)}
                                                        disabled={savingFollowUpSchedule}
                                                        style={{
                                                            padding: '0.3rem 0.65rem',
                                                            borderRadius: '6px',
                                                            fontSize: '0.78rem',
                                                            fontWeight: 600,
                                                            cursor: 'pointer',
                                                            border: active ? '1px solid rgba(234,179,8,0.5)' : '1px solid var(--app-border)',
                                                            background: active ? 'rgba(234,179,8,0.15)' : 'transparent',
                                                            color: active ? '#fde68a' : 'var(--app-text-ghost)',
                                                            transition: 'all 0.15s'
                                                        }}
                                                    >
                                                        {label}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                        <button
                                            type="button"
                                            className="secondary-button"
                                            style={{ padding: '0.3rem 0.75rem', fontSize: '0.8rem', marginLeft: 'auto', flexShrink: 0 }}
                                            onClick={() => handleSaveFollowUpSchedule(followUpSendDays)}
                                            disabled={savingFollowUpSchedule}
                                        >
                                            {savingFollowUpSchedule ? 'Saving…' : 'Save'}
                                        </button>
                                    </div>
                                );
                            })()}

                            {followUpScriptsLoading ? (
                                <p style={{ color: 'var(--app-text-faint)', fontSize: '0.875rem' }}>Loading scripts…</p>
                            ) : followUpScripts.length === 0 ? (
                                <div style={{
                                    padding: '2rem',
                                    textAlign: 'center',
                                    border: '1px dashed var(--app-border-mid)',
                                    borderRadius: '10px',
                                    color: 'var(--app-text-ghost)',
                                    fontSize: '0.875rem'
                                }}>
                                    No follow-up scripts yet. Add one to get started.
                                </div>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                                    {followUpScripts.map(script => (
                                        <div
                                            key={script.id}
                                            style={{
                                                padding: '1rem 1.25rem',
                                                background: 'var(--app-surface-3)',
                                                border: '1px solid var(--app-border)',
                                                borderRadius: '10px',
                                                display: 'flex',
                                                alignItems: 'flex-start',
                                                gap: '1rem',
                                            }}
                                        >
                                            <div style={{ flex: 1, minWidth: 0 }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.25rem' }}>
                                                    <span style={{ fontWeight: 600, fontSize: '0.95rem' }}>
                                                        #{script.script_order}
                                                    </span>
                                                    <span style={{
                                                        fontSize: '0.72rem',
                                                        fontWeight: 600,
                                                        textTransform: 'uppercase',
                                                        letterSpacing: '0.04em',
                                                        padding: '0.15rem 0.5rem',
                                                        borderRadius: '4px',
                                                        background: script.active ? 'rgba(34,197,94,0.15)' : 'var(--app-surface-3)',
                                                        color: script.active ? '#86efac' : 'var(--app-text-ghost)',
                                                    }}>
                                                        {script.active ? 'Active' : 'Inactive'}
                                                    </span>
                                                </div>
                                                <div
                                                    className="fu-script-preview"
                                                    style={{
                                                        marginTop: '0.65rem',
                                                        padding: '0.85rem 0.95rem',
                                                        borderRadius: '8px',
                                                        border: '1px solid var(--app-border)',
                                                        background: 'rgba(0,0,0,0.18)',
                                                        color: 'var(--app-text-high)',
                                                        fontSize: '0.82rem',
                                                        lineHeight: 1.5,
                                                    }}
                                                    dangerouslySetInnerHTML={{ __html: script.html_template }}
                                                />
                                            </div>
                                            <div style={{ display: 'flex', gap: '0.5rem', flexShrink: 0 }}>
                                                <label
                                                    style={{
                                                        display: 'inline-flex',
                                                        alignItems: 'center',
                                                        gap: '0.4rem',
                                                        padding: '0.35rem 0.6rem',
                                                        borderRadius: '8px',
                                                        border: '1px solid var(--app-border)',
                                                        background: 'var(--app-surface-3)',
                                                        fontSize: '0.78rem',
                                                        color: 'var(--app-text-muted)',
                                                        cursor: updatingFollowUpScriptId === script.id ? 'wait' : 'pointer',
                                                    }}
                                                >
                                                    <input
                                                        type="checkbox"
                                                        checked={script.active}
                                                        onChange={() => handleToggleFollowUpScriptActive(script)}
                                                        disabled={updatingFollowUpScriptId === script.id}
                                                        style={{ width: '0.95rem', height: '0.95rem', margin: 0 }}
                                                    />
                                                    {updatingFollowUpScriptId === script.id ? 'Saving…' : 'Active'}
                                                </label>
                                                <button
                                                    type="button"
                                                    className="secondary-button"
                                                    style={{ padding: '0.35rem 0.75rem', fontSize: '0.8rem' }}
                                                    onClick={() => openFollowUpPreviewModal(script)}
                                                    disabled={updatingFollowUpScriptId === script.id}
                                                >
                                                    Preview
                                                </button>
                                                <button
                                                    type="button"
                                                    className="secondary-button"
                                                    style={{ padding: '0.35rem 0.75rem', fontSize: '0.8rem' }}
                                                    onClick={() => openFollowUpScriptModal(script)}
                                                    disabled={updatingFollowUpScriptId === script.id}
                                                >
                                                    Edit
                                                </button>
                                                <button
                                                    type="button"
                                                    className="destructive-button"
                                                    style={{ padding: '0.35rem 0.75rem', fontSize: '0.8rem' }}
                                                    onClick={() => handleDeleteFollowUpScript(script.id)}
                                                    disabled={deletingFollowUpScriptId === script.id || updatingFollowUpScriptId === script.id}
                                                >
                                                    {deletingFollowUpScriptId === script.id ? '…' : 'Delete'}
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </section>
            </AppShell>

            {autoResponderPromptModalOpen && (
                <div
                    className="modal-overlay"
                    role="dialog"
                    aria-modal="true"
                    onClick={() => setAutoResponderPromptModalOpen(false)}
                >
                    <div className="modal" onClick={(event) => event.stopPropagation()} style={{ maxWidth: '720px' }}>
                        <div className="modal__header">
                            <div>
                                <p className="eyebrow eyebrow--muted">Interested Auto-Responder Prompt</p>
                                <h2 className="modal__title">{editingAutoResponderPrompt ? 'Edit Prompt' : 'New Prompt'}</h2>
                            </div>
                        </div>
                        <div className="modal__body" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                            <label className="settings-field">
                                <span className="settings-field__label">Campaign</span>
                                <select
                                    value={autoResponderPromptCampaignId}
                                    onChange={(event) => setAutoResponderPromptCampaignId(event.target.value)}
                                >
                                    <option value="">Select campaign…</option>
                                    {autoResponderCampaigns.map((campaign) => (
                                        <option key={campaign.id} value={campaign.id}>{campaign.name}</option>
                                    ))}
                                </select>
                            </label>
                            <label className="settings-field" style={{ maxWidth: '180px' }}>
                                <span className="settings-field__label">Version</span>
                                <input
                                    type="text"
                                    value={autoResponderPromptVersion}
                                    onChange={(event) => setAutoResponderPromptVersion(event.target.value)}
                                    placeholder="v1"
                                />
                            </label>
                            <label className="settings-field">
                                <span className="settings-field__label">System Prompt</span>
                                <textarea
                                    value={autoResponderPromptSystemPrompt}
                                    onChange={(event) => setAutoResponderPromptSystemPrompt(event.target.value)}
                                    rows={14}
                                />
                            </label>
                            <label className="settings-field" style={{ flexDirection: 'row', alignItems: 'center', gap: '0.75rem' }}>
                                <input
                                    type="checkbox"
                                    checked={autoResponderPromptActive}
                                    onChange={(event) => setAutoResponderPromptActive(event.target.checked)}
                                    style={{ width: '1rem', height: '1rem', flexShrink: 0 }}
                                />
                                <span className="settings-field__label" style={{ margin: 0 }}>Set active for this campaign</span>
                            </label>
                        </div>
                        <div className="modal__actions">
                            <button
                                type="button"
                                className="secondary-button secondary-button--active"
                                onClick={() => setAutoResponderPromptModalOpen(false)}
                                disabled={savingAutoResponderPrompt}
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                className="primary-button"
                                onClick={handleSaveAutoResponderPrompt}
                                disabled={savingAutoResponderPrompt}
                            >
                                {savingAutoResponderPrompt ? 'Saving...' : (editingAutoResponderPrompt ? 'Update Prompt' : 'Create Prompt')}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Auto-Responder Test Modal */}
            {autoResponderTestModalOpen && testingAutoResponderPrompt && (
                <div
                    className="modal-overlay"
                    role="dialog"
                    aria-modal="true"
                    onClick={closeAutoResponderTestModal}
                >
                    <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '860px' }}>
                        <div className="modal__header">
                            <div>
                                <p className="eyebrow eyebrow--muted">Auto-Responder Test</p>
                                <h2 className="modal__title">{testingAutoResponderPrompt.campaign_name} · {testingAutoResponderPrompt.version}</h2>
                                <p className="modal__description">
                                    Search for an interested lead, provide an optional mock message, then generate a test reply without sending anything.
                                </p>
                            </div>
                        </div>
                        <div className="modal__body" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>

                            {/* Lead search */}
                            <label className="settings-field">
                                <span className="settings-field__label">Search Leads</span>
                                <input
                                    type="text"
                                    value={autoResponderTestLeadSearch}
                                    onChange={(e) => setAutoResponderTestLeadSearch(e.target.value)}
                                    placeholder="Search by email, domain, or founder name"
                                    disabled={autoResponderTestLoading}
                                />
                            </label>

                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                                {autoResponderTestLeadSearching ? (
                                    <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--app-text-faint)' }}>Searching leads…</p>
                                ) : debouncedAutoResponderTestLeadSearch.trim() && autoResponderTestLeadResults.length === 0 ? (
                                    <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--app-text-faint)' }}>No matching leads found.</p>
                                ) : null}

                                {autoResponderTestLeadResults.length > 0 && (
                                    <div style={{
                                        border: '1px solid var(--app-border)',
                                        borderRadius: '10px',
                                        overflow: 'hidden',
                                        background: 'var(--app-surface-3)'
                                    }}>
                                        {autoResponderTestLeadResults.map((lead) => {
                                            const isSelected = autoResponderTestSelectedLead?.id === lead.id;
                                            return (
                                                <button
                                                    key={lead.id}
                                                    type="button"
                                                    onClick={() => {
                                                        setAutoResponderTestSelectedLead(lead);
                                                        setAutoResponderTestResult(null);
                                                        setAutoResponderTestExpandedSteps(new Set());
                                                    }}
                                                    disabled={autoResponderTestLoading}
                                                    style={{
                                                        width: '100%',
                                                        textAlign: 'left',
                                                        padding: '0.9rem 1rem',
                                                        border: 'none',
                                                        borderTop: '1px solid var(--app-border)',
                                                        background: isSelected ? 'rgba(59,130,246,0.12)' : 'transparent',
                                                        color: 'inherit',
                                                        cursor: autoResponderTestLoading ? 'wait' : 'pointer',
                                                    }}
                                                >
                                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
                                                        <div style={{ minWidth: 0 }}>
                                                            <div style={{ fontWeight: 600, fontSize: '0.92rem', color: isSelected ? '#93c5fd' : 'var(--app-text)' }}>
                                                                {lead.founderName || lead.email || lead.domain || 'Unnamed lead'}
                                                            </div>
                                                            <div style={{ fontSize: '0.8rem', color: 'var(--app-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                                {lead.email || 'No email'}{lead.domain ? ` · ${lead.domain}` : ''}
                                                            </div>
                                                        </div>
                                                        {isSelected && (
                                                            <span style={{ fontSize: '0.75rem', color: '#93c5fd', flexShrink: 0 }}>Selected</span>
                                                        )}
                                                    </div>
                                                </button>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>

                            {/* Optional mock message + Generate button — shown when a lead is selected */}
                            {autoResponderTestSelectedLead && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                                    <label className="settings-field">
                                        <span className="settings-field__label">Optional Mock Message <span style={{ fontWeight: 400, color: 'var(--app-text-ghost)' }}>(overrides thread context)</span></span>
                                        <textarea
                                            rows={3}
                                            value={autoResponderTestMessage}
                                            onChange={(e) => setAutoResponderTestMessage(e.target.value)}
                                            placeholder="Paste a lead reply here to test against a specific message…"
                                            disabled={autoResponderTestLoading}
                                            style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: '0.82rem' }}
                                        />
                                    </label>
                                    <button
                                        type="button"
                                        className="primary-button"
                                        onClick={() => handleRunAutoResponderTest()}
                                        disabled={autoResponderTestLoading}
                                        style={{ alignSelf: 'flex-start' }}
                                    >
                                        {autoResponderTestLoading ? 'Generating…' : 'Generate Reply'}
                                    </button>
                                </div>
                            )}

                            {/* Multi-step result accordion */}
                            {(autoResponderTestLoading || autoResponderTestResult) && (() => {
                                const r = autoResponderTestResult;
                                const d = r?.debug;

                                const stepStyle = (stepNum: number): React.CSSProperties => ({
                                    borderRadius: '10px',
                                    border: '1px solid var(--app-border)',
                                    background: 'var(--app-surface-3)',
                                    overflow: 'hidden',
                                });

                                const stepHeaderStyle: React.CSSProperties = {
                                    width: '100%',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.75rem',
                                    padding: '0.75rem 1rem',
                                    background: 'transparent',
                                    border: 'none',
                                    color: 'inherit',
                                    textAlign: 'left',
                                    cursor: 'pointer',
                                };

                                const badgeStyle = (complete: boolean, active: boolean): React.CSSProperties => ({
                                    width: '22px',
                                    height: '22px',
                                    borderRadius: '50%',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    fontSize: '0.7rem',
                                    fontWeight: 700,
                                    flexShrink: 0,
                                    background: complete ? 'rgba(34,197,94,0.2)' : active ? 'rgba(59,130,246,0.25)' : 'var(--app-surface-3)',
                                    color: complete ? '#4ade80' : active ? '#93c5fd' : 'var(--app-text-ghost)',
                                    border: complete ? '1px solid rgba(34,197,94,0.35)' : active ? '1px solid rgba(59,130,246,0.4)' : '1px solid var(--app-border)',
                                });

                                const kvRow = (label: string, value: string | null | undefined) => value ? (
                                    <div key={label} style={{ display: 'flex', gap: '0.5rem', fontSize: '0.82rem', lineHeight: 1.5 }}>
                                        <span style={{ color: 'var(--app-text-ghost)', flexShrink: 0, minWidth: '140px' }}>{label}</span>
                                        <span style={{ color: 'var(--app-text-high)', wordBreak: 'break-all' }}>{value}</span>
                                    </div>
                                ) : null;

                                const toggleStep = (n: number) => {
                                    setAutoResponderTestExpandedSteps(prev => {
                                        const next = new Set(prev);
                                        next.has(n) ? next.delete(n) : next.add(n);
                                        return next;
                                    });
                                };

                                const isExpanded = (n: number) => autoResponderTestExpandedSteps.has(n);
                                const done = !!r;
                                const loading = autoResponderTestLoading;

                                const steps = [
                                    {
                                        n: 1,
                                        label: 'Lead data',
                                        summary: d ? `${d.lead.name || d.lead.email}${d.lead.companyDomain ? ' · ' + d.lead.companyDomain : ''}` : loading ? 'Fetching lead…' : null,
                                        content: d ? (
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', padding: '0 1rem 0.9rem' }}>
                                                {kvRow('Email', d.lead.email)}
                                                {kvRow('Name', d.lead.name)}
                                                {kvRow('First name', d.lead.firstName)}
                                                {kvRow('Company domain', d.lead.companyDomain)}
                                                {kvRow('Role type', d.lead.roleType)}
                                            </div>
                                        ) : null,
                                    },
                                    {
                                        n: 2,
                                        label: 'Sender account',
                                        summary: d ? (d.sender.eaccount ? `${d.sender.firstName ? d.sender.firstName + ' · ' : ''}${d.sender.eaccount}` : 'No sender account found') : loading ? 'Resolving sender…' : null,
                                        content: d ? (
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', padding: '0 1rem 0.9rem' }}>
                                                {kvRow('Email account', d.sender.eaccount || 'Not found')}
                                                {kvRow('First name', d.sender.firstName)}
                                                {kvRow('Last name', d.sender.lastName)}
                                            </div>
                                        ) : null,
                                    },
                                    {
                                        n: 3,
                                        label: 'Context sent to AI',
                                        summary: d ? `System prompt rendered · ${d.contextSentToAI?.previousLeadMessage ? 'Thread context included' : 'No thread context'}` : loading ? 'Building system prompt…' : null,
                                        content: d ? (
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', padding: '0 1rem 0.9rem' }}>
                                                <div>
                                                    <div style={{ fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--app-text-ghost)', marginBottom: '0.35rem' }}>System Prompt (rendered)</div>
                                                    <pre style={{ margin: 0, padding: '0.75rem', borderRadius: '8px', border: '1px solid var(--app-border)', background: 'rgba(0,0,0,0.25)', color: 'var(--app-text-high)', fontSize: '0.78rem', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '220px', overflowY: 'auto' }}>{d.renderedSystemPrompt || '—'}</pre>
                                                </div>
                                                <div>
                                                    <div style={{ fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--app-text-ghost)', marginBottom: '0.35rem' }}>User message sent to model</div>
                                                    <pre style={{ margin: 0, padding: '0.75rem', borderRadius: '8px', border: '1px solid var(--app-border)', background: 'rgba(0,0,0,0.25)', color: 'var(--app-text-high)', fontSize: '0.78rem', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '220px', overflowY: 'auto' }}>{[
                                                        `Campaign: ${d.contextSentToAI?.campaignName || '—'}`,
                                                        `Lead email: ${d.contextSentToAI?.leadEmail || '—'}`,
                                                        `Thread subject: ${d.contextSentToAI?.threadSubject || '(none)'}`,
                                                        '',
                                                        'Lead message/thread context:',
                                                        d.contextSentToAI?.previousLeadMessage || '(no message text available)',
                                                    ].join('\n')}</pre>
                                                </div>
                                            </div>
                                        ) : null,
                                    },
                                    {
                                        n: 4,
                                        label: 'AI result',
                                        summary: r ? `Model: ${r.model}` : loading ? 'Waiting for AI response…' : null,
                                        content: r ? (
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', padding: '0 1rem 0.9rem' }}>
                                                <div>
                                                    <div style={{ fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--app-text-ghost)', marginBottom: '0.35rem' }}>Generated Reply</div>
                                                    <div
                                                        style={{ padding: '0.75rem', borderRadius: '8px', border: '1px solid var(--app-border)', background: 'rgba(0,0,0,0.25)', color: 'var(--app-text-high)', fontSize: '0.85rem', lineHeight: 1.6 }}
                                                        dangerouslySetInnerHTML={{ __html: r.renderedText }}
                                                    />
                                                </div>
                                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                                                    {kvRow('Sender first name', d?.sender.firstName)}
                                                    {kvRow('Sender email account', d?.sender.eaccount)}
                                                    {kvRow('Reply thread subject', d?.threadSubject)}
                                                    {kvRow('Model', r.model)}
                                                </div>
                                                {r.reviewUrl && (
                                                    <a
                                                        href={r.reviewUrl}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        style={{ fontSize: '0.82rem', color: '#60a5fa', textDecoration: 'underline', alignSelf: 'flex-start' }}
                                                    >
                                                        Open review &amp; approve page →
                                                    </a>
                                                )}
                                            </div>
                                        ) : null,
                                    },
                                ];

                                return (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                                        {steps.map(({ n, label, summary, content }) => {
                                            const complete = done && n < 4 ? true : done && n === 4;
                                            const active = loading && !done;
                                            const expanded = isExpanded(n);
                                            const canExpand = !!content;
                                            return (
                                                <div key={n} style={stepStyle(n)}>
                                                    <button
                                                        type="button"
                                                        style={stepHeaderStyle}
                                                        onClick={() => canExpand && toggleStep(n)}
                                                        disabled={!canExpand}
                                                    >
                                                        <span style={badgeStyle(complete, active)}>
                                                            {complete ? '✓' : n}
                                                        </span>
                                                        <div style={{ flex: 1, minWidth: 0 }}>
                                                            <div style={{ fontWeight: 600, fontSize: '0.88rem', color: complete ? 'var(--app-text-high)' : 'var(--app-text-ghost)' }}>
                                                                {label}
                                                            </div>
                                                            {summary && (
                                                                <div style={{ fontSize: '0.78rem', color: complete ? 'var(--app-text-muted)' : 'var(--app-text-ghost)', marginTop: '0.1rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                                    {summary}
                                                                </div>
                                                            )}
                                                        </div>
                                                        {canExpand && (
                                                            <span style={{ fontSize: '0.75rem', color: 'var(--app-text-ghost)', flexShrink: 0 }}>
                                                                {expanded ? '▲' : '▼'}
                                                            </span>
                                                        )}
                                                    </button>
                                                    {expanded && content}
                                                </div>
                                            );
                                        })}
                                    </div>
                                );
                            })()}
                        </div>
                        <div className="modal__actions">
                            <button
                                type="button"
                                className="secondary-button"
                                onClick={closeAutoResponderTestModal}
                                disabled={autoResponderTestLoading}
                            >
                                Close
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Follow-Up Script Modal */}
            {followUpScriptModalOpen && (
                <div
                    className="modal-overlay"
                    role="dialog"
                    aria-modal="true"
                    onClick={() => setFollowUpScriptModalOpen(false)}
                >
                    <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '640px' }}>
                        <div className="modal__header">
                            <div>
                                <p className="eyebrow eyebrow--muted">Follow-Up Script</p>
                                <h2 className="modal__title">{editingFollowUpScript ? 'Edit Script' : 'New Script'}</h2>
                            </div>
                        </div>
                        <div className="modal__body" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                            <div style={{ display: 'flex', gap: '1rem' }}>
                                <label className="settings-field" style={{ width: '100px', flexShrink: 0 }}>
                                    <span className="settings-field__label">Order</span>
                                    <input
                                        type="number"
                                        min={1}
                                        value={fuScriptOrder}
                                        onChange={(e) => setFuScriptOrder(Number(e.target.value))}
                                    />
                                </label>
                            </div>
                            <label className="settings-field" style={{ flexDirection: 'row', alignItems: 'center', gap: '0.75rem' }}>
                                <input
                                    type="checkbox"
                                    checked={fuScriptActive}
                                    onChange={(e) => setFuScriptActive(e.target.checked)}
                                    style={{ width: '1rem', height: '1rem', flexShrink: 0 }}
                                />
                                <span className="settings-field__label" style={{ margin: 0 }}>Active</span>
                            </label>
                            <label className="settings-field">
                                <span className="settings-field__label">HTML Body Template</span>
                                <textarea
                                    value={fuScriptHtml}
                                    onChange={(e) => setFuScriptHtml(e.target.value)}
                                    placeholder="<p>Hi {{first_name}},</p><p>Just wanted to follow up…</p>"
                                    rows={8}
                                    style={{ fontFamily: 'monospace', fontSize: '0.82rem' }}
                                />
                            </label>
                            <label className="settings-field">
                                <span className="settings-field__label">Plain Text Body Template <span style={{ fontWeight: 400, opacity: 0.5 }}>(optional)</span></span>
                                <textarea
                                    value={fuScriptText}
                                    onChange={(e) => setFuScriptText(e.target.value)}
                                    placeholder="Hi {{first_name}}, Just wanted to follow up…"
                                    rows={4}
                                    style={{ fontFamily: 'monospace', fontSize: '0.82rem' }}
                                />
                            </label>
                        </div>
                        <div className="modal__actions">
                            <button
                                type="button"
                                className="primary-button"
                                onClick={handleSaveFollowUpScript}
                                disabled={savingFollowUpScript || !fuScriptHtml.trim()}
                            >
                                {savingFollowUpScript ? 'Saving…' : editingFollowUpScript ? 'Save Changes' : 'Create Script'}
                            </button>
                            <button
                                type="button"
                                className="secondary-button"
                                onClick={() => setFollowUpScriptModalOpen(false)}
                                disabled={savingFollowUpScript}
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {followUpPreviewModalOpen && previewingFollowUpScript && (
                <div
                    className="modal-overlay"
                    role="dialog"
                    aria-modal="true"
                    onClick={closeFollowUpPreviewModal}
                >
                    <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '860px' }}>
                        <div className="modal__header">
                            <div>
                                <p className="eyebrow eyebrow--muted">Follow-Up Preview</p>
                                <h2 className="modal__title">Script #{previewingFollowUpScript.script_order}</h2>
                                <p className="modal__description">
                                    Search for a lead, then preview the rendered HTML for this follow-up script without sending anything.
                                </p>
                            </div>
                        </div>
                        <div className="modal__body" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                            <label className="settings-field">
                                <span className="settings-field__label">Search Leads</span>
                                <input
                                    type="text"
                                    value={followUpPreviewLeadSearch}
                                    onChange={(e) => setFollowUpPreviewLeadSearch(e.target.value)}
                                    placeholder="Search by email, domain, or founder name"
                                />
                            </label>

                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                                {followUpPreviewSearching ? (
                                    <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--app-text-faint)' }}>Searching leads…</p>
                                ) : debouncedFollowUpPreviewLeadSearch.trim() && followUpPreviewLeadResults.length === 0 ? (
                                    <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--app-text-faint)' }}>No matching leads found.</p>
                                ) : null}

                                {followUpPreviewLeadResults.length > 0 && (
                                    <div style={{
                                        border: '1px solid var(--app-border)',
                                        borderRadius: '10px',
                                        overflow: 'hidden',
                                        background: 'var(--app-surface-3)'
                                    }}>
                                        {followUpPreviewLeadResults.map((lead) => {
                                            const isSelected = followUpPreviewSelectedLead?.id === lead.id;
                                            return (
                                                <button
                                                    key={lead.id}
                                                    type="button"
                                                    onClick={() => handleRunFollowUpPreview(lead)}
                                                    disabled={followUpPreviewLoading}
                                                    style={{
                                                        width: '100%',
                                                        textAlign: 'left',
                                                        padding: '0.9rem 1rem',
                                                        border: 'none',
                                                        borderTop: '1px solid var(--app-border)',
                                                        background: isSelected ? 'rgba(59,130,246,0.16)' : 'transparent',
                                                        color: 'inherit',
                                                        cursor: followUpPreviewLoading ? 'wait' : 'pointer',
                                                    }}
                                                >
                                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
                                                        <div style={{ minWidth: 0 }}>
                                                            <div style={{ fontWeight: 600, fontSize: '0.92rem', color: 'var(--app-text)' }}>
                                                                {lead.founderName || lead.email || lead.domain || 'Unnamed lead'}
                                                            </div>
                                                            <div style={{ fontSize: '0.8rem', color: 'var(--app-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                                {lead.email || 'No email'}{lead.domain ? ` · ${lead.domain}` : ''}
                                                            </div>
                                                        </div>
                                                        <span style={{ fontSize: '0.78rem', color: 'var(--app-text-muted)', flexShrink: 0 }}>
                                                            {followUpPreviewLoading && isSelected ? 'Rendering…' : 'Preview'}
                                                        </span>
                                                    </div>
                                                </button>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>

                            {followUpPreviewResult && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                                    <div style={{
                                        padding: '0.9rem 1rem',
                                        borderRadius: '10px',
                                        border: '1px solid var(--app-border)',
                                        background: 'var(--app-surface-3)'
                                    }}>
                                        <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--app-text-faint)', marginBottom: '0.35rem' }}>
                                            Previewing
                                        </div>
                                        <div style={{ fontWeight: 600, color: 'var(--app-text)' }}>
                                            {followUpPreviewResult.contactEmail}
                                        </div>
                                    </div>

                                    <div>
                                        <div style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--app-text-faint)', marginBottom: '0.5rem' }}>
                                            Rendered HTML
                                        </div>
                                        <div style={{
                                            padding: '1rem',
                                            borderRadius: '10px',
                                            border: '1px solid var(--app-border)',
                                            background: '#fff',
                                            color: '#111827',
                                            minHeight: '160px'
                                        }}>
                                            <style>{`.followup-preview-render a { color: #2563eb; text-decoration: underline; }`}</style>
                                            <div
                                                className="followup-preview-render"
                                                dangerouslySetInnerHTML={{ __html: followUpPreviewResult.renderedHtml }}
                                            />
                                        </div>
                                    </div>

                                    <div>
                                        <div style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--app-text-faint)', marginBottom: '0.5rem' }}>
                                            Variables
                                        </div>
                                        <pre style={{
                                            margin: 0,
                                            padding: '1rem',
                                            borderRadius: '10px',
                                            border: '1px solid var(--app-border)',
                                            background: 'var(--app-surface-3)',
                                            color: 'var(--app-text-high)',
                                            fontSize: '0.78rem',
                                            overflowX: 'auto',
                                            whiteSpace: 'pre-wrap',
                                            wordBreak: 'break-word'
                                        }}>{JSON.stringify(followUpPreviewResult.vars, null, 2)}</pre>
                                    </div>
                                </div>
                            )}
                        </div>
                        <div className="modal__actions">
                            <button
                                type="button"
                                className="secondary-button"
                                onClick={closeFollowUpPreviewModal}
                                disabled={followUpPreviewLoading}
                            >
                                Close
                            </button>
                        </div>
                    </div>
                </div>
            )}

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
                                            background: step <= wizardStep ? '#3b82f6' : 'var(--app-surface-2)',
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
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--app-text-muted)' }}>
                                                    <div style={{
                                                        width: '14px',
                                                        height: '14px',
                                                        border: '2px solid var(--app-border-mid)',
                                                        borderTopColor: '#3b82f6',
                                                        borderRadius: '50%',
                                                        animation: 'spin 0.8s linear infinite'
                                                    }} />
                                                    Checking domains...
                                                </div>
                                            ) : domainCheckStats ? (
                                                <div style={{ color: 'var(--app-text)' }}>
                                                    <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>
                                                        📊 Domain Analysis
                                                    </div>
                                                    
                                                    {/* Row 1: Basic counts */}
                                                    <div style={{ display: 'flex', gap: '1.25rem', color: 'var(--app-text-muted)', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
                                                        <span>
                                                            <strong style={{ color: 'var(--app-text)' }}>{domainCheckStats.total.toLocaleString()}</strong> total
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
                                                    <div style={{ display: 'flex', gap: '1.25rem', color: 'var(--app-text-muted)', flexWrap: 'wrap', paddingTop: '0.5rem', borderTop: '1px solid var(--app-border)', marginBottom: '0.5rem' }}>
                                                        <span>
                                                            <strong style={{ color: '#22c55e' }}>{domainCheckStats.run.toLocaleString()}</strong> run
                                                        </span>
                                                        <span>
                                                            <strong style={{ color: '#94a3b8' }}>{domainCheckStats.notRun.toLocaleString()}</strong> not run
                                                        </span>
                                                    </div>

                                                    {/* Row 3: Data enrichment */}
                                                    <div style={{ display: 'flex', gap: '1.25rem', color: 'var(--app-text-muted)', flexWrap: 'wrap', paddingTop: '0.5rem', borderTop: '1px solid var(--app-border)' }}>
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
                                    <div style={{ fontSize: '0.95rem', color: 'var(--app-text-high)' }}>
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
                                                ? 'Re-runs enrichment for domains in this file: only non-empty CSV/API values override DB; blank or "Not Found" cells keep existing data and skip later stages. Mapped email/founder columns define which rows are in scope.'
                                                : 'Deduplication is scoped to this client.'}
                                        </span>
                                    </label>

                                    <div style={{
                                        display: 'flex',
                                        flexDirection: 'column',
                                        gap: '0.75rem',
                                        padding: '1rem',
                                        background: 'var(--app-surface-3)',
                                        borderRadius: '8px',
                                        border: '1px solid var(--app-border)'
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
                                                <div style={{ fontWeight: 500, color: 'var(--app-text)' }}>
                                                    Run domain DNS check
                                                </div>
                                                <div style={{ fontSize: '0.8rem', color: 'var(--app-text-muted)', marginTop: '0.15rem' }}>
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
                                                    border: '2px solid var(--app-border-mid)',
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
                                                <div style={{ fontWeight: 500, color: 'var(--app-text)' }}>
                                                    Find Founder
                                                </div>
                                                <div style={{ fontSize: '0.875rem', color: 'var(--app-text-muted)', marginTop: '0.125rem' }}>
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
                                                    border: (findFounder || skipFounderFinder) ? '2px solid var(--app-border-mid)' : '2px solid var(--app-border)',
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
                                                <div style={{ fontWeight: 500, color: 'var(--app-text)' }}>
                                                    Find Email
                                                </div>
                                                <div style={{ fontSize: '0.875rem', color: 'var(--app-text-muted)', marginTop: '0.125rem' }}>
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
                                                    border: (findEmail || skipEmailFinder) && emailProvider !== 'self_hosted' ? '2px solid var(--app-border-mid)' : '2px solid var(--app-border)',
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
                                                <div style={{ fontWeight: 500, color: 'var(--app-text)' }}>
                                                    Verify Email
                                                </div>
                                                <div style={{ fontSize: '0.875rem', color: 'var(--app-text-muted)', marginTop: '0.125rem' }}>
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
                                        background: 'var(--app-surface-3)',
                                        borderRadius: '8px',
                                        border: '1px solid var(--app-border)'
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
                                                    <div style={{ fontWeight: 500, color: 'var(--app-text)' }}>
                                                        Personalize with Product Data
                                                    </div>
                                                    <div style={{ fontSize: '0.875rem', color: 'var(--app-text-muted)', marginTop: '0.125rem' }}>
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
                                                            background: 'var(--app-surface-3)',
                                                            border: '1px solid var(--app-border-mid)'
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
                                                                <span style={{ fontSize: '0.875rem', color: 'var(--app-text)' }}>
                                                                    New Prompt (gpt-5-mini)
                                                                </span>
                                                            </label>

                                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginLeft: '1.5rem' }}>
                                                                <span style={{ fontSize: '0.8rem', color: 'var(--app-text-muted)' }}>Products:</span>
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
                                                                <span style={{ fontSize: '0.875rem', color: 'var(--app-text)' }}>
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
                                                    <div style={{ fontWeight: 500, color: 'var(--app-text)' }}>
                                                        Personalize with Feature/Benefit
                                                    </div>
                                                    <div style={{ fontSize: '0.875rem', color: 'var(--app-text-muted)', marginTop: '0.125rem' }}>
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
                                                    <div style={{ fontWeight: 500, color: 'var(--app-text)' }}>
                                                        Personalize with Website Info
                                                    </div>
                                                    <div style={{ fontSize: '0.875rem', color: 'var(--app-text-muted)', marginTop: '0.125rem' }}>
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
                                                    <div style={{ fontWeight: 500, color: 'var(--app-text)' }}>
                                                        Personalize with Service Offering
                                                    </div>
                                                    <div style={{ fontSize: '0.875rem', color: 'var(--app-text-muted)', marginTop: '0.125rem' }}>
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
                                <h3 style={{ fontSize: '1rem', marginBottom: '1rem', color: 'var(--app-text)' }}>Standard Variables</h3>
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
                                                <div style={{ marginTop: '0.5rem', padding: '0.75rem', background: 'var(--app-surface-3)', borderRadius: '6px', fontSize: '0.875rem' }}>
                                                    <div style={{ color: 'var(--app-text-muted)', marginBottom: '0.5rem' }}>Preview:</div>
                                                    {csvPreviewRows.slice(0, 3).map((row, idx) => (
                                                        <div key={idx} style={{ padding: '0.375rem 0', color: 'var(--app-text-high)', borderBottom: idx < 2 ? '1px solid var(--app-border)' : 'none' }}>
                                                            {row[columnMapping[field].column] || '(empty)'}
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>

                            <div style={{ marginBottom: '1.5rem', paddingTop: '0.75rem', borderTop: '1px solid var(--app-border)' }}>
                                <div style={{ fontWeight: 600, marginBottom: '0.5rem', color: 'var(--app-text)' }}>Email verification status</div>
                                <p style={{ margin: '0 0 0.75rem', fontSize: '0.875rem', color: 'var(--app-text-muted)' }}>
                                    Choose which verified emails to include in this upload.
                                </p>
                                <label className="settings-field" style={{ flexDirection: 'row', alignItems: 'center', gap: '0.5rem' }}>
                                    <input
                                        type="checkbox"
                                        checked={includeValidEmails}
                                        onChange={(e) => setIncludeValidEmails(e.target.checked)}
                                    />
                                    <span className="settings-field__label" style={{ margin: 0 }}>
                                        Include valid emails
                                        {uploadEmailStatusCounts ? ` (${uploadEmailStatusCounts.valid.toLocaleString()})` : ''}
                                    </span>
                                </label>
                                <label className="settings-field" style={{ flexDirection: 'row', alignItems: 'center', gap: '0.5rem' }}>
                                    <input
                                        type="checkbox"
                                        checked={includeRiskyEmails}
                                        onChange={(e) => setIncludeRiskyEmails(e.target.checked)}
                                    />
                                    <span className="settings-field__label" style={{ margin: 0 }}>
                                        Include risky emails
                                        {uploadEmailStatusCounts ? ` (${uploadEmailStatusCounts.risky.toLocaleString()})` : ''}
                                    </span>
                                </label>
                                {uploadLeadCount !== null && (
                                    <div style={{ marginTop: '0.75rem', fontSize: '0.875rem', color: 'var(--app-text-muted)' }}>
                                        {uploadLeadCount > 0
                                            ? `${uploadLeadCount.toLocaleString()} lead${uploadLeadCount === 1 ? '' : 's'} will be uploaded`
                                            : 'Select at least one email status to upload'}
                                    </div>
                                )}
                            </div>

                            <div style={{ marginBottom: '1.5rem', paddingTop: '0.75rem', borderTop: '1px solid var(--app-border)' }}>
                                <div style={{ fontWeight: 600, marginBottom: '0.5rem', color: 'var(--app-text)' }}>Duplicate handling</div>
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
                            <button
                                type="button"
                                className="primary-button"
                                disabled={
                                    uploading
                                    || !columnMapping.email?.column
                                    || !selectedCampaignId
                                    || (!includeValidEmails && !includeRiskyEmails)
                                    || (uploadLeadCount ?? 0) === 0
                                }
                                onClick={handleConfirmUpload}
                            >
                                {uploading ? 'Uploading...' : 'Upload to Instantly'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Verification CSV Import Modal */}
            {verificationImportModalOpen && (
                <div
                    className="modal-overlay"
                    role="dialog"
                    aria-modal="true"
                    onClick={() => { if (!verificationImportLoading && !verificationImportParsing) setVerificationImportModalOpen(false); }}
                >
                    <div
                        className="modal"
                        onClick={(e) => e.stopPropagation()}
                        style={{ maxWidth: '700px', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}
                    >
                        <div className="modal__header">
                            <div>
                                <h2 className="modal__title">Import Verification CSV</h2>
                                <p className="modal__description">
                                    Upload a CSV from your email verification tool. Matched leads will have their email status and <em>last verified at</em> timestamp updated.
                                </p>
                            </div>
                        </div>

                        <div className="modal__body" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', overflowY: 'auto' }}>
                            {/* Step 1 – File upload */}
                            <div>
                                <label className="settings-field">
                                    <span className="settings-field__label">CSV File {verificationImportStep === 1 ? '*' : ''}</span>
                                    <input
                                        type="file"
                                        accept=".csv,text/csv"
                                        disabled={verificationImportParsing || verificationImportLoading}
                                        onChange={(e) => handleVerificationImportFileChange(e.target.files?.[0] || null)}
                                    />
                                    <span className="settings-field__hint">
                                        The CSV must have a column for the email address and a column for the verification status (e.g. valid, invalid, risky, unknown).
                                    </span>
                                </label>
                                {verificationImportParsing && (
                                    <div style={{ fontSize: '0.85rem', color: 'var(--app-text-muted)', marginTop: '0.5rem' }}>
                                        Parsing CSV…
                                    </div>
                                )}
                                {verificationImportStep === 2 && !verificationImportParsing && (
                                    <div style={{ marginTop: '0.4rem', fontSize: '0.85rem', color: 'var(--app-text-ghost)' }}>
                                        {verificationImportTotalRows.toLocaleString()} data rows detected · {verificationImportHeaders.length} columns
                                    </div>
                                )}
                            </div>

                            {/* Step 2 – Column mapping */}
                            {verificationImportStep === 2 && (
                                <>
                                    <div style={{
                                        padding: '1rem',
                                        border: '1px solid var(--app-border)',
                                        borderRadius: '10px',
                                        background: 'var(--app-surface-3)',
                                        display: 'flex',
                                        flexDirection: 'column',
                                        gap: '1rem'
                                    }}>
                                        <div style={{ fontWeight: 600, color: 'var(--app-text-high)', fontSize: '0.9rem' }}>Column Mapping</div>

                                        <label className="settings-field">
                                            <span className="settings-field__label">Email column *</span>
                                            <select
                                                value={verificationImportEmailCol}
                                                onChange={(e) => setVerificationImportEmailCol(e.target.value)}
                                                disabled={verificationImportLoading}
                                            >
                                                <option value="">— select —</option>
                                                {verificationImportHeaders.map((h) => (
                                                    <option key={h} value={h}>{h}</option>
                                                ))}
                                            </select>
                                            <span className="settings-field__hint">Column that contains the contact&apos;s email address (used to match existing leads).</span>
                                        </label>

                                        <label className="settings-field">
                                            <span className="settings-field__label">Email status column *</span>
                                            <select
                                                value={verificationImportStatusCol}
                                                onChange={(e) => setVerificationImportStatusCol(e.target.value)}
                                                disabled={verificationImportLoading}
                                            >
                                                <option value="">— select —</option>
                                                {verificationImportHeaders.map((h) => (
                                                    <option key={h} value={h}>{h}</option>
                                                ))}
                                            </select>
                                            <span className="settings-field__hint">
                                                Accepted values: <strong>valid</strong>, <strong>invalid</strong>, <strong>risky</strong>, <strong>unknown</strong>.
                                                Common tool values like <em>found / deliverable</em> are mapped automatically.
                                            </span>
                                        </label>

                                        <label className="settings-field">
                                            <span className="settings-field__label">Verified at column (optional)</span>
                                            <select
                                                value={verificationImportVerifiedAtCol}
                                                onChange={(e) => setVerificationImportVerifiedAtCol(e.target.value)}
                                                disabled={verificationImportLoading}
                                            >
                                                <option value="">Use current timestamp (default)</option>
                                                {verificationImportHeaders.map((h) => (
                                                    <option key={h} value={h}>{h}</option>
                                                ))}
                                            </select>
                                            <span className="settings-field__hint">If left blank, <em>last verified at</em> is set to right now for every updated lead.</span>
                                        </label>
                                    </div>

                                    {/* Preview table */}
                                    {verificationImportPreviewRows.length > 0 && verificationImportEmailCol && verificationImportStatusCol && (
                                        <div>
                                            <div style={{ fontSize: '0.78rem', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--app-text-faint)', marginBottom: '0.5rem' }}>
                                                Preview (first {verificationImportPreviewRows.length} rows)
                                            </div>
                                            <div style={{ overflowX: 'auto', borderRadius: '8px', border: '1px solid var(--app-border)' }}>
                                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.83rem' }}>
                                                    <thead>
                                                        <tr style={{ background: 'var(--app-surface-3)' }}>
                                                            <th style={{ padding: '0.5rem 0.75rem', textAlign: 'left', color: 'var(--app-text-faint)', fontWeight: 600, whiteSpace: 'nowrap' }}>Email</th>
                                                            <th style={{ padding: '0.5rem 0.75rem', textAlign: 'left', color: 'var(--app-text-faint)', fontWeight: 600, whiteSpace: 'nowrap' }}>Status</th>
                                                            {verificationImportVerifiedAtCol && (
                                                                <th style={{ padding: '0.5rem 0.75rem', textAlign: 'left', color: 'var(--app-text-faint)', fontWeight: 600, whiteSpace: 'nowrap' }}>Verified At</th>
                                                            )}
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        {verificationImportPreviewRows.map((row, i) => (
                                                            <tr key={i} style={{ borderTop: '1px solid var(--app-border)' }}>
                                                                <td style={{ padding: '0.45rem 0.75rem', color: 'var(--app-text-high)', fontFamily: 'monospace' }}>
                                                                    {row[verificationImportEmailCol] || <em style={{ color: 'var(--app-text-ghost)' }}>—</em>}
                                                                </td>
                                                                <td style={{ padding: '0.45rem 0.75rem', color: 'var(--app-text-high)' }}>
                                                                    {row[verificationImportStatusCol] || <em style={{ color: 'var(--app-text-ghost)' }}>—</em>}
                                                                </td>
                                                                {verificationImportVerifiedAtCol && (
                                                                    <td style={{ padding: '0.45rem 0.75rem', color: 'var(--app-text-muted)', fontFamily: 'monospace', fontSize: '0.8rem' }}>
                                                                        {row[verificationImportVerifiedAtCol] || <em style={{ color: 'var(--app-text-ghost)' }}>—</em>}
                                                                    </td>
                                                                )}
                                                            </tr>
                                                        ))}
                                                    </tbody>
                                                </table>
                                            </div>
                                        </div>
                                    )}

                                    {/* Result summary */}
                                    {verificationImportResult && (
                                        <div style={{
                                            padding: '1rem',
                                            borderRadius: '10px',
                                            border: '1px solid rgba(134,239,172,0.25)',
                                            background: 'rgba(134,239,172,0.05)',
                                            display: 'flex',
                                            flexDirection: 'column',
                                            gap: '0.5rem'
                                        }}>
                                            <div style={{ fontWeight: 600, color: '#86efac' }}>Import Complete</div>
                                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '0.5rem', fontSize: '0.9rem' }}>
                                                <div>Total rows: <strong>{verificationImportResult.totalRows.toLocaleString()}</strong></div>
                                                <div>Matched: <strong>{verificationImportResult.matched.toLocaleString()}</strong></div>
                                                <div>Updated: <strong style={{ color: '#86efac' }}>{verificationImportResult.updated.toLocaleString()}</strong></div>
                                                <div>Not found: <strong style={{ color: verificationImportResult.notFound > 0 ? '#fca5a5' : undefined }}>{verificationImportResult.notFound.toLocaleString()}</strong></div>
                                                <div>Skipped: <strong>{verificationImportResult.skipped.toLocaleString()}</strong></div>
                                            </div>
                                            {verificationImportResult.notFound > 0 && (
                                                <div style={{ fontSize: '0.82rem', color: 'var(--app-text-faint)', marginTop: '0.25rem' }}>
                                                    Emails not found in your leads database are skipped — they are not created.
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </>
                            )}
                        </div>

                        <div className="modal__actions">
                            <button
                                type="button"
                                className="secondary-button secondary-button--active"
                                onClick={() => setVerificationImportModalOpen(false)}
                                disabled={verificationImportLoading || verificationImportParsing}
                            >
                                {verificationImportResult ? 'Close' : 'Cancel'}
                            </button>
                            {verificationImportStep === 2 && (
                                <button
                                    type="button"
                                    className="primary-button"
                                    onClick={handleSubmitVerificationImport}
                                    disabled={
                                        verificationImportLoading ||
                                        verificationImportParsing ||
                                        !verificationImportEmailCol ||
                                        !verificationImportStatusCol
                                    }
                                >
                                    {verificationImportLoading
                                        ? 'Importing…'
                                        : verificationImportResult
                                            ? `Re-run Import (${verificationImportTotalRows.toLocaleString()} rows)`
                                            : `Import ${verificationImportTotalRows.toLocaleString()} rows`}
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Lead export field modal */}
            {leadExportModalOpen && (                <div
                    className="modal-overlay"
                    role="dialog"
                    aria-modal="true"
                    onClick={() => !exportingCsv && setLeadExportModalOpen(false)}
                >
                    <div className="modal" onClick={(event) => event.stopPropagation()} style={{ maxWidth: '760px' }}>
                        <div className="modal__header">
                            <div>
                                <h2 className="modal__title">Export lead CSV</h2>
                                <p className="modal__description">
                                    Choose which fields to include and how many rows to export. Event fields use the latest Instantly event per contact.
                                </p>
                            </div>
                        </div>

                        <div className="modal__body" style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxHeight: '65vh', overflowY: 'auto' }}>
                            <div
                                style={{
                                    border: '1px solid var(--app-border)',
                                    borderRadius: '12px',
                                    background: 'var(--app-surface-3)',
                                    padding: '1rem',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    gap: '0.85rem'
                                }}
                            >
                                <div style={{ fontWeight: 600, color: 'var(--app-text-high)' }}>Row limit</div>
                                <label
                                    style={{
                                        display: 'flex',
                                        gap: '0.6rem',
                                        alignItems: 'flex-start',
                                        cursor: exportingCsv ? 'default' : 'pointer'
                                    }}
                                >
                                    <input
                                        type="radio"
                                        name="lead-export-row-limit"
                                        checked={!leadExportLimitEnabled}
                                        onChange={() => setLeadExportLimitEnabled(false)}
                                        disabled={exportingCsv}
                                        style={{ marginTop: '0.2rem' }}
                                    />
                                    <span style={{ color: 'var(--app-text)', fontSize: '0.94rem' }}>
                                        All matching leads
                                        {displayedLeadTotal !== null ? ` (${displayedLeadTotal.toLocaleString()})` : ''}
                                    </span>
                                </label>
                                <label
                                    style={{
                                        display: 'flex',
                                        gap: '0.6rem',
                                        alignItems: 'flex-start',
                                        cursor: exportingCsv ? 'default' : 'pointer'
                                    }}
                                >
                                    <input
                                        type="radio"
                                        name="lead-export-row-limit"
                                        checked={leadExportLimitEnabled}
                                        onChange={() => setLeadExportLimitEnabled(true)}
                                        disabled={exportingCsv}
                                        style={{ marginTop: '0.2rem' }}
                                    />
                                    <span style={{ color: 'var(--app-text)', fontSize: '0.94rem' }}>
                                        Limit to first N rows (current sort and filters)
                                    </span>
                                </label>
                                {leadExportLimitEnabled && (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', paddingLeft: '1.5rem' }}>
                                        <label className="settings-field" style={{ maxWidth: '200px' }}>
                                            <span className="settings-field__label">Max rows</span>
                                            <input
                                                type="number"
                                                min={1}
                                                max={LEAD_EXPORT_MAX_ROWS_CAP}
                                                value={leadExportMaxRows}
                                                onChange={(event) => {
                                                    const parsed = Number.parseInt(event.target.value, 10);
                                                    setLeadExportMaxRows(Number.isFinite(parsed) && parsed > 0 ? parsed : 1);
                                                }}
                                                disabled={exportingCsv}
                                            />
                                        </label>
                                        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                                            {LEAD_EXPORT_ROW_LIMIT_PRESETS.map((preset) => (
                                                <button
                                                    key={preset}
                                                    type="button"
                                                    className={
                                                        leadExportMaxRows === preset
                                                            ? 'secondary-button secondary-button--active'
                                                            : 'secondary-button'
                                                    }
                                                    onClick={() => setLeadExportMaxRows(preset)}
                                                    disabled={exportingCsv}
                                                >
                                                    {preset.toLocaleString()}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>

                            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                                <button
                                    type="button"
                                    className="secondary-button secondary-button--active"
                                    onClick={() => setSelectedLeadExportFields(LEAD_EXPORT_FIELDS.map((field) => field.key))}
                                    disabled={exportingCsv}
                                >
                                    Select All
                                </button>
                                <button
                                    type="button"
                                    className="secondary-button secondary-button--active"
                                    onClick={() => setSelectedLeadExportFields(DEFAULT_LEAD_EXPORT_FIELD_KEYS)}
                                    disabled={exportingCsv}
                                >
                                    Reset Defaults
                                </button>
                            </div>

                            {Object.entries(leadExportFieldGroups).map(([groupName, fields]) => (
                                <div
                                    key={groupName}
                                    style={{
                                        border: '1px solid var(--app-border)',
                                        borderRadius: '12px',
                                        background: 'var(--app-surface-3)',
                                        padding: '1rem'
                                    }}
                                >
                                    <div style={{ fontWeight: 600, color: 'var(--app-text-high)', marginBottom: '0.75rem' }}>{groupName}</div>
                                    <div style={{ display: 'grid', gap: '0.65rem', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
                                        {fields.map((field) => (
                                            <label
                                                key={field.key}
                                                style={{
                                                    display: 'flex',
                                                    gap: '0.6rem',
                                                    alignItems: 'flex-start',
                                                    padding: '0.75rem 0.85rem',
                                                    borderRadius: '10px',
                                                    border: selectedLeadExportFields.includes(field.key)
                                                        ? '1px solid rgba(59, 130, 246, 0.55)'
                                                        : '1px solid var(--app-border)',
                                                    background: selectedLeadExportFields.includes(field.key)
                                                        ? 'rgba(59, 130, 246, 0.12)'
                                                        : 'var(--app-surface-3)',
                                                    cursor: exportingCsv ? 'default' : 'pointer'
                                                }}
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={selectedLeadExportFields.includes(field.key)}
                                                    onChange={() => toggleLeadExportField(field.key)}
                                                    disabled={exportingCsv}
                                                    style={{ marginTop: '0.2rem' }}
                                                />
                                                <span style={{ color: 'var(--app-text)', fontSize: '0.94rem' }}>{field.label}</span>
                                            </label>
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </div>

                        <div className="modal__actions">
                            <button
                                type="button"
                                className="secondary-button secondary-button--active"
                                onClick={() => setLeadExportModalOpen(false)}
                                disabled={exportingCsv}
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                className="primary-button"
                                onClick={handleExportLeadsCsv}
                                disabled={exportingCsv || selectedLeadExportFields.length === 0}
                            >
                                {exportingCsv
                                    ? 'Exporting...'
                                    : leadExportLimitEnabled
                                        ? `Export CSV (${selectedLeadExportFields.length} fields, up to ${Math.max(1, Math.floor(leadExportMaxRows) || 1).toLocaleString()} rows)`
                                        : `Export CSV (${selectedLeadExportFields.length} fields, all matching)`}
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
                                        border: downloadScope === option.value ? '1px solid rgba(59, 130, 246, 0.6)' : '1px solid var(--app-border)',
                                        background: downloadScope === option.value ? 'rgba(59, 130, 246, 0.12)' : 'var(--app-surface-3)',
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
                                        <div style={{ fontWeight: 600, color: 'var(--app-text-high)' }}>{option.label}</div>
                                        <div style={{ color: 'var(--app-text-muted)', fontSize: '0.9rem', marginTop: '0.25rem' }}>
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
                                <div style={{ fontSize: '0.85rem', color: 'var(--app-text-muted)' }}>
                                    Loading campaign options for manual mapping...
                                </div>
                            )}

                            {instantlyCsvImportResult && (
                                <div style={{
                                    padding: '1rem',
                                    borderRadius: '10px',
                                    border: '1px solid var(--app-border)',
                                    background: 'var(--app-surface-3)',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    gap: '0.85rem'
                                }}>
                                    <div style={{ fontWeight: 600, color: 'var(--app-text-high)' }}>Last Import Result</div>
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
                                            <div style={{ fontSize: '0.85rem', color: 'var(--app-text-muted)', marginBottom: '0.25rem' }}>
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
                                                                color: 'var(--app-text)',
                                                                border: '1px solid var(--app-border-mid)'
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
                                                    <div style={{ fontSize: '0.75rem', color: 'var(--app-text-muted)' }}>
                                                        +{instantlyCsvImportResult.unresolvedCampaignNames.length - 10} more unresolved names
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    )}

                                    {instantlyCsvImportResult.skippedRows.length > 0 && (
                                        <div>
                                            <div style={{ fontSize: '0.85rem', color: 'var(--app-text-muted)', marginBottom: '0.25rem' }}>
                                                Skipped rows (first 12)
                                            </div>
                                            <div style={{ fontSize: '0.82rem', color: 'var(--app-text-high)', lineHeight: 1.45 }}>
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
                                background: 'var(--app-surface-3)',
                                borderRadius: '8px',
                                border: '1px solid var(--app-border)'
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

                        <div className="modal__actions" style={{ flexShrink: 0, borderTop: '1px solid var(--app-border)', paddingTop: '1rem', marginTop: '1rem' }}>
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
                        onClick={() => { setSelectedLead(null); setShowLeadAdvanced(false); setLeadModalTab('detail'); }}
                        style={{ zIndex: 10000 }}
                    />
                    <div
                        className="modal"
                        style={{
                            position: 'fixed',
                            top: 0,
                            right: 0,
                            bottom: 0,
                            width: '680px',
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

                        {/* Header: Name + Domain + Status badge */}
                        <div className="modal__header" style={{ paddingBottom: '0.35rem' }}>
                            <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
                                    {selectedLead.domain && (
                                        <img
                                            src={`https://www.google.com/s2/favicons?domain=${selectedLead.domain}&sz=64`}
                                            alt={`${selectedLead.domain} favicon`}
                                            style={{
                                                width: '32px',
                                                height: '32px',
                                                borderRadius: '6px',
                                                background: 'var(--app-surface-2)',
                                                padding: '4px',
                                                flexShrink: 0
                                            }}
                                            onError={(e) => { e.currentTarget.style.display = 'none'; }}
                                        />
                                    )}
                                    <div style={{ minWidth: 0, flex: '1 1 auto' }}>
                                        <h2 style={{
                                            margin: 0,
                                            fontSize: '1.25rem',
                                            fontWeight: 600,
                                            color: 'var(--app-text-high)',
                                            whiteSpace: 'nowrap',
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis'
                                        }}>
                                            {selectedLead.founderName || selectedLead.domain || '—'}
                                        </h2>
                                        {selectedLead.founderName && selectedLead.domain && (
                                            <span style={{ fontSize: '0.85rem', color: 'var(--app-text-ghost)' }}>
                                                {selectedLead.domain}
                                            </span>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className="modal__body" style={{ paddingTop: 0 }}>
                            {/* Email — above tabs */}
                            {(selectedLead.email || selectedLead.emailFindCompletedAt) && (
                                <div style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.5rem',
                                    flexWrap: 'wrap',
                                    margin: '-0.25rem 0 1rem'
                                }}>
                                    <button
                                        type="button"
                                        title={emailCopied ? 'Copied!' : 'Copy email'}
                                        onClick={() => {
                                            if (!selectedLead.email) return;
                                            navigator.clipboard.writeText(selectedLead.email);
                                            setEmailCopied(true);
                                            setTimeout(() => setEmailCopied(false), 2000);
                                        }}
                                        style={{
                                            background: 'none',
                                            border: 'none',
                                            padding: 0,
                                            cursor: selectedLead.email ? 'pointer' : 'default',
                                            color: emailCopied ? '#4ade80' : 'var(--app-text-ghost)',
                                            display: 'flex',
                                            alignItems: 'center',
                                            flexShrink: 0,
                                            transition: 'color 0.15s ease'
                                        }}
                                    >
                                        {emailCopied ? (
                                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                                <polyline points="20 6 9 17 4 12"/>
                                            </svg>
                                        ) : (
                                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                                                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                                            </svg>
                                        )}
                                    </button>
                                    <span style={{
                                        fontSize: '1.05rem',
                                        fontWeight: 500,
                                        color: selectedLead.email ? 'var(--app-text-high)' : 'var(--app-text-ghost)',
                                        wordBreak: 'break-all'
                                    }}>
                                        {selectedLead.email || 'No email found'}
                                    </span>
                                    {(() => {
                                        const v = getEmailVerifyDisplay(selectedLead.email, selectedLead.status, selectedLead.emailVerifyCompletedAt, selectedLead.emailFindCompletedAt);
                                        return (
                                            <span className={`lead-pastel-chip lead-pastel-chip--status-${v.variant}`} style={{ fontSize: '0.7rem', padding: '0.1rem 0.45rem', flexShrink: 0 }}>
                                                {v.label}
                                            </span>
                                        );
                                    })()}
                                </div>
                            )}

                            <div className="tab-nav" style={{ marginTop: 0, marginBottom: '1rem' }}>
                                {([
                                    { key: 'detail', label: 'Detail' },
                                    { key: 'insights', label: 'Insights' }
                                ] as const).map((tab) => {
                                    return (
                                        <button
                                            key={tab.key}
                                            onClick={() => setLeadModalTab(tab.key)}
                                            className={`tab-nav__button ${leadModalTab === tab.key ? 'tab-nav__button--active' : ''}`}
                                        >
                                            {tab.label}
                                        </button>
                                    );
                                })}
                            </div>

                            {leadModalTab === 'detail' ? (
                                <>

                            {/* Lead Info — compressed metadata block */}
                            <div style={{ marginBottom: '1.25rem' }}>
                                <p style={{
                                    margin: '0 0 0.6rem',
                                    fontSize: '0.75rem',
                                    fontWeight: 600,
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.06em',
                                    color: 'var(--app-text-ghost)'
                                }}>Lead Info</p>
                                <div style={{
                                    display: 'grid',
                                    gridTemplateColumns: 'auto 1fr',
                                    gap: '0.35rem 0.75rem',
                                    fontSize: '0.9rem',
                                    lineHeight: 1.6
                                }}>
                                    {selectedLead.founderName && (
                                        <>
                                            <span style={{ color: 'var(--app-text-faint)' }}>Founder</span>
                                            <span style={{ color: 'var(--app-text-high)' }}>{selectedLead.founderName}</span>
                                        </>
                                    )}
                                    {selectedLead.createdAt && (
                                        <>
                                            <span style={{ color: 'var(--app-text-faint)' }}>Created</span>
                                            <span style={{ color: 'var(--app-text-muted)' }}>
                                                {new Date(selectedLead.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                                            </span>
                                        </>
                                    )}
                                    {selectedLead.campaigns && selectedLead.campaigns.length > 0 && (
                                        <>
                                            <span style={{ color: 'var(--app-text-faint)' }}>Source</span>
                                            <span style={{ color: 'var(--app-text-muted)' }}>
                                                {getCampaignNamesForLead(selectedLead)[0] || 'Pipeline'}
                                            </span>
                                        </>
                                    )}
                                </div>
                            </div>


                            {/* First Line */}
                            {selectedLead.firstLine && (
                                <div style={{ marginBottom: '1.25rem' }}>
                                    <p style={{
                                        margin: '0 0 0.4rem',
                                        fontSize: '0.75rem',
                                        fontWeight: 600,
                                        textTransform: 'uppercase',
                                        letterSpacing: '0.06em',
                                        color: 'var(--app-text-ghost)'
                                    }}>First Line</p>
                                    <p style={{
                                        margin: 0,
                                        fontSize: '0.9rem',
                                        color: 'var(--app-text)',
                                        lineHeight: 1.6,
                                        fontStyle: 'italic'
                                    }}>{selectedLead.firstLine}</p>
                                </div>
                            )}

                            {/* Campaign Outcomes — signal, not logs */}
                            {selectedLead.campaignsData && selectedLead.campaignsData.length > 0 && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginBottom: '1.25rem' }}>
                                    {selectedLead.campaignsData.map((campaign, idx) => {
                                        const interest = (campaign.interestStatus || '').toLowerCase().replace(/[_ ]+/g, ' ').trim();
                                        const leadStatus = (campaign.leadStatus || '').toLowerCase().replace(/[_ ]+/g, ' ').trim();
                                        const raw = interest || leadStatus;

                                        const negativeStatuses = ['bounced', 'bad fit', 'risky'];
                                        const neutralStatuses = ['contacted', 'not yet contacted', 'out of office', 'reply received'];
                                        const positiveStatuses = ['meeting booked', 'won', 'interested', 'warm follow up', 'lead interested'];
                                        const isDayN = /^day \d+$/i.test(raw);

                                        const isNegative = negativeStatuses.includes(raw);
                                        const isPositive = positiveStatuses.includes(raw) || isDayN;
                                        const isNeutral = neutralStatuses.includes(raw) || (!raw || raw === '—');

                                        const icon = isPositive ? '✅' : isNegative ? '❌' : '📨';
                                        const statusText = campaign.interestStatus
                                            ? formatInstantlyStateLabel(campaign.interestStatus)
                                            : formatInstantlyStateLabel(campaign.leadStatus) || 'Not yet contacted';

                                        const rowBg = isPositive
                                            ? 'rgba(34, 197, 94, 0.08)'
                                            : isNegative
                                                ? 'rgba(239, 68, 68, 0.08)'
                                                : 'var(--app-surface-3)';
                                        const rowBorder = isPositive
                                            ? 'rgba(34, 197, 94, 0.2)'
                                            : isNegative
                                                ? 'rgba(239, 68, 68, 0.2)'
                                                : 'var(--app-border)';
                                        const statusColor = isPositive
                                            ? '#4ade80'
                                            : isNegative
                                                ? '#f87171'
                                                : 'var(--app-text-ghost)';

                                        const bounceDate = campaign.lastBounceAt ? new Date(campaign.lastBounceAt) : null;
                                        const bounceDateStr = bounceDate
                                            ? bounceDate.toLocaleDateString('en-GB', {
                                                day: 'numeric',
                                                month: 'short',
                                                ...(bounceDate.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {})
                                            })
                                            : null;

                                        return (
                                            <div key={idx} style={{
                                                display: 'flex',
                                                flexDirection: 'column',
                                                gap: '0.2rem',
                                                padding: '0.5rem 0.65rem',
                                                background: rowBg,
                                                borderRadius: '8px',
                                                border: `1px solid ${rowBorder}`,
                                            }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                                    <span style={{ fontSize: '1rem', flexShrink: 0 }}>{icon}</span>
                                                    <span style={{
                                                        fontSize: '0.88rem',
                                                        color: 'var(--app-text-high)',
                                                        flex: '1 1 auto',
                                                        minWidth: 0,
                                                        overflow: 'hidden',
                                                        textOverflow: 'ellipsis',
                                                        whiteSpace: 'nowrap'
                                                    }}>
                                                        {campaign.campaignName}
                                                    </span>
                                                    <span style={{
                                                        fontSize: '0.8rem',
                                                        fontWeight: 600,
                                                        color: statusColor,
                                                        flexShrink: 0,
                                                        textTransform: 'capitalize'
                                                    }}>
                                                        {statusText}
                                                    </span>
                                                </div>
                                                {bounceDateStr && (
                                                    <span style={{
                                                        fontSize: '0.72rem',
                                                        color: 'var(--app-text-ghost)',
                                                        paddingLeft: '1.6rem'
                                                    }}>
                                                        {bounceDateStr}
                                                    </span>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}

                            {/* Events Timeline */}
                            <div style={{ borderTop: '1px solid var(--app-border)', paddingTop: '0.75rem', marginBottom: '0.75rem' }}>
                                <p style={{
                                    margin: '0 0 0.6rem',
                                    fontSize: '0.75rem',
                                    fontWeight: 600,
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.06em',
                                    color: 'var(--app-text-ghost)'
                                }}>Activity</p>
                {(() => {
                                        // Build synthetic status-change events from campaignsData
                                        type TimelineItem = {
                                            id: string;
                                            event_type: string;
                                            displayLabel: string;
                                            event_timestamp: string;
                                            campaign_name: string | null;
                                            lead_email?: string | null;
                                            message_text: string | null;
                                            reply_text_snippet: string | null;
                                            reply_category: string | null;
                                            synthetic?: boolean;
                                        };

                                        const syntheticEvents: TimelineItem[] = [];

                                        // Email find event
                                        if (selectedLead.emailFindCompletedAt) {
                                            syntheticEvents.push({
                                                id: 'syn-email-find',
                                                event_type: selectedLead.email ? 'email_found' : 'email_not_found',
                                                displayLabel: selectedLead.email ? 'Email discovered' : 'Email not found',
                                                event_timestamp: selectedLead.emailFindCompletedAt,
                                                campaign_name: null,
                                                lead_email: selectedLead.email || null,
                                                message_text: null,
                                                reply_text_snippet: null,
                                                reply_category: null,
                                                synthetic: true,
                                            });
                                        }

                                        // Email verify event
                                        if (selectedLead.emailVerifyCompletedAt) {
                                            const verifyDisplay = getEmailVerifyDisplay(
                                                selectedLead.email,
                                                selectedLead.status,
                                                selectedLead.emailVerifyCompletedAt,
                                                selectedLead.emailFindCompletedAt
                                            );
                                            syntheticEvents.push({
                                                id: 'syn-email-verify',
                                                event_type: 'email_verified',
                                                displayLabel: `Email verified — ${verifyDisplay.label}`,
                                                event_timestamp: selectedLead.emailVerifyCompletedAt,
                                                campaign_name: null,
                                                lead_email: selectedLead.email || null,
                                                message_text: null,
                                                reply_text_snippet: null,
                                                reply_category: null,
                                                synthetic: true,
                                            });
                                        }

                                        for (const campaign of (selectedLead.campaignsData || [])) {
                                            const leadStatusNorm = (campaign.leadStatus || '').toLowerCase().replace(/[_ ]+/g, ' ').trim();
                                            const interestNorm = (campaign.interestStatus || '').toLowerCase().replace(/[_ ]+/g, ' ').trim();

                                            if (leadStatusNorm === 'bounced' && campaign.lastBounceAt) {
                                                syntheticEvents.push({
                                                    id: `syn-bounce-${campaign.campaignId}`,
                                                    event_type: 'email_bounced',
                                                    displayLabel: 'Bounced email',
                                                    event_timestamp: campaign.lastBounceAt,
                                                    campaign_name: campaign.campaignName,
                                                    lead_email: selectedLead.email || null,
                                                    message_text: null,
                                                    reply_text_snippet: null,
                                                    reply_category: null,
                                                    synthetic: true,
                                                });
                                            } else if (interestNorm && campaign.timestampLastInterestChange) {
                                                syntheticEvents.push({
                                                    id: `syn-interest-${campaign.campaignId}`,
                                                    event_type: `interest_change`,
                                                    displayLabel: campaign.interestStatus || interestNorm,
                                                    event_timestamp: campaign.timestampLastInterestChange,
                                                    campaign_name: campaign.campaignName,
                                                    lead_email: selectedLead.email || null,
                                                    message_text: null,
                                                    reply_text_snippet: null,
                                                    reply_category: null,
                                                    synthetic: true,
                                                });
                                            }
                                        }

                                        const realEvents: TimelineItem[] = leadEvents.map((evt) => ({
                                            id: String(evt.id),
                                            event_type: evt.event_type || 'unknown',
                                            displayLabel: evt.event_type === 'email_sent' && evt.step != null
                                                ? `email ${evt.step} sent`
                                                : (evt.event_type || 'unknown').replace(/_/g, ' '),
                                            event_timestamp: evt.event_timestamp,
                                            campaign_name: evt.campaign_name || null,
                                            lead_email: evt.lead_email || selectedLead.email || null,
                                            message_text: evt.message_text || null,
                                            reply_text_snippet: evt.reply_text_snippet || null,
                                            reply_category: evt.reply_category || null,
                                        }));

                                        const allEvents = buildCollatedActivityEvents([...realEvents, ...syntheticEvents]);

                                        if (leadEventsLoading) return (
                                            <p style={{ fontSize: '0.85rem', color: 'var(--app-text-ghost)', margin: 0 }}>Loading…</p>
                                        );
                                        if (!allEvents.length) return (
                                            <p style={{ fontSize: '0.85rem', color: 'var(--app-text-ghost)', margin: 0 }}>No events yet</p>
                                        );

                                        return (
                                            <div style={{ position: 'relative', paddingLeft: '1rem' }}>
                                                {/* Vertical line */}
                                                <div style={{
                                                    position: 'absolute',
                                                    left: '3px',
                                                    top: '6px',
                                                    bottom: '6px',
                                                    width: '1px',
                                                    background: 'var(--app-surface-2)'
                                                }} />
                                                {allEvents.map((evt) => {
                                                    const labelNorm = evt.displayLabel.toLowerCase().replace(/[_ ]+/g, ' ').trim();
                                                    const isDayN = /^day \d+$/.test(labelNorm);
                                                    const dotColor = evt.event_type === 'added_to_campaign'
                                                        ? '#f59e0b'
                                                        : evt.event_type === 'email_found'
                                                            ? '#22c55e'
                                                            : evt.event_type === 'email_not_found'
                                                                ? 'var(--app-text-ghost)'
                                                                : evt.event_type === 'email_verified'
                                                                    ? '#3b82f6'
                                                                    : isDayN
                                                                        ? '#22c55e'
                                                                        : getInstantlyActivityColor(evt.event_type, evt.displayLabel);

                                                    const evtDate = new Date(evt.event_timestamp);
                                                    const now = new Date();
                                                    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
                                                    const isWithinLastSevenDays = (now.getTime() - evtDate.getTime()) <= sevenDaysMs;
                                                    const isCurrentYear = evtDate.getFullYear() === now.getFullYear();
                                                    const dateStr = isCurrentYear
                                                        ? evtDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
                                                        : evtDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
                                                    const timeStr = evtDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
                                                    const dateTimeStr = isWithinLastSevenDays ? `${dateStr}, ${timeStr}` : dateStr;

                                                    return (
                                                        <div key={evt.id} style={{
                                                            position: 'relative',
                                                            padding: '0.5rem 0.6rem',
                                                            marginBottom: '0.5rem',
                                                            background: 'var(--app-surface-3)',
                                                            border: '1px solid var(--app-border)',
                                                            borderRadius: '10px',
                                                        }}>
                                                            {/* Dot */}
                                                            <div style={{
                                                                position: 'absolute',
                                                                left: '-1rem',
                                                                top: '5px',
                                                                width: '7px',
                                                                height: '7px',
                                                                borderRadius: '50%',
                                                                background: dotColor
                                                            }} />
                                                            <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.4rem', flexWrap: 'wrap' }}>
                                                                <span style={{
                                                                    fontSize: '0.82rem',
                                                                    fontWeight: 500,
                                                                    color: 'var(--app-text-high)',
                                                                    textTransform: 'capitalize'
                                                                }}>{evt.displayLabel}</span>
                                                                <span style={{ fontSize: '0.75rem', color: 'var(--app-text-ghost)' }}>
                                                                    {dateTimeStr}
                                                                </span>
                                                            </div>
                                                            {evt.secondaryLabel && (
                                                                <p style={{ margin: '0.18rem 0 0', fontSize: '0.72rem', color: 'rgba(191, 219, 254, 0.72)' }}>
                                                                    Includes {evt.secondaryLabel.toLowerCase()}
                                                                </p>
                                                            )}
                                                            {evt.campaign_name && (
                                                                <span style={{
                                                                    display: 'inline-flex',
                                                                    alignItems: 'center',
                                                                    gap: '0.3rem',
                                                                    marginTop: '0.25rem',
                                                                    padding: '0.15rem 0.5rem',
                                                                    borderRadius: '999px',
                                                                    background: 'var(--app-surface-3)',
                                                                    border: '1px solid var(--app-border)',
                                                                    fontSize: '0.72rem',
                                                                    color: 'var(--app-text-faint)',
                                                                    lineHeight: 1.4
                                                                }}>
                                                                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.7 }}>
                                                                        <line x1="22" y1="2" x2="11" y2="13" />
                                                                        <polygon points="22 2 15 22 11 13 2 9 22 2" />
                                                                    </svg>
                                                                    {evt.campaign_name}
                                                                </span>
                                                            )}
                                                            {(() => {
                                                                const snippet = evt.reply_text_snippet
                                                                    || (evt.event_type === 'added_to_campaign' ? evt.message_text : null)
                                                                    || (evt.message_text ? evt.message_text.split('\n').find(l => l.trim()) || null : null);
                                                                const fullContent = evt.message_text || snippet;
                                                                return snippet ? (
                                                                    <p
                                                                        style={{ margin: '0.15rem 0 0', fontSize: '0.78rem', color: 'var(--app-text-faint)', cursor: 'default' }}
                                                                        onMouseEnter={(e) => {
                                                                            if (fullContent) setActivityReplyPopup({ html: fullContent, isHtml: Boolean(evt.message_text && evt.message_text.includes('<')), x: e.clientX, y: e.clientY });
                                                                        }}
                                                                        onMouseMove={(e) => {
                                                                            setActivityReplyPopup(prev => prev ? { ...prev, x: e.clientX, y: e.clientY } : null);
                                                                        }}
                                                                        onMouseLeave={() => setActivityReplyPopup(null)}
                                                                    >
                                                                        {snippet.length > 160 ? snippet.slice(0, 160) + '…' : snippet}
                                                                    </p>
                                                                ) : null;
                                                            })()}
                                                            {evt.reply_category && (
                                                                <span style={{
                                                                    display: 'inline-block',
                                                                    marginTop: '0.2rem',
                                                                    padding: '0.1rem 0.4rem',
                                                                    borderRadius: '4px',
                                                                    fontSize: '0.72rem',
                                                                    fontWeight: 500,
                                                                    background: evt.reply_category === 'Interested' ? 'rgba(34, 197, 94, 0.15)' : 'var(--app-surface-3)',
                                                                    color: evt.reply_category === 'Interested' ? '#4ade80' : 'var(--app-text-ghost)'
                                                                }}>{evt.reply_category}</span>
                                                            )}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        );
                                    })()}
                            </div>

                            {/* Advanced / IDs — collapsed by default */}
                            <div style={{ borderTop: '1px solid var(--app-border)', paddingTop: '0.75rem' }}>
                                <button
                                    onClick={() => setShowLeadAdvanced(!showLeadAdvanced)}
                                    style={{
                                        background: 'none',
                                        border: 'none',
                                        cursor: 'pointer',
                                        color: 'var(--app-text-ghost)',
                                        fontSize: '0.8rem',
                                        padding: 0,
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '0.3rem'
                                    }}
                                >
                                    <span style={{
                                        display: 'inline-block',
                                        transition: 'transform 0.15s',
                                        transform: showLeadAdvanced ? 'rotate(90deg)' : 'rotate(0deg)',
                                        fontSize: '0.75rem'
                                    }}>▶</span>
                                    Advanced
                                </button>
                                {showLeadAdvanced && (
                                    <div style={{
                                        display: 'grid',
                                        gridTemplateColumns: 'auto 1fr',
                                        gap: '0.25rem 0.75rem',
                                        fontSize: '0.85rem',
                                        lineHeight: 1.5,
                                        marginTop: '0.5rem',
                                        color: 'var(--app-text-ghost)'
                                    }}>
                                        <span>Domain ID</span>
                                        <span style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{selectedLead.id}</span>
                                        <span>Job ID</span>
                                        <span style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{selectedLead.jobId || '—'}</span>
                                        {selectedLead.updatedAt && (
                                            <>
                                                <span>Updated</span>
                                                <span>{new Date(selectedLead.updatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                                            </>
                                        )}
                                    </div>
                                )}
                            </div>

                                </>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
                                    <p style={{
                                        margin: 0,
                                        fontSize: '0.75rem',
                                        fontWeight: 600,
                                        textTransform: 'uppercase',
                                        letterSpacing: '0.06em',
                                        color: 'var(--app-text-ghost)'
                                    }}>
                                        Lead Insights
                                    </p>

                                    {(() => {
                                        const insights = selectedLead.insights;
                                        const parsedAttributes = (() => {
                                            const rawAttributes = insights?.attributes;
                                            if (!rawAttributes) return {} as Record<string, unknown>;
                                            if (typeof rawAttributes === 'string') {
                                                try {
                                                    const parsed = JSON.parse(rawAttributes);
                                                    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                                                        ? parsed as Record<string, unknown>
                                                        : {};
                                                } catch {
                                                    return {};
                                                }
                                            }
                                            return (rawAttributes && typeof rawAttributes === 'object' && !Array.isArray(rawAttributes))
                                                ? rawAttributes as Record<string, unknown>
                                                : {};
                                        })();

                                        const normalizeAttributeValue = (value: unknown): unknown => {
                                            if (typeof value !== 'string') return value;
                                            const trimmed = value.trim();
                                            if (!trimmed) return null;
                                            if (!((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']')))) {
                                                return value;
                                            }
                                            try {
                                                return JSON.parse(trimmed);
                                            } catch {
                                                return value;
                                            }
                                        };

                                        const attributeEntries = Object.entries(parsedAttributes)
                                            .map(([key, value]) => [key, normalizeAttributeValue(value)] as const)
                                            .filter(([key, value]) => {
                                                if (key.toLowerCase().includes('instantly')) return false;
                                                if (value === null || value === undefined) return false;
                                                return String(value).trim() !== '';
                                            });

                                        const insightRows: Array<{ label: string; value: string | null }> = [
                                            {
                                                label: 'Annual Revenue',
                                                value: insights?.annualRevenueText
                                                    || ((insights?.annualRevenueMin != null || insights?.annualRevenueMax != null)
                                                        ? `${insights?.annualRevenueMin ?? '—'} to ${insights?.annualRevenueMax ?? '—'}`
                                                        : null)
                                            },
                                            {
                                                label: 'Uses Klaviyo',
                                                value: insights?.usesKlaviyo == null ? null : (insights.usesKlaviyo ? 'Yes' : 'No')
                                            },
                                            {
                                                label: 'Klaviyo Percent',
                                                value: insights?.klaviyoPercent == null ? null : `${insights.klaviyoPercent}%`
                                            },
                                            {
                                                label: 'Discovery Call Held',
                                                value: insights?.discoveryCallHeld == null ? null : (insights.discoveryCallHeld ? 'Yes' : 'No')
                                            },
                                            {
                                                label: 'Last Discovery Call',
                                                value: insights?.lastDiscoveryCallAt
                                                    ? new Date(insights.lastDiscoveryCallAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
                                                    : null
                                            },
                                            {
                                                label: 'Source',
                                                value: insights?.source || null
                                            },
                                            {
                                                label: 'Notes',
                                                value: insights?.notes || null
                                            }
                                        ];

                                        const populatedRows = insightRows.filter((row) => row.value !== null && row.value !== '');
                                        if (!populatedRows.length && !attributeEntries.length) {
                                            return (
                                                <p style={{ margin: 0, fontSize: '0.86rem', color: 'var(--app-text-faint)' }}>
                                                    No insights available for this lead yet.
                                                </p>
                                            );
                                        }

                                        return (
                                            <>
                                                {populatedRows.length > 0 && (
                                                    <div style={{
                                                        display: 'grid',
                                                        gridTemplateColumns: '200px 1fr',
                                                        gap: '0.45rem 0.8rem',
                                                        fontSize: '0.9rem',
                                                        lineHeight: 1.5
                                                    }}>
                                                        {populatedRows.map((row) => (
                                                            <div key={row.label} style={{ display: 'contents' }}>
                                                                <span style={{ color: 'var(--app-text-faint)' }}>{row.label}</span>
                                                                <span style={{ color: 'var(--app-text-high)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{row.value}</span>
                                                            </div>
                                                        ))}
                                                    </div>
                                                )}

                                                {attributeEntries.length > 0 && (
                                                    <div style={{ borderTop: '1px solid var(--app-border)', paddingTop: '0.8rem' }}>
                                                        <p style={{
                                                            margin: '0 0 0.5rem',
                                                            fontSize: '0.75rem',
                                                            fontWeight: 600,
                                                            textTransform: 'uppercase',
                                                            letterSpacing: '0.06em',
                                                            color: 'var(--app-text-ghost)'
                                                        }}>
                                                            Attributes
                                                        </p>
                                                        <div style={{
                                                            display: 'grid',
                                                            gridTemplateColumns: '200px 1fr',
                                                            gap: '0.45rem 0.8rem',
                                                            fontSize: '0.9rem',
                                                            lineHeight: 1.5
                                                        }}>
                                                            {attributeEntries.map(([key, value]) => (
                                                                <div key={key} style={{ display: 'contents' }}>
                                                                    <span style={{ color: 'var(--app-text-faint)' }}>{key}</span>
                                                                    <span style={{ color: 'var(--app-text-high)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{typeof value === 'string' ? value : JSON.stringify(value)}</span>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    </div>
                                                )}
                                            </>
                                        );
                                    })()}
                                </div>
                            )}

                        </div>
                    </div>
                </>
            )}

            {/* Activity Reply Hover Popup */}
            {activityReplyPopup && (
                <div
                    style={{
                        position: 'fixed',
                        zIndex: 99999,
                        left: activityReplyPopup.x + 16,
                        top: activityReplyPopup.y + 16,
                        width: '360px',
                        maxHeight: '420px',
                        overflowY: 'auto',
                        background: 'rgb(14, 14, 24)',
                        border: '1px solid var(--app-border-mid)',
                        borderRadius: '10px',
                        padding: '0.75rem',
                        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.8)',
                        fontSize: '0.8rem',
                        color: 'var(--app-text-high)',
                        lineHeight: '1.55',
                        wordBreak: 'break-word',
                        pointerEvents: 'none',
                    }}
                >
                    {activityReplyPopup.isHtml
                        ? <div dangerouslySetInnerHTML={{ __html: activityReplyPopup.html }} />
                        : <span style={{ whiteSpace: 'pre-wrap' }}>{activityReplyPopup.html}</span>
                    }
                </div>
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

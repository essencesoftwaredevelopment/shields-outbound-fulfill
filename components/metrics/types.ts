export type MetricsScript = {
    instantlyCampaignId: string;
    name: string;
    active: boolean;
    daysLive: number | null;
    emailsSent: number;
    newContacts: number;
    bounces: number;
    positives: number;
    positiveRate: number | null;
    runwayDays: number | null;
    runsDryOn: string | null;
};

export type CostBreakdownLine = {
    id: number | "enrichment";
    label: string;
    category: string;
    amount: number;
    monthlyAmount?: number;
    automatic?: boolean;
};

export type SalesListKey = "callsBooked" | "showRate" | "qualified" | "proposals" | "closes";

export type SalesListEntry = {
    salesCallId: number | string | null;
    name: string | null;
    company: string | null;
    email: string | null;
    date: string | null;
    detail: string;
};

export type MetricsPayload = {
    period: { key: string; label: string; start: string; end: string; days: number; workingDays: number };
    periods: { key: string; label: string }[];
    sending: {
        emailsSent: number;
        newContacts: number;
        bounces: number;
        workingDays: number;
        newContactsPerWorkingDay: number | null;
        bounceRate: number | null;
        capacityPerDay: number | null;
        maxPossibleSends: number | null;
        capacityUsed: number | null;
        leadsQueued: number | null;
        plannedNewContactsPerDay: number | null;
        leadBufferDays: number | null;
        reserveVerified: number | null;
    } | null;
    replies: {
        positives: number | null;
        newContacts: number | null;
        positiveRate: number | null;
        unattributedPositives: number;
        scripts: MetricsScript[];
    };
    sales: {
        callsBooked: number;
        callsCanceled: number;
        bookingRate: number | null;
        callsDue: number;
        callsHeld: number;
        noShows: number;
        callsAssumedHeld: number;
        showRate: number | null;
        qualified: number;
        qualifiedRate: number | null;
        proposalsSent: number;
        proposalRate: number | null;
        dealsWon: number;
        dealsLost: number;
        closeRate: number | null;
        overallCloseRate: number | null;
        avgDaysToClose: number | null;
        stalledDeals: { id: number; name: string | null; daysQuiet: number }[];
        lostReasons: Record<string, number>;
        lists: Record<SalesListKey, SalesListEntry[]>;
    };
    money: {
        newRevenue: number;
        buildRevenue: number;
        retainerRevenue: number;
        avgDealValue: number | null;
        outreachCost: number;
        costPerBookedCall: number | null;
        costPerClient: number | null;
        paybackMonths: number | null;
        activeRetainers: number;
        mrr: number;
        churnedInPeriod: number;
        activeAtPeriodStart: number;
        monthlyChurn: number | null;
        avgTenureMonths: number | null;
        avgRetainer: number | null;
        lifetimeValue: number | null;
        costBreakdown: CostBreakdownLine[];
    };
    warnings: string[];
    computedAt: string;
};

export type CallStatus = "booked" | "held" | "no_show" | "canceled";
export type Outcome = "open" | "won" | "lost";

export type SalesCall = {
    id: number;
    contact_id: number | null;
    calendly_booking_id: string | null;
    company: string | null;
    contact_name: string | null;
    contact_email: string | null;
    booked_at: string | null;
    call_at: string | null;
    call_status: CallStatus;
    qualified: boolean | null;
    proposal_sent_on: string | null;
    outcome: Outcome;
    closed_on: string | null;
    lost_reason: string | null;
    build_value: number | null;
    retainer_monthly: number | null;
    retainer_start: string | null;
    retainer_end: string | null;
    last_contact_on: string | null;
    next_follow_up_on: string | null;
    notes: string | null;
    /** Fields the call analysis (Fathom recordings) filled and nobody has edited since. */
    ai_filled_fields: string[];
    ai_summary: string | null;
    ai_updated_at: string | null;
    recording_url: string | null;
};

export type OutreachCost = {
    id: number;
    label: string;
    category: string;
    monthly_amount: number;
    starts_on: string;
    ends_on: string | null;
};

export const CALL_STATUS_LABEL: Record<CallStatus, string> = {
    booked: "Booked",
    held: "Held",
    no_show: "No-show",
    canceled: "Canceled"
};

export const OUTCOME_LABEL: Record<Outcome, string> = {
    open: "Open",
    won: "Won",
    lost: "Lost"
};

export const LOST_REASON_LABEL: Record<string, string> = {
    price: "Price",
    timing: "Timing",
    competitor: "Went with someone else",
    no_budget: "No budget",
    ghosted: "Ghosted",
    not_a_fit: "Not a fit",
    unspecified: "No reason given"
};

export const COST_CATEGORY_LABEL: Record<string, string> = {
    inboxes: "Inboxes",
    domains: "Domains",
    tools: "Tools",
    leads: "Leads",
    other: "Other"
};

export type StageKind = "open" | "won" | "lost";
export type StageColor = "violet" | "sky" | "teal" | "green" | "red" | "amber" | "slate";

export const STAGE_COLORS: StageColor[] = ["violet", "sky", "teal", "green", "red", "amber", "slate"];

export interface DealStage {
    id: number;
    key: string;
    name: string;
    position: number;
    kind: StageKind;
    color: StageColor;
    isEntry: boolean;
    instantlyInterestValue: number | null;
    totalCount?: number;
}

export interface Deal {
    id: number;
    stageId: number;
    position: number;
    notes: string;
    nextActionAt: string | null;
    stageChangedAt: string;
    closedAt: string | null;
    source: "reconcile" | "manual";
    createdAt: string;
    contact: { id: number; fullName: string; email: string; roleType: string };
    company: { id: number | null; domain: string };
    campaign: { id: number; instantlyCampaignId: string; name: string } | null;
    instantly: {
        interestStatus: number | null;
        interestStatusLabel: string | null;
        lastEventType: string | null;
        timestampLastReply: string | null;
        replySnippet: string | null;
    };
    draft: { id: number; status: string; reviewToken: string | null } | null;
}

export interface BoardResponse {
    stages: DealStage[];
    deals: Deal[];
    pageSize: number;
    reconciled: number;
}

export interface StagePageResponse {
    deals: Deal[];
    /** Rows older than the request cursor, this page included. */
    remaining: number;
    pageSize: number;
}

export interface DealPatch {
    stageId?: number;
    position?: number;
    notes?: string | null;
    nextActionAt?: string | null;
}

/** Editable copy of a stage used by the settings dialog. `id` is null for new stages. */
export interface StageDraft {
    id: number | null;
    localKey: string;
    name: string;
    kind: StageKind;
    color: StageColor;
    isEntry: boolean;
    totalCount: number;
}

export interface StageDeletion {
    id: number;
    moveDealsTo: number;
}

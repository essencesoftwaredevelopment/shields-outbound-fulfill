# Deal Flow tab — implementation plan (2026-08-30)

A kanban board in the client view for working interested leads through
Interested → Follow Up → Meeting Booked → Won / Lost, with custom stages.
Built as an additive layer: new tables, a new Express router, a new
component folder, one feature flag. Nothing in the existing pipeline,
Instantly sync, autoresponder or leads code changes behaviour.

## 1. Where it plugs in (what exists today)

- Client view is one file: `app/clients/[clientId]/page.tsx` (14.8k lines).
  Tabs are `allowedTabs` (L1545) + button nav (L8449-8481) + `{activeTab === X && ...}`
  blocks. `?tab=` is read once at mount (L1547).
- The only "stage" that exists is `contact_instantly_campaigns.interest_status`
  (1 interested, 2 meeting_booked, 3 meeting_completed, 4 won, 0 ooo, -1 not
  interested, -2 wrong person, -3 lost, -4 no show) — written by the Instantly
  webhook/sync (`server/src/services/instantlyState.js`) and by the manual
  `POST /api/leads/:contactId/instantly-interest-status` (`leads.js:3295`),
  which also pushes to Instantly's `update-interest-status`.
- No `deals`/`stages` tables. No DnD library. Feature flags live in
  `agency_settings.features` and are read client-side only at page.tsx L2733-2775
  (type narrowed to `{ shoppingAudit?: boolean }`).
- Realtime: page already subscribes to `contact_instantly_events` changes for
  the client (L4909-5112).

## 2. Design decisions

1. **Own state, not derived state.** Deals and stages get their own tables.
   Instantly's `interest_status` remains untouched and is shown on the card as
   a badge. This is the only way to support custom stages, per-column
   ordering, and "Follow Up" (which has no Instantly equivalent) without
   rewriting the interest-status semantics that analytics, follow-ups and the
   autoresponder depend on.
2. **Reconcile on read, never on write.** `GET …/deal-flow` first runs an
   idempotent `INSERT … SELECT … ON CONFLICT DO NOTHING` that creates a deal
   for every `contact_instantly_campaigns` row with `interest_status >= 1`
   that has none yet. New interested replies therefore appear on the board
   without touching `instantlyState.js` or the webhook. Reconcile only
   *creates* deals; it never moves one — the user's manual stage always wins.
3. **Instantly sync is opt-in per stage, and off by default.** Each stage has
   a nullable `instantly_interest_value`. Phase 1 ships with it null on all
   stages (pure CRM board, zero coupling). Phase 5 lets a stage be marked
   "also set Instantly status", reusing the logic already in
   `leads.js:3295` (extracted into a service; the existing route delegates).
4. **New code lives outside page.tsx.** The page gets ~15 lines: a tab entry,
   a button, one render line, one `onOpenLead` callback. The board itself is
   `components/deal-flow/*`.
5. **Feature-flagged.** `features.dealFlow === true` shows the tab. Every
   existing client is unaffected until the flag is set.

## 3. Data model — `server/migrations/0053_deal_flow.sql`

```sql
CREATE TABLE IF NOT EXISTS deal_stages (
    id              BIGSERIAL PRIMARY KEY,
    agency_id       TEXT NOT NULL,
    client_id       BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    key             TEXT NOT NULL,                 -- 'interested', 'follow_up', 'meeting_booked', 'won', 'lost', custom slug
    name            TEXT NOT NULL,
    position        INTEGER NOT NULL,
    kind            TEXT NOT NULL DEFAULT 'open'   -- open | won | lost
                    CHECK (kind IN ('open','won','lost')),
    color           TEXT,                          -- token name, e.g. 'violet'
    is_entry        BOOLEAN NOT NULL DEFAULT FALSE,-- where reconciled interested leads land
    instantly_interest_value INTEGER,              -- null = no Instantly sync (phase 5)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_id, key)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_deal_stages_entry
    ON deal_stages (client_id) WHERE is_entry;

CREATE TABLE IF NOT EXISTS deals (
    id              BIGSERIAL PRIMARY KEY,
    agency_id       TEXT NOT NULL,
    client_id       BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    contact_id      BIGINT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    campaign_id     BIGINT REFERENCES instantly_campaigns(id) ON DELETE SET NULL, -- campaign that produced the interest
    stage_id        BIGINT NOT NULL REFERENCES deal_stages(id),
    position        DOUBLE PRECISION NOT NULL DEFAULT 0, -- ordering within a column (fractional insert)
    notes           TEXT,
    next_action_at  TIMESTAMPTZ,
    source          TEXT NOT NULL DEFAULT 'reconcile' CHECK (source IN ('reconcile','manual')),
    stage_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at       TIMESTAMPTZ,
    archived_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- one deal per contact per client (decided 2026-08-30)
CREATE UNIQUE INDEX IF NOT EXISTS uq_deals_client_contact ON deals (client_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_deals_client_stage ON deals (client_id, stage_id, position);

CREATE TABLE IF NOT EXISTS deal_stage_events (
    id              BIGSERIAL PRIMARY KEY,
    deal_id         BIGINT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
    from_stage_id   BIGINT REFERENCES deal_stages(id),
    to_stage_id     BIGINT NOT NULL REFERENCES deal_stages(id),
    actor           TEXT,                          -- 'user:<email>' | 'system:reconcile'
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_deal_stage_events_deal ON deal_stage_events (deal_id, created_at);

ALTER TABLE deal_stages ENABLE ROW LEVEL SECURITY;   -- server-only, same as 0049
ALTER TABLE deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_stage_events ENABLE ROW LEVEL SECURITY;
```

**Default stages** (seeded per client the first time the board is opened,
in `ensureDefaultStages(clientRow)`):

| position | key | name | kind | is_entry | maps from interest_status |
|---|---|---|---|---|---|
| 0 | interested | Interested | open | yes | 1 |
| 1 | follow_up | Follow Up | open | | — |
| 2 | meeting_booked | Meeting Booked | open | | 2, 3 |
| 3 | won | Won | won | | 4 |
| 4 | lost | Lost | lost | | -3 |

Mapping only applies at *creation* (reconcile). Stages can be renamed,
recoloured, reordered, added and deleted; `won`/`lost` kinds are required
(at least one of each) so the board can compute conversion later. Deleting a
stage requires a `moveDealsTo` target.

**Reconcile query** (runs inside the GET, guarded by a per-client advisory
lock so concurrent tab loads don't race):

```sql
INSERT INTO deals (agency_id, client_id, contact_id, campaign_id, stage_id, position, source, stage_changed_at)
SELECT cic.agency_id, cic.client_id, cic.contact_id, cic.campaign_id,
       COALESCE(s_map.id, s_entry.id),
       EXTRACT(EPOCH FROM COALESCE(cic.timestamp_last_interest_change, NOW())),
       'reconcile',
       COALESCE(cic.timestamp_last_interest_change, NOW())
FROM (
    -- one row per contact: the campaign with the highest interest, then the most recent change
    SELECT DISTINCT ON (contact_id) *
    FROM contact_instantly_campaigns
    WHERE client_id = $1 AND interest_status >= 1
    ORDER BY contact_id, interest_status DESC, timestamp_last_interest_change DESC NULLS LAST
) cic
JOIN deal_stages s_entry ON s_entry.client_id = cic.client_id AND s_entry.is_entry
LEFT JOIN LATERAL (
    SELECT id FROM deal_stages s WHERE s.client_id = cic.client_id
      AND s.key = CASE cic.interest_status WHEN 2 THEN 'meeting_booked' WHEN 3 THEN 'meeting_booked'
                                          WHEN 4 THEN 'won' WHEN -3 THEN 'lost' END
    LIMIT 1
) s_map ON TRUE
ON CONFLICT (client_id, contact_id) DO NOTHING;
```

Seeds from all-time history on first open (decided): every contact that was
ever interested / won / lost lands in the matching column immediately.
A contact in several campaigns gets one deal; the card shows the campaign
that produced it and the Instantly status of that campaign.

## 4. API — `server/src/routes/dealFlow.js`, mounted in `index.js` under `/api`

All routes: `requireAuth` → `queries.resolveClientRow(req.agencyId, req.params.clientId)`
→ 404 if missing → every deal/stage query also filters `client_id = row.id`.
Same shape as `leads.js:3295`.

| Method | Path | Body / query | Does |
|---|---|---|---|
| GET | `/clients/:clientId/deal-flow` | `?closedSince=60d` | ensureDefaultStages → reconcile → returns `{ stages[], deals[] }`. Open stages return all deals; won/lost stages return last N days + total count. |
| PATCH | `/clients/:clientId/deal-flow/deals/:dealId` | `{ stageId?, position?, notes?, nextActionAt? }` | Moves/edits one deal; writes `deal_stage_events` when stage changes; sets `closed_at` when entering a won/lost stage, clears it when leaving. Phase 5: if target stage has `instantly_interest_value`, also calls the interest-status service. |
| POST | `/clients/:clientId/deal-flow/deals` | `{ contactId, campaignId?, stageId? }` | Manual add (from lead drawer). 409 if the contact already has a deal for this client. |
| DELETE | `/clients/:clientId/deal-flow/deals/:dealId` | | Sets `archived_at` (soft). |
| PUT | `/clients/:clientId/deal-flow/stages` | `{ stages: [{ id?, key?, name, position, kind, color, instantlyInterestValue? }], deletions: [{ id, moveDealsTo }] }` | Bulk upsert in a transaction. Validates ≥1 won, ≥1 lost, exactly one entry. |

Deal row returned to the client (joined in one query — no N+1):

```
id, stageId, position, notes, nextActionAt, stageChangedAt, closedAt, source,
contact: { id, fullName, email, roleType },
company: { id, name, domain },
campaign: { id, instantlyCampaignId, name },
instantly: { interestStatus, interestStatusLabel, lastEventType, timestampLastReply, replySnippet },
draft: { id, status, reviewToken } | null       -- from interested_autoresponder_drafts (open statuses)
```

## 5. Frontend

**Dependency:** `@dnd-kit/core` + `@dnd-kit/sortable` + `@dnd-kit/utilities`
(React 19 compatible; `react-beautiful-dnd` is not). Repo has both
`package-lock.json` and `pnpm-lock.yaml` — install with whichever Vercel uses
(check `vercel.json`/project settings) and commit that lockfile only.

**Files** (all new):

```
components/deal-flow/
  DealFlowBoard.tsx      -- data load, DndContext, optimistic move + rollback, polling
  DealColumn.tsx         -- droppable + SortableContext, header (name, count)
  DealCard.tsx           -- favicon+domain, founder, company, campaign, reply snippet, days-in-stage,
                            Instantly badge when it diverges from stage, draft "Review ↗" link
  StageSettingsDialog.tsx-- rename / reorder / color / kind / add / delete-with-move
  DealDetailSheet.tsx    -- notes, next action; "Open lead" → onOpenLead(contactId)
  useDealFlow.ts         -- fetch + mutations via apiJson/apiFetch (lib/api/http.ts)
  types.ts
```

**Touches to `app/clients/[clientId]/page.tsx`** (the only edits to existing code):

1. L1545 `allowedTabs`: add `"deal-flow"`.
2. L8449-8481 nav: one more `<button>` ("Deal Flow"), rendered only when `dealFlowEnabled`.
3. After L10541: `{activeTab === "deal-flow" && <DealFlowBoard clientId={clientId} onOpenLead={openLeadDrawer} />}`
   where `openLeadDrawer` is the existing set-state that the leads table already uses to open the drawer at L13808.
4. L2733-2775 features read: widen the local type to `{ shoppingAudit?: boolean; dealFlow?: boolean }`
   and keep `dealFlow` in state alongside `shoppingAudit`.

Nothing else in the page changes. Tab-gated effects (L4825, L4834, L6770)
already skip work for unknown tabs, so no analytics/leads fetches fire on
the board.

**Board behaviour**

- Columns = stages in `position` order; horizontal scroll; won/lost columns
  collapsed-by-default with count + "show last 60 days".
- Drag card → `PATCH` with `{ stageId, position }` where position is the
  midpoint between neighbours (fractional; renormalise server-side when the
  gap < 1e-6). Optimistic update, rollback + `sonner` toast on failure.
- Keyboard: dnd-kit sensors give arrow-key moving for free; card also has a
  "Move to…" menu for accessibility.
- Refresh: `useIntervalWhenVisible` every 60s + on tab focus. (Phase 5: pass
  the page's existing realtime "events changed" tick as a prop to refetch
  instantly.)
- Column header: count.
- Card badge when Instantly's status diverges from the stage (e.g. Instantly
  flips to not_interested while the deal is open) — red badge, no auto-move
  (decided).
- Filters (top bar): campaign, search by name/company/email, "has next action
  due". Client-side over the loaded set.
- Empty state on first open: "No interested leads yet — leads that reply
  Interested in Instantly appear here automatically."

**Styling:** reuse `globals.css` tokens/classes (`tab-nav__*`, card
surfaces). Stage `color` is a token name resolved to the same status colours
`formatInstantlyStateLabel` uses (page.tsx L567-589) so Interested/Meeting/Won
match the rest of the app.

## 6. Isolation guarantees

- No column added to any existing table; no change to `instantlyState.js`,
  webhooks, follow-up sender, autoresponder, `leads.js` (until phase 5, where
  the existing route is refactored to delegate to a service with identical
  behaviour and a test).
- Board hidden unless `features.dealFlow` is set on the agency.
- Reconcile is `ON CONFLICT DO NOTHING` under an advisory lock — safe to run
  on every load, cannot duplicate or move deals.
- All new tables RLS-enabled with no policies (server-only, per 0049).
- Deleting a client cascades deals/stages; deleting a contact cascades its deal.

## 7. Phases

| # | Scope | Deliverable |
|---|---|---|
| 1 | Migration 0053, `dealFlow.js` GET (seed + reconcile), feature flag, tab + static board (no DnD) | Board renders real interested leads in the right columns |
| 2 | dnd-kit, PATCH move endpoint, optimistic UI, `deal_stage_events` | Drag between/within columns, persists, survives reload |
| 3 | Stage settings dialog + PUT stages | Rename/reorder/add/delete custom stages |
| 4 | Deal detail sheet (notes, next action), lead-drawer hook, manual add from lead drawer, filters | Usable daily CRM |
| 5 | Opt-in Instantly sync per stage (extract service from `leads.js:3295`), realtime refetch, conversion/time-in-stage stats in column headers | Two-way with Instantly where the client wants it |

Rough effort: phases 1–2 ≈ 2 days, 3–4 ≈ 2 days, 5 ≈ 1–2 days.

## 8. Decisions (confirmed 2026-08-30)

1. **Deal granularity**: one deal per contact per client
   (`UNIQUE (client_id, contact_id)`). `campaign_id` records the campaign that
   produced the interest; reconcile picks the campaign with the highest
   interest status, then the most recent change.
2. **Instantly says "not interested" after a deal exists**: red badge on the
   card; no auto-move to Lost.
3. **Seed history**: all-time interested / won / lost on first open.
4. **Who edits stages**: anyone with client access.
5. **Value field**: left out. (It would have been an optional deal amount —
   e.g. "$4,800" — summed per column for a pipeline-value total. Can be
   added later with one nullable column.)

## 9. Implementation status (2026-08-30)

Phases 1–4 built. Phase 5 (opt-in Instantly write-back, realtime refetch,
conversion stats) not started.

- `server/migrations/0053_deal_flow.sql` — **not yet applied**. Dry-run
  against prod in a rolled-back transaction: DDL ok; reconcile for the largest
  client created 390 deals (352 Interested / 29 Meeting Booked / 8 Won /
  1 Lost) in 1.3 s; board SELECT 17 ms (EXPLAIN ANALYZE, existing indexes).
- `server/src/services/db/dealFlow.js`, `server/src/routes/dealFlow.js`,
  mounted in `index.js`.
- `components/deal-flow/*` (board, column, card, detail sheet, stage
  settings, hook, types); styles appended to `app/globals.css` (`.df-*`).
- `app/clients/[clientId]/page.tsx`: tab entry, nav button, render line,
  `dealFlowEnabled` state from `features.dealFlow`.
- Dependency: `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`
  (pnpm; `package-lock.json` not regenerated).

Note: `contact_instantly_campaigns` has no `client_id`/`agency_id` column —
reconcile scopes through `instantly_campaigns.client_id` and takes
`agency_id` from `contacts` (the plan's sketch above was wrong on that).

To enable for a client: apply 0053, then set `features.dealFlow = true` on
the agency in `agency_settings`.

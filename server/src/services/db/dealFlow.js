/**
 * Deal Flow — data access for the client-view kanban board.
 *
 * Deals own their state; contact_instantly_campaigns.interest_status is only
 * read here (to reconcile new deals and to surface an Instantly badge). Nothing
 * in this module writes to any pre-existing table.
 */
import { pool } from '../../config/db.js';

export const STAGE_KINDS = new Set(['open', 'won', 'lost']);
export const STAGE_COLORS = new Set(['violet', 'sky', 'teal', 'green', 'red', 'amber', 'slate']);

const DEFAULT_STAGES = [
    { key: 'interested', name: 'Interested', position: 0, kind: 'open', color: 'violet', is_entry: true },
    { key: 'follow_up', name: 'Follow Up', position: 1, kind: 'open', color: 'sky', is_entry: false },
    { key: 'meeting_booked', name: 'Meeting Booked', position: 2, kind: 'open', color: 'teal', is_entry: false },
    { key: 'won', name: 'Won', position: 3, kind: 'won', color: 'green', is_entry: false },
    { key: 'lost', name: 'Lost', position: 4, kind: 'lost', color: 'red', is_entry: false }
];

const OPEN_DRAFT_STATUSES = ['researching', 'pending_review'];

function lockKey(clientId) {
    return `deal_flow:${clientId}`;
}

async function withClientLock(clientId, fn) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey(clientId)]);
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

export function slugifyStageKey(name) {
    const base = String(name || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40);
    return base || 'stage';
}

async function seedDefaultStages(db, clientRow) {
    const existing = await db.query(
        `SELECT COUNT(*)::int AS n FROM deal_stages WHERE client_id = $1`,
        [clientRow.id]
    );
    if (existing.rows[0].n > 0) return false;
    for (const stage of DEFAULT_STAGES) {
        await db.query(
            `INSERT INTO deal_stages (agency_id, client_id, key, name, position, kind, color, is_entry)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (client_id, key) DO NOTHING`,
            [clientRow.agency_id, clientRow.id, stage.key, stage.name, stage.position, stage.kind, stage.color, stage.is_entry]
        );
    }
    return true;
}

/**
 * Create a deal for every contact in this client that Instantly marks as
 * interested (or further along) and that has no deal yet. Never moves an
 * existing deal. One row per contact: highest interest status wins, then the
 * most recent change.
 */
async function reconcileDeals(db, clientRow) {
    const result = await db.query(
        `INSERT INTO deals (agency_id, client_id, contact_id, campaign_id, stage_id, position, source, stage_changed_at, closed_at)
         SELECT c.agency_id,
                c.client_id,
                cic.contact_id,
                cic.campaign_id,
                COALESCE(s_map.id, s_entry.id),
                EXTRACT(EPOCH FROM COALESCE(cic.timestamp_last_interest_change, NOW())),
                'reconcile',
                COALESCE(cic.timestamp_last_interest_change, NOW()),
                CASE WHEN s_map.kind IN ('won', 'lost') THEN COALESCE(cic.timestamp_last_interest_change, NOW()) END
         FROM (
             -- contact_instantly_campaigns has no client_id; scope through instantly_campaigns.
             SELECT DISTINCT ON (cic.contact_id)
                    cic.contact_id, cic.campaign_id, cic.interest_status, cic.timestamp_last_interest_change
             FROM contact_instantly_campaigns cic
             JOIN instantly_campaigns ic ON ic.id = cic.campaign_id
             WHERE ic.client_id = $1
               AND cic.interest_status IS NOT NULL
               AND (cic.interest_status >= 1 OR cic.interest_status = -3)
             ORDER BY cic.contact_id, cic.interest_status DESC, cic.timestamp_last_interest_change DESC NULLS LAST
         ) cic
         JOIN contacts c ON c.id = cic.contact_id AND c.client_id = $1
         JOIN deal_stages s_entry ON s_entry.client_id = $1 AND s_entry.is_entry
         LEFT JOIN LATERAL (
             SELECT s.id, s.kind
             FROM deal_stages s
             WHERE s.client_id = $1
               AND s.key = CASE cic.interest_status
                               WHEN 2 THEN 'meeting_booked'
                               WHEN 3 THEN 'meeting_booked'
                               WHEN 4 THEN 'won'
                               WHEN -3 THEN 'lost'
                           END
             LIMIT 1
         ) s_map ON TRUE
         WHERE cic.interest_status >= 1 OR s_map.id IS NOT NULL
         ON CONFLICT (client_id, contact_id) DO NOTHING
         RETURNING id, stage_id`,
        [clientRow.id]
    );
    if (result.rows.length) {
        await db.query(
            `INSERT INTO deal_stage_events (deal_id, from_stage_id, to_stage_id, actor)
             SELECT d.id, NULL, d.stage_id, 'system:reconcile'
             FROM deals d
             WHERE d.id = ANY($1::bigint[])`,
            [result.rows.map((r) => r.id)]
        );
    }
    return result.rows.length;
}

function mapStage(row) {
    return {
        id: Number(row.id),
        key: row.key,
        name: row.name,
        position: Number(row.position),
        kind: row.kind,
        color: row.color || 'slate',
        isEntry: Boolean(row.is_entry),
        instantlyInterestValue: row.instantly_interest_value === null ? null : Number(row.instantly_interest_value),
        totalCount: row.total_count === undefined ? undefined : Number(row.total_count)
    };
}

function mapDeal(row) {
    return {
        id: Number(row.id),
        stageId: Number(row.stage_id),
        position: Number(row.position),
        notes: row.notes || '',
        nextActionAt: row.next_action_at,
        stageChangedAt: row.stage_changed_at,
        closedAt: row.closed_at,
        source: row.source,
        createdAt: row.created_at,
        contact: {
            id: Number(row.contact_id),
            fullName: row.full_name || '',
            email: row.email || '',
            roleType: row.role_type || ''
        },
        company: {
            id: row.company_id === null ? null : Number(row.company_id),
            domain: row.domain_normalized || ''
        },
        campaign: row.campaign_id === null ? null : {
            id: Number(row.campaign_id),
            instantlyCampaignId: row.instantly_campaign_id || '',
            name: row.campaign_name || ''
        },
        instantly: {
            interestStatus: row.interest_status === null ? null : Number(row.interest_status),
            interestStatusLabel: row.interest_status_label || null,
            lastEventType: row.last_event_type || null,
            timestampLastReply: row.timestamp_last_reply || null,
            replySnippet: row.reply_snippet || null
        },
        draft: row.draft_id === null ? null : {
            id: Number(row.draft_id),
            status: row.draft_status,
            reviewToken: row.draft_review_token || null
        }
    };
}

const DEAL_SELECT = `
    SELECT d.id, d.stage_id, d.position, d.notes, d.next_action_at, d.stage_changed_at, d.closed_at,
           d.source, d.created_at, d.contact_id, d.campaign_id,
           c.full_name, c.email, c.role_type, c.company_id,
           co.domain_normalized,
           ic.instantly_campaign_id, ic.name AS campaign_name,
           cic.interest_status, cic.interest_status_label, cic.last_event_type, cic.timestamp_last_reply,
           ev.reply_snippet,
           dr.id AS draft_id, dr.status AS draft_status, dr.review_token AS draft_review_token
    FROM deals d
    JOIN contacts c ON c.id = d.contact_id
    LEFT JOIN companies co ON co.id = c.company_id
    LEFT JOIN instantly_campaigns ic ON ic.id = d.campaign_id
    LEFT JOIN contact_instantly_campaigns cic ON cic.contact_id = d.contact_id AND cic.campaign_id = d.campaign_id
    LEFT JOIN LATERAL (
        SELECT COALESCE(NULLIF(e.reply_text_snippet, ''), NULLIF(LEFT(e.message_text, 240), '')) AS reply_snippet
        FROM contact_instantly_events e
        WHERE e.contact_id = d.contact_id
          AND e.client_id = d.client_id
          AND (e.reply_text_snippet IS NOT NULL OR e.message_text IS NOT NULL)
          AND e.event_type NOT IN ('email_sent', 'interested_reply_sent')
        ORDER BY e.event_timestamp DESC NULLS LAST, e.id DESC
        LIMIT 1
    ) ev ON TRUE
    LEFT JOIN LATERAL (
        SELECT dr.id, dr.status, dr.review_token
        FROM interested_autoresponder_drafts dr
        WHERE dr.contact_id = d.contact_id
          AND dr.client_id = d.client_id
          AND dr.status = ANY($2::text[])
        ORDER BY dr.created_at DESC
        LIMIT 1
    ) dr ON TRUE
`;

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 500;

function clampPageSize(value, fallback = DEFAULT_PAGE_SIZE) {
    const n = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(n, MAX_PAGE_SIZE);
}

/**
 * Ensure default stages exist, optionally reconcile new deals, and return the
 * first `pageSize` deals of every stage (newest first) plus a total count per
 * stage. Older deals are fetched per stage with listStageDeals().
 */
export async function loadBoard(clientRow, { pageSize = DEFAULT_PAGE_SIZE, reconcile = true } = {}) {
    const limit = clampPageSize(pageSize);

    // Write phase (first open / explicit refresh only): seed stages + reconcile
    // under the per-client lock. Background polls skip this entirely so they
    // cost two round trips, not a transaction.
    let reconciled = 0;
    if (reconcile) {
        reconciled = await withClientLock(clientRow.id, async (db) => {
            await seedDefaultStages(db, clientRow);
            return reconcileDeals(db, clientRow);
        });
    }

    const [stagesResult, dealsResult] = await Promise.all([
        pool.query(
            `SELECT s.*, (
                 SELECT COUNT(*)::int FROM deals d
                 WHERE d.stage_id = s.id AND d.archived_at IS NULL
             ) AS total_count
             FROM deal_stages s
             WHERE s.client_id = $1
             ORDER BY s.position, s.id`,
            [clientRow.id]
        ),
        pool.query(
            `WITH ranked AS (
                 SELECT id, ROW_NUMBER() OVER (PARTITION BY stage_id ORDER BY position DESC, id DESC) AS rn
                 FROM deals
                 WHERE client_id = $1 AND archived_at IS NULL
             )
             ${DEAL_SELECT}
             JOIN ranked r ON r.id = d.id
             WHERE d.client_id = $1 AND r.rn <= $3
             ORDER BY d.stage_id, d.position DESC, d.id DESC`,
            [clientRow.id, OPEN_DRAFT_STATUSES, limit]
        )
    ]);

    // A client whose board has never been opened has no stages yet; seed once.
    if (stagesResult.rows.length === 0 && !reconcile) {
        return loadBoard(clientRow, { pageSize: limit, reconcile: true });
    }

    return {
        stages: stagesResult.rows.map(mapStage),
        deals: dealsResult.rows.map(mapDeal),
        pageSize: limit,
        reconciled
    };
}

/**
 * Next page of one stage, keyset-paginated on (position, id) descending.
 * The cursor is the id of the last loaded deal; its position is looked up
 * here rather than trusted from the client — float8 leaves the server with
 * 15 significant digits, and epoch-based positions have exactly 15, so a
 * client-supplied position can land on either side of the stored value.
 */
export async function listStageDeals(clientRow, stageId, { beforeId = null, limit = DEFAULT_PAGE_SIZE } = {}) {
    const size = clampPageSize(limit);
    const hasCursor = Number.isInteger(beforeId) && beforeId > 0;
    // total_count via window function so one round trip serves both.
    const result = await pool.query(
        `${DEAL_SELECT.replace('SELECT d.id,', 'SELECT COUNT(*) OVER () AS total_count, d.id,')}
         WHERE d.client_id = $1
           AND d.stage_id = $3
           AND d.archived_at IS NULL
           AND (
               $4::boolean = FALSE
               OR (d.position, d.id) < (
                   SELECT cur.position, cur.id FROM deals cur
                   WHERE cur.id = $5::bigint AND cur.client_id = $1
               )
           )
         ORDER BY d.position DESC, d.id DESC
         LIMIT $6`,
        [clientRow.id, OPEN_DRAFT_STATUSES, stageId, hasCursor, hasCursor ? beforeId : 0, size]
    );
    // COUNT(*) OVER () counts rows matching the cursor, i.e. the remaining tail;
    // loaded-so-far is what the client already has, so total = loaded + remaining.
    const remaining = result.rows.length ? Number(result.rows[0].total_count) : 0;
    return { deals: result.rows.map(mapDeal), remaining, pageSize: size };
}

async function getDealRow(db, clientId, dealId) {
    const result = await db.query(
        `${DEAL_SELECT} WHERE d.id = $1 AND d.client_id = $3 AND d.archived_at IS NULL`,
        [dealId, OPEN_DRAFT_STATUSES, clientId]
    );
    return result.rows[0] || null;
}

async function getStageRow(db, clientId, stageId) {
    const result = await db.query(
        `SELECT * FROM deal_stages WHERE id = $1 AND client_id = $2`,
        [stageId, clientId]
    );
    return result.rows[0] || null;
}

async function renormalizeIfNeeded(db, stageId) {
    // Higher position = nearer the top of the column.
    const result = await db.query(
        `SELECT id, position FROM deals WHERE stage_id = $1 AND archived_at IS NULL ORDER BY position DESC, id DESC`,
        [stageId]
    );
    const rows = result.rows;
    let needs = rows.some((r) => Number(r.position) <= 0);
    for (let i = 1; i < rows.length; i += 1) {
        // 1e-3 (not 1e-6): float8 is shown to clients with 15 significant digits,
        // so at ~1.8e9 anything closer than ~1e-5 is indistinguishable client-side.
        if (Math.abs(Number(rows[i].position) - Number(rows[i - 1].position)) < 1e-3) {
            needs = true;
            break;
        }
    }
    if (!needs) return;
    for (let i = 0; i < rows.length; i += 1) {
        await db.query(`UPDATE deals SET position = $2 WHERE id = $1`, [rows[i].id, (rows.length - i) * 1000]);
    }
}

/**
 * Patch one deal. Stage changes write an audit row and maintain closed_at.
 */
export async function updateDeal(clientRow, dealId, patch, { actor } = {}) {
    return withClientLock(clientRow.id, async (db) => {
        const current = await db.query(
            `SELECT d.*, s.kind AS stage_kind FROM deals d JOIN deal_stages s ON s.id = d.stage_id
             WHERE d.id = $1 AND d.client_id = $2 AND d.archived_at IS NULL FOR UPDATE OF d`,
            [dealId, clientRow.id]
        );
        const deal = current.rows[0];
        if (!deal) return null;

        const sets = [];
        const values = [dealId, clientRow.id];
        const push = (sql, value) => {
            values.push(value);
            sets.push(`${sql} = $${values.length}`);
        };

        let stageChanged = false;
        let targetStage = null;
        if (patch.stageId !== undefined && Number(patch.stageId) !== Number(deal.stage_id)) {
            targetStage = await getStageRow(db, clientRow.id, Number(patch.stageId));
            if (!targetStage) {
                const err = new Error('Stage not found.');
                err.statusCode = 404;
                throw err;
            }
            stageChanged = true;
            push('stage_id', targetStage.id);
            push('stage_changed_at', new Date().toISOString());
            if (targetStage.kind === 'open') {
                push('closed_at', null);
            } else if (deal.stage_kind === 'open' || !deal.closed_at) {
                push('closed_at', new Date().toISOString());
            }
        }
        if (patch.position !== undefined) push('position', Number(patch.position));
        if (patch.notes !== undefined) push('notes', patch.notes === null ? null : String(patch.notes));
        if (patch.nextActionAt !== undefined) push('next_action_at', patch.nextActionAt || null);

        if (sets.length) {
            sets.push('updated_at = NOW()');
            await db.query(
                `UPDATE deals SET ${sets.join(', ')} WHERE id = $1 AND client_id = $2`,
                values
            );
        }
        if (stageChanged) {
            await db.query(
                `INSERT INTO deal_stage_events (deal_id, from_stage_id, to_stage_id, actor) VALUES ($1, $2, $3, $4)`,
                [dealId, deal.stage_id, targetStage.id, actor || null]
            );
        }
        if (patch.position !== undefined || stageChanged) {
            await renormalizeIfNeeded(db, targetStage ? targetStage.id : deal.stage_id);
        }
        const row = await getDealRow(db, clientRow.id, dealId);
        return row ? mapDeal(row) : null;
    });
}

export async function createDeal(clientRow, { contactId, campaignId, stageId }, { actor } = {}) {
    return withClientLock(clientRow.id, async (db) => {
        await seedDefaultStages(db, clientRow);
        const contact = await db.query(
            `SELECT id FROM contacts WHERE id = $1 AND client_id = $2 AND agency_id = $3`,
            [contactId, clientRow.id, clientRow.agency_id]
        );
        if (!contact.rows[0]) {
            const err = new Error('Contact not found.');
            err.statusCode = 404;
            throw err;
        }
        let stage = null;
        if (stageId) {
            stage = await getStageRow(db, clientRow.id, Number(stageId));
        }
        if (!stage) {
            const entry = await db.query(
                `SELECT * FROM deal_stages WHERE client_id = $1 AND is_entry LIMIT 1`,
                [clientRow.id]
            );
            stage = entry.rows[0];
        }
        if (!stage) {
            const err = new Error('No entry stage configured.');
            err.statusCode = 400;
            throw err;
        }
        let campaign = null;
        if (campaignId) {
            const c = await db.query(
                `SELECT id FROM instantly_campaigns WHERE id = $1 AND client_id = $2`,
                [campaignId, clientRow.id]
            );
            campaign = c.rows[0] || null;
        }
        const existing = await db.query(
            `SELECT id, archived_at FROM deals WHERE client_id = $1 AND contact_id = $2`,
            [clientRow.id, contactId]
        );
        let dealId;
        if (existing.rows[0]) {
            if (!existing.rows[0].archived_at) {
                const err = new Error('This lead is already on the board.');
                err.statusCode = 409;
                throw err;
            }
            dealId = existing.rows[0].id;
            await db.query(
                `UPDATE deals SET archived_at = NULL, stage_id = $2, campaign_id = COALESCE($3, campaign_id),
                        position = EXTRACT(EPOCH FROM NOW()), source = 'manual', stage_changed_at = NOW(),
                        closed_at = CASE WHEN $4 = 'open' THEN NULL ELSE NOW() END, updated_at = NOW()
                 WHERE id = $1`,
                [dealId, stage.id, campaign ? campaign.id : null, stage.kind]
            );
        } else {
            const inserted = await db.query(
                `INSERT INTO deals (agency_id, client_id, contact_id, campaign_id, stage_id, position, source, closed_at)
                 VALUES ($1, $2, $3, $4, $5, EXTRACT(EPOCH FROM NOW()), 'manual',
                         CASE WHEN $6 = 'open' THEN NULL ELSE NOW() END)
                 RETURNING id`,
                [clientRow.agency_id, clientRow.id, contactId, campaign ? campaign.id : null, stage.id, stage.kind]
            );
            dealId = inserted.rows[0].id;
        }
        await db.query(
            `INSERT INTO deal_stage_events (deal_id, from_stage_id, to_stage_id, actor) VALUES ($1, NULL, $2, $3)`,
            [dealId, stage.id, actor || null]
        );
        const row = await getDealRow(db, clientRow.id, dealId);
        return mapDeal(row);
    });
}

export async function archiveDeal(clientRow, dealId) {
    const result = await pool.query(
        `UPDATE deals SET archived_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND client_id = $2 AND archived_at IS NULL
         RETURNING id`,
        [dealId, clientRow.id]
    );
    return Boolean(result.rows[0]);
}

/**
 * Bulk upsert stages. `stages` is the full desired list; `deletions` lists
 * stages to remove with a `moveDealsTo` target.
 */
export async function saveStages(clientRow, { stages, deletions }, { actor } = {}) {
    if (!Array.isArray(stages) || stages.length === 0) {
        const err = new Error('At least one stage is required.');
        err.statusCode = 400;
        throw err;
    }
    const deletionIds = new Set((deletions || []).map((d) => Number(d.id)));
    const kept = stages.filter((s) => !s.id || !deletionIds.has(Number(s.id)));
    const entryCount = kept.filter((s) => s.isEntry).length;
    if (entryCount !== 1) {
        const err = new Error('Exactly one stage must be the entry stage.');
        err.statusCode = 400;
        throw err;
    }
    if (!kept.some((s) => s.kind === 'won') || !kept.some((s) => s.kind === 'lost')) {
        const err = new Error('Keep at least one Won and one Lost stage.');
        err.statusCode = 400;
        throw err;
    }
    for (const s of kept) {
        if (!String(s.name || '').trim()) {
            const err = new Error('Every stage needs a name.');
            err.statusCode = 400;
            throw err;
        }
        if (!STAGE_KINDS.has(s.kind)) {
            const err = new Error(`Invalid stage kind: ${s.kind}`);
            err.statusCode = 400;
            throw err;
        }
    }

    return withClientLock(clientRow.id, async (db) => {
        const existingResult = await db.query(
            `SELECT * FROM deal_stages WHERE client_id = $1`,
            [clientRow.id]
        );
        const existingById = new Map(existingResult.rows.map((r) => [Number(r.id), r]));
        const usedKeys = new Set(existingResult.rows.map((r) => r.key));

        // Deletions first (move deals, then drop the stage).
        for (const del of deletions || []) {
            const id = Number(del.id);
            const stage = existingById.get(id);
            if (!stage) continue;
            const target = Number(del.moveDealsTo);
            if (!target || target === id || deletionIds.has(target) || !existingById.has(target)) {
                const err = new Error(`Choose where to move deals from "${stage.name}".`);
                err.statusCode = 400;
                throw err;
            }
            const targetStage = existingById.get(target);
            const moved = await db.query(
                `UPDATE deals SET stage_id = $2, stage_changed_at = NOW(), updated_at = NOW(),
                        closed_at = CASE WHEN $3 = 'open' THEN NULL ELSE COALESCE(closed_at, NOW()) END
                 WHERE stage_id = $1 AND client_id = $4
                 RETURNING id`,
                [id, target, targetStage.kind, clientRow.id]
            );
            if (moved.rows.length) {
                await db.query(
                    `INSERT INTO deal_stage_events (deal_id, from_stage_id, to_stage_id, actor)
                     SELECT id, $2, $3, $4 FROM deals WHERE id = ANY($1::bigint[])`,
                    [moved.rows.map((r) => r.id), id, target, actor || null]
                );
            }
            await db.query(`DELETE FROM deal_stages WHERE id = $1 AND client_id = $2`, [id, clientRow.id]);
            existingById.delete(id);
            usedKeys.delete(stage.key);
        }

        // Clear entry flags so the partial unique index doesn't trip mid-update.
        await db.query(`UPDATE deal_stages SET is_entry = FALSE WHERE client_id = $1`, [clientRow.id]);
        // Park positions out of the way to avoid transient collisions (positions aren't unique, but keep it tidy).
        await db.query(`UPDATE deal_stages SET position = position + 100000 WHERE client_id = $1`, [clientRow.id]);

        const out = [];
        for (let index = 0; index < kept.length; index += 1) {
            const s = kept[index];
            const name = String(s.name).trim();
            const color = STAGE_COLORS.has(s.color) ? s.color : 'slate';
            const id = s.id ? Number(s.id) : null;
            if (id && existingById.has(id)) {
                await db.query(
                    `UPDATE deal_stages SET name = $3, position = $4, kind = $5, color = $6, is_entry = $7, updated_at = NOW()
                     WHERE id = $1 AND client_id = $2`,
                    [id, clientRow.id, name, index, s.kind, color, Boolean(s.isEntry)]
                );
                out.push(id);
            } else {
                let key = slugifyStageKey(name);
                let suffix = 1;
                while (usedKeys.has(key)) {
                    suffix += 1;
                    key = `${slugifyStageKey(name)}_${suffix}`;
                }
                usedKeys.add(key);
                const inserted = await db.query(
                    `INSERT INTO deal_stages (agency_id, client_id, key, name, position, kind, color, is_entry)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
                    [clientRow.agency_id, clientRow.id, key, name, index, s.kind, color, Boolean(s.isEntry)]
                );
                out.push(inserted.rows[0].id);
            }
        }

        const result = await db.query(
            `SELECT s.*, (
                 SELECT COUNT(*)::int FROM deals d WHERE d.stage_id = s.id AND d.archived_at IS NULL
             ) AS total_count
             FROM deal_stages s WHERE s.client_id = $1 ORDER BY s.position, s.id`,
            [clientRow.id]
        );
        return result.rows.map(mapStage);
    });
}

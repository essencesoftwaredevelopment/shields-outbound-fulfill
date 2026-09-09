/**
 * Named lead lists — static contact membership for All Leads.
 *
 * Lists are agency+client scoped. Membership writes always re-check that the
 * list and the contacts belong to the same tenant (the Express pool bypasses RLS).
 */

import { pool, withTx } from '../lib/db.js';

export const MAX_LEAD_LIST_NAME_LENGTH = 80;
export const MAX_LEAD_LIST_CONTACT_IDS = 5000;

export function normalizeLeadListName(raw) {
    const name = String(raw || '').trim().replace(/\s+/g, ' ');
    if (!name) return null;
    return name.slice(0, MAX_LEAD_LIST_NAME_LENGTH);
}

export function parseLeadListId(raw) {
    const parsed = Number.parseInt(String(raw ?? ''), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function parseContactIds(rawIds) {
    if (!Array.isArray(rawIds)) return [];
    const seen = new Set();
    const ids = [];
    for (const raw of rawIds) {
        const parsed = Number.parseInt(String(raw), 10);
        if (!Number.isInteger(parsed) || parsed <= 0 || seen.has(parsed)) continue;
        seen.add(parsed);
        ids.push(parsed);
        if (ids.length >= MAX_LEAD_LIST_CONTACT_IDS) break;
    }
    return ids;
}

function uniqueViolation(error) {
    return error?.code === '23505';
}

function conflictError(message) {
    const error = new Error(message);
    error.statusCode = 409;
    return error;
}

function notFoundError(message) {
    const error = new Error(message);
    error.statusCode = 404;
    return error;
}

function mapListRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        name: row.name,
        memberCount: Number(row.member_count || 0),
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

export async function listLeadLists(agencyId, clientId) {
    const result = await pool.query(
        `SELECT
            ll.id,
            ll.name,
            ll.created_at,
            ll.updated_at,
            COUNT(llm.contact_id)::int AS member_count
         FROM lead_lists ll
         LEFT JOIN lead_list_members llm ON llm.list_id = ll.id
         WHERE ll.agency_id = $1 AND ll.client_id = $2
         GROUP BY ll.id
         ORDER BY lower(ll.name), ll.id`,
        [agencyId, clientId]
    );
    return result.rows.map(mapListRow);
}

export async function getLeadList(agencyId, clientId, listId) {
    const result = await pool.query(
        `SELECT
            ll.id,
            ll.name,
            ll.created_at,
            ll.updated_at,
            COUNT(llm.contact_id)::int AS member_count
         FROM lead_lists ll
         LEFT JOIN lead_list_members llm ON llm.list_id = ll.id
         WHERE ll.agency_id = $1 AND ll.client_id = $2 AND ll.id = $3
         GROUP BY ll.id`,
        [agencyId, clientId, listId]
    );
    return mapListRow(result.rows[0]);
}

async function insertList(db, agencyId, clientId, name) {
    try {
        const result = await db.query(
            `INSERT INTO lead_lists (agency_id, client_id, name)
             VALUES ($1, $2, $3)
             RETURNING id, name, created_at, updated_at, 0::int AS member_count`,
            [agencyId, clientId, name]
        );
        return result.rows[0];
    } catch (error) {
        if (uniqueViolation(error)) {
            throw conflictError('A list with that name already exists.');
        }
        throw error;
    }
}

async function insertMembersFromIds(db, agencyId, clientId, listId, contactIds) {
    if (!contactIds.length) return 0;
    const result = await db.query(
        `INSERT INTO lead_list_members (list_id, contact_id)
         SELECT $3, c.id
         FROM contacts c
         WHERE c.agency_id = $1
           AND c.client_id = $2
           AND c.id = ANY($4::bigint[])
         ON CONFLICT DO NOTHING
         RETURNING contact_id`,
        [agencyId, clientId, listId, contactIds]
    );
    return result.rowCount || 0;
}

async function insertMembersFromFilter(db, listId, filterContext) {
    const { whereClause, filterParams, baseWithClause, filterJoins } = filterContext;
    const listParam = `$${filterParams.length + 1}`;
    const result = await db.query(
        `${baseWithClause}
         INSERT INTO lead_list_members (list_id, contact_id)
         SELECT ${listParam}::bigint, c.id
         FROM contacts c
         JOIN scoped_companies co ON c.company_id = co.id
         ${filterJoins}
         WHERE ${whereClause}
         ON CONFLICT DO NOTHING
         RETURNING contact_id`,
        [...filterParams, listId]
    );
    return result.rowCount || 0;
}

export async function createLeadList(agencyId, clientId, { name, contactIds, filterContext } = {}) {
    const normalizedName = normalizeLeadListName(name);
    if (!normalizedName) {
        const error = new Error('List name is required.');
        error.statusCode = 400;
        throw error;
    }

    return withTx(async (db) => {
        const created = await insertList(db, agencyId, clientId, normalizedName);
        let addedCount = 0;
        if (filterContext && !filterContext.emptyResult) {
            addedCount = await insertMembersFromFilter(db, created.id, filterContext);
        } else if (Array.isArray(contactIds) && contactIds.length > 0) {
            addedCount = await insertMembersFromIds(db, agencyId, clientId, created.id, contactIds);
        }
        return {
            list: {
                id: created.id,
                name: created.name,
                memberCount: addedCount,
                createdAt: created.created_at,
                updatedAt: created.updated_at
            },
            addedCount
        };
    });
}

export async function renameLeadList(agencyId, clientId, listId, name) {
    const normalizedName = normalizeLeadListName(name);
    if (!normalizedName) {
        const error = new Error('List name is required.');
        error.statusCode = 400;
        throw error;
    }
    try {
        const result = await pool.query(
            `UPDATE lead_lists
             SET name = $4, updated_at = NOW()
             WHERE agency_id = $1 AND client_id = $2 AND id = $3
             RETURNING id`,
            [agencyId, clientId, listId, normalizedName]
        );
        if (!result.rowCount) throw notFoundError('List not found.');
        return getLeadList(agencyId, clientId, listId);
    } catch (error) {
        if (uniqueViolation(error)) {
            throw conflictError('A list with that name already exists.');
        }
        throw error;
    }
}

export async function deleteLeadList(agencyId, clientId, listId) {
    const result = await pool.query(
        `DELETE FROM lead_lists
         WHERE agency_id = $1 AND client_id = $2 AND id = $3
         RETURNING id`,
        [agencyId, clientId, listId]
    );
    return (result.rowCount || 0) > 0;
}

export async function addMembersByIds(agencyId, clientId, listId, contactIds) {
    const list = await getLeadList(agencyId, clientId, listId);
    if (!list) throw notFoundError('List not found.');
    const addedCount = await insertMembersFromIds(pool, agencyId, clientId, listId, contactIds);
    return { list: await getLeadList(agencyId, clientId, listId), addedCount };
}

export async function addMembersByFilter(agencyId, clientId, listId, filterContext) {
    const list = await getLeadList(agencyId, clientId, listId);
    if (!list) throw notFoundError('List not found.');
    if (!filterContext || filterContext.emptyResult) {
        return { list, addedCount: 0 };
    }
    const addedCount = await insertMembersFromFilter(pool, listId, filterContext);
    return { list: await getLeadList(agencyId, clientId, listId), addedCount };
}

export async function removeMembersByIds(agencyId, clientId, listId, contactIds) {
    const list = await getLeadList(agencyId, clientId, listId);
    if (!list) throw notFoundError('List not found.');
    if (!contactIds.length) {
        return { list, removedCount: 0 };
    }
    const result = await pool.query(
        `DELETE FROM lead_list_members llm
         USING contacts c
         WHERE llm.list_id = $3
           AND llm.contact_id = c.id
           AND c.agency_id = $1
           AND c.client_id = $2
           AND c.id = ANY($4::bigint[])
         RETURNING llm.contact_id`,
        [agencyId, clientId, listId, contactIds]
    );
    return {
        list: await getLeadList(agencyId, clientId, listId),
        removedCount: result.rowCount || 0
    };
}

export async function removeMembersByFilter(agencyId, clientId, listId, filterContext) {
    const list = await getLeadList(agencyId, clientId, listId);
    if (!list) throw notFoundError('List not found.');
    if (!filterContext || filterContext.emptyResult) {
        return { list, removedCount: 0 };
    }
    const { whereClause, filterParams, baseWithClause, filterJoins } = filterContext;
    const listParam = `$${filterParams.length + 1}`;
    const result = await pool.query(
        `${baseWithClause},
         matching_contacts AS (
             SELECT c.id
             FROM contacts c
             JOIN scoped_companies co ON c.company_id = co.id
             ${filterJoins}
             WHERE ${whereClause}
         )
         DELETE FROM lead_list_members llm
         USING matching_contacts mc
         WHERE llm.list_id = ${listParam}::bigint
           AND llm.contact_id = mc.id
         RETURNING llm.contact_id`,
        [...filterParams, listId]
    );
    return {
        list: await getLeadList(agencyId, clientId, listId),
        removedCount: result.rowCount || 0
    };
}

export async function listsForContact(agencyId, clientId, contactId) {
    const result = await pool.query(
        `SELECT ll.id, ll.name
         FROM lead_list_members llm
         JOIN lead_lists ll ON ll.id = llm.list_id
         WHERE llm.contact_id = $3
           AND ll.agency_id = $1
           AND ll.client_id = $2
         ORDER BY lower(ll.name), ll.id`,
        [agencyId, clientId, contactId]
    );
    return result.rows.map((row) => ({ id: row.id, name: row.name }));
}

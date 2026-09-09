/**
 * Lead list CRUD and membership mutations.
 *
 * Membership can be written from explicit contact IDs or from the same All Leads
 * filter snapshot used by delete / enrich-filtered (select-all-matching).
 */

import express from 'express';
import { verifyFirebaseToken as requireAuth } from '../middleware/auth.js';
import { resolveClientRow } from '../services/db/queries.js';
import { buildLeadListFilterContext } from './leads.js';
import {
    addMembersByFilter,
    addMembersByIds,
    createLeadList,
    deleteLeadList,
    getLeadList,
    listLeadLists,
    MAX_LEAD_LIST_CONTACT_IDS,
    parseContactIds,
    parseLeadListId,
    removeMembersByFilter,
    removeMembersByIds,
    renameLeadList
} from '../services/leadLists.js';

const router = express.Router();

function setNoStoreHeaders(res) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
}

function sendError(res, error, fallback) {
    const status = Number(error?.statusCode) || 500;
    if (status >= 500) {
        console.error(fallback, error?.message || error);
    }
    res.status(status).json({ error: status >= 500 ? fallback : (error?.message || fallback) });
}

async function resolveClient(req, res) {
    const row = await resolveClientRow(req.agencyId, req.params.clientId);
    if (!row) {
        res.status(404).json({ error: 'Client not found.' });
        return null;
    }
    return row;
}

function parseMembershipBody(body) {
    const selectAllMatching = body?.selectAllMatching === true;
    const contactIds = parseContactIds(body?.contactIds);
    const query = body?.query && typeof body.query === 'object' && !Array.isArray(body.query)
        ? body.query
        : {};

    if (selectAllMatching && contactIds.length > 0) {
        const error = new Error('Provide either contactIds or selectAllMatching, not both.');
        error.statusCode = 400;
        throw error;
    }

    if (!selectAllMatching && contactIds.length === 0) {
        const error = new Error('contactIds or selectAllMatching is required.');
        error.statusCode = 400;
        throw error;
    }

    if (!selectAllMatching && Array.isArray(body?.contactIds) && body.contactIds.length > MAX_LEAD_LIST_CONTACT_IDS) {
        const error = new Error(`Cannot update more than ${MAX_LEAD_LIST_CONTACT_IDS.toLocaleString()} leads at once.`);
        error.statusCode = 400;
        throw error;
    }

    return { selectAllMatching, contactIds, query };
}

router.get('/clients/:clientId/lead-lists', requireAuth, async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const client = await resolveClient(req, res);
        if (!client) return;
        const lists = await listLeadLists(req.agencyId, client.id);
        res.json({ lists });
    } catch (error) {
        sendError(res, error, 'Failed to list lead lists.');
    }
});

router.post('/clients/:clientId/lead-lists', requireAuth, async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const client = await resolveClient(req, res);
        if (!client) return;

        const name = req.body?.name;
        const selectAllMatching = req.body?.selectAllMatching === true;
        const contactIds = parseContactIds(req.body?.contactIds);
        const query = req.body?.query && typeof req.body.query === 'object' ? req.body.query : {};

        if (selectAllMatching && contactIds.length > 0) {
            return res.status(400).json({ error: 'Provide either contactIds or selectAllMatching, not both.' });
        }

        let filterContext = null;
        if (selectAllMatching) {
            filterContext = await buildLeadListFilterContext(req.agencyId, client.id, query);
        }

        const result = await createLeadList(req.agencyId, client.id, {
            name,
            contactIds: selectAllMatching ? [] : contactIds,
            filterContext
        });
        res.status(201).json(result);
    } catch (error) {
        sendError(res, error, 'Failed to create list.');
    }
});

router.patch('/clients/:clientId/lead-lists/:listId', requireAuth, async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const client = await resolveClient(req, res);
        if (!client) return;
        const listId = parseLeadListId(req.params.listId);
        if (!listId) return res.status(400).json({ error: 'Valid listId is required.' });
        const list = await renameLeadList(req.agencyId, client.id, listId, req.body?.name);
        res.json({ list });
    } catch (error) {
        sendError(res, error, 'Failed to rename list.');
    }
});

router.delete('/clients/:clientId/lead-lists/:listId', requireAuth, async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const client = await resolveClient(req, res);
        if (!client) return;
        const listId = parseLeadListId(req.params.listId);
        if (!listId) return res.status(400).json({ error: 'Valid listId is required.' });
        const ok = await deleteLeadList(req.agencyId, client.id, listId);
        if (!ok) return res.status(404).json({ error: 'List not found.' });
        res.json({ ok: true });
    } catch (error) {
        sendError(res, error, 'Failed to delete list.');
    }
});

router.post('/clients/:clientId/lead-lists/:listId/members', requireAuth, async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const client = await resolveClient(req, res);
        if (!client) return;
        const listId = parseLeadListId(req.params.listId);
        if (!listId) return res.status(400).json({ error: 'Valid listId is required.' });
        if (!(await getLeadList(req.agencyId, client.id, listId))) {
            return res.status(404).json({ error: 'List not found.' });
        }

        const { selectAllMatching, contactIds, query } = parseMembershipBody(req.body || {});
        const result = selectAllMatching
            ? await addMembersByFilter(
                req.agencyId,
                client.id,
                listId,
                await buildLeadListFilterContext(req.agencyId, client.id, query)
            )
            : await addMembersByIds(req.agencyId, client.id, listId, contactIds);
        res.json(result);
    } catch (error) {
        sendError(res, error, 'Failed to add leads to list.');
    }
});

router.post('/clients/:clientId/lead-lists/:listId/members/remove', requireAuth, async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const client = await resolveClient(req, res);
        if (!client) return;
        const listId = parseLeadListId(req.params.listId);
        if (!listId) return res.status(400).json({ error: 'Valid listId is required.' });
        if (!(await getLeadList(req.agencyId, client.id, listId))) {
            return res.status(404).json({ error: 'List not found.' });
        }

        const { selectAllMatching, contactIds, query } = parseMembershipBody(req.body || {});
        const result = selectAllMatching
            ? await removeMembersByFilter(
                req.agencyId,
                client.id,
                listId,
                await buildLeadListFilterContext(req.agencyId, client.id, query)
            )
            : await removeMembersByIds(req.agencyId, client.id, listId, contactIds);
        res.json(result);
    } catch (error) {
        sendError(res, error, 'Failed to remove leads from list.');
    }
});

export default router;

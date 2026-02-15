/**
 * Leads API endpoints (SQL-only, no Firestore)
 *
 * CANONICAL AGENCY IDENTIFIER RULE:
 * Firebase uid = agency_id directly, no mapping table.
 * All endpoints require Firebase ID token authentication.
 * agency_id is ALWAYS derived from verified token, never from client input.
 *
 * All data operations use Cloud SQL (Postgres) as the single source of truth.
 * No Firestore lead storage.
 */

import express from 'express';
import { verifyFirebaseToken } from '../middleware/auth.js';
import * as leadsService from '../services/leads.js';
import * as queries from '../services/db/queries.js';
import { pool } from '../lib/db.js';

const router = express.Router();

function safeDecodeURIComponent(value = '') {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function safeEncodeURIComponent(value = '') {
    try {
        return encodeURIComponent(value);
    } catch {
        return value;
    }
}

function buildClientMatchers(...values) {
    const textVariants = new Set();
    const slugVariants = new Set();
    const compactVariants = new Set();

    const addValue = (input) => {
        const raw = String(input || '').trim();
        if (!raw) return;

        const decoded = safeDecodeURIComponent(raw);
        const encodedRaw = safeEncodeURIComponent(raw);
        const encodedDecoded = safeEncodeURIComponent(decoded);

        const variants = [raw, decoded, encodedRaw, encodedDecoded]
            .map((variant) => String(variant || '').trim().toLowerCase())
            .filter(Boolean);

        for (const variant of variants) {
            textVariants.add(variant);

            const slug = variant
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '');
            if (slug) slugVariants.add(slug);

            const compact = variant.replace(/[^a-z0-9]+/g, '');
            if (compact) compactVariants.add(compact);
        }
    };

    values.forEach(addValue);

    return {
        textVariants: Array.from(textVariants),
        slugVariants: Array.from(slugVariants),
        compactVariants: Array.from(compactVariants),
        sets: {
            text: textVariants,
            slug: slugVariants,
            compact: compactVariants
        }
    };
}

function setsIntersect(leftSet, rightSet) {
    for (const value of leftSet) {
        if (rightSet.has(value)) return true;
    }
    return false;
}

function clientMatchersOverlap(left, right) {
    return setsIntersect(left.sets.text, right.sets.text)
        || setsIntersect(left.sets.slug, right.sets.slug)
        || setsIntersect(left.sets.compact, right.sets.compact);
}

/**
 * GET /leads
 *
 * Fetch contacts (leads) for the authenticated agency with optional filtering.
 *
 * Query parameters:
 *   - clientId: Client slug to resolve to numeric SQL client_id (required)
 *   - emailStatus: Filter by single email_status (valid, valid-risky, invalid, etc.)
 *   - emailStatusMulti: Filter by multiple email statuses (comma-separated, e.g., "valid,valid-risky")
 *   - roleType: Filter by role type (founder, dm, etc.)
 *   - search: Search term for domain, email, or founder name (general search)
 *   - fullName: Specific full name search (contains, for segments)
 *   - founderFilter: Filter founder existence (exists, not_found)
 *   - emailFilter: Filter email existence (exists, not_found)
 *   - createdAfter: Filter leads created after date (ISO 8601 format)
 *   - createdBefore: Filter leads created before date (ISO 8601 format)
 *   - limit: Max results (default 200, max 500)
 *   - offset: Pagination offset (default 0)
 *
 * Authorization: Bearer <idToken> (required)
 */
router.get('/leads', verifyFirebaseToken, async (req, res) => {
    try {
        const agencyId = req.agencyId;
        const {
            clientId: clientSlug,
            emailStatus,
            emailStatusMulti,
            roleType,
            search,
            fullName,
            founderFilter,
            emailFilter,
            createdAfter,
            createdBefore,
            instantlyCampaignId,
            limit = 200,
            offset = 0
        } = req.query;

        if (!clientSlug) {
            return res.status(400).json({ error: 'clientId parameter is required' });
        }

        // Resolve client slug to numeric SQL ID
        let clientId;
        try {
            clientId = await queries.getOrCreateClient(agencyId, clientSlug);
        } catch (error) {
            console.error('Failed to resolve client ID:', error);
            return res.status(500).json({ error: 'Failed to resolve client ID' });
        }

        const parsedLimit = Math.min(parseInt(limit, 10) || 200, 500);
        const parsedOffset = parseInt(offset, 10) || 0;

        // Build WHERE clause with filters
        let whereClause = 'c.agency_id = $1 AND co.client_id = $2';
        const params = [agencyId, clientId];
        let paramIndex = 3;

        // Single email status filter
        if (emailStatus) {
            if (emailStatus === 'not_run') {
                whereClause += ` AND (c.email_status IS NULL OR c.email_status = '')`;
            } else {
                whereClause += ` AND c.email_status = $${paramIndex}`;
                params.push(emailStatus);
                paramIndex++;
            }
        }

        // Multi-select email status filter (for segments)
        if (emailStatusMulti) {
            const statuses = emailStatusMulti.split(',').filter(s => s.trim());
            if (statuses.length > 0) {
                const placeholders = statuses.map((_, i) => `$${paramIndex + i}`).join(',');
                whereClause += ` AND c.email_status IN (${placeholders})`;
                params.push(...statuses);
                paramIndex += statuses.length;
            }
        }

        if (roleType) {
            whereClause += ` AND c.role_type = $${paramIndex}`;
            params.push(roleType);
            paramIndex++;
        }

        // General search filter
        if (search) {
            const searchTerm = `%${search.toLowerCase()}%`;
            whereClause += ` AND (
                LOWER(co.domain_normalized) LIKE $${paramIndex}
                OR LOWER(c.email) LIKE $${paramIndex}
                OR LOWER(c.full_name) LIKE $${paramIndex}
            )`;
            params.push(searchTerm);
            paramIndex++;
        }

        // Specific full name search (for segments)
        if (fullName) {
            const nameTerm = `%${fullName.toLowerCase()}%`;
            whereClause += ` AND LOWER(c.full_name) LIKE $${paramIndex}`;
            params.push(nameTerm);
            paramIndex++;
        }

        // Filter by founder existence
        if (founderFilter === 'exists') {
            whereClause += ` AND c.full_name IS NOT NULL AND c.full_name != '' AND LOWER(c.full_name) NOT LIKE '%not found%' AND LOWER(c.full_name) != 'not_found'`;
        } else if (founderFilter === 'not_found') {
            whereClause += ` AND (c.full_name IS NULL OR c.full_name = '' OR LOWER(c.full_name) LIKE '%not found%' OR LOWER(c.full_name) = 'not_found')`;
        }

        // Filter by email existence
        if (emailFilter === 'exists') {
            // Email finder ran (has status) and email found
            whereClause += ` AND c.email_status IS NOT NULL AND c.email_status != '' AND c.email IS NOT NULL AND c.email != '' AND LOWER(c.email) NOT LIKE '%not found%' AND LOWER(c.email) != 'not_found'`;
        } else if (emailFilter === 'not_found') {
            // Email finder ran (has status) but no email found
            whereClause += ` AND c.email_status IS NOT NULL AND c.email_status != '' AND (c.email IS NULL OR c.email = '')`;
        } else if (emailFilter === 'not_run') {
            // Email finder never ran (no status) AND no email exists (not backfilled from Instantly)
            whereClause += ` AND (c.email_status IS NULL OR c.email_status = '') AND (c.email IS NULL OR c.email = '')`;
        }

        // Date filters
        if (createdAfter) {
            whereClause += ` AND c.created_at >= $${paramIndex}::timestamp`;
            params.push(createdAfter);
            paramIndex++;
        }

        if (createdBefore) {
            whereClause += ` AND c.created_at <= $${paramIndex}::timestamp`;
            params.push(createdBefore);
            paramIndex++;
        }

        // Campaign filter (requires join with contact_instantly_campaigns and instantly_campaigns)
        let joinClause = '';
        if (instantlyCampaignId) {
            joinClause = `
                JOIN contact_instantly_campaigns cic ON cic.contact_id = c.id
                JOIN instantly_campaigns ic ON ic.id = cic.campaign_id
            `;
            whereClause += ` AND ic.instantly_campaign_id = $${paramIndex}`;
            params.push(instantlyCampaignId);
            paramIndex++;
        }

        // Get total count with filters applied
        const countQuery = `
            SELECT COUNT(*) as count
            FROM contacts c
            JOIN companies co ON c.company_id = co.id
            ${joinClause}
            WHERE ${whereClause}
        `;
        const countResult = await pool.query(countQuery, params);
        const total = parseInt(countResult.rows[0]?.count || 0, 10);

        // Fetch contacts with pagination and campaign data
        const contactsQuery = `
            SELECT
                c.id,
                c.agency_id,
                c.company_id,
                c.role_type,
                c.full_name,
                c.email,
                c.email_status,
                c.last_verified_at,
                c.last_contacted_at,
                c.confidence,
                c.personalization_first_line,
                c.job_id,
                c.created_at,
                c.updated_at,
                co.domain_normalized,
                (
                    SELECT json_agg(
                        json_build_object(
                            'campaignId', ic.instantly_campaign_id,
                            'campaignName', ic.name,
                            'addedAt', cic.added_at
                        )
                    )
                    FROM contact_instantly_campaigns cic
                    JOIN instantly_campaigns ic ON ic.id = cic.campaign_id
                    WHERE cic.contact_id = c.id
                ) as campaigns_data
            FROM contacts c
            JOIN companies co ON c.company_id = co.id
            ${joinClause}
            WHERE ${whereClause}
            ORDER BY c.created_at DESC
            LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
        `;
        params.push(parsedLimit, parsedOffset);

        const result = await pool.query(contactsQuery, params);

        const leads = result.rows.map((row) => ({
            id: row.id,
            domain: row.domain_normalized,
            email: row.email,
            founderName: row.full_name,
            roleType: row.role_type,
            status: row.email_status,
            verified: row.email_status === 'valid',
            confidence: row.confidence,
            lastVerifiedAt: row.last_verified_at,
            lastContactedAt: row.last_contacted_at,
            firstLine: row.personalization_first_line,
            jobId: row.job_id,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            campaignsData: row.campaigns_data || []
        }));

        res.json({
            leads,
            total,
            limit: parsedLimit,
            offset: parsedOffset,
            hasMore: parsedOffset + parsedLimit < total
        });
    } catch (error) {
        console.error('Error fetching leads:', error);
        res.status(500).json({ error: 'Failed to fetch leads' });
    }
});

/**
 * POST /leads/mark-sent
 *
 * Mark contacts as sent/exported by updating last_contacted_at.
 * This is the send-safety guardrail to prevent accidental resends.
 *
 * Request body:
 *   - contactIds: Array of contact IDs to mark as sent
 *   - emails: Array of email addresses to mark as sent (alternative)
 *
 * Authorization: Bearer <idToken> (required)
 */
router.post('/leads/mark-sent', verifyFirebaseToken, async (req, res) => {
    try {
        const agencyId = req.agencyId;
        const { contactIds, emails } = req.body || {};

        if (contactIds && Array.isArray(contactIds) && contactIds.length > 0) {
            const updated = await leadsService.markContactsAsSent(agencyId, contactIds);
            return res.json({
                count: updated.length,
                contacts: updated,
                method: 'contact_ids'
            });
        }

        if (emails && Array.isArray(emails) && emails.length > 0) {
            const updated = await leadsService.markEmailsAsSent(agencyId, emails);
            return res.json({
                count: updated.length,
                contacts: updated,
                method: 'emails'
            });
        }

        res.status(400).json({ error: 'contactIds or emails must be provided as non-empty arrays' });
    } catch (error) {
        console.error('Error marking contacts as sent:', error);
        res.status(500).json({ error: 'Failed to mark contacts as sent' });
    }
});

/**
 * GET /leads/companies
 *
 * Fetch companies (domains) for the authenticated agency with contact counts.
 *
 * Query parameters:
 *   - limit: Max results (default 500, max 1000)
 *   - offset: Pagination offset (default 0)
 *
 * Authorization: Bearer <idToken> (required)
 */
router.get('/leads/companies', verifyFirebaseToken, async (req, res) => {
    try {
        const agencyId = req.agencyId;
        const { limit = 500, offset = 0 } = req.query;

        const parsedLimit = Math.min(parseInt(limit, 10) || 500, 1000);
        const parsedOffset = parseInt(offset, 10) || 0;

        const companies = await leadsService.getCompaniesForAgency(agencyId, { limit: parsedLimit, offset: parsedOffset });

        // Get total count
        const countResult = await queries.pool.query(
            `SELECT COUNT(*) as count FROM companies WHERE agency_id = $1`,
            [agencyId]
        );
        const total = parseInt(countResult.rows[0]?.count || 0, 10);

        res.json({
            companies,
            total,
            limit: parsedLimit,
            offset: parsedOffset,
            hasMore: parsedOffset + parsedLimit < total
        });
    } catch (error) {
        console.error('Error fetching companies:', error);
        res.status(500).json({ error: 'Failed to fetch companies' });
    }
});

/**
 * GET /leads/stats
 *
 * Get summary statistics for authenticated agency's leads.
 *
 * Returns:
 *   - total_contacts: Total number of contacts
 *   - total_companies: Total number of unique companies
 *   - verified_emails: Contacts with valid email status
 *   - contacted_count: Contacts that have been sent to
 *   - untouched_count: Contacts never sent to
 *
 * Authorization: Bearer <idToken> (required)
 */
router.get('/leads/stats', verifyFirebaseToken, async (req, res) => {
    try {
        const agencyId = req.agencyId;
        const stats = await leadsService.getLeadStats(agencyId);

        res.json({
            stats,
            agencyId: req.auth.agencyId,
            email: req.auth.email
        });
    } catch (error) {
        console.error('Error fetching lead stats:', error);
        res.status(500).json({ error: 'Failed to fetch lead stats' });
    }
});

/**
 * GET /stats/companies-count
 *
 * Get total company count for authenticated agency.
 *
 * Returns:
 *   - count: Total number of companies
 *
 * Authorization: Bearer <idToken> (required)
 */
router.get('/stats/companies-count', verifyFirebaseToken, async (req, res) => {
    try {
        const agencyId = req.agencyId;
        const clientSlug = typeof req.query.clientId === 'string' ? req.query.clientId.trim() : '';
        const clientName = typeof req.query.clientName === 'string' ? req.query.clientName.trim() : '';
        const matchers = buildClientMatchers(clientSlug, clientName);
        console.log('[stats/companies-count] request', {
            agencyId,
            clientSlug,
            clientName,
            textVariants: matchers.textVariants,
            slugVariants: matchers.slugVariants,
            compactVariants: matchers.compactVariants
        });

        if (clientSlug) {
            const matchedResult = await pool.query(
                `
                    WITH client_candidates AS (
                        SELECT
                            id,
                            name,
                            LOWER(name) AS lower_name,
                            REPLACE(REPLACE(LOWER(name), '%40', '@'), '%2e', '.') AS decoded_name,
                            REGEXP_REPLACE(LOWER(name), '[^a-z0-9]+', '-', 'g') AS slug_name,
                            REGEXP_REPLACE(LOWER(name), '[^a-z0-9]+', '', 'g') AS compact_name,
                            REGEXP_REPLACE(REPLACE(REPLACE(LOWER(name), '%40', '@'), '%2e', '.'), '[^a-z0-9]+', '-', 'g') AS decoded_slug_name,
                            REGEXP_REPLACE(REPLACE(REPLACE(LOWER(name), '%40', '@'), '%2e', '.'), '[^a-z0-9]+', '', 'g') AS decoded_compact_name
                        FROM clients
                        WHERE agency_id = $1
                    ),
                    matched_clients AS (
                        SELECT id, name
                        FROM client_candidates
                        WHERE
                            lower_name = ANY($2::text[])
                            OR decoded_name = ANY($2::text[])
                            OR slug_name = ANY($3::text[])
                            OR decoded_slug_name = ANY($3::text[])
                            OR compact_name = ANY($4::text[])
                            OR decoded_compact_name = ANY($4::text[])
                    )
                    SELECT
                        COUNT(co.id)::int AS count,
                        COALESCE(
                            json_agg(
                                DISTINCT jsonb_build_object(
                                    'id', mc.id,
                                    'name', mc.name
                                )
                            ) FILTER (WHERE mc.id IS NOT NULL),
                            '[]'::json
                        ) AS matched_clients
                    FROM matched_clients mc
                    LEFT JOIN companies co
                        ON co.client_id = mc.id
                       AND co.agency_id = $1
                `,
                [agencyId, matchers.textVariants, matchers.slugVariants, matchers.compactVariants]
            );

            const matchedPayload = matchedResult.rows[0] || {};
            const count = parseInt(matchedPayload.count || 0, 10);
            const matchedClients = Array.isArray(matchedPayload.matched_clients)
                ? matchedPayload.matched_clients
                : [];

            if (matchedClients.length === 0) {
                const topClientsResult = await pool.query(
                    `
                        SELECT
                            cl.id,
                            cl.name,
                            COUNT(co.id)::int AS company_count
                        FROM clients cl
                        LEFT JOIN companies co
                            ON co.client_id = cl.id
                           AND co.agency_id = $1
                        WHERE cl.agency_id = $1
                        GROUP BY cl.id, cl.name
                        ORDER BY company_count DESC, cl.name ASC
                        LIMIT 10
                    `,
                    [agencyId]
                );
                console.warn('[stats/companies-count] no SQL client match', {
                    agencyId,
                    clientSlug,
                    clientName,
                    textVariants: matchers.textVariants,
                    slugVariants: matchers.slugVariants,
                    compactVariants: matchers.compactVariants,
                    topClients: topClientsResult.rows
                });
                return res.json({
                    count: 0,
                    clientId: clientSlug,
                    matchedClients: [],
                    debug: {
                        reason: 'no_sql_client_match',
                        topClients: topClientsResult.rows
                    }
                });
            }

            console.log('[stats/companies-count] scoped result', {
                agencyId,
                clientSlug,
                clientName,
                matchedClients,
                count,
            });
            return res.json({
                count,
                clientId: clientSlug,
                matchedClients
            });
        }

        const countResult = await pool.query(
            `SELECT COUNT(*) as count FROM companies WHERE agency_id = $1`,
            [agencyId]
        );

        const count = parseInt(countResult.rows[0]?.count || 0, 10);
        console.log('[stats/companies-count] agency-wide result', {
            agencyId,
            count
        });
        res.json({ count });
    } catch (error) {
        console.error('Error fetching companies count:', error);
        res.status(500).json({ error: 'Failed to fetch companies count' });
    }
});

/**
 * GET /stats/companies-counts
 *
 * Get company counts for multiple client slugs in one request.
 *
 * Query parameters:
 *   - clientIds: Comma-separated client slugs (required)
 *
 * Returns:
 *   - counts: Object map of { [clientSlug]: number }
 *
 * Authorization: Bearer <idToken> (required)
 */
router.get('/stats/companies-counts', verifyFirebaseToken, async (req, res) => {
    try {
        const agencyId = req.agencyId;
        const rawClientIds = typeof req.query.clientIds === 'string'
            ? req.query.clientIds
            : Array.isArray(req.query.clientIds)
                ? req.query.clientIds.join(',')
                : '';

        const clientSlugs = [...new Set(
            rawClientIds
                .split(',')
                .map((value) => value.trim())
                .filter(Boolean)
        )];

        if (clientSlugs.length === 0) {
            return res.json({ counts: {} });
        }

        const result = await pool.query(
            `
                SELECT
                    cl.id,
                    cl.name AS client_name,
                    COUNT(co.id)::int AS count
                FROM clients cl
                LEFT JOIN companies co
                    ON co.client_id = cl.id
                    AND co.agency_id = $1
                WHERE cl.agency_id = $1
                GROUP BY cl.id, cl.name
            `,
            [agencyId]
        );

        const counts = clientSlugs.reduce((acc, slug) => {
            acc[slug] = 0;
            return acc;
        }, {});

        const requestedMatchers = clientSlugs.map((slug) => ({
            slug,
            matchers: buildClientMatchers(slug)
        }));
        const sqlClients = result.rows.map((row) => ({
            id: row.id,
            name: row.client_name,
            count: Number(row.count) || 0,
            matchers: buildClientMatchers(row.client_name)
        }));

        for (const requested of requestedMatchers) {
            let totalCount = 0;
            for (const sqlClient of sqlClients) {
                if (clientMatchersOverlap(requested.matchers, sqlClient.matchers)) {
                    totalCount += sqlClient.count;
                }
            }
            counts[requested.slug] = totalCount;
        }

        const unmatched = requestedMatchers
            .filter((requested) => counts[requested.slug] === 0)
            .map((requested) => requested.slug);
        if (unmatched.length > 0) {
            console.warn('[stats/companies-counts] unmatched slugs', {
                agencyId,
                unmatched,
                topClients: sqlClients
                    .sort((a, b) => b.count - a.count)
                    .slice(0, 10)
                    .map((client) => ({
                        id: client.id,
                        name: client.name,
                        company_count: client.count
                    }))
            });
        }

        res.json({ counts });
    } catch (error) {
        console.error('Error fetching companies counts by client:', error);
        res.status(500).json({ error: 'Failed to fetch companies counts' });
    }
});

/**
 * GET /instantly-campaigns
 *
 * Fetch Instantly campaigns for a specific client.
 *
 * Query parameters:
 *   - clientId: Client slug to resolve to numeric SQL client_id (required)
 *
 * Returns:
 *   - campaigns: Array of { id: instantly_campaign_id, name: campaign_name }
 *
 * Authorization: Bearer <idToken> (required)
 */
router.get('/instantly-campaigns', verifyFirebaseToken, async (req, res) => {
    try {
        const agencyId = req.agencyId;
        const { clientId: clientSlug } = req.query;

        if (!clientSlug) {
            return res.status(400).json({ error: 'clientId parameter is required' });
        }

        // Resolve client slug to numeric SQL ID
        let clientId;
        try {
            clientId = await queries.getOrCreateClient(agencyId, clientSlug);
        } catch (error) {
            console.error('Failed to resolve client ID:', error);
            return res.status(500).json({ error: 'Failed to resolve client ID' });
        }

        // Fetch campaigns from instantly_campaigns table
        const campaignsQuery = `
            SELECT 
                instantly_campaign_id as id,
                name
            FROM instantly_campaigns
            WHERE agency_id = $1 AND client_id = $2
            ORDER BY created_at DESC
        `;

        const result = await pool.query(campaignsQuery, [agencyId, clientId]);

        res.json({
            campaigns: result.rows
        });
    } catch (error) {
        console.error('Error fetching instantly campaigns:', error);
        res.status(500).json({ error: 'Failed to fetch campaigns' });
    }
});

export default router;

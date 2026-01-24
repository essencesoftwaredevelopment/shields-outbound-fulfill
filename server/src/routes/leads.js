import express from 'express';
import { pool } from '../config/db.js';

const router = express.Router();

// GET /leads?clientId=X&limit=200&offset=0&emailStatus=valid
// Returns leads for a specific client with optional pagination and filtering
router.get('/leads', async (req, res) => {
    try {
        const { clientId, limit = 200, offset = 0, emailStatus } = req.query;

        if (!clientId) {
            return res.status(400).json({ error: 'Missing clientId' });
        }

        const parsedLimit = Math.min(parseInt(limit, 10) || 200, 500);
        const parsedOffset = parseInt(offset, 10) || 0;

        let query = `
            SELECT 
                c.id,
                c.email,
                c.full_name as founder_name,
                c.email_status,
                c.confidence,
                c.last_verified_at,
                c.created_at,
                c.updated_at,
                co.domain_normalized as domain
            FROM contacts c
            JOIN companies co ON c.company_id = co.id
            WHERE co.client_id = $1 AND c.role_type = 'founder'
        `;

        const params = [clientId];
        let paramIndex = 2;

        if (emailStatus) {
            query += ` AND c.email_status = $${paramIndex}`;
            params.push(emailStatus);
            paramIndex++;
        }

        // Get total count
        const countQuery = query.replace(
            /SELECT.*FROM/s,
            'SELECT COUNT(*) as count FROM'
        ).replace(/ORDER BY.*/, '').replace(/LIMIT.*/, '').replace(/OFFSET.*/, '');

        const countResult = await pool.query(countQuery, params.slice(0, paramIndex - 1));
        const total = parseInt(countResult.rows[0].count, 10);

        // Get paginated results
        query += ` ORDER BY c.updated_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(parsedLimit, parsedOffset);

        const result = await pool.query(query, params);

        const leads = result.rows.map((row) => ({
            id: row.email || row.domain, // Use email as ID if available, otherwise domain
            domain: row.domain,
            email: row.email,
            founderName: row.founder_name,
            status: row.email_status,
            verified: row.email_status === 'valid',
            confidence: row.confidence,
            updatedAt: row.updated_at ? new Date(row.updated_at).toLocaleString() : '',
            campaigns: [] // Campaigns relationship would need to be stored separately
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

export default router;

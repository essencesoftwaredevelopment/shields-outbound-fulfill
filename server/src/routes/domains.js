/**
 * Domains API endpoints
 *
 * Provides domain analysis and statistics for the personalizer feature.
 */

import express from 'express';
import { verifyFirebaseToken } from '../middleware/auth.js';
import * as queries from '../services/db/queries.js';
import { pool } from '../lib/db.js';

const router = express.Router();

/**
 * POST /api/domains/analyze
 *
 * Analyze domains to provide statistics about run status, enrichment data
 *
 * Body parameters:
 *   - clientId: Client slug (required)
 *   - domains: Array of domain strings to analyze (required)
 *
 * Returns:
 *   - run: Number of domains that have been processed (have job_id)
 *   - notRun: Number of domains never processed
 *   - withFounders: Number of domains with full_name populated
 *   - withEmails: Number of domains with email populated
 *   - withPersonalization: Number of domains with personalization_first_line populated
 *
 * Authorization: Bearer <idToken> (required)
 */
router.post('/domains/analyze', verifyFirebaseToken, async (req, res) => {
    try {
        const agencyId = req.agencyId;
        const { clientId: clientSlug, domains } = req.body;

        if (!clientSlug) {
            return res.status(400).json({ error: 'clientId is required' });
        }

        if (!domains || !Array.isArray(domains) || domains.length === 0) {
            return res.status(400).json({ error: 'domains array is required' });
        }

        // Resolve client slug to numeric SQL ID
        let clientId;
        try {
            clientId = await queries.getOrCreateClient(agencyId, clientSlug);
        } catch (error) {
            console.error('Failed to resolve client ID:', error);
            return res.status(500).json({ error: 'Failed to resolve client ID' });
        }

        // Query the database to get statistics about these domains
        const query = `
            SELECT 
                COUNT(DISTINCT CASE 
                    WHEN EXISTS (
                        SELECT 1 FROM contacts ct 
                        WHERE ct.company_id = co.id 
                        AND ct.job_id IS NOT NULL
                    ) THEN co.domain_normalized 
                END) as run_count,
                COUNT(DISTINCT CASE 
                    WHEN NOT EXISTS (
                        SELECT 1 FROM contacts ct 
                        WHERE ct.company_id = co.id 
                        AND ct.job_id IS NOT NULL
                    ) THEN co.domain_normalized 
                END) as not_run_count,
                COUNT(DISTINCT CASE 
                    WHEN EXISTS (
                        SELECT 1 FROM contacts ct 
                        WHERE ct.company_id = co.id 
                        AND ct.full_name IS NOT NULL 
                        AND ct.full_name != ''
                        AND ct.job_id IS NOT NULL
                    ) THEN co.domain_normalized 
                END) as with_founders_count,
                COUNT(DISTINCT CASE 
                    WHEN EXISTS (
                        SELECT 1 FROM contacts ct 
                        WHERE ct.company_id = co.id 
                        AND ct.email IS NOT NULL 
                        AND ct.email != ''
                        AND ct.job_id IS NOT NULL
                    ) THEN co.domain_normalized 
                END) as with_emails_count,
                COUNT(DISTINCT CASE 
                    WHEN EXISTS (
                        SELECT 1 FROM contacts ct 
                        WHERE ct.company_id = co.id 
                        AND ct.personalization_first_line IS NOT NULL 
                        AND ct.personalization_first_line != ''
                        AND ct.job_id IS NOT NULL
                    ) THEN co.domain_normalized 
                END) as with_personalization_count
            FROM companies co
            WHERE co.agency_id = $1 
                AND co.client_id = $2 
                AND co.domain_normalized = ANY($3::text[])
        `;

        const result = await pool.query(query, [agencyId, clientId, domains]);
        const stats = result.rows[0];

        res.json({
            run: parseInt(stats.run_count) || 0,
            notRun: parseInt(stats.not_run_count) || 0,
            withFounders: parseInt(stats.with_founders_count) || 0,
            withEmails: parseInt(stats.with_emails_count) || 0,
            withPersonalization: parseInt(stats.with_personalization_count) || 0
        });

    } catch (error) {
        console.error('Domain analysis error:', error);
        res.status(500).json({ error: 'Failed to analyze domains' });
    }
});

export default router;

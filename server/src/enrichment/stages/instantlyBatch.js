/**
 * Mid-run Instantly auto-add: after personalization, push this batch's leads that
 * pass the job's checklist (email status, optional first line) to the chosen
 * campaign, with the mapping the user set when starting the job.
 *
 * Config lives on the job row (jobs.options.autoInstantly), set at job creation:
 *   { campaignId, campaignName?, columnMapping, customVariables, skipOptions,
 *     includeValid, includeRisky, requireFirstLine }
 *
 * Best-effort like the Enrow fallback: an Instantly problem is logged on the
 * job and skipped, never failing the batch. Added leads are recorded in
 * contact_instantly_campaigns, and candidates already in the campaign are
 * excluded, so a retried step or a resume never adds the same lead twice and a
 * failed push is retried on the next resume.
 */
import { pool } from '../../config/db.js';
import { getJobById, listAutoInstantlyCandidates } from '../../services/db/jobs.js';
import {
    INSTANTLY_UPLOAD_BATCH_SIZE,
    buildInstantlyLead,
    addLeadsToInstantlyCampaign,
    getSqlCampaignId,
    trackContactsInCampaign
} from '../../services/instantlyUpload.js';
import { setJobActivity } from '../persist.js';

async function reportActivity(ctx, message) {
    console.log(`[${ctx.jobId}] [instantly] ${message}`);
    try {
        await setJobActivity(ctx.jobId, ctx.agencyId, message);
    } catch {
        // activity text is cosmetic
    }
}

async function getClientInstantlyKey(agencyId, clientId) {
    const result = await pool.query(
        'SELECT instantly_key FROM clients WHERE id = $1 AND agency_id = $2',
        [clientId, agencyId]
    );
    return String(result.rows[0]?.instantly_key || '').trim();
}

/** Running totals on the job, for the UI and debugging. Single atomic UPDATE. */
async function recordAutoAddStats(jobId, agencyId, { added, failed, error }) {
    await pool.query(
        `UPDATE jobs SET
            options = jsonb_set(
                COALESCE(options, '{}'::jsonb),
                '{autoInstantlyStats}',
                jsonb_build_object(
                    'added', COALESCE((options->'autoInstantlyStats'->>'added')::int, 0) + $3,
                    'failed', COALESCE((options->'autoInstantlyStats'->>'failed')::int, 0) + $4,
                    'lastError', COALESCE($5, options->'autoInstantlyStats'->>'lastError'),
                    'updatedAt', NOW()
                )
            ),
            updated_at = NOW()
         WHERE id = $1 AND agency_id = $2`,
        [jobId, agencyId, added, failed, error]
    );
}

/** @param {unknown} jobRow */
export function autoInstantlyConfigFromJob(jobRow) {
    const config = jobRow?.options?.autoInstantly;
    return config && typeof config === 'object' && config.campaignId ? config : null;
}

/**
 * @param {import('../context.js').EnrichmentContext} ctx
 * @param {string[] | null} batchDomains null = whole job (PM2)
 * @returns {Promise<{ skipped?: boolean, added?: number, failed?: number }>}
 */
export async function runInstantlyAutoAddBatch(ctx, batchDomains) {
    const jobRow = await getJobById(ctx.jobId, ctx.agencyId);
    const config = autoInstantlyConfigFromJob(jobRow);
    if (!config) return { skipped: true };

    const instantlyKey = await getClientInstantlyKey(ctx.agencyId, ctx.clientId);
    if (!instantlyKey) {
        await reportActivity(ctx, 'Instantly auto-add skipped: this client has no Instantly API key.');
        return { skipped: true };
    }

    const sqlCampaignId = await getSqlCampaignId(ctx.agencyId, config.campaignId);
    const candidates = await listAutoInstantlyCandidates(ctx.jobId, {
        domains: batchDomains,
        includeValid: config.includeValid !== false,
        includeRisky: config.includeRisky === true,
        requireFirstLine: config.requireFirstLine !== false,
        sqlCampaignId
    });
    if (!candidates.length) return { added: 0, failed: 0 };
    if (!sqlCampaignId) {
        // Without the synced campaign row the add can't be recorded, so a retry
        // may re-send; Instantly itself de-duplicates within a campaign.
        console.warn(`[${ctx.jobId}] [instantly] campaign ${config.campaignId} not synced — adds won't be tracked`);
    }

    let added = 0;
    let failed = 0;
    let lastError = null;
    for (let i = 0; i < candidates.length; i += INSTANTLY_UPLOAD_BATCH_SIZE) {
        const chunk = candidates.slice(i, i + INSTANTLY_UPLOAD_BATCH_SIZE);
        const leads = chunk.map((row) => buildInstantlyLead(row, config.columnMapping, config.customVariables));
        try {
            await addLeadsToInstantlyCampaign({
                instantlyKey,
                campaignId: config.campaignId,
                leads,
                skipOptions: config.skipOptions
            });
            added += chunk.length;
            if (sqlCampaignId) {
                await trackContactsInCampaign({
                    contactIds: chunk.map((row) => row.contact_id),
                    sqlCampaignId,
                    jobId: ctx.jobId,
                    uploadSource: 'pipeline'
                });
            }
        } catch (err) {
            failed += chunk.length;
            lastError = err?.code === 'INSTANTLY_UNAUTHORIZED'
                ? 'Instantly rejected the API key'
                : String(err?.message || err).slice(0, 200);
            console.error(`[${ctx.jobId}] [instantly] add failed: ${lastError}`);
            // A bad key fails every chunk the same way: stop here.
            if (err?.code === 'INSTANTLY_UNAUTHORIZED') {
                failed += candidates.length - (i + chunk.length);
                break;
            }
        }
    }

    await recordAutoAddStats(ctx.jobId, ctx.agencyId, { added, failed, error: lastError });
    const campaignLabel = config.campaignName ? `"${config.campaignName}"` : 'the campaign';
    await reportActivity(
        ctx,
        failed
            ? `Instantly: added ${added} lead(s) to ${campaignLabel}; ${failed} failed (${lastError}) — resume the job to retry them.`
            : `Instantly: added ${added} lead(s) to ${campaignLabel}.`
    );
    return { added, failed };
}

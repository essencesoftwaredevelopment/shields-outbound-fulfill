#!/usr/bin/env node
/**
 * Vulcan: seed interested-autoresponder prompts + backfill drafts for existing
 * lead_interested events.
 *
 * Usage (from server/):
 *   node src/scripts/backfill-vulcan-interested-drafts.js
 *   node src/scripts/backfill-vulcan-interested-drafts.js --dry-run
 *   node src/scripts/backfill-vulcan-interested-drafts.js --prompts-only
 *   node src/scripts/backfill-vulcan-interested-drafts.js --drafts-only
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '../..');
const WORKSPACE_ROOT = path.resolve(SERVER_ROOT, '..');

for (const candidate of [
    path.join(SERVER_ROOT, '.secrets', '.env'),
    path.join(SERVER_ROOT, '.env'),
    path.join(WORKSPACE_ROOT, '.env.local'),
    path.join(WORKSPACE_ROOT, '.env')
]) {
    if (fs.existsSync(candidate)) {
        dotenv.config({ path: candidate, override: false });
    }
}

const { pool } = await import('../config/db.js');
const { createInterestedAutoResponderDraftFromEvent } = await import('../services/interestedAutoResponder.js');

const VULCAN_CLIENT_ID = 27;
const VULCAN_AGENCY_ID = 'efddb63d-a4c9-44d9-a204-baa052fd0fd8';
const VULCAN_CLIENT_SLUG = 'vulcan-digital';
const INSTANTLY_API_BASE_URL = 'https://api.instantly.ai';
const PROMPT_PATH = path.join(__dirname, 'vulcan-interested-prompt.txt');

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const promptsOnly = args.has('--prompts-only');
const draftsOnly = args.has('--drafts-only');

function log(...parts) {
    console.log(`[vulcan-backfill]${dryRun ? ' [dry-run]' : ''}`, ...parts);
}

async function instantlyGet(apiKey, apiPath) {
    const response = await fetch(`${INSTANTLY_API_BASE_URL}${apiPath}`, {
        method: 'GET',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: 'application/json'
        }
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Instantly GET ${apiPath} failed (${response.status}): ${text.slice(0, 300)}`);
    }
    if (response.status === 204) return null;
    return response.json();
}

function extractEmailItems(payload) {
    if (!payload) return [];
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload.items)) return payload.items;
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.emails)) return payload.emails;
    return [];
}

/**
 * Prefer the lead's inbound reply (ue_type=2). Fall back to latest thread email.
 * Instantly reply API needs: reply_to_uuid = email.id, eaccount = sending account.
 */
function pickThreadEmail(emails) {
    const list = (emails || []).filter((e) => e && (e.id || e.uuid));
    if (!list.length) return null;

    const received = list.filter((e) => Number(e.ue_type) === 2);
    const pool = received.length ? received : list;
    pool.sort((a, b) => {
        const at = new Date(a.timestamp_email || a.timestamp_created || a.created_at || 0).getTime();
        const bt = new Date(b.timestamp_email || b.timestamp_created || b.created_at || 0).getTime();
        return bt - at;
    });
    return pool[0];
}

async function ensurePrompts(systemPrompt) {
    const campaigns = await pool.query(
        `SELECT id, name FROM instantly_campaigns WHERE client_id = $1 ORDER BY id`,
        [VULCAN_CLIENT_ID]
    );

    for (const campaign of campaigns.rows) {
        const existing = await pool.query(
            `SELECT id, active, version FROM interested_autoresponder_prompts
             WHERE client_id = $1 AND campaign_id = $2
             ORDER BY id DESC LIMIT 1`,
            [VULCAN_CLIENT_ID, campaign.id]
        );

        if (existing.rows[0]?.active) {
            log(`prompt already active for campaign=${campaign.id} (${campaign.name}) id=${existing.rows[0].id}`);
            continue;
        }

        if (dryRun) {
            log(`would upsert prompt for campaign=${campaign.id} (${campaign.name})`);
            continue;
        }

        if (existing.rows[0]) {
            await pool.query(
                `UPDATE interested_autoresponder_prompts
                 SET system_prompt = $1, active = TRUE, version = 'v1', updated_at = NOW()
                 WHERE id = $2`,
                [systemPrompt, existing.rows[0].id]
            );
            log(`reactivated prompt id=${existing.rows[0].id} campaign=${campaign.name}`);
        } else {
            // deactivate any other active prompts for this campaign first (unique-ish safety)
            await pool.query(
                `UPDATE interested_autoresponder_prompts
                 SET active = FALSE, updated_at = NOW()
                 WHERE client_id = $1 AND campaign_id = $2 AND active = TRUE`,
                [VULCAN_CLIENT_ID, campaign.id]
            );
            const inserted = await pool.query(
                `INSERT INTO interested_autoresponder_prompts (
                    agency_id, client_id, campaign_id, version, system_prompt, active
                 ) VALUES ($1, $2, $3, 'v1', $4, TRUE)
                 RETURNING id`,
                [VULCAN_AGENCY_ID, VULCAN_CLIENT_ID, campaign.id, systemPrompt]
            );
            log(`inserted prompt id=${inserted.rows[0].id} campaign=${campaign.name}`);
        }
    }
}

async function hydrateThreadMetadata(apiKey, { eventId, contactId, campaignId, leadEmail }) {
    const params = new URLSearchParams({
        lead: leadEmail,
        limit: '20'
    });
    const payload = await instantlyGet(apiKey, `/api/v2/emails?${params.toString()}`);
    const emails = extractEmailItems(payload);
    const picked = pickThreadEmail(emails);

    if (!picked) {
        return { ok: false, reason: 'no_emails_in_unibox' };
    }

    const replyToUuid = String(picked.id || picked.uuid);
    const eaccount = String(picked.eaccount || '').trim();
    const subject = picked.subject || picked.email_subject || null;
    const messageText = picked.body?.text
        || picked.body_text
        || picked.content_preview
        || picked.snippet
        || picked.text
        || null;

    if (!replyToUuid || !eaccount) {
        return {
            ok: false,
            reason: 'incomplete_email_fields',
            replyToUuid,
            eaccount,
            emailCount: emails.length
        };
    }

    if (dryRun) {
        log(`would hydrate event=${eventId} reply_to_uuid=${replyToUuid} eaccount=${eaccount}`);
        return { ok: true, replyToUuid, eaccount, dryRun: true };
    }

    await pool.query(
        `UPDATE contact_instantly_events
         SET reply_to_uuid = COALESCE(reply_to_uuid, $2),
             email_account = COALESCE(email_account, $3),
             message_text = COALESCE(NULLIF(message_text, ''), $4),
             payload = COALESCE(payload, '{}'::jsonb)
                || jsonb_build_object(
                    'subject', COALESCE(payload->>'subject', $5::text),
                    'hydrated_from', 'vulcan_interested_backfill',
                    'hydrated_email_id', $2::text
                )
         WHERE id = $1`,
        [eventId, replyToUuid, eaccount, messageText, subject]
    );

    // Also insert a reply_received row so thread metadata helpers prefer the inbound message.
    const fingerprint = `backfill:reply_received:${contactId}:${campaignId}:${replyToUuid}`;
    await pool.query(
        `INSERT INTO contact_instantly_events (
            agency_id, client_id, contact_id, campaign_id, event_type,
            lead_email, email_account, message_text, reply_to_uuid,
            event_timestamp, fingerprint, source, payload
         )
         SELECT e.agency_id, e.client_id, e.contact_id, e.campaign_id, 'reply_received',
                e.lead_email, $2, $3, $4,
                COALESCE(e.event_timestamp, NOW()), $6, 'backfill',
                jsonb_build_object(
                    'subject', $5::text,
                    'hydrated_from', 'vulcan_interested_backfill',
                    'source_interested_event_id', e.id
                )
         FROM contact_instantly_events e
         WHERE e.id = $1
           AND NOT EXISTS (
               SELECT 1 FROM contact_instantly_events r
               WHERE r.fingerprint = $6
           )`,
        [eventId, eaccount, messageText, replyToUuid, subject, fingerprint]
    );

    return { ok: true, replyToUuid, eaccount, contactId, campaignId };
}

async function backfillDrafts(apiKey) {
    const leads = await pool.query(
        `SELECT e.id AS event_id,
                e.contact_id,
                e.campaign_id,
                e.lead_email,
                cic.instantly_lead_id,
                co.domain_normalized
         FROM contact_instantly_events e
         JOIN contacts c ON c.id = e.contact_id
         LEFT JOIN companies co ON co.id = c.company_id
         LEFT JOIN contact_instantly_campaigns cic
           ON cic.contact_id = e.contact_id AND cic.campaign_id = e.campaign_id
         WHERE e.client_id = $1
           AND e.event_type = 'lead_interested'
         ORDER BY e.id`,
        [VULCAN_CLIENT_ID]
    );

    log(`found ${leads.rows.length} lead_interested event(s)`);

    const results = [];
    for (const row of leads.rows) {
        log(`--- ${row.lead_email} domain=${row.domain_normalized || '?'} event=${row.event_id}`);

        const hydrate = await hydrateThreadMetadata(apiKey, {
            eventId: row.event_id,
            contactId: row.contact_id,
            campaignId: row.campaign_id,
            leadEmail: row.lead_email
        });

        if (!hydrate.ok) {
            log(`hydrate failed: ${hydrate.reason}`, hydrate);
            results.push({ email: row.lead_email, ok: false, stage: 'hydrate', ...hydrate });
            continue;
        }

        if (dryRun) {
            log(`would create draft for contact=${row.contact_id}`);
            results.push({ email: row.lead_email, ok: true, stage: 'dry-run' });
            continue;
        }

        const draft = await createInterestedAutoResponderDraftFromEvent({
            agencyId: VULCAN_AGENCY_ID,
            clientSlug: VULCAN_CLIENT_SLUG,
            clientId: VULCAN_CLIENT_ID,
            campaignId: row.campaign_id,
            contactId: row.contact_id,
            instantlyLeadId: row.instantly_lead_id,
            sourceEventId: row.event_id,
            leadEmail: row.lead_email,
            logger: (msg) => log(msg)
        });

        log(`draft result:`, draft);
        results.push({ email: row.lead_email, ok: Boolean(draft.created), stage: 'draft', ...draft });
    }

    return results;
}

async function main() {
    const systemPrompt = fs.readFileSync(PROMPT_PATH, 'utf8').trim();
    if (!systemPrompt) throw new Error(`Empty prompt at ${PROMPT_PATH}`);

    const clientRow = await pool.query(
        `SELECT id, slug, instantly_key FROM clients WHERE id = $1`,
        [VULCAN_CLIENT_ID]
    );
    if (!clientRow.rows[0]) throw new Error(`Client ${VULCAN_CLIENT_ID} not found`);
    const instantlyKey = clientRow.rows[0].instantly_key;
    if (!instantlyKey && !promptsOnly) {
        throw new Error('Vulcan client has no instantly_key');
    }

    if (!draftsOnly) {
        log('ensuring interested-autoresponder prompts…');
        await ensurePrompts(systemPrompt);
    }

    if (!promptsOnly) {
        log('hydrating Unibox thread metadata + creating drafts…');
        const results = await backfillDrafts(instantlyKey);
        const created = results.filter((r) => r.created || (r.ok && r.stage === 'dry-run')).length;
        const failed = results.filter((r) => !r.ok && r.stage !== 'dry-run').length;
        log(`done. created/ok=${created} failed=${failed}`);
        console.log(JSON.stringify(results, null, 2));
    }
}

main()
    .catch((err) => {
        console.error('[vulcan-backfill] fatal:', err);
        process.exitCode = 1;
    })
    .finally(async () => {
        await pool.end().catch(() => {});
    });

import fs from 'fs';
import { parse as csvParse } from 'csv-parse';
import { pool } from '../config/db.js';

function getLeadRef(uid, clientId, domain) {
    return firestore
        .collection('users').doc(uid)
        .collection('clients').doc(clientId)
        .collection('leads').doc(domain.toLowerCase());
}

async function ensureCompanyId(clientId, domain) {
    const normalized = domain.toLowerCase();
    const { rows } = await pool.query(
        `insert into companies (client_id, domain_normalized)
         values ($1, $2)
         on conflict (client_id, domain_normalized)
         do update set updated_at = now()
         returning id`,
        [clientId, normalized]
    );
    return rows[0].id;
}

async function upsertContact({ companyId, roleType = 'founder', fullName = null, email = null, emailStatus = null, confidence = null, lastVerifiedAt = null }) {
    const params = [companyId, roleType, fullName, email, emailStatus, confidence, lastVerifiedAt];
    const query = `
        insert into contacts (company_id, role_type, full_name, email, email_status, confidence, last_verified_at)
        values ($1, $2, $3, $4, $5, $6, $7)
        on conflict (company_id, role_type) do update set
            full_name = coalesce(excluded.full_name, contacts.full_name),
            email = coalesce(excluded.email, contacts.email),
            email_status = coalesce(excluded.email_status, contacts.email_status),
            confidence = coalesce(excluded.confidence, contacts.confidence),
            last_verified_at = coalesce(excluded.last_verified_at, contacts.last_verified_at),
            updated_at = now();
    `;

    try {
        await pool.query(query, params);
    } catch (err) {
        // Handle unique(email) conflicts by updating the existing row keyed by email
        if (err?.code === '23505' && email) {
            await pool.query(
                `update contacts
                 set full_name = coalesce($1, full_name),
                     email_status = coalesce($2, email_status),
                     confidence = coalesce($3, confidence),
                     last_verified_at = coalesce($4, last_verified_at),
                     updated_at = now()
                 where email = $5`,
                [fullName, emailStatus, confidence, lastVerifiedAt, email]
            );
            return;
        }
        throw err;
    }
}

// Map lookup statuses from email finder to valid database email_status values
function normalizeEmailStatus(rawStatus) {
    if (!rawStatus) return null;
    const status = String(rawStatus).toLowerCase().trim();
    
    // If already a valid status, keep it
    if (['valid', 'risky', 'invalid', 'unknown'].includes(status)) {
        return status;
    }
    
    // Map email finder statuses to database constraints
    if (status === 'found') return 'valid'; // found emails are assumed valid
    if (status === 'not_found') return 'invalid'; // not found means invalid
    if (status.startsWith('error')) return 'unknown'; // errors are unknown
    if (status === 'skipped_no_founder') return null; // skip rows without founder
    
    // Default unknown for anything else
    return 'unknown';
}

function buildContactPayload(row, type) {
    const domain = String(row.domain || '').trim().toLowerCase();
    const founderName = String(row.founder_name || row.full_name || row.name || '').trim() || null;
    const confidence = row.confidence ? Number(row.confidence) : null;
    const email = String(row.email || '').trim() || null;
    const lookupStatus = String(row.lookup_status || '').trim() || null;
    const emailStatus = String(row.email_status || lookupStatus || '').trim() || null;

    if (!domain) return null;

    if (type === 'founders') {
        return { domain, roleType: 'founder', fullName: founderName, confidence: Number.isFinite(confidence) ? confidence : null };
    }
    if (type === 'emails') {
        return { domain, roleType: 'founder', fullName: founderName, email, emailStatus: normalizeEmailStatus(lookupStatus), confidence: Number.isFinite(confidence) ? confidence : null };
    }
    if (type === 'verification') {
        return { domain, roleType: 'founder', fullName: founderName, email, emailStatus: normalizeEmailStatus(emailStatus), lastVerifiedAt: emailStatus ? new Date().toISOString() : null };
    }
    if (type === 'personalization') {
        return { domain, roleType: 'founder' }; // personalization does not mutate contact fields here
    }
    return { domain, roleType: 'founder', fullName: founderName };
}

export async function upsertLead(uid, clientId, domain, data) {
    if (!clientId || !domain) return;
    const companyId = await ensureCompanyId(clientId, domain);
    const fullName = typeof data?.name === 'string' ? data.name : null;
    const email = typeof data?.email === 'string' ? data.email : null;
    await upsertContact({ companyId, roleType: 'founder', fullName, email });
}

export async function upsertLeadsFromCsv({ clientId, csvPath, type }) {
    if (!fs.existsSync(csvPath) || !clientId) return;
    const rows = [];
    await new Promise((resolve, reject) => {
        fs.createReadStream(csvPath)
            .pipe(csvParse({ columns: true, trim: true }))
            .on('data', (row) => rows.push(row))
            .on('end', resolve)
            .on('error', reject);
    });

    for (const row of rows) {
        const payload = buildContactPayload(row, type);
        if (!payload) continue;
        const companyId = await ensureCompanyId(clientId, payload.domain);
        await upsertContact({
            companyId,
            roleType: payload.roleType,
            fullName: payload.fullName,
            email: payload.email,
            emailStatus: payload.emailStatus,
            confidence: payload.confidence,
            lastVerifiedAt: payload.lastVerifiedAt
        });
    }
}

export async function filterAndWriteProcessedDomains({ uid, clientId, jobId, domainsCsvPath, dedupeStrategy = 'skip', domainColumn = 'domain' }) {
    if (!clientId || !domainsCsvPath) {
        console.warn(`[${jobId}] Missing clientId/domainsCsvPath. clientId=${clientId}, domainsCsvPath=${domainsCsvPath}`);
        return { filtered: domainsCsvPath, stats: { total: 0, skipped: 0, new: 0 } };
    }

    const domains = [];
    await new Promise((resolve, reject) => {
        fs.createReadStream(domainsCsvPath)
            .pipe(csvParse({ columns: true, trim: true }))
            .on('data', (row) => {
                const domain = String(row[domainColumn] || row.domain || '').trim();
                if (domain) domains.push(domain.toLowerCase());
            })
            .on('end', resolve)
            .on('error', reject);
    });

    const stats = { total: domains.length, skipped: 0, new: 0 };

    if (domains.length === 0) {
        return { filtered: domainsCsvPath, stats };
    }

    const uniqueDomains = Array.from(new Set(domains));

    // Fetch existing domains for this client from SQL
    let existing = [];
    try {
        const { rows } = await pool.query(
            'select domain_normalized from companies where client_id = $1 and domain_normalized = any($2)',
            [clientId, uniqueDomains]
        );
        existing = rows.map((r) => r.domain_normalized.toLowerCase());
    } catch (err) {
        console.error(`[${jobId}] SQL dedupe query failed:`, err?.message || err);
        // Fall back to no filtering if query fails
        return { filtered: domainsCsvPath, stats };
    }

    const existingSet = new Set(existing);

    let filteredDomains = domains;
    if (dedupeStrategy === 'skip') {
        filteredDomains = domains.filter((d) => !existingSet.has(d));
        stats.skipped = domains.length - filteredDomains.length;
        stats.new = filteredDomains.length;
    } else {
        stats.skipped = 0;
        stats.new = uniqueDomains.filter((d) => !existingSet.has(d)).length;
    }

    if (dedupeStrategy === 'skip' && stats.skipped > 0) {
        const filteredPath = domainsCsvPath.replace('.csv', '-filtered.csv');
        const writer = fs.createWriteStream(filteredPath);
        writer.write('domain\n');
        filteredDomains.forEach((domain) => writer.write(`${domain}\n`));
        writer.end();
        await new Promise((resolve) => writer.on('finish', resolve));
        return { filtered: filteredPath, stats };
    }

    return { filtered: domainsCsvPath, stats };
}

export async function attachCampaignToLeads({ clientId, rows }) {
    if (!clientId || !Array.isArray(rows) || rows.length === 0) return;
    const emails = rows.map((r) => String(r.email || '').trim()).filter(Boolean);
    if (!emails.length) return;
    await pool.query(
        'update contacts set last_contacted_at = now(), updated_at = now() where email = any($1)',
        [emails]
    );
}

export async function incrementCampaignLeadCount() {
    // No-op: Firestore aggregate counts removed in SQL version
    return;
}

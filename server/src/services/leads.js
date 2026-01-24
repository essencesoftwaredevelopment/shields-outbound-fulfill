import fs from 'fs';
import { parse as csvParse } from 'csv-parse';
import { admin, firestore } from '../config/firebase.js';

function getLeadRef(uid, clientId, domain) {
    return firestore
        .collection('users').doc(uid)
        .collection('clients').doc(clientId)
        .collection('leads').doc(domain.toLowerCase());
}

export async function upsertLead(uid, clientId, domain, data) {
    if (!uid || !clientId || !domain) return;
    const leadRef = getLeadRef(uid, clientId, domain);
    await leadRef.set({
        domain: domain.toLowerCase(),
        ...data,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
}

export async function upsertLeadsFromCsv({ uid, clientId, csvPath, type, dedupeStrategy = 'skip' }) {
    if (!fs.existsSync(csvPath)) return;
    const rows = [];
    await new Promise((resolve, reject) => {
        fs.createReadStream(csvPath)
            .pipe(csvParse({ columns: true, trim: true }))
            .on('data', (row) => rows.push(row))
            .on('end', resolve)
            .on('error', reject);
    });

    // Upsert all leads from CSV regardless of dedupeStrategy
    // (dedupeStrategy only affects which domains make it into the CSV via filterAndWriteProcessedDomains)
    const writer = firestore.bulkWriter();
    writer.onWriteError((error) => {
        const code = error?.code || '';
        const willRetry = error?.failedAttempts < 3;
        if (willRetry) return true;
        console.warn('BulkWriter error (no retry):', code, error?.message);
        return false;
    });

    for (const row of rows) {
        const domain = String(row.domain || '').trim();
        if (!domain) continue;
        const ref = getLeadRef(uid, clientId, domain);
        let payload = {};
        if (type === 'founders') {
            payload = { founder_name: String(row.founder_name || '').trim() };
        } else if (type === 'emails') {
            payload = {
                founder_name: String(row.founder_name || '').trim(),
                email: String(row.email || '').trim(),
                email_status: String(row.lookup_status || '').trim()
            };
        } else if (type === 'verification') {
            payload = {
                founder_name: String(row.founder_name || '').trim(),
                email: String(row.email || '').trim(),
                email_status: String(row.email_status || '').trim()
            };
        } else if (type === 'personalization') {
            payload = {
                personalization_url: String(row.url || '').trim(),
                personalization_title: String(row.title || '').trim(),
                personalization_first_line: String(row.first_line || '').trim()
            };
        }
        writer.set(ref, {
            domain: domain.toLowerCase(),
            ...payload,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    }

    await writer.close();
}

export async function filterAndWriteProcessedDomains({ uid, clientId, jobId, domainsCsvPath, dedupeStrategy = 'skip', domainColumn = 'domain' }) {
    if (!uid || !domainsCsvPath || !clientId) {
        console.warn(`[${jobId}] Missing uid/clientId/domainsCsvPath. uid=${uid}, clientId=${clientId}, domainsCsvPath=${domainsCsvPath}`);
        return { filtered: domainsCsvPath, stats: { total: 0, skipped: 0, new: 0 } };
    }
    const clientRef = firestore.collection('users').doc(uid).collection('clients').doc(clientId);
    const subRef = clientRef.collection('processed-domains');

    // Read all domains from CSV
    const domains = [];
    await new Promise((resolve, reject) => {
        fs.createReadStream(domainsCsvPath)
            .pipe(csvParse({ columns: true, trim: true }))
            .on('data', (row) => {
                const domain = String(row[domainColumn] || row.domain || '').trim();
                if (domain) domains.push(domain);
            })
            .on('end', resolve)
            .on('error', reject);
    });

    const stats = { total: domains.length, skipped: 0, new: 0 };

    // Build set of existing processed domains for uniqueness
    const processedSet = new Set();
    const existingSnap = await subRef.get();
    existingSnap.forEach(doc => {
        const domain = doc.data().domain || doc.id;
        if (domain) processedSet.add(String(domain).toLowerCase());
    });

    // Determine filtered list when skipping duplicates
    let filteredDomains = domains;
    if (dedupeStrategy === 'skip') {
        filteredDomains = domains.filter(d => !processedSet.has(d.toLowerCase()));
        stats.skipped = domains.length - filteredDomains.length;
        stats.new = filteredDomains.length;
    } else {
        // include: process ALL domains (no filtering), just track new vs existing in stats
        filteredDomains = domains; // Keep all domains for processing
        const uniqueDomains = new Set(domains.map(d => d.toLowerCase()));
        let newCount = 0;
        uniqueDomains.forEach(d => { if (!processedSet.has(d)) newCount += 1; });
        stats.new = newCount; // How many are truly new
        stats.skipped = 0; // Don't skip any when strategy is 'include'
    }

    // Write to processed-domains ensuring one doc per domain (unique key)
    const writePromises = (dedupeStrategy === 'skip' ? filteredDomains : Array.from(new Set(domains.map(d => d.toLowerCase())))).map(async (domain) => {
        const id = domain.toLowerCase();
        const ref = subRef.doc(id);
        try {
            await ref.set({
                domain: id,
                lastJobId: jobId,
                // optional list of jobs processed
                jobs: admin.firestore.FieldValue.arrayUnion(jobId),
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        } catch (err) {
            console.warn('processed-domains write error', err?.message);
        }
    });
    await Promise.all(writePromises);

    // Update client document with absolute total leads count based on processed-domains size
    try {
        const allProcessedSnap = await subRef.get();
        const total = allProcessedSnap.size;
        console.log(`[${jobId}] Updating client ${clientId} totalLeads=${total}`);
        await clientRef.set({
            totalLeads: total,
            lastUpdated: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    } catch (err) {
        console.warn(`[${jobId}] Failed to set client totalLeads count for clientId=${clientId}`, err?.message);
    }

    // Write filtered CSV if we filtered anything
    if (dedupeStrategy === 'skip' && stats.skipped > 0) {
        const filteredPath = domainsCsvPath.replace('.csv', '-filtered.csv');
        const writer = fs.createWriteStream(filteredPath);
        writer.write('domain\n');
        filteredDomains.forEach(domain => writer.write(`${domain}\n`));
        writer.end();
        await new Promise(resolve => writer.on('finish', resolve));
        return { filtered: filteredPath, stats };
    }

    return { filtered: domainsCsvPath, stats };
}

export async function attachCampaignToLeads({ uid, clientId, campaignId, rows }) {
    if (!uid || !clientId || !campaignId || !Array.isArray(rows) || rows.length === 0) return;
    const leadsCol = firestore.collection('users').doc(uid).collection('clients').doc(clientId).collection('leads');
    const writer = firestore.bulkWriter();
    writer.onWriteError((error) => {
        const willRetry = error?.failedAttempts < 3;
        return willRetry;
    });

    rows.forEach((row) => {
        const domain = String(row.domain || '').toLowerCase();
        if (!domain) return;
        const ref = leadsCol.doc(domain);
        writer.set(ref, {
            campaignId,
            campaigns: admin.firestore.FieldValue.arrayUnion(campaignId),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    });

    await writer.close();
}

export async function incrementCampaignLeadCount({ uid, clientId, campaignId, delta }) {
    if (!uid || !clientId || !campaignId || !Number.isFinite(delta) || delta <= 0) return;
    const campaignRef = firestore.collection('users').doc(uid).collection('clients').doc(clientId).collection('campaigns').doc(campaignId);
    await campaignRef.set({
        totalLeads: admin.firestore.FieldValue.increment(delta),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
}

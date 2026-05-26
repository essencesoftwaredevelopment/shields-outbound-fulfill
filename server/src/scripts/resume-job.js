/**
 * Manual Job Recovery Script
 * 
 * Resumes a job from the emails.csv stage when server crashes or restarts
 * Reconstructs job state from tmp directory files and continues processing
 * 
 * Usage: node src/scripts/resume-job.js <jobId> <uid> <clientId> <sqlClientId>
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TMP_ROOT } from '../config/paths.js';
import { admin, firestore } from '../config/firebase.js';
import { runEmailVerifier } from '../services/emailVerifier.js';
import { runPersonalization } from '../services/personalization/index.js';
import { buildUnifiedRows, writeUploadCsv } from '../utils/csv.js';
import { upsertLeadsFromCsv } from '../services/leads.js';
import { DEFAULT_PRICING, computeJobCost } from '../utils/pricing.js';
import { getOrCreateClient } from '../services/db/queries.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Parse command line arguments
const args = process.argv.slice(2);
if (args.length < 4) {
    console.error('Usage: node src/scripts/resume-job.js <jobId> <uid> <clientId> <sqlClientId>');
    console.error('Example: node src/scripts/resume-job.js 1769381227114-m7xyym abc123uid my-client 42');
    process.exit(1);
}

const [jobId, uid, clientId, sqlClientIdStr] = args;
let sqlClientId = parseInt(sqlClientIdStr, 10);

if (isNaN(sqlClientId)) {
    console.error('Error: sqlClientId must be a valid number');
    process.exit(1);
}

// If sqlClientId is 0, we'll look it up or create it
if (sqlClientId === 0) {
    console.log('sqlClientId is 0, will look up or create client in database...');
}

// Reconstruct job object from tmp files
async function reconstructJob() {
    const jobDir = path.join(TMP_ROOT, jobId);
    
    if (!fs.existsSync(jobDir)) {
        throw new Error(`Job directory not found: ${jobDir}`);
    }

    const domainsPath = path.join(jobDir, 'domains.csv');
    const foundersPath = path.join(jobDir, 'founders.csv');
    const emailsPath = path.join(jobDir, 'emails.csv');
    const finalPath = path.join(jobDir, 'final.csv');
    const personalizedPath = path.join(jobDir, 'personalized.csv');
    const uploadPath = path.join(jobDir, 'upload.csv');

    // Verify emails.csv exists
    if (!fs.existsSync(emailsPath)) {
        throw new Error(`emails.csv not found in ${jobDir}`);
    }

    // Get original filename from domains.csv
    let fileName = 'unknown.csv';
    if (fs.existsSync(domainsPath)) {
        fileName = 'domains.csv';
    }

    // Fetch API keys from Firestore
    console.log(`Fetching API keys for user ${uid}...`);
    const userDoc = await firestore.collection('users').doc(uid).get();
    if (!userDoc.exists) {
        throw new Error(`User document not found for uid: ${uid}`);
    }

    const userData = userDoc.data();
    const apiKeys = {
        openai: userData?.openai_key || '',
        serper: userData?.serper_key || '',
        kitt: userData?.trykitt_key || ''
    };

    const emailVerificationProvider = userData?.email_verification_provider || 'trykitt';

    // Fetch client info from Firestore
    console.log(`Fetching client info for ${clientId}...`);
    const clientDoc = await firestore
        .collection('users').doc(uid)
        .collection('clients').doc(clientId)
        .get();

    const clientData = clientDoc.exists ? clientDoc.data() : {};
    const industry = clientData?.industry || null;

    // Create job object
    const job = {
        id: jobId,
        status: 'running',
        createdAt: new Date().toISOString(),
        completedAt: null,
        error: null,
        fileName,
        apiKeys,
        uid,
        clientId,
        sqlClientId,
        cancelled: false,
        paused: false,
        skipFounderFinder: false,
        skipEmailFinder: false,
        skipVerification: false,
        findFounder: true,
        industry,
        nicheId: industry,
        nicheLabel: clientData?.name || clientId,
        personalizeFirstLine: true,
        emailVerificationProvider,
        pricing: DEFAULT_PRICING,
        cost: 0,
        paths: {
            dir: jobDir,
            domains: domainsPath,
            filtered: path.join(jobDir, 'domains-filtered.csv'),
            founders: foundersPath,
            emails: emailsPath,
            final: finalPath,
            personalized: personalizedPath,
            upload: uploadPath
        },
        tmpDir: jobDir,
        stages: {
            deduplication: {
                status: 'completed',
                startedAt: new Date().toISOString(),
                completedAt: new Date().toISOString(),
                summary: { processed: 0 },
                error: null,
                progress: null
            },
            founders: {
                status: 'completed',
                startedAt: new Date().toISOString(),
                completedAt: new Date().toISOString(),
                summary: { processed: 0 },
                error: null,
                progress: null
            },
            emailDiscovery: {
                status: 'completed',
                startedAt: new Date().toISOString(),
                completedAt: new Date().toISOString(),
                summary: { processed: 0 },
                error: null,
                progress: null
            },
            verification: {
                status: 'pending',
                startedAt: null,
                completedAt: null,
                summary: null,
                error: null,
                progress: null
            },
            personalization: {
                status: 'pending',
                startedAt: null,
                completedAt: null,
                summary: null,
                error: null,
                progress: null
            }
        },
        dedupeStats: null,
        __persistedOnce: true
    };

    return job;
}

function log(job, message, meta = {}) {
    console.log(`[${job.id}] ${message}`, meta ? JSON.stringify(meta) : '');
}

async function updateStage(job, stageKey, updates) {
    job.stages[stageKey] = {
        ...job.stages[stageKey],
        ...updates
    };
    
    // Persist to Firestore
    try {
        const jobRef = firestore
            .collection('users').doc(job.uid)
            .collection('clients').doc(job.clientId)
            .collection('jobs').doc(job.id);

        await jobRef.set({
            id: job.id,
            status: job.status,
            stages: job.stages,
            error: job.error,
            createdAt: job.createdAt,
            completedAt: job.completedAt,
            cost: job.cost,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        
        console.log(`Updated stage ${stageKey} in Firestore`);
    } catch (error) {
        console.error(`Failed to update Firestore:`, error.message);
    }
}

async function runStage(job, stageKey, handler) {
    await updateStage(job, stageKey, { 
        status: 'running', 
        startedAt: new Date().toISOString(), 
        error: null 
    });
    
    try {
        const summary = await handler();
        const safeSummary = summary || {};
        await updateStage(job, stageKey, { 
            status: 'completed', 
            completedAt: new Date().toISOString(), 
            summary: safeSummary 
        });
        return summary;
    } catch (err) {
        const message = err?.message || 'Unknown error';
        await updateStage(job, stageKey, { 
            status: 'error', 
            completedAt: new Date().toISOString(), 
            error: message 
        });
        throw err;
    }
}

function resolveJobPaths(jobId) {
    const jobDir = path.join(TMP_ROOT, jobId);
    return {
        job: null, // Not needed for this context
        jobDir,
        finalPath: path.join(jobDir, 'final.csv'),
        personalizedPath: path.join(jobDir, 'personalized.csv'),
        uploadPath: path.join(jobDir, 'upload.csv')
    };
}

async function resumeJob() {
    console.log('\n🔄 Job Recovery Tool\n');
    console.log(`Job ID: ${jobId}`);
    console.log(`User ID: ${uid}`);
    console.log(`Client ID: ${clientId}`);
    console.log(`SQL Client ID: ${sqlClientId}\n`);

    try {
        // Look up or create SQL client if needed
        if (sqlClientId === 0) {
            console.log('Looking up or creating SQL client...');
            sqlClientId = await getOrCreateClient(uid, clientId);
            console.log(`✅ SQL Client ID: ${sqlClientId}\n`);
        }

        // Reconstruct job
        console.log('📦 Reconstructing job state...');
        const job = await reconstructJob();
        console.log('✅ Job state reconstructed\n');

        // Check which stages need to run
        const needsVerification = !fs.existsSync(job.paths.final);
        const needsPersonalization = !fs.existsSync(job.paths.personalized);

        console.log(`📊 Stage Status:`);
        console.log(`  ✅ Deduplication: Completed`);
        console.log(`  ✅ Founders: Completed`);
        console.log(`  ✅ Email Discovery: Completed`);
        console.log(`  ${needsVerification ? '⏳' : '✅'} Verification: ${needsVerification ? 'Pending' : 'Completed'}`);
        console.log(`  ${needsPersonalization ? '⏳' : '✅'} Personalization: ${needsPersonalization ? 'Pending' : 'Completed'}\n`);

        // Run verification if needed
        if (needsVerification) {
            console.log('🔍 Starting email verification...');
            await runStage(job, 'verification', () =>
                runEmailVerifier({
                    inputCsv: job.paths.emails,
                    outputCsv: job.paths.final,
                    apiKeys: job.apiKeys,
                    provider: job.emailVerificationProvider,
                    log: (message, meta) => log(job, message, meta),
                    job,
                    checkPaused: () => job.paused
                })
            );
            
            // Upsert leads with verification status
            await upsertLeadsFromCsv({ 
                agencyId: job.uid, 
                clientId: job.sqlClientId, 
                csvPath: job.paths.final, 
                type: 'verification' 
            });
            
            computeJobCost(job);
            console.log('✅ Verification completed\n');
        }

        // Run personalization if needed
        if (needsPersonalization) {
            console.log('✨ Starting personalization...');
            await runStage(job, 'personalization', () =>
                runPersonalization({
                    inputCsv: job.paths.final,
                    outputCsv: job.paths.personalized,
                    apiKeys: job.apiKeys,
                    log: (message, meta) => log(job, message, meta),
                    removeB2B: false,
                    industry: job.industry || job.nicheId || null,
                    nicheId: job.nicheId || null,
                    nicheLabel: job.nicheLabel || null,
                    personalizeFirstLine: job.personalizeFirstLine,
                })
            );

            // Upsert leads with personalization data
            await upsertLeadsFromCsv({ 
                agencyId: job.uid, 
                clientId: job.sqlClientId, 
                csvPath: job.paths.personalized, 
                type: 'personalization' 
            });
            
            computeJobCost(job);
            console.log('✅ Personalization completed\n');
        }

        // Build upload CSV
        console.log('📝 Building upload CSV...');
        try {
            const uploadRows = await buildUnifiedRows({ 
                jobId: job.id, 
                scope: 'complete', 
                resolveJobPaths 
            });
            await writeUploadCsv(job.paths.upload, uploadRows);
            log(job, `Upload CSV ready at ${job.paths.upload} (${uploadRows.length} rows)`);
            console.log(`✅ Upload CSV ready: ${uploadRows.length} rows\n`);
        } catch (err) {
            console.warn(`⚠️  Failed to build upload.csv:`, err?.message || err);
        }

        // Update final status
        job.status = 'pending-upload';
        job.completedAt = new Date().toISOString();
        
        // Final Firestore update
        const jobRef = firestore
            .collection('users').doc(job.uid)
            .collection('clients').doc(job.clientId)
            .collection('jobs').doc(job.id);

        await jobRef.set({
            id: job.id,
            status: job.status,
            stages: job.stages,
            error: null,
            createdAt: job.createdAt,
            completedAt: job.completedAt,
            cost: job.cost,
            fileName: job.fileName,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        // Update activeJob
        const activeJobRef = firestore
            .collection('users').doc(job.uid)
            .collection('clients').doc(job.clientId)
            .collection('activeJob').doc('current');

        await activeJobRef.set({
            jobId: job.id,
            status: 'pending-upload',
            uploadError: null,
            uploadMetrics: null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        console.log('✅ Job completed successfully!');
        console.log(`💰 Total cost: $${job.cost.toFixed(4)}`);
        console.log(`📁 Final CSV: ${job.paths.final}`);
        console.log(`📁 Personalized CSV: ${job.paths.personalized}`);
        console.log(`📁 Upload CSV: ${job.paths.upload}\n`);

        process.exit(0);
    } catch (error) {
        console.error('\n❌ Job recovery failed:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

// Run the recovery
resumeJob();

/**
 * Job Information Lookup Helper
 * 
 * Helps find uid, clientId, and sqlClientId for a job by querying:
 * - Firestore for job metadata
 * - PostgreSQL for client information
 * 
 * Usage: node src/scripts/lookup-job-info.js <jobId>
 */

import { admin, firestore } from '../config/firebase.js';
import { pool } from '../config/db.js';

const jobId = process.argv[2];

if (!jobId) {
    console.error('Usage: node src/scripts/lookup-job-info.js <jobId>');
    console.error('Example: node src/scripts/lookup-job-info.js 1769381227114-m7xyym');
    process.exit(1);
}

async function findJobInfo() {
    console.log(`\n🔍 Looking up information for job: ${jobId}\n`);

    try {
        // Search all users and clients for this job
        console.log('Searching Firestore for job...');
        const usersRef = firestore.collection('users');
        const usersSnap = await usersRef.get();
        
        let foundJob = null;
        let foundUid = null;
        let foundClientId = null;

        for (const userDoc of usersSnap.docs) {
            const uid = userDoc.id;
            const clientsRef = firestore.collection('users').doc(uid).collection('clients');
            const clientsSnap = await clientsRef.get();
            
            for (const clientDoc of clientsSnap.docs) {
                const clientId = clientDoc.id;
                const jobRef = firestore
                    .collection('users').doc(uid)
                    .collection('clients').doc(clientId)
                    .collection('jobs').doc(jobId);
                
                const jobSnap = await jobRef.get();
                if (jobSnap.exists) {
                    foundJob = jobSnap.data();
                    foundUid = uid;
                    foundClientId = clientId;
                    break;
                }
            }
            if (foundJob) break;
        }

        if (!foundJob) {
            console.error('❌ Job not found in Firestore');
            console.log('\n💡 Manual search tips:');
            console.log('1. Check if the job exists in Firebase Console');
            console.log('2. Look in Firestore: users/{uid}/clients/{clientId}/jobs/{jobId}');
            console.log('3. You may need to provide the uid and clientId manually\n');
            process.exit(1);
        }

        console.log('✅ Job found in Firestore!\n');
        console.log('📊 Job Information:');
        console.log(`  Job ID: ${jobId}`);
        console.log(`  User ID (uid): ${foundUid}`);
        console.log(`  Client ID: ${foundClientId}`);
        console.log(`  Status: ${foundJob.status || 'unknown'}`);
        console.log(`  Created: ${foundJob.createdAt || 'unknown'}`);
        console.log(`  File Name: ${foundJob.fileName || 'unknown'}\n`);

        // Look up SQL client ID
        console.log('Looking up SQL Client ID...');
        try {
            const result = await pool.query(
                'SELECT id FROM clients WHERE agency_id = $1 AND name = $2',
                [foundUid, foundClientId]
            );
            
            if (result.rows.length > 0) {
                const sqlClientId = result.rows[0].id;
                console.log(`✅ SQL Client ID: ${sqlClientId}\n`);
                
                console.log('🚀 Ready to Resume!\n');
                console.log('Run this command to resume the job:\n');
                console.log(`node src/scripts/resume-job.js ${jobId} ${foundUid} ${foundClientId} ${sqlClientId}\n`);
            } else {
                console.log('⚠️  SQL Client not found - will be created automatically\n');
                console.log('🚀 Ready to Resume!\n');
                console.log('Run this command to resume the job (it will create the SQL client):\n');
                console.log(`node src/scripts/resume-job.js ${jobId} ${foundUid} ${foundClientId} 0\n`);
                console.log('Note: Using 0 will trigger automatic client creation\n');
            }
        } catch (dbErr) {
            console.error('⚠️  Could not query database:', dbErr.message);
            console.log('\nYou can still try to resume with:\n');
            console.log(`node src/scripts/resume-job.js ${jobId} ${foundUid} ${foundClientId} <sqlClientId>\n`);
        }

    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    } finally {
        await pool.end();
        process.exit(0);
    }
}

findJobInfo();

import { admin, firestore } from '../config/firebase.js';

const uid = 'ktYWFKCyaPPYOG1Y6HNM8cfZTnt1';
const clientId = 'essence';          // e.g. the client slug you used when uploading
const jobId = '1769381227114-m7xyym';

async function forceCompleteVerification() {
  console.log(`Force completing verification for job ${jobId}...`);

  const jobRef = firestore
    .collection('users').doc(uid)
    .collection('clients').doc(clientId)
    .collection('jobs').doc(jobId);

  const activeJobRef = firestore
    .collection('users').doc(uid)
    .collection('clients').doc(clientId)
    .collection('activeJob').doc('current');

  const update = {
    'progress.stage': 'personalization',
    'progress.processed': 6498,
    'progress.stats.unknown': 6,
    status: 'running',
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await Promise.all([
    jobRef.set(update, { merge: true }),
    activeJobRef.set({ jobId, status: 'running', uploadError: null }, { merge: true }),
  ]);

  console.log('Job advanced to personalization.');
}

forceCompleteVerification().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
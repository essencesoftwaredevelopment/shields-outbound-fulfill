import admin from 'firebase-admin';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const require = createRequire(import.meta.url);
// service account is at server/.secrets/service-account.json
// service-account.json lives under server/.secrets
const serviceAccountPath = path.join(__dirname, '..', '..', '.secrets', 'service-account.json');

if (!admin.apps.length) {
    // Check if service account file exists
    if (!fs.existsSync(serviceAccountPath)) {
        console.error('\n❌ Firebase service account file not found!');
        console.error(`📁 Expected location: ${serviceAccountPath}`);
        console.error('\n📝 Setup instructions:');
        console.error('1. Go to Firebase Console: https://console.firebase.google.com/');
        console.error('2. Select project: shields-outbound-fulfill');
        console.error('3. Go to Project Settings > Service Accounts');
        console.error('4. Click "Generate New Private Key"');
        console.error('5. Save the file as: server/.secrets/service-account.json\n');
        process.exit(1);
    }

    admin.initializeApp({
        credential: admin.credential.cert(require(serviceAccountPath)),
        projectId: 'shields-outbound-fulfill'
    });
}

export const firestore = admin.firestore();
export const auth = admin.auth();
export { admin };

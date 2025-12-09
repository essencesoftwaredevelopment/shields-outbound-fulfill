import admin from 'firebase-admin';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const require = createRequire(import.meta.url);
// service account is at server/.secrets/service-account.json
// service-account.json lives under server/.secrets
const serviceAccountPath = path.join(__dirname, '..', '..', '.secrets', 'service-account.json');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(require(serviceAccountPath)),
        projectId: 'shields-outbound-fulfill'
    });
}

export const firestore = admin.firestore();
export const auth = admin.auth();
export { admin };

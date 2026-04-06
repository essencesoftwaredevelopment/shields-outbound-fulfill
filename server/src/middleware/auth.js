/**
 * Firebase authentication middleware for Express routes.
 *
 * CANONICAL AGENCY IDENTIFIER RULE:
 * The Firestore users/{uid} document ID is the canonical agency identifier.
 * This same Firebase Auth uid is used directly as agency_id in all PostgreSQL tables.
 * No reconciliation or mapping is required.
 *
 * This middleware:
 * 1. Extracts the ID token from the Authorization header
 * 2. Verifies it using Firebase Admin SDK
 * 3. Derives agency_id from the decoded token's uid
 * 4. Attaches agency_id to req.agencyId
 *
 * All SQL queries must be scoped by this derived agency_id.
 * The frontend never sends agency_id; it is always derived from the verified token.
 */

import { admin } from '../config/firebase.js';

/**
 * Middleware: Verify Firebase ID token and derive agency_id
 * Attaches req.auth with agencyId and other user context
 *
 * @param {Express.Request} req
 * @param {Express.Response} res
 * @param {Function} next
 */
export async function verifyFirebaseToken(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Missing or invalid Authorization header' });
        }

        const idToken = authHeader.slice(7); // Remove 'Bearer ' prefix
        const decoded = await admin.auth().verifyIdToken(idToken);

        // Extract uid as agency_id (canonical identifier; no mapping table needed)
        // Attach to req.auth for consistency and future extensibility
        req.auth = {
            agencyId: decoded.uid,
            uid: decoded.uid,
            email: decoded.email,
            emailVerified: decoded.email_verified
        };

        // Also set req.agencyId for backward compatibility with existing code
        req.agencyId = decoded.uid;

        next();
    } catch (error) {
        console.error('Firebase token verification failed:', error.message);
        res.status(401).json({ error: 'Unauthorized' });
    }
}

export default verifyFirebaseToken;

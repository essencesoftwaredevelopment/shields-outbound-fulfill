import os from 'os';
import { admin, firestore } from '../config/firebase.js';

const QUEUE_COLLECTION = 'jobQueue';

function queueRef(jobId) {
    return firestore.collection(QUEUE_COLLECTION).doc(jobId);
}

function nowIso() {
    return new Date().toISOString();
}

function normalizeQueueStatus(status) {
    const allowed = new Set(['queued', 'running', 'paused', 'completed', 'cancelled', 'failed']);
    return allowed.has(status) ? status : 'queued';
}

export async function enqueuePipelineJob({
    jobId,
    uid,
    clientId,
    payload = {}
}) {
    if (!jobId || !uid || !clientId) {
        throw new Error('enqueuePipelineJob requires jobId, uid, and clientId');
    }

    const ref = queueRef(jobId);
    const snapshot = await ref.get();
    const previous = snapshot.exists ? snapshot.data() : null;
    const attempts = Number(previous?.attempts || 0);

    await ref.set({
        jobId,
        uid,
        clientId,
        status: 'queued',
        control: {
            paused: false,
            cancelled: false
        },
        payload,
        attempts,
        enqueuedAt: previous?.enqueuedAt || admin.firestore.FieldValue.serverTimestamp(),
        enqueuedAtIso: previous?.enqueuedAtIso || nowIso(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAtIso: nowIso(),
        completedAt: null,
        completedAtIso: null,
        error: null
    }, { merge: true });
}

export async function getQueueJob(jobId) {
    if (!jobId) return null;
    const snapshot = await queueRef(jobId).get();
    if (!snapshot.exists) return null;
    return {
        id: snapshot.id,
        ...snapshot.data()
    };
}

export async function claimNextQueuedJob(workerId = `${os.hostname()}-${process.pid}`) {
    const snapshot = await firestore.collection(QUEUE_COLLECTION)
        .where('status', '==', 'queued')
        .limit(20)
        .get();

    if (snapshot.empty) {
        return null;
    }

    const candidates = snapshot.docs
        .map((doc) => ({ doc, data: doc.data() }))
        .filter(({ data }) => !data?.control?.cancelled)
        .sort((a, b) => {
            const left = new Date(a.data?.enqueuedAtIso || 0).getTime();
            const right = new Date(b.data?.enqueuedAtIso || 0).getTime();
            return left - right;
        });

    for (const candidate of candidates) {
        const ref = candidate.doc.ref;
        let claimed = null;

        await firestore.runTransaction(async (tx) => {
            const fresh = await tx.get(ref);
            if (!fresh.exists) return;
            const data = fresh.data();
            if (data?.status !== 'queued') return;
            if (data?.control?.cancelled) return;
            if (data?.control?.paused) {
                tx.update(ref, {
                    status: 'paused',
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    updatedAtIso: nowIso()
                });
                return;
            }

            tx.update(ref, {
                status: 'running',
                workerId,
                claimedAt: admin.firestore.FieldValue.serverTimestamp(),
                claimedAtIso: nowIso(),
                attempts: Number(data?.attempts || 0) + 1,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAtIso: nowIso()
            });

            claimed = {
                id: fresh.id,
                ...data,
                status: 'running',
                workerId
            };
        });

        if (claimed) {
            return claimed;
        }
    }

    return null;
}

export async function updateQueueControl(jobId, controlPatch = {}) {
    if (!jobId) return;
    await queueRef(jobId).set({
        control: {
            ...controlPatch
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAtIso: nowIso()
    }, { merge: true });
}

export async function setQueueStatus(jobId, status, extra = {}) {
    if (!jobId) return;
    const normalizedStatus = normalizeQueueStatus(status);
    const payload = {
        status: normalizedStatus,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAtIso: nowIso(),
        ...extra
    };

    if (normalizedStatus === 'completed' || normalizedStatus === 'cancelled' || normalizedStatus === 'failed') {
        payload.completedAt = admin.firestore.FieldValue.serverTimestamp();
        payload.completedAtIso = nowIso();
    }

    await queueRef(jobId).set(payload, { merge: true });
}

export async function deleteQueueJob(jobId) {
    if (!jobId) return;
    await queueRef(jobId).delete();
}

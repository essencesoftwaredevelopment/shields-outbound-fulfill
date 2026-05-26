/**
 * One-time migration: Firestore users/{uid}, clients/*, segments/* -> Postgres.
 * Requires server/.secrets/service-account.json and DATABASE_URL in server/.secrets/.env
 *
 * Usage (from repo root):
 *   node server/src/scripts/migrate-firestore-to-sql/migrate-users-clients.js
 */

import { firestore } from '../../config/firebase.js';
import { pool } from '../../config/db.js';
import { upsertAgencySettings } from '../../services/db/agencySettings.js';
import { getOrCreateClient } from '../../services/db/queries.js';

async function migrateUsers() {
    const usersSnap = await firestore.collection('users').get();
    let count = 0;
    for (const userDoc of usersSnap.docs) {
        const data = userDoc.data() || {};
        await upsertAgencySettings(userDoc.id, {
            openai_key: data.openai_key || null,
            serper_key: data.serper_key || null,
            trykitt_key: data.trykitt_key || null,
            openai_founder_model: data.openai_founder_model || null,
            email_verification_provider: data.email_verification_provider || null
        });
        count += 1;
        console.log(`[users] agency_settings <- users/${userDoc.id}`);
    }
    return count;
}

async function migrateClients() {
    const usersSnap = await firestore.collection('users').get();
    let count = 0;
    for (const userDoc of usersSnap.docs) {
        const clientsSnap = await userDoc.ref.collection('clients').get();
        for (const clientDoc of clientsSnap.docs) {
            const data = clientDoc.data() || {};
            const sqlId = await getOrCreateClient(userDoc.id, clientDoc.id);
            await pool.query(
                `UPDATE clients SET
                    slug = $3,
                    instantly_key = COALESCE($4, instantly_key),
                    industry = COALESCE($5, industry),
                    ntfy_topic = COALESCE($6, ntfy_topic),
                    display_name = COALESCE($7, display_name),
                    updated_at = NOW()
                 WHERE id = $1 AND agency_id = $2`,
                [
                    sqlId,
                    userDoc.id,
                    clientDoc.id,
                    data.instantly_key || null,
                    data.industry || null,
                    data.ntfy_topic || null,
                    data.name || clientDoc.id
                ]
            );
            count += 1;
            console.log(`[clients] ${clientDoc.id} -> clients.id=${sqlId} (agency ${userDoc.id})`);
        }
    }
    return count;
}

async function migrateSegments() {
    const usersSnap = await firestore.collection('users').get();
    let count = 0;
    for (const userDoc of usersSnap.docs) {
        const clientsSnap = await userDoc.ref.collection('clients').get();
        for (const clientDoc of clientsSnap.docs) {
            const sqlId = await getOrCreateClient(userDoc.id, clientDoc.id);
            const segmentsSnap = await clientDoc.ref.collection('segments').get();
            for (const segmentDoc of segmentsSnap.docs) {
                const data = segmentDoc.data() || {};
                const filters = data.filters ?? data.filter ?? [];
                await pool.query(
                    `INSERT INTO client_segments (id, agency_id, client_id, name, filters, created_at, updated_at)
                     VALUES ($1, $2, $3, $4, $5::jsonb, NOW(), NOW())
                     ON CONFLICT (agency_id, client_id, id) DO UPDATE SET
                        name = EXCLUDED.name,
                        filters = EXCLUDED.filters,
                        updated_at = NOW()`,
                    [
                        segmentDoc.id,
                        userDoc.id,
                        sqlId,
                        data.name || segmentDoc.id,
                        JSON.stringify(Array.isArray(filters) ? filters : [])
                    ]
                );
                count += 1;
                console.log(`[segments] ${clientDoc.id}/${segmentDoc.id} -> client_segments`);
            }
        }
    }
    return count;
}

async function main() {
    const userCount = await migrateUsers();
    const clientCount = await migrateClients();
    const segmentCount = await migrateSegments();
    console.log('Migration complete.', { userCount, clientCount, segmentCount });
    await pool.end();
    process.exit(0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

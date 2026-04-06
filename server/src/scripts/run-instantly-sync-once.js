import { listInstantlySyncClients, syncClientInstantlyState } from '../services/instantlyState.js';

async function main() {
    const filterAgencyId = (process.env.INSTANTLY_SYNC_AGENCY_ID || '').trim();
    const filterClientSlug = (process.env.INSTANTLY_SYNC_CLIENT_ID || '').trim();

    const clients = await listInstantlySyncClients();
    const selected = clients.filter((client) => {
        if (filterAgencyId && client.agencyId !== filterAgencyId) return false;
        if (filterClientSlug && client.clientSlug !== filterClientSlug) return false;
        return true;
    });

    if (!selected.length) {
        console.log('No Instantly clients matched the requested filters.');
        return;
    }

    for (const client of selected) {
        const summary = await syncClientInstantlyState({
            agencyId: client.agencyId,
            clientSlug: client.clientSlug,
            instantlyKey: client.instantlyKey,
            logger: (message) => console.log(`[instantly-sync][${client.agencyId}/${client.clientSlug}] ${message}`)
        });
        console.log(`[instantly-sync] Summary for ${client.agencyId}/${client.clientSlug}:`, summary);
    }
}

main().catch((error) => {
    console.error('[instantly-sync] One-off sync failed:', error);
    process.exit(1);
});

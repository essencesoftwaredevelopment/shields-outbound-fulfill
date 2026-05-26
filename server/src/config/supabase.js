import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import { env } from './env.js';

let adminClient = null;

export function getSupabaseAdmin() {
    if (adminClient) return adminClient;
    const url = env.SUPABASE_URL;
    const key = env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
        throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
    }
    adminClient = createClient(url, key, {
        auth: { autoRefreshToken: false, persistSession: false },
        // Node 20 has no global WebSocket; supabase-js Realtime init requires one for createClient.
        global: { WebSocket: ws }
    });
    return adminClient;
}

import axios from 'axios';
import dns from 'dns/promises';

// DNS-over-HTTPS configuration
const USE_DNS_OVER_HTTPS = true;
const DOH_PROVIDERS = [
    'https://dns.google/resolve',
    'https://cloudflare-dns.com/dns-query'
];
const USE_PROXY = false;
const DOH_TIMEOUT_MS = 3000;
const SYSTEM_DNS_TIMEOUT_MS = 3000;

function emitLog(log, message) {
    if (typeof log === 'function') {
        log(message);
        return;
    }
    console.log(message);
}

/**
 * DNS-over-HTTPS TXT lookup
 * @param {string} domain - Domain to query
 * @returns {Promise<string[]>} Array of TXT record strings
 */
async function dohLookupFromProvider(domain, provider, log) {
    const startedAt = Date.now();
    const url = `${provider}?name=${encodeURIComponent(domain)}&type=TXT`;

    emitLog(log, `[Klaviyo][DoH] Lookup start domain=${domain} provider=${provider} dnsOverHttps=${USE_DNS_OVER_HTTPS} proxy=${USE_PROXY} timeout_ms=${DOH_TIMEOUT_MS}`);

    try {
        const response = await axios.get(url, {
            timeout: DOH_TIMEOUT_MS,
            headers: provider.includes('cloudflare-dns.com')
                ? { Accept: 'application/dns-json' }
                : undefined
        });
        const answers = response.data?.Answer || [];
        
        // Parse TXT records from DNS response
        const txtRecords = answers
            .filter(record => record.type === 16) // TXT records
            .map(record => {
                // Strip quotes from TXT values
                const data = record.data || '';
                return data.replace(/^"(.*)"$/, '$1');
            })
            .filter(Boolean);

        emitLog(
            log,
            `[Klaviyo][DoH] Lookup success domain=${domain} provider=${provider} txt_records=${txtRecords.length} latency_ms=${Date.now() - startedAt}`
        );

        return txtRecords;
    } catch (error) {
        const errorCode = error?.code || 'unknown';
        emitLog(
            log,
            `[Klaviyo][DoH] Lookup failed domain=${domain} provider=${provider} latency_ms=${Date.now() - startedAt} code=${errorCode} error=${error.message}`
        );
        throw error;
    }
}

async function dohLookup(domain, log) {
    let lastError = null;

    for (const provider of DOH_PROVIDERS) {
        try {
            return await dohLookupFromProvider(domain, provider, log);
        } catch (error) {
            lastError = error;
        }
    }

    throw new Error(`DoH lookup failed across providers: ${lastError?.message || 'Unknown error'}`);
}

async function systemDnsTxtLookup(domain, log) {
    const startedAt = Date.now();
    emitLog(log, `[Klaviyo][SystemDNS] Lookup start domain=${domain} timeout_ms=${SYSTEM_DNS_TIMEOUT_MS}`);

    try {
        const txtRecordChunks = await Promise.race([
            dns.resolveTxt(domain),
            new Promise((_, reject) => {
                setTimeout(() => reject(new Error(`system DNS timeout after ${SYSTEM_DNS_TIMEOUT_MS}ms`)), SYSTEM_DNS_TIMEOUT_MS);
            })
        ]);

        const txtRecords = (txtRecordChunks || [])
            .map((chunks) => Array.isArray(chunks) ? chunks.join('') : '')
            .filter(Boolean);

        emitLog(
            log,
            `[Klaviyo][SystemDNS] Lookup success domain=${domain} txt_records=${txtRecords.length} latency_ms=${Date.now() - startedAt}`
        );

        return txtRecords;
    } catch (error) {
        emitLog(
            log,
            `[Klaviyo][SystemDNS] Lookup failed domain=${domain} latency_ms=${Date.now() - startedAt} error=${error.message}`
        );
        throw error;
    }
}

/**
 * Detect if domain uses Klaviyo
 * @param {string} domain - Domain to check
 * @param {function} log - Optional logging function
 * @returns {Promise<boolean|null>} True if detected, false if not detected, null if lookup unresolved
 */
export async function detectKlaviyo(domain, log) {
    const startedAt = Date.now();
    emitLog(log, `[Klaviyo] Check start domain=${domain}`);

    try {
        let txtRecords = [];
        try {
            txtRecords = await systemDnsTxtLookup(domain, log);
        } catch {
            txtRecords = await dohLookup(domain, log);
        }
        
        // Flatten all TXT content and check for klaviyo-site-verification
        const allContent = txtRecords.join(' ');
        const hasKlaviyo = allContent.includes('klaviyo-site-verification=');

        emitLog(
            log,
            `[Klaviyo] Check complete domain=${domain} detected=${hasKlaviyo} txt_records=${txtRecords.length} latency_ms=${Date.now() - startedAt}`
        );
        
        return hasKlaviyo;
    } catch (error) {
        emitLog(log, `[Klaviyo] Check unresolved domain=${domain} latency_ms=${Date.now() - startedAt} error=${error.message}`);
        return null;
    }
}

/**
 * Batch detect Klaviyo for multiple domains
 * @param {Array<{domain: string}>} domains - Array of domain objects
 * @param {function} log - Optional logging function
 * @param {number} concurrency - Number of concurrent checks
 * @returns {Promise<Map<string, boolean|null>>} Map of domain to Klaviyo detection result
 */
export async function batchDetectKlaviyo(domains, log, concurrency = 50) {
    const results = new Map();
    let processed = 0;
    const startedAt = Date.now();
    let detectedCount = 0;
    let unresolvedCount = 0;
    const totalDomains = Array.isArray(domains) ? domains.length : 0;

    emitLog(log, `[Klaviyo][Batch] Start total=${totalDomains} concurrency=${concurrency}`);

    const checkBatch = async (batch) => {
        emitLog(log, `[Klaviyo][Batch] Processing batch size=${batch.length}`);

        await Promise.allSettled(
            batch.map(async ({ domain }) => {
                try {
                    const hasKlaviyo = await detectKlaviyo(domain, log);
                    results.set(domain, hasKlaviyo);
                    if (hasKlaviyo === true) detectedCount++;
                    if (hasKlaviyo === null) unresolvedCount++;
                } catch (error) {
                    results.set(domain, null);
                    unresolvedCount++;
                }
                
                processed++;
                if (processed % 10 === 0) {
                    emitLog(log, `[Klaviyo][Batch] Progress ${processed}/${totalDomains}`);
                }
            })
        );
    };

    // Process in batches
    for (let i = 0; i < domains.length; i += concurrency) {
        const batch = domains.slice(i, i + concurrency);
        await checkBatch(batch);
    }

    emitLog(
        log,
        `[Klaviyo][Batch] Complete checked=${processed} detected=${detectedCount} not_detected=${Math.max(processed - detectedCount - unresolvedCount, 0)} unresolved=${unresolvedCount} latency_ms=${Date.now() - startedAt}`
    );

    return results;
}

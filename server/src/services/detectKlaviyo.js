import axios from 'axios';
import https from 'https';

// DNS-over-HTTPS configuration
const USE_DNS_OVER_HTTPS = true;
const DOH_PROVIDER = 'https://dns.google/resolve';
const USE_PROXY = false;

/**
 * DNS-over-HTTPS TXT lookup
 * @param {string} domain - Domain to query
 * @returns {Promise<string[]>} Array of TXT record strings
 */
async function dohLookup(domain) {
    const url = `${DOH_PROVIDER}?name=${encodeURIComponent(domain)}&type=TXT`;
    
    const config = {
        timeout: 10000,
        httpsAgent: new https.Agent({
            rejectUnauthorized: false // Disable strict cert validation
        })
    };

    try {
        const response = await axios.get(url, config);
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
        
        return txtRecords;
    } catch (error) {
        throw new Error(`DoH lookup failed: ${error.message}`);
    }
}

/**
 * Detect if domain uses Klaviyo
 * @param {string} domain - Domain to check
 * @param {function} log - Optional logging function
 * @returns {Promise<boolean>} True if Klaviyo detected
 */
export async function detectKlaviyo(domain, log) {
    try {
        const txtRecords = await dohLookup(domain);
        
        // Flatten all TXT content and check for klaviyo-site-verification
        const allContent = txtRecords.join(' ');
        const hasKlaviyo = allContent.includes('klaviyo-site-verification=');
        
        if (hasKlaviyo) {
            log?.(`✓ Klaviyo detected for ${domain}`);
        }
        
        return hasKlaviyo;
    } catch (error) {
        log?.(`✗ Klaviyo check failed for ${domain}: ${error.message}`);
        return false;
    }
}

/**
 * Batch detect Klaviyo for multiple domains
 * @param {Array<{domain: string}>} domains - Array of domain objects
 * @param {function} log - Optional logging function
 * @param {number} concurrency - Number of concurrent checks
 * @returns {Promise<Map<string, boolean>>} Map of domain to Klaviyo detection result
 */
export async function batchDetectKlaviyo(domains, log, concurrency = 50) {
    const results = new Map();
    let processed = 0;

    const checkBatch = async (batch) => {
        await Promise.allSettled(
            batch.map(async ({ domain }) => {
                try {
                    const hasKlaviyo = await detectKlaviyo(domain, log);
                    results.set(domain, hasKlaviyo);
                } catch (error) {
                    results.set(domain, false);
                }
                
                processed++;
                if (processed % 10 === 0) {
                    log?.(`Klaviyo check progress: ${processed}/${domains.length}`);
                }
            })
        );
    };

    // Process in batches
    for (let i = 0; i < domains.length; i += concurrency) {
        const batch = domains.slice(i, i + concurrency);
        await checkBatch(batch);
    }

    log?.(`Klaviyo detection complete: ${processed} domains checked`);
    return results;
}

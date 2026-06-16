import dns from 'dns';
import { promisify } from 'util';
import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { parse as csvParse } from 'csv-parse';
import { stringify as csvStringify } from 'csv-stringify';
import OpenAI from 'openai';
import pLimit from 'p-limit';

const dnsResolve4 = promisify(dns.resolve4);
const dnsResolveCname = promisify(dns.resolveCname);

// B2B keyword patterns for filtering
const B2B_KEYWORDS = [
    'wholesale', 'bulk', 'distributor', 'moq', 'reseller',
    'white label', 'private label', 'trade only', 'b2b',
    'business pricing', 'commercial', 'industrial', 'oem',
    'minimum order', 'bulk order', 'trade account'
];

const NEW_PROMPT_MODEL = 'gpt-5-mini';

/** Emits stage progress so jobPipeline persists to SQL + Supabase Realtime. */
function reportPersonalizationProgress(log, processed, total, stats = {}) {
    const safeTotal = Math.max(1, Number(total) || 1);
    const done = Math.min(Math.max(0, Number(processed) || 0), safeTotal);
    const progress = {
        stage: 'personalization',
        processed: done,
        total: safeTotal,
        stats: { personalized: done, ...stats }
    };
    if (typeof stats.cost === 'number' && Number.isFinite(stats.cost)) {
        progress.cost = stats.cost;
        progress.stats.Cost = `$${stats.cost.toFixed(2)}`;
    }
    const phase = stats.phase;
    const label =
        phase === 'shopify_detection'
            ? 'Shopify detection'
            : phase === 'fetching_products'
                ? 'Fetching products'
                : phase === 'generating'
                    ? 'Generating first lines'
                    : 'Personalization';
    log?.(`${label}: ${done}/${safeTotal}`, { progress });
}

function normalizeHostname(urlOrDomain) {
    let hostname = urlOrDomain.trim().toLowerCase();
    // Fix malformed URLs
    hostname = hostname.replace(/^ttp:\/\//, 'http://');
    hostname = hostname.replace(/^ttps:\/\//, 'https://');

    // Extract hostname if URL
    try {
        if (hostname.includes('://')) {
            const url = new URL(hostname);
            hostname = url.hostname;
        }
    } catch {
        // Not a URL, treat as domain
    }

    // Strip www
    hostname = hostname.replace(/^www\./, '');
    return hostname;
}

export async function detectShopify(domain, log) {
    try {
        // Check A records for Shopify IPs (23.227.38.*)
        try {
            const aRecords = await dnsResolve4(domain);
            if (aRecords.some(ip => ip.startsWith('23.227.38.'))) {
                return true;
            }
        } catch {
            // A record lookup failed, continue to CNAME check
        }

        // Check CNAME for myshopify.com
        try {
            const wwwDomain = `www.${domain}`;
            const cnames = await dnsResolveCname(wwwDomain);
            if (cnames.some(cname => cname.includes('myshopify.com'))) {
                return true;
            }
        } catch {
            // CNAME lookup failed
        }

        return false;
    } catch (error) {
        log?.(`Shopify detection error for ${domain}: ${error.message}`);
        return false;
    }
}

async function runShopifyDetection({ inputCsv, outputCsv, log, concurrency = 200 }) {
    log?.('Starting Shopify detection...');

    const rows = [];
    await new Promise((resolve, reject) => {
        fs.createReadStream(inputCsv)
            .pipe(csvParse({ columns: true, trim: true }))
            .on('data', (row) => {
                // Process any row with an email address
                const email = (row.email || '').trim();
                if (email) {
                    rows.push(row);
                }
            })
            .on('end', resolve)
            .on('error', reject);
    });

    if (rows.length === 0) {
        log?.('No emails found, skipping Shopify detection');
        fs.writeFileSync(outputCsv, 'domain,shopify,founder_name,email,email_status\n');
        return { total: 0, shopifyStores: 0 };
    }

    reportPersonalizationProgress(log, 0, rows.length, { phase: 'shopify_detection', shopifyStores: 0 });

    const results = [];
    let processed = 0;
    let shopifyCount = 0;

    // Process in batches with concurrency
    const processBatch = async (batch) => {
        const batchResults = await Promise.all(
            batch.map(async (row) => {
                const domain = normalizeHostname(row.domain || '');
                if (!domain) return null;

                const isShopify = await detectShopify(domain, log);
                processed++;

                if (isShopify) shopifyCount++;

                return {
                    domain,
                    shopify: isShopify ? 'Yes' : 'No',
                    founder_name: row.founder_name || '',
                    email: row.email || '',
                    email_status: row.email_status || ''
                };
            })
        );
        return batchResults.filter(Boolean);
    };

    // Process all rows in batches
    for (let i = 0; i < rows.length; i += concurrency) {
        const batch = rows.slice(i, i + concurrency);
        const batchResults = await processBatch(batch);
        results.push(...batchResults);
        reportPersonalizationProgress(log, Math.min(i + batch.length, rows.length), rows.length, {
            phase: 'shopify_detection',
            shopifyStores: shopifyCount
        });
    }

    // Write results
    const writeStream = fs.createWriteStream(outputCsv);
    const stringifier = csvStringify({ header: true, columns: ['domain', 'shopify', 'founder_name', 'email', 'email_status'] });
    stringifier.pipe(writeStream);
    results.forEach(row => stringifier.write(row));
    stringifier.end();
    await new Promise(resolve => writeStream.on('finish', resolve));

    log?.(`Shopify detection complete: ${shopifyCount}/${rows.length} Shopify stores detected`);
    return { total: rows.length, shopifyStores: shopifyCount };
}

async function writeAllDomainsAsShopify({ inputCsv, outputCsv, log }) {
    log?.('Skipping Shopify DNS detection; treating all domains as Shopify stores');

    const rows = [];
    await new Promise((resolve, reject) => {
        fs.createReadStream(inputCsv)
            .pipe(csvParse({ columns: true, trim: true }))
            .on('data', (row) => {
                const email = (row.email || '').trim();
                if (email) {
                    rows.push(row);
                }
            })
            .on('end', resolve)
            .on('error', reject);
    });

    if (rows.length === 0) {
        log?.('No emails found, skipping personalization');
        fs.writeFileSync(outputCsv, 'domain,shopify,founder_name,email,email_status\n');
        return { total: 0, shopifyStores: 0 };
    }

    const results = rows
        .map((row) => {
            const domain = normalizeHostname(row.domain || '');
            if (!domain) return null;
            return {
                domain,
                shopify: 'Yes',
                founder_name: row.founder_name || '',
                email: row.email || '',
                email_status: row.email_status || ''
            };
        })
        .filter(Boolean);

    const writeStream = fs.createWriteStream(outputCsv);
    const stringifier = csvStringify({ header: true, columns: ['domain', 'shopify', 'founder_name', 'email', 'email_status'] });
    stringifier.pipe(writeStream);
    results.forEach((row) => stringifier.write(row));
    stringifier.end();
    await new Promise((resolve) => writeStream.on('finish', resolve));

    log?.(`Shopify detection bypassed: ${results.length} domains marked as Shopify`);
    return { total: rows.length, shopifyStores: results.length };
}

function fetchUrl(url, timeout = 3000) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        const timeoutId = setTimeout(() => {
            req.destroy();
            reject(new Error('Request timeout'));
        }, timeout);

        const req = protocol.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        }, (res) => {
            clearTimeout(timeoutId);

            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }

            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (err) {
                    reject(new Error('Invalid JSON'));
                }
            });
        });

        req.on('error', (err) => {
            clearTimeout(timeoutId);
            reject(err);
        });
    });
}

async function fetchProductSamples({ inputCsv, outputJson, outputFailures, log, concurrency = 20, batchDelay = 300, retries = 2 }) {
    log?.('Fetching product samples from Shopify stores...');

    const rows = [];
    await new Promise((resolve, reject) => {
        fs.createReadStream(inputCsv)
            .pipe(csvParse({ columns: true, trim: true }))
            .on('data', (row) => {
                if (row.shopify === 'Yes') {
                    rows.push(row);
                }
            })
            .on('end', resolve)
            .on('error', reject);
    });

    const products = [];
    const failures = [];
    let processed = 0;

    const fetchWithRetry = async (url, attempts = 0) => {
        try {
            const data = await fetchUrl(url);
            if (data.products && data.products.length > 0) {
                const product = data.products[0];
                return {
                    url,
                    title: product.title || '',
                    body_html: product.body_html || '',
                    tags: Array.isArray(product.tags) ? product.tags.join(', ') : (product.tags || ''),
                    published_at: product.published_at || '',
                    created_at: product.created_at || '',
                    updated_at: product.updated_at || ''
                };
            }
            return null;
        } catch (err) {
            if (attempts < retries) {
                await new Promise(resolve => setTimeout(resolve, 1000 * (attempts + 1)));
                return fetchWithRetry(url, attempts + 1);
            }
            throw err;
        }
    };

    const processBatch = async (batch) => {
        const results = await Promise.allSettled(
            batch.map(async (row) => {
                const domain = normalizeHostname(row.domain);
                const url = `https://${domain}/products.json?limit=1`;

                try {
                    const product = await fetchWithRetry(url);
                    if (product) {
                        products.push(product);
                    }
                } catch (err) {
                    failures.push({ url, error: err.message });
                }

                processed++;
                if (processed % 10 === 0) {
                    log?.(`Product fetch progress: ${processed}/${rows.length} (${products.length} fetched, ${failures.length} failed)`);
                }
            })
        );
    };

    // Process in batches with delay
    for (let i = 0; i < rows.length; i += concurrency) {
        const batch = rows.slice(i, i + concurrency);
        await processBatch(batch);
        if (i + concurrency < rows.length) {
            await new Promise(resolve => setTimeout(resolve, batchDelay));
        }
    }

    // Write products to JSON
    fs.writeFileSync(outputJson, JSON.stringify(products, null, 2));

    // Write failures to CSV
    if (failures.length > 0) {
        const writeStream = fs.createWriteStream(outputFailures);
        const stringifier = csvStringify({ header: true, columns: ['url', 'error'] });
        stringifier.pipe(writeStream);
        failures.forEach(row => stringifier.write(row));
        stringifier.end();
        await new Promise(resolve => writeStream.on('finish', resolve));
    }

    log?.(`Product fetch complete: ${products.length} products fetched, ${failures.length} failures`);
    return { fetched: products.length, failed: failures.length };
}

function stripHtml(html) {
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function isB2B(text) {
    const lower = text.toLowerCase();
    return B2B_KEYWORDS.some(keyword => lower.includes(keyword));
}

function formatProductsForNewPrompt(products = []) {
    return products.map((p, idx) => {
        const title = String(p.title || '').trim() || '[No title]';
        const description = String(stripHtml(p.body_html || '') || '').trim().slice(0, 320);

        return `${idx + 1}. Title: ${title}
Description: ${description || 'N/A'}`;
    }).join('\n\n');
}

function buildNewPrompt({ domain, productList }) {
    return `You are analyzing multiple products from a Shopify store (domain: ${domain}).

Your task:
1. Review all products below.
2. Choose the ONE product most likely to be:
   - currently live and available
   - a real consumer product, not a test item, gift card, SKU dump, placeholder, or broken title
   - representative of the store.
3. Generate one personalized first line based only on that chosen product.

First-line rules:
- Exact structure: "I was taking a look at the {natural product name} and {brief, specific observation}!"
- One sentence only
- Sound like one real person writing to one real person
- Keep it short, natural, and believable
- Use active voice
- The product name can be shortened naturally if needed
- Rewrite product names into natural sentence case when needed (no ALL CAPS or shouty casing)
- Remove promo words from the product name in the first line (for example: "EXCLUSIVE", "BESTSELLER", "NEW")
- The observation must read like a compliment, not a catalog description
- The observation must be a complete natural-language phrase, not a fragment
- The observation must include a natural verb like "looks", "sounds", or "really catches the light"
- The line must not imply I bought, used, touched, smelled, wore, tasted, or tried the product
- Base the observation only on things that could reasonably be noticed from the product title, description, or images
- Keep the compliment visual and aesthetic (how it looks), not functional or factual
- Shorten the product name so it sounds natural in a cold opener
- Prefer the simplest natural version that still clearly identifies the product
- Do not invent, merge, rename, or alter key words from the original product name

Avoid:
- "We were taking a look"
- copied product attributes pasted as compliments
- all-caps product names or robotic title casing
- feature/spec descriptions such as pack size, number of pieces, included item breakdown, gusset/material composition, measurements, or construction details
- neutral product summaries like "it is a six-piece set..." or "it has X and Y"
- marketing language, clichés, hype, or jargon

If the product list is mostly junk, duplicate filler, test products, gift cards, SKUs, or unusable titles, return: "invalid"

Products to choose from:
${productList}

Output format (JSON):
{
  "chosen_product_number": 1,
  "product_title": "...",
  "first_line": "..."
}`;
}

function parseNewPromptResponse(raw = '') {
    const text = String(raw || '').trim();
    if (!text) return null;

    const fencedMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    const candidate = (fencedMatch ? fencedMatch[1] : text).trim();

    if (/^"?invalid"?$/i.test(candidate)) {
        return { invalid: true };
    }

    try {
        const parsed = JSON.parse(candidate);
        if (typeof parsed === 'string' && /^invalid$/i.test(parsed.trim())) {
            return { invalid: true };
        }
        const firstLine = String(parsed?.first_line || '').trim();
        const productTitle = String(parsed?.product_title || '').trim();
        const chosenProductNumber = Number.parseInt(String(parsed?.chosen_product_number || 1), 10);
        if (!firstLine) return null;
        return {
            invalid: false,
            firstLine,
            productTitle,
            chosenProductNumber: Number.isFinite(chosenProductNumber) ? chosenProductNumber : 1
        };
    } catch {
        const plain = candidate.replace(/^"|"$/g, '').trim();
        if (!plain) return null;
        return {
            invalid: false,
            firstLine: plain,
            productTitle: '',
            chosenProductNumber: 1
        };
    }
}

async function personalizeWithNewPromptFromShopify({
    inputCsv,
    outputCsv,
    apiKeys,
    log,
    productPromptProducts = 3,
    concurrency = 100,
    fetchConcurrency = 200,
    model = NEW_PROMPT_MODEL,
    removeB2B = true,
    onBatch = null,
    checkpoint = null
}) {
    log?.(`Generating personalized first lines with New Prompt (${model})...`);

    if (!apiKeys.openai) {
        throw new Error('OpenAI API key required for personalization');
    }

    const openai = new OpenAI({ apiKey: apiKeys.openai });
    const rows = [];
    await new Promise((resolve, reject) => {
        fs.createReadStream(inputCsv)
            .pipe(csvParse({ columns: true, trim: true }))
            .on('data', (row) => {
                if (row.shopify === 'Yes') rows.push(row);
            })
            .on('end', resolve)
            .on('error', reject);
    });

    if (!rows.length) {
        fs.writeFileSync(outputCsv, 'domain,url,title,description,date,first_line\n');
        return { personalized: 0, productsFetched: 0, failed: 0 };
    }

    const writeStream = fs.createWriteStream(outputCsv);
    const stringifier = csvStringify({
        header: true,
        columns: ['domain', 'url', 'title', 'description', 'date', 'first_line']
    });
    stringifier.pipe(writeStream);

    let processed = 0;
    let productsFetched = 0;
    let failed = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let fallbackUsed = 0;
    let backoffMs = 0;

    // In-flight batch for incremental upserts
    const pendingBatch = [];
    let flushPromise = Promise.resolve();
    const BATCH_SIZE = 50;

    const flushBatch = async (force = false) => {
        if (!onBatch) return;
        if (!force && pendingBatch.length < BATCH_SIZE) return;
        const batch = pendingBatch.splice(0, pendingBatch.length);
        if (batch.length === 0) return;
        flushPromise = flushPromise.then(() => onBatch(batch));
        await flushPromise;
    };

    const isPermanentFetchError = (err) => {
        const message = String(err?.message || '');
        // 3xx redirects, 4xx client errors — deterministic, won't change on retry
        if (/^HTTP [34]\d\d$/.test(message)) return true;
        // SSL/TLS issues — won't recover within seconds
        if (/certificate/i.test(message)) return true;
        // DNS — domain doesn't resolve, won't change
        if (/ENOTFOUND/i.test(message)) return true;
        return false;
    };

    const fetchProductsForDomain = async (domain, retries = 1, attempts = 0) => {
        const url = `https://${domain}/products.json?limit=${productPromptProducts}`;
        try {
            const data = await fetchUrl(url);
            const products = Array.isArray(data?.products) ? data.products : [];
            return products.slice(0, productPromptProducts);
        } catch (err) {
            if (attempts < retries && !isPermanentFetchError(err)) {
                await new Promise((resolve) => setTimeout(resolve, 700 * (attempts + 1)));
                return fetchProductsForDomain(domain, retries, attempts + 1);
            }
            throw err;
        }
    };

    const createCompletionWithRetry = async ({
        prompt,
        requestedModel,
        retryCount = 0,
        allowFallback = true
    }) => {
        try {
            if (backoffMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, backoffMs));
            }

            const request = {
                model: requestedModel,
                messages: [{ role: 'user', content: prompt }]
            };
            if (requestedModel !== NEW_PROMPT_MODEL) {
                request.max_tokens = 180;
                request.temperature = 0.7;
            }

            const completion = await openai.chat.completions.create(request);

            backoffMs = Math.max(0, backoffMs - 100);
            return completion;
        } catch (err) {
            const message = String(err?.message || '');
            const messageLower = message.toLowerCase();
            const statusCode = Number(err?.status || 0);

            if (statusCode === 429 && retryCount < 3) {
                backoffMs = Math.min(5000, (backoffMs || 500) * 2);
                log?.(`New prompt rate limited (${requestedModel}), backing off for ${backoffMs}ms`);
                await new Promise((resolve) => setTimeout(resolve, backoffMs + Math.random() * 1000));
                return createCompletionWithRetry({
                    prompt,
                    requestedModel,
                    retryCount: retryCount + 1,
                    allowFallback
                });
            }

            const shouldFallback = allowFallback
                && requestedModel === NEW_PROMPT_MODEL
                && (messageLower.includes('model') || messageLower.includes('permission'));
            if (shouldFallback) {
                fallbackUsed += 1;
                log?.(`New prompt model fallback: ${message}`);
                return createCompletionWithRetry({
                    prompt,
                    requestedModel: 'gpt-4o-mini',
                    retryCount,
                    allowFallback: false
                });
            }

            throw err;
        }
    };

    // ===== Phase 1: Fetch products in parallel =====
    log?.(`Fetching products for ${rows.length} Shopify stores (concurrency ${fetchConcurrency})...`);
    reportPersonalizationProgress(log, 0, rows.length, { phase: 'fetching_products' });

    // domain -> { products: Product[] } | { fetchError: string } | { empty: true }
    const productCache = new Map();
    const fetchLimit = pLimit(fetchConcurrency);
    let fetchProcessed = 0;
    let fetchFailed = 0;

    await Promise.all(rows.map((row) => fetchLimit(async () => {
        if (checkpoint) await checkpoint();
        const domain = normalizeHostname(row.domain || '');
        if (!domain) {
            fetchProcessed += 1;
            return;
        }
        try {
            let products = await fetchProductsForDomain(domain);
            if (removeB2B) {
                products = products.filter((p) => {
                    const combined = `${p.title || ''} ${stripHtml(p.body_html || '')} ${Array.isArray(p.tags) ? p.tags.join(', ') : (p.tags || '')}`;
                    return !isB2B(combined);
                });
            }
            if (!products.length) {
                productCache.set(domain, { empty: true });
            } else {
                productCache.set(domain, { products });
                productsFetched += products.length;
            }
        } catch (err) {
            fetchFailed += 1;
            productCache.set(domain, { fetchError: err.message });
            log?.(`Product fetch failed for ${domain}: ${err.message}`);
        }

        fetchProcessed += 1;
        if (fetchProcessed % 50 === 0 || fetchProcessed === rows.length) {
            reportPersonalizationProgress(log, fetchProcessed, rows.length, {
                phase: 'fetching_products',
                productsFetched,
                fetchFailed
            });
        }
    })));

    log?.(`Product fetch complete: ${productsFetched} products from ${rows.length - fetchFailed}/${rows.length} stores${fetchFailed ? ` (${fetchFailed} failed)` : ''}`);

    // ===== Phase 2: Generate first lines in parallel =====
    log?.(`Generating first lines with OpenAI (concurrency ${concurrency})...`);
    reportPersonalizationProgress(log, 0, rows.length, { phase: 'generating', productsFetched });

    const llmLimit = pLimit(concurrency);

    const runRow = async (row) => {
        if (checkpoint) await checkpoint();
        const domain = normalizeHostname(row.domain || '');
        if (!domain) return null;

        const cached = productCache.get(domain);
        if (!cached) {
            return {
                domain,
                url: `https://${domain}`,
                title: '',
                description: '',
                date: '',
                first_line: '[Generation failed]'
            };
        }
        if (cached.fetchError) {
            return {
                domain,
                url: `https://${domain}`,
                title: '',
                description: '',
                date: '',
                first_line: '[Generation failed]'
            };
        }
        if (cached.empty || !cached.products?.length) {
            return {
                domain,
                url: `https://${domain}`,
                title: '',
                description: '',
                date: '',
                first_line: 'invalid'
            };
        }

        const productList = formatProductsForNewPrompt(cached.products);
        const prompt = buildNewPrompt({ domain, productList });

        const completion = await createCompletionWithRetry({
            prompt,
            requestedModel: model,
            retryCount: 0,
            allowFallback: true
        });

        totalInputTokens += completion.usage?.prompt_tokens || 0;
        totalOutputTokens += completion.usage?.completion_tokens || 0;

        const output = completion.choices?.[0]?.message?.content?.trim() || '';
        const parsed = parseNewPromptResponse(output);
        if (!parsed) {
            log?.(`New prompt parse failed for ${domain}: ${output.slice(0, 180)}`);
            return {
                domain,
                url: `https://${domain}`,
                title: '',
                description: '',
                date: '',
                first_line: '[Generation failed]'
            };
        }
        if (parsed.invalid) {
            return {
                domain,
                url: `https://${domain}`,
                title: '',
                description: '',
                date: '',
                first_line: 'invalid'
            };
        }

        return {
            domain,
            url: `https://${domain}`,
            title: parsed.productTitle || '',
            description: '',
            date: '',
            first_line: parsed.firstLine
        };
    };

    await Promise.all(rows.map((row) => llmLimit(async () => {
        let result = null;
        try {
            result = await runRow(row);
        } catch (err) {
            failed += 1;
            log?.(`New prompt row failed: ${err?.message || err || 'Unknown error'}`);
        }

        if (result) {
            processed += 1;
            stringifier.write(result);
            if (onBatch && result.first_line && result.first_line !== '[Generation failed]' && result.first_line !== 'invalid') {
                pendingBatch.push({
                    domain: result.domain,
                    personalization_first_line: result.first_line
                });
                if (pendingBatch.length >= BATCH_SIZE) {
                    await flushBatch(false);
                }
            }
        }

        if (processed % 25 === 0 || processed === rows.length) {
            const runningCost =
                (totalInputTokens * 0.00025) / 1000 + (totalOutputTokens * 0.002) / 1000;
            reportPersonalizationProgress(log, processed, rows.length, {
                phase: 'generating',
                productsFetched,
                failed,
                cost: Number(runningCost.toFixed(6))
            });
        }
    })));

    stringifier.end();
    await new Promise((resolve) => writeStream.on('finish', resolve));

    // Flush remaining batch
    if (onBatch) {
        await flushBatch(true);
    }

    const estimatedCost = (totalInputTokens * 0.00025) / 1000 + (totalOutputTokens * 0.002) / 1000;
    reportPersonalizationProgress(log, processed, rows.length, {
        phase: 'generating',
        productsFetched,
        failed,
        cost: Number(estimatedCost.toFixed(6))
    });

    log?.(`New prompt personalization complete: ${processed} rows. Tokens in/out: ${totalInputTokens}/${totalOutputTokens} (~$${estimatedCost.toFixed(4)})${fallbackUsed ? `, fallback used: ${fallbackUsed}` : ''}`);

    return {
        personalized: processed,
        productsFetched,
        failed,
        estimatedCost: Number(estimatedCost.toFixed(6))
    };
}

async function cleanProductData({ inputJson, outputCsv, log, maxBodyLength = 800, removeB2B = true }) {
    log?.(`Cleaning product data...${removeB2B ? '' : ' (B2B filter disabled)'}`);

    const products = JSON.parse(fs.readFileSync(inputJson, 'utf-8'));
    const cleaned = [];
    let removed = 0;
    let truncated = 0;
    const removedExamples = [];

    for (const product of products) {
        const title = product.title || '';
        const bodyText = stripHtml(product.body_html || '');
        const tags = product.tags || '';
        const url = product.url || '';

        // Extract domain from URL
        const domain = normalizeHostname(url);

        // Check if B2B
        const combinedText = `${title} ${bodyText} ${tags} ${url}`;
        if (removeB2B && isB2B(combinedText)) {
            removed++;
            if (removedExamples.length < 3) {
                removedExamples.push({ title, url });
            }
            continue;
        }

        // Truncate long bodies
        let finalBody = bodyText;
        if (bodyText.length > maxBodyLength) {
            finalBody = bodyText.substring(0, maxBodyLength) + '...[truncated]';
            truncated++;
        }

        // Sanitize
        finalBody = finalBody.replace(/\n+/g, ' ').replace(/"/g, "'").trim();

        cleaned.push({
            domain,
            url,
            title,
            body_text: finalBody,
            tags,
            published_at: product.published_at || '',
            created_at: product.created_at || '',
            updated_at: product.updated_at || ''
        });
    }

    // Write cleaned data
    const writeStream = fs.createWriteStream(outputCsv);
    const stringifier = csvStringify({
        header: true,
        columns: ['domain', 'url', 'title', 'body_text', 'tags', 'published_at', 'created_at', 'updated_at']
    });
    stringifier.pipe(writeStream);
    cleaned.forEach(row => stringifier.write(row));
    stringifier.end();
    await new Promise(resolve => writeStream.on('finish', resolve));

    log?.(`Cleaning complete: ${cleaned.length} products kept, ${removed} B2B removed, ${truncated} truncated`);
    if (removedExamples.length > 0) {
        log?.(`Removed examples: ${removedExamples.map(e => e.title).join(', ')}`);
    }

    return { kept: cleaned.length, removed, truncated };
}

function getHumanTimeframe(dateStr) {
    if (!dateStr) return 'recently';

    try {
        const date = new Date(dateStr);
        const now = new Date();
        const diffMs = now - date;
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

        if (diffDays < 7) return 'a few days ago';
        if (diffDays < 30) return 'a few weeks ago';
        if (diffDays < 90) return 'earlier this quarter';

        const months = ['January', 'February', 'March', 'April', 'May', 'June',
            'July', 'August', 'September', 'October', 'November', 'December'];
        return `back in ${months[date.getMonth()]} ${date.getFullYear()}`;
    } catch {
        return 'recently';
    }
}

async function personalizeWithLLM({ inputCsv, outputCsv, apiKeys, log, concurrency = 15, model = 'gpt-5-nano', onBatch = null }) {
    log?.('Generating personalized first lines with OpenAI...');

    if (!apiKeys.openai) {
        throw new Error('OpenAI API key required for personalization');
    }

    const openai = new OpenAI({ apiKey: apiKeys.openai });

    const rows = [];
    await new Promise((resolve, reject) => {
        fs.createReadStream(inputCsv)
            .pipe(csvParse({ columns: true, trim: true }))
            .on('data', (row) => rows.push(row))
            .on('end', resolve)
            .on('error', reject);
    });

    const results = [];
    let processed = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let backoffMs = 0;

    // In-flight batch for incremental upserts
    const pendingBatch = [];
    let flushPromise = Promise.resolve();
    const BATCH_SIZE = 50;

    const flushBatch = async (force = false) => {
        if (!onBatch) return;
        if (!force && pendingBatch.length < BATCH_SIZE) return;
        const batch = pendingBatch.splice(0, pendingBatch.length);
        if (batch.length === 0) return;
        flushPromise = flushPromise.then(() => onBatch(batch));
        await flushPromise;
    };

    const generateFirstLine = async (title, description, timeframe, retryCount = 0) => {
        try {
            if (backoffMs > 0) {
                await new Promise(resolve => setTimeout(resolve, backoffMs));
            }

            const prompt = `Write one natural, human-sounding sentence using this structure:
"We were taking a look at the {natural product name} and {short, real human compliment}."
Follow these style rules:
Use active voice.Talk directly, like you’re speaking to one person.Be concise.Use simple language.Cut all fluff.Focus on clarity.Sound conversational and real.Avoid marketing language entirely.Avoid clichés, jargon, hashtags, semicolons, emojis, asterisks, and dashes.Vary sentence rhythm but keep it one sentence total.Avoid AI-filler phrases.If something is certain, say it directly.No repetition.
About the product name:Shorten it to a human version, brand plus simple category.

About the compliment:Make it brief, specific, human, grounded in real life.Don't make a generic compliment, make it about a detail or something specific.Make the comment enthusiastic, feel free to use a '!' where it would suit.Do not imply you bought or used the product.
If the product title is nonsense or only an SKU, return exactly: invalid.
Output:One sentence only. No extra text or explanation.Inputs:Product Title
Product Description:

Product: ${title}
Description: ${description}
`;

            const completion = await openai.chat.completions.create({
                model,
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 60,
                temperature: 0.8
            });

            const firstLine = completion.choices[0].message.content.trim();
            totalInputTokens += completion.usage?.prompt_tokens || 0;
            totalOutputTokens += completion.usage?.completion_tokens || 0;

            // Success - reduce backoff
            backoffMs = Math.max(0, backoffMs - 100);

            return firstLine;
        } catch (err) {
            if (err.status === 429 && retryCount < 3) {
                backoffMs = Math.min(5000, (backoffMs || 500) * 2);
                log?.(`Rate limited, backing off for ${backoffMs}ms`);
                await new Promise(resolve => setTimeout(resolve, backoffMs + Math.random() * 1000));
                return generateFirstLine(title, description, timeframe, retryCount + 1);
            }
            throw err;
        }
    };

    // Create write stream
    const writeStream = fs.createWriteStream(outputCsv);
    const stringifier = csvStringify({
        header: true,
        columns: ['domain', 'url', 'title', 'description', 'date', 'first_line']
    });
    stringifier.pipe(writeStream);

    // Process in batches
    const processBatch = async (batch) => {
        const batchResults = await Promise.allSettled(
            batch.map(async (row) => {
                const domain = row.domain || '';
                const title = row.title || '';
                const description = (row.body_text || '').substring(0, 180);
                const date = row.published_at || row.created_at || '';
                const timeframe = getHumanTimeframe(date);

                try {
                    const firstLine = await generateFirstLine(title, description, timeframe);
                    processed++;

                    return {
                        domain,
                        url: row.url || '',
                        title,
                        description,
                        date,
                        first_line: firstLine
                    };
                } catch (err) {
                    log?.(`Failed to personalize "${title}": ${err.message}`);
                    return {
                        domain,
                        url: row.url || '',
                        title,
                        description,
                        date,
                        first_line: '[Generation failed]'
                    };
                }
            })
        );

        // Write results as they arrive
        batchResults.forEach(result => {
            if (result.status === 'fulfilled' && result.value) {
                stringifier.write(result.value);
                // Queue incremental upsert
                if (onBatch && result.value.first_line && result.value.first_line !== '[Generation failed]' && result.value.first_line !== 'invalid') {
                    pendingBatch.push({
                        domain: result.value.domain,
                        personalization_first_line: result.value.first_line
                    });
                }
            }
        });
        await flushBatch(false);
    };

    // Process all rows in batches
    for (let i = 0; i < rows.length; i += concurrency) {
        const batch = rows.slice(i, i + concurrency);
        await processBatch(batch);
        const runningCost =
            (totalInputTokens * 0.00015) / 1000 + (totalOutputTokens * 0.0006) / 1000;
        reportPersonalizationProgress(log, Math.min(i + batch.length, rows.length), rows.length, {
            phase: 'generating',
            cost: Number(runningCost.toFixed(6))
        });
    }

    stringifier.end();
    await new Promise(resolve => writeStream.on('finish', resolve));

    // Flush remaining batch
    if (onBatch) {
        await flushBatch(true);
    }

    const estimatedCost = (totalInputTokens * 0.00015) / 1000 + (totalOutputTokens * 0.0006) / 1000;
    reportPersonalizationProgress(log, processed, rows.length, {
        phase: 'generating',
        cost: Number(estimatedCost.toFixed(6))
    });
    log?.(`Personalization complete: ${processed} first lines generated`);
    log?.(`Token usage: ${totalInputTokens.toLocaleString()} input, ${totalOutputTokens.toLocaleString()} output (~$${estimatedCost.toFixed(4)})`);

    return {
        personalized: processed,
        cost: estimatedCost,
        'Estimated Cost': estimatedCost
    };
}

export async function runPersonalization({
    inputCsv,
    outputCsv,
    apiKeys,
    log,
    concurrency,
    removeB2B = true,
    productPromptVersion = 'old',
    productPromptProducts = 3,
    skipShopifyDetection = false,
    onBatch = null,
    checkpoint = null
}) {
    const jobDir = path.dirname(inputCsv);
    const shopifyDetectionCsv = path.join(jobDir, 'shopify-detection.csv');
    const productsJson = path.join(jobDir, 'products.json');
    const productFailuresCsv = path.join(jobDir, 'product-failures.csv');
    const cleanedProductsCsv = path.join(jobDir, 'products-cleaned.csv');

    // Step 1: Shopify Detection (optional DNS bypass for local runs)
    const shopifyStats = skipShopifyDetection
        ? await writeAllDomainsAsShopify({ inputCsv, outputCsv: shopifyDetectionCsv, log })
        : await runShopifyDetection({
            inputCsv,
            outputCsv: shopifyDetectionCsv,
            log,
            concurrency: 200
        });

    // If no Shopify stores found, skip remaining steps
    if (shopifyStats.shopifyStores === 0) {
        log?.('No Shopify stores detected, skipping product fetch and personalization');
        // Create empty output file
        fs.writeFileSync(outputCsv, 'domain,url,title,description,date,first_line\n');
        return {
            shopifyStores: 0,
            productsFetched: 0,
            personalized: 0,
            skipped: true
        };
    }

    const useNewPrompt = String(productPromptVersion || '').toLowerCase() === 'new_gpt5mini';
    const personalizationConcurrency = Number.isFinite(concurrency)
        ? Math.max(1, concurrency)
        : (useNewPrompt ? 100 : 15);
    if (useNewPrompt) {
        const newPromptProducts = Number.isFinite(productPromptProducts)
            ? Math.max(1, Math.min(productPromptProducts, 5))
            : 3;

        const newPromptStats = await personalizeWithNewPromptFromShopify({
            inputCsv: shopifyDetectionCsv,
            outputCsv,
            apiKeys,
            log,
            productPromptProducts: newPromptProducts,
            concurrency: personalizationConcurrency,
            model: NEW_PROMPT_MODEL,
            removeB2B,
            onBatch,
            checkpoint
        });

        const estimatedCost = newPromptStats.estimatedCost || 0;
        return {
            processed: newPromptStats.personalized,
            total: shopifyStats.total,
            ['Shopify Stores']: shopifyStats.shopifyStores,
            ['Products Fetched']: newPromptStats.productsFetched,
            ['Products Failed']: newPromptStats.failed,
            ['Products Removed']: 0,
            ['Personalized']: newPromptStats.personalized,
            cost: estimatedCost,
            ['Estimated Cost']: estimatedCost
        };
    }

    // Step 2: Fetch Product Samples
    const fetchStats = await fetchProductSamples({
        inputCsv: shopifyDetectionCsv,
        outputJson: productsJson,
        outputFailures: productFailuresCsv,
        log,
        concurrency: 20,
        batchDelay: 300,
        retries: 2
    });

    // If no products fetched, skip remaining steps
    if (fetchStats.fetched === 0) {
        log?.('No products fetched, skipping cleaning and personalization');
        fs.writeFileSync(outputCsv, 'domain,url,title,description,date,first_line\n');
        return {
            shopifyStores: shopifyStats.shopifyStores,
            productsFetched: 0,
            personalized: 0,
            skipped: true
        };
    }

    // Step 3: Clean Product Data
    const cleanStats = await cleanProductData({
        inputJson: productsJson,
        outputCsv: cleanedProductsCsv,
        log,
        maxBodyLength: 800,
        removeB2B
    });

    // If no products after cleaning, skip personalization
    if (cleanStats.kept === 0) {
        log?.('No products after B2B filtering, skipping personalization');
        fs.writeFileSync(outputCsv, 'domain,url,title,description,date,first_line\n');
        return {
            shopifyStores: shopifyStats.shopifyStores,
            productsFetched: fetchStats.fetched,
            productsAfterCleaning: 0,
            personalized: 0,
            skipped: true
        };
    }

    // Step 4: Personalize with LLM
    const personalizeStats = await personalizeWithLLM({
        inputCsv: cleanedProductsCsv,
        outputCsv,
        apiKeys,
        log,
        concurrency: personalizationConcurrency,
        model: 'gpt-4o-mini',
        onBatch
    });

    const estimatedCost = personalizeStats['Estimated Cost'] || 0;
    return {
        processed: personalizeStats.personalized,
        total: shopifyStats.total,
        ['Shopify Stores']: shopifyStats.shopifyStores,
        ['Products Fetched']: fetchStats.fetched,
        ['Products Failed']: fetchStats.failed,
        ['Products Removed']: cleanStats.removed,
        ['Personalized']: personalizeStats.personalized,
        cost: estimatedCost,
        ['Estimated Cost']: estimatedCost
    };
}

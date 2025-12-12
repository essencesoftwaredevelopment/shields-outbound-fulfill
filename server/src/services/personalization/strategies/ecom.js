import dns from 'dns';
import { promisify } from 'util';
import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { parse as csvParse } from 'csv-parse';
import { stringify as csvStringify } from 'csv-stringify';
import OpenAI from 'openai';

const dnsResolve4 = promisify(dns.resolve4);
const dnsResolveCname = promisify(dns.resolveCname);

// B2B keyword patterns for filtering
const B2B_KEYWORDS = [
    'wholesale', 'bulk', 'distributor', 'moq', 'reseller',
    'white label', 'private label', 'trade only', 'b2b',
    'business pricing', 'commercial', 'industrial', 'oem',
    'minimum order', 'bulk order', 'trade account'
];

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

async function detectShopify(domain, log) {
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
                // Only process verified emails
                const emailStatus = (row.email_status || '').toLowerCase();
                if (emailStatus === 'valid' || emailStatus === 'verified') {
                    rows.push(row);
                }
            })
            .on('end', resolve)
            .on('error', reject);
    });

    if (rows.length === 0) {
        log?.('No verified emails found, skipping Shopify detection');
        fs.writeFileSync(outputCsv, 'domain,shopify,founder_name,email,email_status\n');
        return { total: 0, shopifyStores: 0 };
    }

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

                if (processed % 50 === 0) {
                    log?.(`DNS lookup progress: ${processed}/${rows.length} (${shopifyCount} Shopify stores found)`);
                }

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

function fetchUrl(url, timeout = 4000) {
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

async function personalizeWithLLM({ inputCsv, outputCsv, apiKeys, log, concurrency = 15, model = 'gpt-5-nano' }) {
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

                    if (processed % 5 === 0) {
                        const avgTokens = processed > 0 ? Math.round((totalInputTokens + totalOutputTokens) / processed) : 0;
                        log?.(`Personalization progress: ${processed}/${rows.length} (avg ${avgTokens} tokens/request)`);
                    }

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
            }
        });
    };

    // Process all rows in batches
    for (let i = 0; i < rows.length; i += concurrency) {
        const batch = rows.slice(i, i + concurrency);
        await processBatch(batch);
    }

    stringifier.end();
    await new Promise(resolve => writeStream.on('finish', resolve));

    const estimatedCost = (totalInputTokens * 0.00015 / 1000) + (totalOutputTokens * 0.0006 / 1000);
    log?.(`Personalization complete: ${processed} first lines generated`);
    log?.(`Token usage: ${totalInputTokens.toLocaleString()} input, ${totalOutputTokens.toLocaleString()} output (~$${estimatedCost.toFixed(4)})`);

    return {
        personalized: processed,
        // inputTokens: totalInputTokens,
        // outputTokens: totalOutputTokens,
        'Estimated Cost': estimatedCost
    };
}

export async function runPersonalization({ inputCsv, outputCsv, apiKeys, log, removeB2B = true }) {
    const jobDir = path.dirname(inputCsv);
    const shopifyDetectionCsv = path.join(jobDir, 'shopify-detection.csv');
    const productsJson = path.join(jobDir, 'products.json');
    const productFailuresCsv = path.join(jobDir, 'product-failures.csv');
    const cleanedProductsCsv = path.join(jobDir, 'products-cleaned.csv');

    // Step 1: Shopify Detection
    const shopifyStats = await runShopifyDetection({
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
        concurrency: 15,
        model: 'gpt-4o-mini'
    });

    return {
        processed: personalizeStats.personalized,
        total: shopifyStats.total,
        ['Shopify Stores']: shopifyStats.shopifyStores,
        ['Products Fetched']: fetchStats.fetched,
        ['Products Failed']: fetchStats.failed,
        ['Products Removed']: cleanStats.removed,
        ['Personalized']: personalizeStats.personalized,
        ['Estimated Cost']: personalizeStats['Estimated Cost']
    };
}

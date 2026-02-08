import fs from 'fs';
import path from 'path';
import { parse as csvParse } from 'csv-parse';
import { stringify as csvStringify } from 'csv-stringify';
import https from 'https';
import http from 'http';
import OpenAI from 'openai';
import { detectShopify } from './personalization/strategies/ecom.js';
import { batchDetectKlaviyo } from './detectKlaviyo.js';

function normalizeHostname(urlOrDomain) {
    let hostname = urlOrDomain.trim().toLowerCase();
    hostname = hostname.replace(/^ttp:\/\//, 'http://');
    hostname = hostname.replace(/^ttps:\/\//, 'https://');
    
    try {
        if (hostname.includes('://')) {
            const url = new URL(hostname);
            hostname = url.hostname;
        }
    } catch {
        // Not a URL, treat as domain
    }
    
    hostname = hostname.replace(/^www\./, '');
    return hostname;
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

// B2B keyword patterns for filtering
const B2B_KEYWORDS = [
    'wholesale', 'bulk', 'distributor', 'moq', 'reseller',
    'white label', 'private label', 'trade only', 'b2b',
    'business pricing', 'commercial', 'industrial', 'oem',
    'minimum order', 'bulk order', 'trade account'
];

function stripHtml(html) {
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function isB2B(text) {
    const lower = text.toLowerCase();
    return B2B_KEYWORDS.some(keyword => lower.includes(keyword));
}

/**
 * Run Shopify detection
 */
async function runShopifyDetection({ inputCsv, outputCsv, log, concurrency = 200 }) {
    log?.('Starting Shopify detection...');

    const rows = [];
    await new Promise((resolve, reject) => {
        fs.createReadStream(inputCsv)
            .pipe(csvParse({ columns: true, trim: true }))
            .on('data', (row) => {
                const domain = (row.domain || '').trim();
                if (domain) {
                    rows.push(row);
                }
            })
            .on('end', resolve)
            .on('error', reject);
    });

    if (rows.length === 0) {
        log?.('No domains found, skipping Shopify detection');
        fs.writeFileSync(outputCsv, 'domain,shopify\n');
        return { total: 0, shopifyStores: 0 };
    }

    const results = [];
    let processed = 0;
    let shopifyCount = 0;

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
                    shopify: isShopify ? 'Yes' : 'No'
                };
            })
        );
        return batchResults.filter(Boolean);
    };

    for (let i = 0; i < rows.length; i += concurrency) {
        const batch = rows.slice(i, i + concurrency);
        const batchResults = await processBatch(batch);
        results.push(...batchResults);
    }

    // Only write Shopify stores to output (filter out non-Shopify)
    const shopifyStoresOnly = results.filter(row => row.shopify === 'Yes');
    
    const writeStream = fs.createWriteStream(outputCsv);
    const stringifier = csvStringify({ header: true, columns: ['domain', 'shopify'] });
    stringifier.pipe(writeStream);
    shopifyStoresOnly.forEach(row => stringifier.write(row));
    stringifier.end();
    await new Promise(resolve => writeStream.on('finish', resolve));

    log?.(`Shopify detection complete: ${shopifyCount}/${rows.length} Shopify stores detected (${shopifyStoresOnly.length} passed to next stage)`);
    return { total: rows.length, shopifyStores: shopifyCount };
}

/**
 * Run Klaviyo detection
 */
async function runKlaviyoDetection({ inputCsv, outputCsv, log, concurrency = 50 }) {
    log?.('Starting Klaviyo detection...');

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

    if (rows.length === 0) {
        log?.('No Shopify stores to check for Klaviyo');
        fs.writeFileSync(outputCsv, 'domain,shopify,klaviyo\n');
        return { total: 0, klaviyoStores: 0 };
    }

    const klaviyoResults = await batchDetectKlaviyo(rows, log, concurrency);

    // Only write stores WITH Klaviyo to output (filter out non-Klaviyo stores)
    const klaviyoStoresOnly = rows
        .filter(row => klaviyoResults.get(row.domain))
        .map(row => ({
            domain: row.domain,
            shopify: row.shopify,
            klaviyo: 'Yes'
        }));

    const writeStream = fs.createWriteStream(outputCsv);
    const stringifier = csvStringify({ header: true, columns: ['domain', 'shopify', 'klaviyo'] });
    stringifier.pipe(writeStream);
    klaviyoStoresOnly.forEach(row => stringifier.write(row));
    stringifier.end();
    await new Promise(resolve => writeStream.on('finish', resolve));

    const klaviyoCount = klaviyoStoresOnly.length;
    log?.(`Klaviyo detection complete: ${klaviyoCount}/${rows.length} stores have Klaviyo (${klaviyoCount} passed to next stage)`);
    return { total: rows.length, klaviyoStores: klaviyoCount };
}

/**
 * Fetch multiple products from Shopify stores
 */
async function fetchMultipleProducts({ inputCsv, outputJson, outputFailures, log, productLimit = 3, concurrency = 20, batchDelay = 300, retries = 2 }) {
    log?.(`Fetching up to ${productLimit} products per store from Shopify stores...`);

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

    const allProducts = [];
    const failures = [];
    let processed = 0;

    const fetchWithRetry = async (url, attempts = 0) => {
        try {
            const data = await fetchUrl(url);
            if (data.products && data.products.length > 0) {
                return data.products.slice(0, productLimit).map(product => ({
                    title: product.title || '',
                    body_html: product.body_html || '',
                    tags: Array.isArray(product.tags) ? product.tags.join(', ') : (product.tags || ''),
                    published_at: product.published_at || '',
                    created_at: product.created_at || '',
                    updated_at: product.updated_at || ''
                }));
            }
            return [];
        } catch (err) {
            if (attempts < retries) {
                await new Promise(resolve => setTimeout(resolve, 1000 * (attempts + 1)));
                return fetchWithRetry(url, attempts + 1);
            }
            throw err;
        }
    };

    const processBatch = async (batch) => {
        await Promise.allSettled(
            batch.map(async (row) => {
                const domain = normalizeHostname(row.domain);
                const url = `https://${domain}/products.json?limit=${productLimit}`;

                try {
                    const products = await fetchWithRetry(url);
                    if (products.length > 0) {
                        allProducts.push({
                            domain,
                            klaviyo: row.klaviyo || 'Unknown',
                            products
                        });
                    }
                } catch (err) {
                    failures.push({ url, error: err.message });
                }

                processed++;
                if (processed % 10 === 0) {
                    log?.(`Product fetch progress: ${processed}/${rows.length} (${allProducts.length} stores with products, ${failures.length} failed)`);
                }
            })
        );
    };

    for (let i = 0; i < rows.length; i += concurrency) {
        const batch = rows.slice(i, i + concurrency);
        await processBatch(batch);
        if (i + concurrency < rows.length) {
            await new Promise(resolve => setTimeout(resolve, batchDelay));
        }
    }

    fs.writeFileSync(outputJson, JSON.stringify(allProducts, null, 2));

    if (failures.length > 0) {
        const writeStream = fs.createWriteStream(outputFailures);
        const stringifier = csvStringify({ header: true, columns: ['url', 'error'] });
        stringifier.pipe(writeStream);
        failures.forEach(row => stringifier.write(row));
        stringifier.end();
        await new Promise(resolve => writeStream.on('finish', resolve));
    }

    log?.(`Product fetch complete: ${allProducts.length} stores with products, ${failures.length} failures`);
    return { fetched: allProducts.length, failed: failures.length };
}

/**
 * Filter B2B products and prepare for personalization
 */
async function filterAndPrepareProducts({ inputJson, outputCsv, log, removeB2B = true }) {
    log?.(`Preparing product data...${removeB2B ? ' (filtering B2B)' : ''}`);

    const storesWithProducts = JSON.parse(fs.readFileSync(inputJson, 'utf-8'));
    const prepared = [];
    let totalProducts = 0;
    let removedProducts = 0;

    for (const store of storesWithProducts) {
        const { domain, klaviyo, products } = store;
        
        const cleanProducts = [];
        for (const product of products) {
            totalProducts++;
            const title = product.title || '';
            const bodyText = stripHtml(product.body_html || '');
            const tags = product.tags || '';

            // Check if B2B
            const combinedText = `${title} ${bodyText} ${tags}`;
            if (removeB2B && isB2B(combinedText)) {
                removedProducts++;
                continue;
            }

            cleanProducts.push({
                title,
                description: bodyText.substring(0, 300), // Limit description
                published_at: product.published_at || '',
                created_at: product.created_at || '',
                updated_at: product.updated_at || ''
            });
        }

        // Only include stores that have at least one valid product after filtering
        if (cleanProducts.length > 0) {
            prepared.push({
                domain,
                klaviyo,
                products: cleanProducts
            });
        }
    }

    fs.writeFileSync(outputCsv, JSON.stringify(prepared, null, 2));

    log?.(`Preparation complete: ${prepared.length} stores with ${totalProducts - removedProducts} products (${removedProducts} B2B removed)`);
    return { stores: prepared.length, productsKept: totalProducts - removedProducts, productsRemoved: removedProducts };
}

/**
 * Personalize with AI - choosing ONE best product from multiple
 */
async function personalizeWithSingleProductSelection({ inputJson, outputCsv, apiKeys, log, concurrency = 15, model = 'gpt-4o-mini' }) {
    log?.('Generating personalized content (AI selecting best product)...');

    if (!apiKeys.openai) {
        throw new Error('OpenAI API key required for personalization');
    }

    const openai = new OpenAI({ apiKey: apiKeys.openai });
    const stores = JSON.parse(fs.readFileSync(inputJson, 'utf-8'));

    const results = [];
    let processed = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let backoffMs = 0;

    const generatePersonalization = async (domain, klaviyo, products, retryCount = 0) => {
        try {
            if (backoffMs > 0) {
                await new Promise(resolve => setTimeout(resolve, backoffMs));
            }

            // Format products for AI
            const productList = products.map((p, idx) => 
                `Product ${idx + 1}:
Title: ${p.title}
Description: ${p.description}
Published: ${p.published_at || p.created_at || 'Unknown'}
---`
            ).join('\n');

            const prompt = `You are analyzing multiple products from a Shopify store (domain: ${domain}).

Your task:
1. Review ALL the products below
2. Choose the ONE product that is MOST LIKELY:
   - Currently live and available (not discontinued)
   - Popular or flagship product for the store
3. Generate a personalized first line based on ONLY that chosen product

Style rules for the first line:
- Structure: "We were taking a look at the {natural product name} and {short, real human compliment}."
- Use active voice, speak directly to one person
- Be concise and conversational
- Avoid marketing language, clichés, jargon
- Shorten product name to brand + simple category
- Make compliment brief, specific, enthusiastic (! is okay)
- One sentence only
- If ALL products are nonsense/SKUs, return: "invalid"

Products to choose from:
${productList}

Output format (JSON):
{
  "chosen_product_number": 1,
  "product_title": "...",
  "first_line": "..."
}`;

            const completion = await openai.chat.completions.create({
                model,
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 150,
                temperature: 0.8,
                response_format: { type: "json_object" }
            });

            const response = JSON.parse(completion.choices[0].message. content.trim());
            totalInputTokens += completion.usage?.prompt_tokens || 0;
            totalOutputTokens += completion.usage?.completion_tokens || 0;

            backoffMs = Math.max(0, backoffMs - 100);

            return {
                chosenProduct: response.chosen_product_number || 1,
                productTitle: response.product_title || '',
                firstLine: response.first_line || ''
            };
        } catch (err) {
            if (err.status === 429 && retryCount < 3) {
                backoffMs = Math.min(5000, (backoffMs || 500) * 2);
                log?.(`Rate limited, backing off for ${backoffMs}ms`);
                await new Promise(resolve => setTimeout(resolve, backoffMs + Math.random() * 1000));
                return generatePersonalization(domain, klaviyo, products, retryCount + 1);
            }
            throw err;
        }
    };

    const writeStream = fs.createWriteStream(outputCsv);
    const stringifier = csvStringify({
        header: true,
        columns: ['domain', 'klaviyo', 'chosen_product', 'product_title', 'first_line']
    });
    stringifier.pipe(writeStream);

    const processBatch = async (batch) => {
        const batchResults = await Promise.allSettled(
            batch.map(async (store) => {
                const { domain, klaviyo, products } = store;

                try {
                    const result = await generatePersonalization(domain, klaviyo, products);
                    processed++;

                    if (processed % 5 === 0) {
                        const avgTokens = processed > 0 ? Math.round((totalInputTokens + totalOutputTokens) / processed) : 0;
                        log?.(`Personalization progress: ${processed}/${stores.length} (avg ${avgTokens} tokens/request)`, {
                            progress: {
                                stage: 'personalization',
                                processed,
                                total: stores.length,
                                stats: { personalized: processed }
                            }
                        });
                    } else {
                        log?.(null, {
                            progress: {
                                stage: 'personalization',
                                processed,
                                total: stores.length,
                                stats: { personalized: processed }
                            }
                        });
                    }

                    return {
                        domain,
                        klaviyo: klaviyo || 'Unknown',
                        chosen_product: result.chosenProduct,
                        product_title: result.productTitle,
                        first_line: result.firstLine
                    };
                } catch (err) {
                    log?.(`Failed to personalize ${domain}: ${err.message}`);
                    return {
                        domain,
                        klaviyo: klaviyo || 'Unknown',
                        chosen_product: 0,
                        product_title: '',
                        first_line: '[Generation failed]'
                    };
                }
            })
        );

        batchResults.forEach(result => {
            if (result.status === 'fulfilled' && result.value) {
                stringifier.write(result.value);
            }
        });
    };

    for (let i = 0; i < stores.length; i += concurrency) {
        const batch = stores.slice(i, i + concurrency);
        await processBatch(batch);
    }

    stringifier.end();
    await new Promise(resolve => writeStream.on('finish', resolve));

    const estimatedCost = (totalInputTokens * 0.00015 / 1000) + (totalOutputTokens * 0.0006 / 1000);
    log?.(`Personalization complete: ${processed} personalizations generated`);
    log?.(`Token usage: ${totalInputTokens.toLocaleString()} input, ${totalOutputTokens.toLocaleString()} output (~$${estimatedCost.toFixed(4)})`);

    return {
        personalized: processed,
        estimatedCost
    };
}

/**
 * Main personalizer pipeline
 */
export async function runPersonalizerPipeline({ 
    inputCsv, 
    outputCsv, 
    apiKeys, 
    log, 
    productsToPull = 3,
    checkKlaviyo = false,
    removeB2B = false,
    jobRef = null,
    updateStage = null
}) {
    const jobDir = path.dirname(inputCsv);
    const shopifyDetectionCsv = path.join(jobDir, 'shopify-detection.csv');
    const klaviyoDetectionCsv = path.join(jobDir, 'klaviyo-detection.csv');
    const productsJson = path.join(jobDir, 'products-multi.json');
    const productFailuresCsv = path.join(jobDir, 'product-failures.csv');
    const preparedProductsJson = path.join(jobDir, 'products-prepared.json');

    // Step 1: Shopify Detection
    if (updateStage) {
        await updateStage('shopifyDetection', { status: 'running', startedAt: true });
    }
    
    const shopifyStats = await runShopifyDetection({
        inputCsv,
        outputCsv: shopifyDetectionCsv,
        log,
        concurrency: 200
    });

    if (updateStage) {
        await updateStage('shopifyDetection', { 
            status: 'completed', 
            completedAt: true,
            summary: { total: shopifyStats.total, shopifyStores: shopifyStats.shopifyStores }
        });
    }

    if (shopifyStats.shopifyStores === 0) {
        log?.('⚠️ No Shopify stores detected, ending pipeline');
        fs.writeFileSync(outputCsv, 'domain,klaviyo,chosen_product,product_title,first_line\n');
        
        // Mark remaining stages as skipped
        if (updateStage) {
            await updateStage('klaviyoDetection', { 
                status: 'completed', 
                completedAt: true,
                summary: { skipped: true, reason: 'No Shopify stores found' }
            });
            await updateStage('productFetch', { 
                status: 'completed', 
                completedAt: true,
                summary: { skipped: true, reason: 'No Shopify stores found' }
            });
            await updateStage('personalization', { 
                status: 'completed', 
                completedAt: true,
                summary: { skipped: true, reason: 'No Shopify stores found' }
            });
        }
        
        return {
            shopifyStores: 0,
            klaviyoStores: 0,
            productsFetched: 0,
            personalized: 0,
            skipped: true
        };
    }

    // Step 2: Klaviyo Detection (if enabled)
    let klaviyoStats = { klaviyoStores: 0 };
    
    if (checkKlaviyo) {
        if (updateStage) {
            await updateStage('klaviyoDetection', { status: 'running', startedAt: true });
        }
        
        klaviyoStats = await runKlaviyoDetection({
            inputCsv: shopifyDetectionCsv,
            outputCsv: klaviyoDetectionCsv,
            log,
            concurrency: 50
        });
        
        if (updateStage) {
            await updateStage('klaviyoDetection', { 
                status: 'completed', 
                completedAt: true,
                summary: { klaviyoStores: klaviyoStats.klaviyoStores }
            });
        }
        
        // If Klaviyo check is enabled but no stores have Klaviyo, end pipeline
        if (klaviyoStats.klaviyoStores === 0) {
            log?.('⚠️ No stores with Klaviyo detected, ending pipeline');
            fs.writeFileSync(outputCsv, 'domain,klaviyo,chosen_product,product_title,first_line\n');
            
            if (updateStage) {
                await updateStage('productFetch', { 
                    status: 'completed', 
                    completedAt: true,
                    summary: { skipped: true, reason: 'No Klaviyo stores found' }
                });
                await updateStage('personalization', { 
                    status: 'completed', 
                    completedAt: true,
                    summary: { skipped: true, reason: 'No Klaviyo stores found' }
                });
            }
            
            return {
                shopifyStores: shopifyStats.shopifyStores,
                klaviyoStores: 0,
                productsFetched: 0,
                personalized: 0,
                skipped: true
            };
        }
    } else {
        if (updateStage) {
            await updateStage('klaviyoDetection', { 
                status: 'completed', 
                completedAt: true,
                summary: { skipped: true, reason: 'Klaviyo check disabled' }
            });
        }
    }

    // Step 3: Fetch Multiple Products
    if (updateStage) {
        await updateStage('productFetch', { status: 'running', startedAt: true });
    }
    
    const fetchStats = await fetchMultipleProducts({
        inputCsv: checkKlaviyo ? klaviyoDetectionCsv : shopifyDetectionCsv,
        outputJson: productsJson,
        outputFailures: productFailuresCsv,
        log,
        productLimit: productsToPull,
        concurrency: 20,
        batchDelay: 300,
        retries: 2
    });

    if (updateStage) {
        await updateStage('productFetch', { 
            status: 'completed', 
            completedAt: true,
            summary: { fetched: fetchStats.fetched, failed: fetchStats.failed }
        });
    }

    if (fetchStats.fetched === 0) {
        log?.('⚠️ No products fetched from any stores, ending pipeline');
        fs.writeFileSync(outputCsv, 'domain,klaviyo,chosen_product,product_title,first_line\n');
        
        if (updateStage) {
            await updateStage('personalization', { 
                status: 'completed', 
                completedAt: true,
                summary: { skipped: true, reason: 'No products found' }
            });
        }
        
        return {
            shopifyStores: shopifyStats.shopifyStores,
            klaviyoStores: klaviyoStats.klaviyoStores,
            productsFetched: 0,
            personalized: 0,
            skipped: true
        };
    }

    // Step 4: Filter B2B and Prepare
    const prepareStats = await filterAndPrepareProducts({
        inputJson: productsJson,
        outputCsv: preparedProductsJson,
        log,
        removeB2B
    });

    if (prepareStats.stores === 0) {
        log?.('⚠️ No stores with valid products after B2B filtering, ending pipeline');
        fs.writeFileSync(outputCsv, 'domain,klaviyo,chosen_product,product_title,first_line\n');
        
        if (updateStage) {
            await updateStage('personalization', { 
                status: 'completed', 
                completedAt: true,
                summary: { skipped: true, reason: 'All products filtered out (B2B)' }
            });
        }
        
        return {
            shopifyStores: shopifyStats.shopifyStores,
            klaviyoStores: klaviyoStats.klaviyoStores,
            productsFetched: fetchStats.fetched,
            storesAfterFiltering: 0,
            personalized: 0,
            skipped: true
        };
    }

    // Step 5: AI Personalization (choosing best product)
    if (updateStage) {
        await updateStage('personalization', { status: 'running', startedAt: true });
    }
    
    const personalizeStats = await personalizeWithSingleProductSelection({
        inputJson: preparedProductsJson,
        outputCsv,
        apiKeys,
        log,
        concurrency: 15,
        model: 'gpt-4o-mini'
    });

    if (updateStage) {
        await updateStage('personalization', { 
            status: 'completed', 
            completedAt: true,
            summary: { personalized: personalizeStats.personalized, estimatedCost: personalizeStats.estimatedCost }
        });
    }

    return {
        processed: personalizeStats.personalized,
        total: shopifyStats.total,
        shopifyStores: shopifyStats.shopifyStores,
        klaviyoStores: checkKlaviyo ? klaviyoStats.klaviyoStores : 'Not checked',
        productsFetched: fetchStats.fetched,
        productsFailed: fetchStats.failed,
        productsRemoved: removeB2B ? prepareStats.productsRemoved : 0,
        personalized: personalizeStats.personalized,
        estimatedCost: personalizeStats.estimatedCost
    };
}

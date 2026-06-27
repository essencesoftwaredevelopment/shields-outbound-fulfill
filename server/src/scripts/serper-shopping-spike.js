#!/usr/bin/env node
/**
 * Phase 0 — Serper Shopping feasibility spike.
 *
 * Answers one question before running the full audit pipeline at scale:
 * "For Shopify stores, can we find their Google Shopping ad for a hero product
 *  and read price + rating from Serper?"
 *
 * This script does NOT write to the database, emit signals, or send email.
 * It runs DNS Shopify detection, then a single /products.json?limit=10 fetch,
 * writes a JSON report. Use ad_found rate and price/rating completeness to
 * decide whether to proceed with production jobs.
 *
 * Usage:
 *   node src/scripts/serper-shopping-spike.js --serper-key KEY
 *   node src/scripts/serper-shopping-spike.js --domains sweatband.com,gymshark.com
 *   node src/scripts/serper-shopping-spike.js --domains-file fixtures/serper-shopping-spike-domains.txt
 *
 * Output: JSON report + summary to stdout.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import pLimit from 'p-limit';
import '../config/env.js';
import { detectShopify } from '../services/personalization/strategies/ecom.js';
import { fetchShopifyCatalogSample, productToSnapshotRow } from '../services/shoppingAudit/shopifyCatalog.js';
import { selectHeroProduct } from '../services/shoppingAudit/heroSelection.js';
import { searchShoppingForHero } from '../services/shoppingAudit/serperShopping.js';
import { heroVariantPrice, normalizeHostname } from '../services/shoppingAudit/utils.js';
import { DEFAULT_SERPER_GEO } from '../services/shoppingAudit/constants.js';
import {
    ContextDevRateLimiter,
    verifyAdDestinationUrl
} from '../services/shoppingAudit/adDestinationVerify.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, '../../..');

for (const rel of ['.env.local', '.env']) {
    const candidate = path.join(WORKSPACE_ROOT, rel);
    if (fs.existsSync(candidate)) {
        dotenv.config({ path: candidate, override: false });
    }
}

const DEFAULT_CONCURRENCY = 6;

const DEFAULT_DOMAINS_FILE = path.join(WORKSPACE_ROOT, 'server/fixtures/serper-shopping-spike-domains.txt');

const DEFAULT_DOMAINS = [
    'sweatband.com',
    'gymshark.com',
    'allbirds.com',
    'brooklinen.com',
    'mvmt.com',
    'colourpop.com',
    'skims.com',
    'awaytravel.com'
];

function loadDomainsFromFile(filePath) {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'));
}

function resolveDomainsFilePath(filePath) {
    if (!filePath) return DEFAULT_DOMAINS_FILE;
    return path.isAbsolute(filePath) ? filePath : path.join(WORKSPACE_ROOT, filePath);
}

function shopifyProductUrl(domain, handle) {
    if (!domain || !handle) return '';
    return `https://${normalizeHostname(domain)}/products/${handle}`;
}

function formatUsdPrice(value) {
    if (value == null || value === '') return '';
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return '';
    return `$${n.toFixed(2)}`;
}

function toReportRow({
    domain,
    shopify = false,
    ad_found = false,
    hero_title = '',
    shopify_price = '',
    ad_price = '',
    shopify_product_url = '',
    ad_destination_url = '',
    ad_destination_final_url = '',
    ad_destination_verified = null,
    rating = null,
    rating_count = null,
    match_score = 0
}) {
    return {
        domain,
        shopify: Boolean(shopify),
        ad_found: Boolean(ad_found),
        hero_title,
        shopify_price,
        ad_price,
        shopify_product_url,
        ad_destination_url,
        ad_destination_final_url,
        ad_destination_verified: ad_destination_verified == null ? null : Boolean(ad_destination_verified),
        rating: rating ?? null,
        rating_count: rating_count ?? null,
        match_score: Number(match_score) || 0
    };
}

function parseArgs(argv) {
    const args = {
        domains: null,
        domainsFile: DEFAULT_DOMAINS_FILE,
        serperKey: process.env.SERPER_API_KEY || process.env.SERPER_KEY || '',
        contextDevKey: process.env.CONTEXT_DEV_API_KEY || '',
        verifyDestinations: null,
        output: path.join(WORKSPACE_ROOT, 'server/tmp/serper-shopping-spike-report.json'),
        concurrency: DEFAULT_CONCURRENCY
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--domains') args.domains = argv[++i].split(',').map((d) => d.trim()).filter(Boolean);
        else if (arg === '--domains-file') args.domainsFile = resolveDomainsFilePath(argv[++i]);
        else if (arg === '--serper-key') args.serperKey = argv[++i];
        else if (arg === '--context-dev-key') args.contextDevKey = argv[++i];
        else if (arg === '--verify-destinations') args.verifyDestinations = true;
        else if (arg === '--no-verify-destinations') args.verifyDestinations = false;
        else if (arg === '--output') args.output = argv[++i];
        else if (arg === '--concurrency') args.concurrency = Math.max(1, parseInt(argv[++i], 10) || DEFAULT_CONCURRENCY);
        else if (arg === '--help') args.help = true;
    }
    return args;
}

function resolveDomainList(args) {
    if (args.domains?.length) return args.domains;
    const fromFile = loadDomainsFromFile(args.domainsFile);
    if (fromFile?.length) return fromFile;
    return DEFAULT_DOMAINS;
}

async function processDomain(domain, { serperKey, log, verifyDestinations, contextDevKey, contextLimiter }) {
    const host = normalizeHostname(domain);
    log(`${host}: starting`);

    const isShopify = await detectShopify(host, (msg) => log(`${host}: ${msg}`));
    if (!isShopify) {
        log(`${host}: not Shopify (DNS)`);
        return toReportRow({ domain: host, shopify: false });
    }

    let heroTitle = '';
    let heroHandle = '';
    let feedPrice = null;

    try {
        const { products, error } = await fetchShopifyCatalogSample(host, (msg) => log(`${host}: ${msg}`));
        if (!products.length) {
            log(`${host}: catalog unavailable${error ? ` (${error})` : ''}`);
            return toReportRow({ domain: host, shopify: true });
        }
        const snapshots = products.map((p) => productToSnapshotRow(p, host));
        const hero = selectHeroProduct(snapshots);
        heroTitle = hero?.snapshot?.title || products[0].title;
        heroHandle = hero?.snapshot?.handle || products[0].handle;
        feedPrice = heroVariantPrice(hero?.snapshot?.variants || []);
    } catch (err) {
        log(`${host}: catalog fetch failed — ${err.message}`);
        return toReportRow({ domain: host, shopify: true });
    }

    const shopifyRow = {
        domain: host,
        shopify: true,
        hero_title: heroTitle,
        shopify_price: formatUsdPrice(feedPrice),
        shopify_product_url: shopifyProductUrl(host, heroHandle)
    };

    try {
        const result = await searchShoppingForHero({
            domain: host,
            productTitle: heroTitle,
            feedPrice,
            apiKey: serperKey,
            geo: DEFAULT_SERPER_GEO
        });
        const card = result.match;
        const adFound = result.branch !== 'none';
        let adDestinationFinalUrl = '';
        let adDestinationVerified = null;

        if (adFound && card?.link && verifyDestinations && contextDevKey) {
            const verdict = await verifyAdDestinationUrl(card.link, host, contextDevKey, {
                rateLimiter: contextLimiter
            });
            adDestinationFinalUrl = verdict.finalUrl || '';
            adDestinationVerified = verdict.verified;
            log(`${host}: ad destination ${verdict.verified ? 'verified' : 'FAILED'} (${verdict.reason}${verdict.scrapeError ? `, ${verdict.scrapeError}` : ''})`);
        }

        log(`${host}: done (ad_found=${adFound})`);
        return toReportRow({
            ...shopifyRow,
            ad_found: adFound,
            ad_price: card?.price ?? '',
            ad_destination_url: card?.link ?? '',
            ad_destination_final_url: adDestinationFinalUrl,
            ad_destination_verified: adDestinationVerified,
            rating: card?.rating ?? null,
            rating_count: card?.ratingCount ?? null,
            match_score: result.matchScore
        });
    } catch (err) {
        log(`${host}: Serper failed — ${err.message}`);
        return toReportRow(shopifyRow);
    }
}

function buildSummary(results) {
    const shopifyRows = results.filter((r) => r.shopify);
    const catalogOk = shopifyRows.filter((r) => r.hero_title).length;
    const adFound = shopifyRows.filter((r) => r.ad_found).length;
    const withPrice = shopifyRows.filter((r) => r.ad_found && r.ad_price).length;
    const verifiedChecked = shopifyRows.filter((r) => r.ad_destination_verified != null).length;
    const verifiedOk = shopifyRows.filter((r) => r.ad_destination_verified === true).length;
    const shopifyCount = shopifyRows.length;
    const catalogDenom = Math.max(catalogOk, 1);
    const shopifyDenom = Math.max(shopifyCount, 1);
    const verifiedDenom = Math.max(verifiedChecked, 1);

    return {
        domains_tested: results.length,
        shopify_dns: shopifyCount,
        catalog_fetched: catalogOk,
        ad_found: adFound,
        ad_found_rate: Number((adFound / catalogDenom).toFixed(3)),
        ad_with_price: withPrice,
        ad_with_price_rate: Number((withPrice / catalogDenom).toFixed(3)),
        catalog_fetch_rate: Number((catalogOk / shopifyDenom).toFixed(3)),
        ad_destination_verified: verifiedOk,
        ad_destination_verified_rate: Number((verifiedOk / verifiedDenom).toFixed(3)),
        ad_destination_checks: verifiedChecked
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log('Usage: node src/scripts/serper-shopping-spike.js [--domains a.com,b.com] [--domains-file path.txt] [--serper-key KEY] [--context-dev-key KEY] [--verify-destinations|--no-verify-destinations] [--output path.json] [--concurrency N]');
        process.exit(0);
    }
    if (!args.serperKey) {
        console.error('Missing Serper API key. Pass --serper-key or set SERPER_API_KEY.');
        process.exit(1);
    }

    const verifyDestinations = args.verifyDestinations ?? Boolean(args.contextDevKey);
    if (verifyDestinations && !args.contextDevKey) {
        console.error('Destination verification requires CONTEXT_DEV_API_KEY or --context-dev-key.');
        process.exit(1);
    }

    const domains = resolveDomainList(args);
    const log = (msg) => console.log(`[spike] ${msg}`);
    const limit = pLimit(args.concurrency);
    const contextLimiter = verifyDestinations ? new ContextDevRateLimiter() : null;
    log(`Processing ${domains.length} domains from ${args.domains ? '--domains' : args.domainsFile} (concurrency=${args.concurrency}${verifyDestinations ? ', verifying ad destinations via Context.dev' : ''})...`);

    const processed = await Promise.all(
        domains.map((domain) => limit(() => processDomain(domain, {
            serperKey: args.serperKey,
            log,
            verifyDestinations,
            contextDevKey: args.contextDevKey,
            contextLimiter
        })))
    );
    const results = domains.map((domain) => processed.find((r) => r.domain === domain));
    const summary = buildSummary(results);

    const report = {
        phase: 0,
        description: 'Serper Shopping feasibility — Shopify hero product vs matched Shopping ad',
        generated_at: new Date().toISOString(),
        summary,
        results
    };

    fs.mkdirSync(path.dirname(args.output), { recursive: true });
    fs.writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`);

    console.log('\n=== Phase 0 Serper Shopping Spike ===');
    console.log(`Domains tested: ${summary.domains_tested}`);
    console.log(`Shopify (DNS): ${summary.shopify_dns}`);
    console.log(`Catalog fetched: ${summary.catalog_fetched}/${summary.shopify_dns || 1} (${(summary.catalog_fetch_rate * 100).toFixed(1)}%)`);
    console.log(`Ad found: ${summary.ad_found}/${summary.catalog_fetched || 1} (${(summary.ad_found_rate * 100).toFixed(1)}%)`);
    console.log(`Ad with price: ${summary.ad_with_price}/${summary.catalog_fetched || 1} (${(summary.ad_with_price_rate * 100).toFixed(1)}%)`);
    if (summary.ad_destination_checks) {
        console.log(`Ad destination verified: ${summary.ad_destination_verified}/${summary.ad_destination_checks} (${(summary.ad_destination_verified_rate * 100).toFixed(1)}%)`);
    }
    console.log(`Report written to: ${args.output}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

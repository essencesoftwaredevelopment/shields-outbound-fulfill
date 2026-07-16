#!/usr/bin/env node
/**
 * Domain-first Serper Shopping spike.
 *
 * Tests the inverted match direction against the production hero-first flow:
 *   1. Serper Shopping query = the bare domain (e.g. "spicywear.com")
 *   2. Keep cards whose `source` (seller) matches the brand — including
 *      space-insensitive matches ("Spicy Wear" vs spicywear.com), which the
 *      production sellerMatchesDomain() currently rejects.
 *   3. Reverse-match each seller card's title against the store catalog via
 *      /products.json?limit=50&page=N, paginating until a title matches or
 *      the store runs out of products.
 *
 * With --compare (default on) it also runs the production hero-first query
 * ("{domain} {hero title}") so the report shows both find rates side by side.
 *
 * No DB writes. Output: JSON report + summary to stdout.
 *
 * Usage:
 *   node src/scripts/serper-domain-first-spike.js --agency <agencyId>
 *   node src/scripts/serper-domain-first-spike.js --serper-key KEY --domains spicywear.com,gymshark.com
 *   node src/scripts/serper-domain-first-spike.js --domains-file fixtures/serper-shopping-spike-domains.txt
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import axios from 'axios';
import pLimit from 'p-limit';
import '../config/env.js';
import { selectHeroProduct } from '../services/shoppingAudit/heroSelection.js';
import { searchShoppingForHero } from '../services/shoppingAudit/serperShopping.js';
import { productToSnapshotRow } from '../services/shoppingAudit/shopifyCatalog.js';
import {
    brandRootLabel,
    cardToProductSimilarity,
    extractCardFields,
    fetchJson,
    heroVariantPrice,
    matchSellerToBrand,
    normalizeHostname
} from '../services/shoppingAudit/utils.js';
import { DEFAULT_SERPER_GEO, SERPER_SHOPPING_URL, STRONG_MATCH_STRICT } from '../services/shoppingAudit/constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, '../../..');

for (const rel of ['.env.local', '.env']) {
    const candidate = path.join(WORKSPACE_ROOT, rel);
    if (fs.existsSync(candidate)) {
        dotenv.config({ path: candidate, override: false });
    }
}

const DEFAULT_DOMAINS_FILE = path.join(WORKSPACE_ROOT, 'server/fixtures/serper-shopping-spike-domains.txt');
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_CATALOG_LIMIT = 50;
const DEFAULT_MAX_PAGES = 10;
const DEFAULT_MIN_TITLE_SIM = 0.6;
const DEFAULT_SERPER_NUM = 20;
const MAX_SELLER_CARDS = 5;

function parseArgs(argv) {
    const args = {
        domains: null,
        domainsFile: DEFAULT_DOMAINS_FILE,
        serperKey: process.env.SERPER_API_KEY || process.env.SERPER_KEY || '',
        agency: null,
        catalogLimit: DEFAULT_CATALOG_LIMIT,
        maxPages: DEFAULT_MAX_PAGES,
        minTitleSim: DEFAULT_MIN_TITLE_SIM,
        serperNum: DEFAULT_SERPER_NUM,
        compare: true,
        output: path.join(WORKSPACE_ROOT, 'server/tmp/serper-domain-first-spike-report.json'),
        concurrency: DEFAULT_CONCURRENCY
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--domains') args.domains = argv[++i].split(',').map((d) => d.trim()).filter(Boolean);
        else if (arg === '--domains-file') args.domainsFile = path.isAbsolute(argv[i + 1]) ? argv[++i] : path.join(WORKSPACE_ROOT, argv[++i]);
        else if (arg === '--serper-key') args.serperKey = argv[++i];
        else if (arg === '--agency') args.agency = argv[++i];
        else if (arg === '--catalog-limit') args.catalogLimit = Math.max(1, parseInt(argv[++i], 10) || DEFAULT_CATALOG_LIMIT);
        else if (arg === '--max-pages') args.maxPages = Math.max(1, parseInt(argv[++i], 10) || DEFAULT_MAX_PAGES);
        else if (arg === '--min-title-sim') args.minTitleSim = parseFloat(argv[++i]) || DEFAULT_MIN_TITLE_SIM;
        else if (arg === '--serper-num') args.serperNum = Math.max(1, parseInt(argv[++i], 10) || DEFAULT_SERPER_NUM);
        else if (arg === '--no-compare') args.compare = false;
        else if (arg === '--compare') args.compare = true;
        else if (arg === '--output') args.output = argv[++i];
        else if (arg === '--concurrency') args.concurrency = Math.max(1, parseInt(argv[++i], 10) || DEFAULT_CONCURRENCY);
        else if (arg === '--help') args.help = true;
    }
    return args;
}

function loadDomainsFromFile(filePath) {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'));
}

async function serperShoppingSearch(query, apiKey, num) {
    const response = await axios.post(
        SERPER_SHOPPING_URL,
        [{
            q: query,
            gl: DEFAULT_SERPER_GEO.gl,
            hl: DEFAULT_SERPER_GEO.hl,
            location: DEFAULT_SERPER_GEO.location,
            num
        }],
        {
            headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
            timeout: 30000
        }
    );
    const payload = response.data;
    const result = Array.isArray(payload) ? payload[0] : payload;
    return result?.shopping || [];
}

async function fetchCatalogPage(host, limit, page, log) {
    const url = `https://${host}/products.json?limit=${limit}&page=${page}`;
    for (let attempt = 0; attempt <= 1; attempt += 1) {
        try {
            const data = await fetchJson(url, 8000);
            return { products: Array.isArray(data?.products) ? data.products : [], error: null };
        } catch (err) {
            if (attempt === 0 && /HTTP 429/i.test(err.message)) {
                await new Promise((r) => setTimeout(r, 1200));
                continue;
            }
            log(`${host}: catalog page ${page} failed — ${err.message}`);
            return { products: [], error: err.message };
        }
    }
    return { products: [], error: 'unreachable' };
}

function bestCatalogMatch(cardFields, products, root) {
    let best = null;
    for (const product of products) {
        const title = product.title || '';
        if (!title) continue;
        const sim = cardToProductSimilarity(cardFields.title, title, root);
        if (!best || sim.lenient > best.similarity_lenient
            || (sim.lenient === best.similarity_lenient && sim.strict > best.similarity_strict)) {
            best = {
                product_title: title,
                handle: product.handle || '',
                product_price: product.variants?.[0]?.price ?? null,
                similarity_lenient: Number(sim.lenient.toFixed(3)),
                similarity_strict: Number(sim.strict.toFixed(3))
            };
        }
    }
    return best;
}

async function processDomain(domain, args, log) {
    const host = normalizeHostname(domain);
    const root = brandRootLabel(host);
    const row = {
        domain: host,
        catalog_available: false,
        catalog_pages_fetched: 0,
        catalog_products_scanned: 0,
        serper_cards: 0,
        seller_cards: 0,
        seller_match_methods: [],
        cards: [],
        found: false,
        best_match: null,
        old_ad_found: null,
        old_match_score: null,
        old_hero_title: null,
        error: null
    };

    // Page 1 first: it doubles as the Shopify check, and --compare needs it for hero selection.
    const firstPage = await fetchCatalogPage(host, args.catalogLimit, 1, log);
    if (!firstPage.products.length) {
        row.error = firstPage.error || 'empty_catalog';
        log(`${host}: no catalog (${row.error}) — skipping`);
        return row;
    }
    row.catalog_available = true;
    row.catalog_pages_fetched = 1;
    let products = [...firstPage.products];
    row.catalog_products_scanned = products.length;

    let cards;
    try {
        cards = await serperShoppingSearch(host, args.serperKey, args.serperNum);
    } catch (err) {
        row.error = `serper: ${err.message}`;
        log(`${host}: Serper failed — ${err.message}`);
        return row;
    }
    row.serper_cards = cards.length;

    const sellerCards = [];
    for (const card of cards) {
        const fields = extractCardFields(card);
        if (!fields.title) continue;
        const { matched, method } = matchSellerToBrand(fields.seller, host);
        if (matched) {
            sellerCards.push({ fields, method });
            row.seller_match_methods.push(method);
        }
    }
    row.seller_cards = sellerCards.length;
    const candidates = sellerCards.slice(0, MAX_SELLER_CARDS);

    if (!candidates.length) {
        log(`${host}: ${cards.length} cards, none seller-matched`);
    } else {
        // Paginate the catalog until every candidate card has a title match or
        // the store runs out of products.
        const bestByCard = candidates.map(({ fields }) => ({
            card_title: fields.title,
            card_seller: fields.seller,
            card_price: fields.price,
            card_link: fields.link,
            match: bestCatalogMatch(fields, products, root),
            matched_on_page: null
        }));
        const cardMatched = (entry) => entry.match && entry.match.similarity_lenient >= args.minTitleSim;
        // Mirror production matchDomainCards: keep paginating past a passable
        // match until it is near-exact, so sibling variants on early pages
        // don't freeze out the advertised product on a later one.
        const cardSettled = (entry) => cardMatched(entry) && entry.match.similarity_strict >= STRONG_MATCH_STRICT;
        const betterMatch = (a, b) => !b
            || a.similarity_lenient > b.similarity_lenient
            || (a.similarity_lenient === b.similarity_lenient && a.similarity_strict > b.similarity_strict);
        bestByCard.forEach((entry) => {
            if (cardMatched(entry)) entry.matched_on_page = 1;
        });

        let page = 1;
        let lastPageSize = firstPage.products.length;
        while (
            bestByCard.some((entry) => !cardSettled(entry))
            && lastPageSize >= args.catalogLimit
            && page < args.maxPages
        ) {
            page += 1;
            const { products: pageProducts } = await fetchCatalogPage(host, args.catalogLimit, page, log);
            row.catalog_pages_fetched = page;
            lastPageSize = pageProducts.length;
            if (!pageProducts.length) break;
            products = products.concat(pageProducts);
            row.catalog_products_scanned = products.length;

            for (const entry of bestByCard) {
                if (cardSettled(entry)) continue;
                const pageBest = bestCatalogMatch({ title: entry.card_title }, pageProducts, root);
                if (pageBest && betterMatch(pageBest, entry.match)) {
                    entry.match = pageBest;
                    if (cardMatched(entry)) entry.matched_on_page = page;
                }
            }
        }

        row.cards = bestByCard.map((entry) => ({ ...entry, matched: cardMatched(entry) }));
        const matchedCards = row.cards.filter((c) => c.matched);
        row.found = matchedCards.length > 0;
        row.best_match = matchedCards
            .sort((a, b) => b.match.similarity_lenient - a.match.similarity_lenient)[0] || null;
        log(`${host}: ${cards.length} cards, ${candidates.length} seller-matched, `
            + `${matchedCards.length} matched to catalog (${row.catalog_products_scanned} products, `
            + `${row.catalog_pages_fetched} page(s))`);
    }

    if (args.compare) {
        try {
            const snapshots = firstPage.products.map((p) => productToSnapshotRow(p, host));
            const hero = selectHeroProduct(snapshots);
            const heroTitle = hero?.snapshot?.title || firstPage.products[0].title;
            row.old_hero_title = heroTitle;
            const oldResult = await searchShoppingForHero({
                domain: host,
                productTitle: heroTitle,
                feedPrice: heroVariantPrice(hero?.snapshot?.variants || []),
                apiKey: args.serperKey,
                geo: DEFAULT_SERPER_GEO
            });
            row.old_ad_found = oldResult.branch !== 'none';
            row.old_match_score = Number((oldResult.matchScore || 0).toFixed(3));
        } catch (err) {
            log(`${host}: compare (hero-first) failed — ${err.message}`);
        }
    }

    return row;
}

function buildSummary(results, compare) {
    const withCatalog = results.filter((r) => r.catalog_available);
    const withSellerCard = withCatalog.filter((r) => r.seller_cards > 0);
    const found = withCatalog.filter((r) => r.found);
    const concatOnly = withCatalog.filter(
        (r) => r.seller_match_methods.length && r.seller_match_methods.every((m) => m === 'concat')
    );
    const denom = Math.max(withCatalog.length, 1);

    const summary = {
        domains_tested: results.length,
        catalog_available: withCatalog.length,
        seller_card_found: withSellerCard.length,
        seller_card_rate: Number((withSellerCard.length / denom).toFixed(3)),
        seller_match_only_via_concat_fix: concatOnly.length,
        catalog_match_found: found.length,
        new_find_rate: Number((found.length / denom).toFixed(3)),
        avg_catalog_pages: Number(
            (withCatalog.reduce((acc, r) => acc + r.catalog_pages_fetched, 0) / denom).toFixed(2)
        )
    };

    if (compare) {
        const compared = withCatalog.filter((r) => r.old_ad_found != null);
        const oldFound = compared.filter((r) => r.old_ad_found);
        const comparedDenom = Math.max(compared.length, 1);
        summary.old_find_rate = Number((oldFound.length / comparedDenom).toFixed(3));
        summary.compared_domains = compared.length;
        summary.new_only = compared.filter((r) => r.found && !r.old_ad_found).map((r) => r.domain);
        summary.old_only = compared.filter((r) => !r.found && r.old_ad_found).map((r) => r.domain);
    }

    return summary;
}

async function resolveSerperKeyFromAgency(agencyId) {
    const [{ getAgencySettings, apiKeysFromSettings }, { pool }] = await Promise.all([
        import('../services/db/agencySettings.js'),
        import('../config/db.js')
    ]);
    try {
        const settings = await getAgencySettings(agencyId);
        return apiKeysFromSettings(settings).serper || '';
    } finally {
        await pool.end().catch(() => {});
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log('Usage: node src/scripts/serper-domain-first-spike.js [--agency ID | --serper-key KEY] '
            + '[--domains a.com,b.com] [--domains-file path.txt] [--catalog-limit 50] [--max-pages 10] '
            + '[--min-title-sim 0.6] [--serper-num 20] [--no-compare] [--output path.json] [--concurrency N]');
        process.exit(0);
    }

    if (!args.serperKey && args.agency) {
        args.serperKey = await resolveSerperKeyFromAgency(args.agency);
        if (!args.serperKey) {
            console.error(`No serper_key found in agency_settings for agency ${args.agency}.`);
            process.exit(1);
        }
    }
    if (!args.serperKey) {
        console.error('Missing Serper API key. Pass --serper-key, --agency <id>, or set SERPER_API_KEY.');
        process.exit(1);
    }

    const domains = args.domains?.length
        ? args.domains
        : (loadDomainsFromFile(args.domainsFile) || []);
    if (!domains.length) {
        console.error(`No domains. Pass --domains or --domains-file (tried ${args.domainsFile}).`);
        process.exit(1);
    }

    const log = (msg) => console.log(`[domain-first] ${msg}`);
    const limit = pLimit(args.concurrency);
    log(`Processing ${domains.length} domains (catalog limit ${args.catalogLimit}, max ${args.maxPages} pages, `
        + `min title sim ${args.minTitleSim}, compare=${args.compare})…`);

    const results = await Promise.all(
        domains.map((domain) => limit(() => processDomain(domain, args, log)))
    );
    const summary = buildSummary(results, args.compare);

    const report = {
        description: 'Domain-first Serper Shopping spike — seller match + reverse catalog title match',
        generated_at: new Date().toISOString(),
        config: {
            catalog_limit: args.catalogLimit,
            max_pages: args.maxPages,
            min_title_sim: args.minTitleSim,
            serper_num: args.serperNum,
            compare: args.compare
        },
        summary,
        results
    };

    fs.mkdirSync(path.dirname(args.output), { recursive: true });
    fs.writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`);

    console.log('\n=== Domain-first Serper Shopping Spike ===');
    console.log(`Domains tested: ${summary.domains_tested}`);
    console.log(`Catalog available: ${summary.catalog_available}`);
    console.log(`Seller card found: ${summary.seller_card_found}/${summary.catalog_available} (${(summary.seller_card_rate * 100).toFixed(1)}%)`);
    console.log(`  …of which only via space-insensitive fix: ${summary.seller_match_only_via_concat_fix}`);
    console.log(`Matched to catalog (find): ${summary.catalog_match_found}/${summary.catalog_available} (${(summary.new_find_rate * 100).toFixed(1)}%)`);
    if (args.compare) {
        console.log(`Old hero-first find rate: ${(summary.old_find_rate * 100).toFixed(1)}% (${summary.compared_domains} compared)`);
        console.log(`New-only wins: ${summary.new_only.join(', ') || '—'}`);
        console.log(`Old-only wins: ${summary.old_only.join(', ') || '—'}`);
    }
    console.log(`Avg catalog pages fetched: ${summary.avg_catalog_pages}`);
    console.log(`Report written to: ${args.output}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

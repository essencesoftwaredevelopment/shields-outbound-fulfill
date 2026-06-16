import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { parse as csvParse } from 'csv-parse';
import { stringify as csvStringify } from 'csv-stringify';
import '../config/env.js';
import { runPersonalization } from '../services/personalization/strategies/ecom.js';
import { TMP_ROOT } from '../config/paths.js';

// Additionally load workspace-root env files so local runs can reuse
// OPENAI_API_KEY (and others) from the repo's .env.local.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, '../../..');
for (const rel of ['.env.local', '.env']) {
    const candidate = path.join(WORKSPACE_ROOT, rel);
    if (fs.existsSync(candidate)) {
        dotenv.config({ path: candidate, override: false });
    }
}

function printUsage() {
    console.log(`Usage:
  node src/scripts/run-personalizer-local.js --input <file.csv> [options]

Options:
  --output <file.csv>           Output CSV path. Default: server/tmp/jobs/<run-id>/personalized.csv
  --domain-column <name>        Input column containing domains. Default: domain
  --email-column <name>         Optional input email column. If missing, a placeholder email is injected
  --concurrency <n>             Personalization concurrency. Default: strategy default
  --remove-b2b                  Filter B2B-style products before personalization
  --product-prompt-version <v>  ecom.js mode: old | new_gpt5mini. Default: new_gpt5mini
  --product-prompt-products <n> Number of Shopify products to include in the new prompt path. Default: 3
  --skip-shopify-detection      Skip DNS Shopify checks; treat every domain as a Shopify store
  --openai-key <key>            OpenAI API key. Falls back to OPENAI_API_KEY env var
  --help                        Show this message
`);
}

function parseArgs(argv) {
    const args = {
        input: '',
        output: '',
        domainColumn: 'domain',
        emailColumn: '',
        concurrency: undefined,
        removeB2B: false,
        productPromptVersion: 'new_gpt5mini',
        productPromptProducts: 3,
        skipShopifyDetection: false,
        openaiKey: process.env.OPENAI_API_KEY || ''
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') {
            args.help = true;
            continue;
        }
        if (arg === '--remove-b2b') {
            args.removeB2B = true;
            continue;
        }
        if (arg === '--skip-shopify-detection') {
            args.skipShopifyDetection = true;
            continue;
        }
        if (arg === '--input') {
            args.input = argv[i + 1] || '';
            i += 1;
            continue;
        }
        if (arg === '--output') {
            args.output = argv[i + 1] || '';
            i += 1;
            continue;
        }
        if (arg === '--domain-column') {
            args.domainColumn = argv[i + 1] || 'domain';
            i += 1;
            continue;
        }
        if (arg === '--email-column') {
            args.emailColumn = argv[i + 1] || '';
            i += 1;
            continue;
        }
        if (arg === '--concurrency') {
            const parsed = parseInt(argv[i + 1] || '', 10);
            args.concurrency = Number.isFinite(parsed) ? Math.max(1, parsed) : undefined;
            i += 1;
            continue;
        }
        if (arg === '--product-prompt-version') {
            const value = String(argv[i + 1] || '').trim().toLowerCase();
            args.productPromptVersion = value === 'old' ? 'old' : 'new_gpt5mini';
            i += 1;
            continue;
        }
        if (arg === '--product-prompt-products') {
            const parsed = parseInt(argv[i + 1] || '3', 10);
            args.productPromptProducts = Number.isFinite(parsed) ? Math.max(1, Math.min(parsed, 5)) : 3;
            i += 1;
            continue;
        }
        if (arg === '--openai-key') {
            args.openaiKey = argv[i + 1] || '';
            i += 1;
        }
    }

    return args;
}

async function readCsvRows(inputPath) {
    return new Promise((resolve, reject) => {
        const rows = [];
        fs.createReadStream(inputPath)
            .pipe(csvParse({ columns: true, trim: true }))
            .on('data', (row) => rows.push(row))
            .on('end', () => resolve(rows))
            .on('error', reject);
    });
}

async function writeNormalizedInput({ inputPath, outputPath, domainColumn, emailColumn }) {
    const rows = await readCsvRows(inputPath);
    const writeStream = fs.createWriteStream(outputPath);
    const stringifier = csvStringify({ header: true, columns: ['domain', 'email'] });
    stringifier.pipe(writeStream);

    for (const row of rows) {
        const domain = String(row[domainColumn] || '').trim();
        const email = String(emailColumn ? (row[emailColumn] || '') : '').trim() || 'placeholder@example.com';
        if (domain) {
            stringifier.write({ domain, email });
        }
    }

    stringifier.end();
    await new Promise((resolve) => writeStream.on('finish', resolve));
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printUsage();
        process.exit(0);
    }

    if (!args.input) {
        printUsage();
        throw new Error('Missing required --input argument.');
    }

    if (!args.openaiKey) {
        throw new Error('Missing OpenAI key. Pass --openai-key or set OPENAI_API_KEY.');
    }

    const inputPath = path.resolve(args.input);
    if (!fs.existsSync(inputPath)) {
        throw new Error(`Input file not found: ${inputPath}`);
    }

    const runId = `local-personalizer-${Date.now()}`;
    const runDir = path.join(TMP_ROOT, runId);
    fs.mkdirSync(runDir, { recursive: true });

    const normalizedInputCsv = path.join(runDir, 'input.csv');
    const outputCsv = args.output
        ? path.resolve(args.output)
        : path.join(runDir, 'personalized.csv');

    await writeNormalizedInput({
        inputPath,
        outputPath: normalizedInputCsv,
        domainColumn: args.domainColumn,
        emailColumn: args.emailColumn
    });

    console.log(`Input: ${inputPath}`);
    console.log(`Working dir: ${runDir}`);
    console.log(`Output: ${outputCsv}`);
    console.log(`Strategy: ecom.js (${args.productPromptVersion})`);
    if (args.skipShopifyDetection) {
        console.log('Shopify DNS detection: skipped');
    }
    if (Number.isFinite(args.concurrency)) {
        console.log(`Concurrency override: ${args.concurrency}`);
    }

    const runStartMs = Date.now();
    const phaseStarts = new Map();
    const phaseDurations = new Map();

    const formatDuration = (ms) => {
        if (ms < 1000) return `${ms}ms`;
        const seconds = ms / 1000;
        if (seconds < 60) return `${seconds.toFixed(2)}s`;
        const minutes = Math.floor(seconds / 60);
        const rem = (seconds - minutes * 60).toFixed(1);
        return `${minutes}m ${rem}s`;
    };

    const stampedLog = (message) => {
        if (!message) return;
        const elapsedMs = Date.now() - runStartMs;
        console.log(`[+${formatDuration(elapsedMs).padStart(7, ' ')}] ${message}`);

        // Track phase boundaries based on log strings emitted by ecom.js
        if (typeof message === 'string') {
            if (message.startsWith('Starting Shopify detection')) {
                phaseStarts.set('shopify_detection', Date.now());
            } else if (message.startsWith('Skipping Shopify DNS detection')) {
                phaseStarts.set('shopify_detection', Date.now());
            } else if (message.startsWith('Shopify detection complete') || message.startsWith('Shopify detection bypassed')) {
                const start = phaseStarts.get('shopify_detection');
                if (start) phaseDurations.set('Shopify detection', Date.now() - start);
            } else if (message.startsWith('Fetching products for')) {
                phaseStarts.set('fetching_products', Date.now());
            } else if (message.startsWith('Product fetch complete')) {
                const start = phaseStarts.get('fetching_products');
                if (start) phaseDurations.set('Product fetch', Date.now() - start);
            } else if (message.startsWith('Generating first lines with OpenAI')) {
                phaseStarts.set('generating', Date.now());
            } else if (message.startsWith('New prompt personalization complete')) {
                const start = phaseStarts.get('generating');
                if (start) phaseDurations.set('OpenAI generation', Date.now() - start);
            } else if (message.startsWith('Cleaning product data')) {
                phaseStarts.set('cleaning', Date.now());
            } else if (message.startsWith('Personalization complete:')) {
                const start = phaseStarts.get('generating_old');
                if (start) phaseDurations.set('OpenAI generation', Date.now() - start);
            } else if (message.startsWith('Generating personalized first lines with OpenAI')) {
                phaseStarts.set('generating_old', Date.now());
            } else if (message.startsWith('Fetching product samples')) {
                phaseStarts.set('fetching_products_old', Date.now());
            } else if (/^Product fetch progress:.*\(\d+ fetched/.test(message)) {
                // no-op, just progress
            }
        }
    };

    const result = await runPersonalization({
        inputCsv: normalizedInputCsv,
        outputCsv,
        apiKeys: {
            openai: args.openaiKey
        },
        log: stampedLog,
        concurrency: args.concurrency,
        removeB2B: args.removeB2B,
        productPromptVersion: args.productPromptVersion,
        productPromptProducts: args.productPromptProducts,
        skipShopifyDetection: args.skipShopifyDetection
    });

    const totalMs = Date.now() - runStartMs;
    const totalRows = (result?.['Shopify Stores'] ?? result?.processed ?? 0);
    const personalized = result?.['Personalized'] ?? result?.processed ?? 0;
    const rowsPerSecond = totalMs > 0 ? (personalized / (totalMs / 1000)).toFixed(2) : '0';

    console.log('');
    console.log('===== Timing =====');
    for (const [label, ms] of phaseDurations.entries()) {
        console.log(`  ${label.padEnd(22, ' ')} ${formatDuration(ms)}`);
    }
    console.log(`  ${'Total'.padEnd(22, ' ')} ${formatDuration(totalMs)}`);
    if (personalized > 0) {
        console.log(`  ${'Throughput'.padEnd(22, ' ')} ${rowsPerSecond} personalized/sec (${personalized} total)`);
    }
    console.log('');
    console.log('Done.');
    console.log(JSON.stringify({ outputCsv, result }, null, 2));
}

main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
});

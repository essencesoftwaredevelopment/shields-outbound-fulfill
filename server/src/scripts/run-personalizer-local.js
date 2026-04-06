import fs from 'fs';
import path from 'path';
import { parse as csvParse } from 'csv-parse';
import { stringify as csvStringify } from 'csv-stringify';
import '../config/env.js';
import { runPersonalization } from '../services/personalization/strategies/ecom.js';
import { TMP_ROOT } from '../config/paths.js';

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

    const result = await runPersonalization({
        inputCsv: normalizedInputCsv,
        outputCsv,
        apiKeys: {
            openai: args.openaiKey
        },
        log: (message) => {
            if (message) console.log(message);
        },
        concurrency: args.concurrency,
        removeB2B: args.removeB2B,
        productPromptVersion: args.productPromptVersion,
        productPromptProducts: args.productPromptProducts
    });

    console.log('Done.');
    console.log(JSON.stringify({ outputCsv, result }, null, 2));
}

main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
});

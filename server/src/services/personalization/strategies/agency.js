import fs from 'fs';
import { parse as csvParse } from 'csv-parse';
import { stringify as csvStringify } from 'csv-stringify';
import OpenAI from 'openai';
import http from 'http';
import https from 'https';

async function readVerifiedRows(inputCsv) {
    const rows = [];
    await new Promise((resolve, reject) => {
        fs.createReadStream(inputCsv)
            .pipe(csvParse({ columns: true, trim: true }))
            .on('data', (row) => {
                const emailStatus = (row.email_status || '').toLowerCase();
                if (emailStatus === 'valid' || emailStatus === 'verified' || emailStatus === 'valid-risky') {
                    rows.push(row);
                }
            })
            .on('end', resolve)
            .on('error', reject);
    });
    return rows;
}

function fetchWithTimeout(url, timeoutMs = 6000, maxBytes = 350_000) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        const controller = new AbortController();
        const timer = setTimeout(() => {
            controller.abort();
            reject(new Error('Fetch timeout'));
        }, timeoutMs);

        mod.get(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html,*/*' } }, (res) => {
            if (res.statusCode && res.statusCode >= 400) {
                clearTimeout(timer);
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
                if (data.length > maxBytes) {
                    res.destroy();
                    clearTimeout(timer);
                    reject(new Error('Response too large'));
                }
            });
            res.on('end', () => {
                clearTimeout(timer);
                resolve(data);
            });
        }).on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

function extractSnippet(html = '') {
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const metaDescMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i);
    const h1Match = html.match(/<h1[^>]*>([^<]{10,180})<\/h1>/i);
    const title = titleMatch ? titleMatch[1].trim() : '';
    const description = metaDescMatch ? metaDescMatch[1].trim() : '';
    const h1 = h1Match ? h1Match[1].replace(/\s+/g, ' ').trim() : '';
    const pieces = [title, h1, description].filter(Boolean);
    const combined = pieces.join(' • ').slice(0, 500);
    return combined || 'No site content found';
}

async function fetchSiteContext(domain, log) {
    if (!domain) return '';
    const url = `https://${domain}`;
    try {
        const html = await fetchWithTimeout(url);
        return extractSnippet(html);
    } catch (err) {
        log?.(`Agency site fetch failed for ${domain}: ${err.message}`);
        return '';
    }
}

async function personalizeRows({ rows, apiKeys, log, model = 'gpt-5-nano', maxTokens = 120, concurrent = 6 }) {
    if (!apiKeys?.openai) {
        throw new Error('Missing OpenAI API key for agency personalization');
    }

    const client = new OpenAI({ apiKey: apiKeys.openai });
    const results = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    const worker = async (row) => {
        const domain = row.domain || '';
        const founder = row.founder_name || '';
        const email = row.email || '';
        const siteContext = await fetchSiteContext(domain, log);

        const prompt = `
Write one warm, human-sounding sentence under 220 characters that starts with:

"I was looking around the site and "

Style rules:
Use active voice.
Use active voice.Talk directly, like you’re speaking to one person.Be concise.Use simple language.Cut all fluff.Focus on clarity.Sound conversational and real.Avoid marketing language entirely.Avoid clichés, jargon, hashtags, semicolons, emojis, asterisks, and dashes.Vary sentence rhythm but keep it one sentence total.Avoid AI-filler phrases.If something is certain, say it directly.No repetition.

Content rules:
Use only the website context provided.
Do not invent facts.
Pick one real detail and turn it into a specific, human compliment.
Not a summary.
Not a list of services.
Not generic praise.
Make the compliment about something concrete, like a project, result, style choice, or approach visible on the site.
Keep the compliment natural, like something a person would say after browsing for a minute.

If the website context is vague, empty, or nonsense, return exactly: invalid.

Inputs:
Website context: ${siteContext || 'N/A'}

Output:
One sentence under 220 characters starting with “I was looking around the site and ...” and containing a specific, human compliment based on the context.`;

        try {
            const response = await client.chat.completions.create({
                model,
                messages: [
                    { role: 'system', content: 'You craft concise outreach first-line personalizations.' },
                    { role: 'user', content: `${prompt}\n\nDomain: ${domain}\nFounder: ${founder || 'N/A'}` }
                ]
            });

            const choice = response.choices?.[0]?.message?.content?.trim() || '';
            const usage = response.usage || {};
            totalInputTokens += usage.prompt_tokens || 0;
            totalOutputTokens += usage.completion_tokens || 0;

            results.push({
                domain,
                url: domain ? `https://${domain}` : '',
                title: '',
                description: siteContext || '',
                date: '',
                first_line: choice,
                email,
                email_status: row.email_status || '',
                founder_name: founder
            });
        } catch (err) {
            log?.(`Agency personalization failed for ${domain}: ${err.message}`);
        }
    };

    // Simple concurrency control
    const queue = rows.slice();
    const workers = Array.from({ length: Math.min(concurrent, rows.length) }, async () => {
        while (queue.length) {
            const row = queue.shift();
            if (row) {
                // eslint-disable-next-line no-await-in-loop
                await worker(row);
            }
        }
    });
    await Promise.all(workers);

    return { rows: results, totalInputTokens, totalOutputTokens };
}

export async function runPersonalization({ inputCsv, outputCsv, apiKeys, log }) {
    const verifiedRows = await readVerifiedRows(inputCsv);

    if (!verifiedRows.length) {
        log?.('No verified emails to personalize for agency.');
        fs.writeFileSync(outputCsv, 'domain,url,title,description,date,first_line\n');
        return { personalized: 0, skipped: true };
    }

    const { rows: personalizedRows, totalInputTokens, totalOutputTokens } = await personalizeRows({
        rows: verifiedRows,
        apiKeys,
        log
    });

    const writeStream = fs.createWriteStream(outputCsv);
    const stringifier = csvStringify({
        header: true,
        columns: ['domain', 'url', 'title', 'description', 'date', 'first_line']
    });
    stringifier.pipe(writeStream);
    personalizedRows.forEach((row) => stringifier.write({
        domain: row.domain || '',
        url: row.url || '',
        title: row.title || '',
        description: row.description || '',
        date: row.date || '',
        first_line: row.first_line || ''
    }));
    stringifier.end();
    await new Promise(resolve => writeStream.on('finish', resolve));

    const estimatedCost = ((totalInputTokens / 1_000_000) * 0.25) + ((totalOutputTokens / 1_000_000) * 2.0);
    log?.(`Agency personalization complete: ${personalizedRows.length} rows. Tokens in/out: ${totalInputTokens}/${totalOutputTokens} (~$${estimatedCost.toFixed(4)})`);

    return {
        personalized: personalizedRows.length,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        estimatedCost
    };
}

import OpenAI from 'openai';
import { createConcurrencyLimit } from '../../../lib/concurrency.js';
import { DEFAULT_SIGNAL_TEMPLATES, SIGNAL_TYPES } from '../../shoppingAudit/constants.js';
import { getSignalEmissionById } from '../../shoppingAudit/db.js';

function parsePositiveInt(raw, fallback) {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

const PERSONALIZATION_CONCURRENCY = parsePositiveInt(
    process.env.SHOPPING_AUDIT_PERSONALIZATION_CONCURRENCY,
    20
);

function renderTemplate(template, vars) {
    return String(template || '').replace(/\{\{(\w+)\}\}/g, (_, key) => {
        const val = vars[key];
        return val != null ? String(val) : '';
    });
}

function buildSignalVars(signal, snapshot) {
    const observed = signal?.observed || {};
    const expected = signal?.expected || {};
    const competitor = signal?.competitor_ref || {};
    const productTitle = observed.ad_title || snapshot?.title || observed.feed_title || 'your product';
    return {
        product: productTitle,
        ad_price: observed.ad_price != null ? `$${observed.ad_price}` : observed.ad_price,
        page_price: expected.page_price != null ? `$${expected.page_price}` : expected.page_price,
        review_count: expected.page_review_count || observed.page_review_count || '',
        competitor: competitor.seller || competitor.title || 'a competitor',
        competitor_rating: competitor.rating || expected.competitor_stars || ''
    };
}

async function generateFirstLineFromSignal({ signal, snapshot, apiKey, templates, log }) {
    const templateMap = { ...DEFAULT_SIGNAL_TEMPLATES, ...(templates || {}) };
    const baseTemplate = templateMap[signal.signal_type] || templateMap.title_quality;
    const vars = buildSignalVars(signal, snapshot);
    const seeded = renderTemplate(baseTemplate, vars);

    if (signal.signal_type === SIGNAL_TYPES.AD_MATCH) {
        return { first_line: seeded, inputTokens: 0, outputTokens: 0 };
    }

    const client = new OpenAI({ apiKey });
    const response = await client.chat.completions.create({
        model: process.env.SHOPPING_AUDIT_PERSONALIZATION_MODEL || 'gpt-4o-mini',
        temperature: 0.7,
        messages: [
            {
                role: 'system',
                content: `You write cold-email first lines for DTC founders about Google Shopping ad issues.
Use the factual seed below. Normalize the product name naturally. Keep under 45 words.
End with an offer to send an optimized ad preview. No fluff, no em dashes.`
            },
            {
                role: 'user',
                content: `Signal type: ${signal.signal_type}
Seed line: ${seeded}
Product title from store: ${snapshot?.title || 'unknown'}`
            }
        ]
    });

    const line = response.choices?.[0]?.message?.content?.trim() || seeded;
    const usage = response.usage || {};
    const inputTokens = usage.prompt_tokens || 0;
    const outputTokens = usage.completion_tokens || 0;
    return { first_line: line, inputTokens, outputTokens };
}

export async function runPersonalization({
    rows,
    apiKeys,
    log,
    recordTiming,
    signalEmissionByDomain,
    templates,
    onBatch,
    checkpoint,
    concurrency = PERSONALIZATION_CONCURRENCY,
    rateLimitHooks = null
}) {
    let processed = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let llmMs = 0;
    const outputRows = [];
    const total = rows.length;
    const llmLimit = createConcurrencyLimit(concurrency);

    log?.(`Shopping audit personalization: ${total} rows (concurrency ${concurrency})…`);

    await Promise.all(
        rows.map((row) =>
            llmLimit(async () => {
                if (checkpoint && processed % 10 === 0) await checkpoint();

                const domain = row.domain;
                const emissionRef = signalEmissionByDomain?.get?.(domain);
                let signal = emissionRef?.signal;
                let snapshot = emissionRef?.selection?.snapshot;

                if (!signal && row.signal_emission_id) {
                    const dbSignal = await getSignalEmissionById(row.signal_emission_id);
                    if (dbSignal) {
                        signal = dbSignal;
                    }
                }

                processed += 1;

                if (!signal) {
                    log?.(`No signal for ${domain}, skipping personalization`);
                    if (processed % 5 === 0 || processed === total) {
                        log?.(`Shopping audit personalization: ${processed}/${total}`, {
                            progress: {
                                stage: 'personalization',
                                processed,
                                total,
                                stats: { personalized: outputRows.length }
                            }
                        });
                    }
                    return;
                }

                try {
                    if (rateLimitHooks?.openai) await rateLimitHooks.openai();
                    const llmStart = Date.now();
                    const { first_line, inputTokens, outputTokens } = await generateFirstLineFromSignal({
                        signal,
                        snapshot,
                        apiKey: apiKeys.openai,
                        templates,
                        log
                    });
                    llmMs += Date.now() - llmStart;
                    totalInputTokens += inputTokens;
                    totalOutputTokens += outputTokens;
                    outputRows.push({
                        domain,
                        first_line,
                        signal_type: signal.signal_type,
                        signal_emission_id: emissionRef?.signalId || row.signal_emission_id || null
                    });
                } catch (err) {
                    log?.(`Personalization failed for ${domain}: ${err.message}`);
                }

                if (processed % 5 === 0 || processed === total) {
                    log?.(`Shopping audit personalization: ${processed}/${total}`, {
                        progress: {
                            stage: 'personalization',
                            processed,
                            total,
                            stats: { personalized: outputRows.length }
                        }
                    });
                }
            })
        )
    );

    if (outputRows.length && onBatch) {
        await onBatch(outputRows);
    }

    if (llmMs > 0) {
        recordTiming?.({
            label: 'fetch:personalizationLlm',
            category: 'fetch',
            durationMs: llmMs,
            rows: outputRows.length,
            stage: 'personalization'
        });
    }

    return {
        processed: outputRows.length,
        total,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens
    };
}

import { createConcurrencyLimit } from '../../../lib/concurrency.js';
import { DEFAULT_SIGNAL_TEMPLATES } from '../../shoppingAudit/constants.js';
import { humanizeProductShort } from '../../shoppingAudit/utils.js';
import { getSignalEmissionById, updateSignalEmissionExportVars } from '../../shoppingAudit/db.js';

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

/** Signal may be an in-memory waterfall emission or a signal_emissions DB row. */
function buildSignalVars(signal, snapshot) {
    const observed = signal?.observed || {};
    const expected = signal?.expected || {};
    const competitor = signal?.competitor_ref || {};
    const exportVars = signal?.export_vars || {};
    const productTitle = exportVars.product
        || snapshot?.title
        || observed.ad_title
        || observed.feed_title
        || 'your product';
    return {
        product: productTitle,
        ad_price: exportVars.ad_price
            || (observed.ad_price != null ? `$${observed.ad_price}` : observed.ad_price),
        page_price: exportVars.page_price
            || (expected.page_price != null ? `$${expected.page_price}` : expected.page_price),
        review_count: expected.page_review_count || observed.page_review_count || '',
        competitor: competitor.seller || competitor.title || 'a competitor',
        competitor_rating: competitor.rating || expected.competitor_stars || ''
    };
}

/**
 * {{product_short}} — the humanized ad/product title used across subjects and
 * bodies of the shopping-audit emails: marketing junk stripped, sentence-cased
 * when ALL CAPS, truncated below 35 characters. Deterministic — formerly an
 * LLM call (generic "socks"-style names), now humanizeProductShort().
 */
function generateProductShort(productTitle) {
    if (!productTitle) return '';
    return humanizeProductShort(productTitle);
}

export async function runPersonalization({
    rows,
    log,
    signalEmissionByDomain,
    templates,
    onBatch,
    checkpoint,
    concurrency = PERSONALIZATION_CONCURRENCY
}) {
    let processed = 0;
    const outputRows = [];
    const exportVarPatches = [];
    const total = rows.length;
    const llmLimit = createConcurrencyLimit(concurrency);
    const templateMap = { ...DEFAULT_SIGNAL_TEMPLATES, ...(templates || {}) };

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
                    const vars = buildSignalVars(signal, snapshot);
                    const baseTemplate = templateMap[signal.signal_type] || templateMap.title_quality;
                    const first_line = renderTemplate(baseTemplate, vars);

                    const product_short = generateProductShort(
                        vars.product === 'your product' ? '' : vars.product
                    );

                    const signalEmissionId = emissionRef?.signalId || row.signal_emission_id || signal.id || null;
                    if (signalEmissionId && product_short) {
                        exportVarPatches.push({ id: signalEmissionId, vars: { product_short } });
                    }

                    outputRows.push({
                        domain,
                        first_line,
                        product_short,
                        signal_type: signal.signal_type,
                        signal_emission_id: signalEmissionId
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

    if (exportVarPatches.length) {
        await updateSignalEmissionExportVars(exportVarPatches);
        log?.(`Shopping audit personalization: saved product_short for ${exportVarPatches.length} signals`);
    }

    if (outputRows.length && onBatch) {
        await onBatch(outputRows);
    }

    return {
        processed: outputRows.length,
        total,
        inputTokens: 0,
        outputTokens: 0
    };
}

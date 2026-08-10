import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildSerperQueries,
    compactSerperResults,
    estimateVisitorsFromReviewCount,
    extractHomepageSummary,
    extractReviewCountFromSerper,
    formatResearchBriefForPrompt,
    normalizeResearchBrief,
    normalizeResearchIndustry,
    normalizeReviewCount,
    RESEARCH_INDUSTRIES,
    stripHtmlToText,
    VISITORS_PER_REVIEW
} from '../briefUtils.js';

test('stripHtmlToText removes markup, scripts, and entities', () => {
    const html = `
        <html><head><style>body{color:red}</style>
        <script>window.x = 1;</script></head>
        <body><h1>Wild &amp; Free</h1><p>Organic teas<br>shipped fast.</p></body></html>`;
    const text = stripHtmlToText(html);
    assert.ok(text.includes('Wild & Free'));
    assert.ok(text.includes('Organic teas\nshipped fast.'));
    assert.ok(!text.includes('<'));
    assert.ok(!text.includes('window.x'));
    assert.ok(!text.includes('color:red'));
});

test('extractHomepageSummary pulls title, meta description, and bounded text', () => {
    const html = `<html><head><title> Wild Orchard Tea </title>
        <meta name="description" content="Regenerative teas from Jeju island.">
        </head><body>${'tea '.repeat(5000)}</body></html>`;
    const summary = extractHomepageSummary(html, { textLimit: 100 });
    assert.equal(summary.title, 'Wild Orchard Tea');
    assert.equal(summary.description, 'Regenerative teas from Jeju island.');
    assert.ok(summary.text.length <= 100);
});

test('buildSerperQueries needs a subject and includes news + review queries', () => {
    assert.deepEqual(buildSerperQueries({ companyName: '', domain: '' }), []);
    const queries = buildSerperQueries({ companyName: 'Wild Orchard', domain: 'wildorchard.com' });
    assert.equal(queries.length, 3);
    assert.equal(queries[0].q, 'Wild Orchard wildorchard.com');
    assert.ok(queries[1].q.includes('news'));
    assert.ok(queries[2].q.includes('Trustpilot'));
});

test('compactSerperResults dedupes links and truncates snippets', () => {
    const responses = [
        {
            organic: [
                { title: 'Wild Orchard', link: 'https://a.com', snippet: 'x'.repeat(500) },
                { title: 'Dup', link: 'https://a.com', snippet: 'ignored' },
                { title: 'No link' },
                { title: 'News', link: 'https://b.com', snippet: 'launch', date: 'Jan 2026' }
            ],
            knowledgeGraph: { title: 'Wild Orchard', description: 'Tea company', website: 'https://a.com' }
        }
    ];
    const results = compactSerperResults(responses);
    assert.equal(results.length, 3);
    assert.equal(results[0].snippet.length, 300);
    assert.equal(results[1].date, 'Jan 2026');
    assert.ok(results[2].title.startsWith('Knowledge graph:'));
});

test('normalizeReviewCount and estimateVisitorsFromReviewCount', () => {
    assert.equal(normalizeReviewCount(null), null);
    assert.equal(normalizeReviewCount(0), null);
    assert.equal(normalizeReviewCount(-3), null);
    assert.equal(normalizeReviewCount(1240), 1240);
    assert.equal(normalizeReviewCount('1,234'), 1234);
    assert.equal(normalizeReviewCount('1.2k'), 1200);
    assert.equal(normalizeReviewCount('890 reviews'), 890);
    assert.equal(estimateVisitorsFromReviewCount(12), 12 * VISITORS_PER_REVIEW);
    assert.equal(estimateVisitorsFromReviewCount(null), null);
});

test('extractReviewCountFromSerper prefers explicit review totals', () => {
    assert.equal(extractReviewCountFromSerper([]), null);
    assert.equal(
        extractReviewCountFromSerper([
            { title: 'Wild Orchard Trustpilot', snippet: 'Based on 1,240 reviews' },
            { title: 'Other', snippet: '12 reviews on a blog' }
        ]),
        1240
    );
    assert.equal(
        extractReviewCountFromSerper([
            { title: 'Brand', snippet: '4.8 · 892 reviews on Trustpilot' }
        ]),
        892
    );
});

test('normalizeResearchBrief rejects empty summaries and fills fallbacks', () => {
    assert.equal(normalizeResearchBrief(null), null);
    assert.equal(normalizeResearchBrief({ summary: '   ' }), null);

    const brief = normalizeResearchBrief(
        {
            summary: 'Sells regenerative tea DTC.',
            talkingPoints: ['Jeju sourcing', '', 42],
            risks: ['No pricing info'],
            sources: [{ title: '', url: 'https://a.com' }, { url: '' }, 'junk']
        },
        { company: 'Wild Orchard', domain: 'wildorchard.com' }
    );
    assert.equal(brief.company, 'Wild Orchard');
    assert.equal(brief.domain, 'wildorchard.com');
    assert.deepEqual(brief.talkingPoints, ['Jeju sourcing', '42']);
    assert.deepEqual(brief.sources, [{ title: 'https://a.com', url: 'https://a.com' }]);
    assert.equal(brief.reviewCount, null);
    assert.equal(brief.estimatedVisitors, null);
});

test('normalizeResearchBrief derives estimatedVisitors from reviewCount', () => {
    const fromLlm = normalizeResearchBrief(
        { summary: 'Sells tea.', reviewCount: 250 },
        { company: 'Wild Orchard', domain: 'wildorchard.com' }
    );
    assert.equal(fromLlm.reviewCount, 250);
    assert.equal(fromLlm.estimatedVisitors, 250 * VISITORS_PER_REVIEW);

    const fromFallback = normalizeResearchBrief(
        { summary: 'Sells tea.' },
        { company: 'Wild Orchard', domain: 'wildorchard.com', fallbackReviewCount: 80 }
    );
    assert.equal(fromFallback.reviewCount, 80);
    assert.equal(fromFallback.estimatedVisitors, 80 * VISITORS_PER_REVIEW);
});

test('normalizeResearchIndustry coerces to the enum with null as fallback', () => {
    assert.equal(normalizeResearchIndustry('beauty_skincare'), 'beauty_skincare');
    assert.equal(normalizeResearchIndustry('Beauty Skincare'), 'beauty_skincare');
    assert.equal(normalizeResearchIndustry('food/beverage'), 'food_beverage');
    assert.equal(normalizeResearchIndustry('quantum computing'), null);
    assert.equal(normalizeResearchIndustry('other'), null);
    assert.equal(normalizeResearchIndustry(''), null);
    assert.equal(normalizeResearchIndustry(null), null);
    for (const industry of RESEARCH_INDUSTRIES) {
        assert.equal(normalizeResearchIndustry(industry), industry);
    }
});

test('normalizeResearchBrief carries a valid industry or null', () => {
    const withIndustry = normalizeResearchBrief(
        { summary: 'Sells tea.', industry: 'food_beverage' },
        { company: 'Wild Orchard', domain: 'wildorchard.com' }
    );
    assert.equal(withIndustry.industry, 'food_beverage');

    const withoutIndustry = normalizeResearchBrief(
        { summary: 'Sells tea.' },
        { company: 'Wild Orchard', domain: 'wildorchard.com' }
    );
    assert.equal(withoutIndustry.industry, null);
});

test('formatResearchBriefForPrompt renders sections and skips empty briefs', () => {
    assert.equal(formatResearchBriefForPrompt(null), '');
    assert.equal(formatResearchBriefForPrompt({ summary: '' }), '');

    const block = formatResearchBriefForPrompt({
        company: 'Wild Orchard',
        domain: 'wildorchard.com',
        summary: 'Sells tea.',
        talkingPoints: ['Jeju sourcing'],
        risks: ['Avoid pricing claims'],
        sources: [{ title: 'Site', url: 'https://a.com' }],
        reviewCount: 100,
        estimatedVisitors: 10_000
    });
    assert.ok(block.includes('Company: Wild Orchard (wildorchard.com)'));
    assert.ok(block.includes('Summary: Sells tea.'));
    assert.ok(block.includes('- Jeju sourcing'));
    assert.ok(block.includes('Avoid / be careful with:'));
    assert.ok(block.includes('Published reviews: 100'));
    assert.ok(block.includes('Estimated site visitors'));
    assert.ok(block.includes('10000'));
});

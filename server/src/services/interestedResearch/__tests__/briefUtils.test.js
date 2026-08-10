import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildSerperQueries,
    compactSerperResults,
    extractHomepageSummary,
    formatResearchBriefForPrompt,
    normalizeResearchBrief,
    normalizeResearchIndustry,
    RESEARCH_INDUSTRIES,
    stripHtmlToText
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

test('buildSerperQueries needs a subject and includes news query', () => {
    assert.deepEqual(buildSerperQueries({ companyName: '', domain: '' }), []);
    const queries = buildSerperQueries({ companyName: 'Wild Orchard', domain: 'wildorchard.com' });
    assert.equal(queries.length, 2);
    assert.equal(queries[0].q, 'Wild Orchard wildorchard.com');
    assert.ok(queries[1].q.includes('news'));
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
        sources: [{ title: 'Site', url: 'https://a.com' }]
    });
    assert.ok(block.includes('Company: Wild Orchard (wildorchard.com)'));
    assert.ok(block.includes('Summary: Sells tea.'));
    assert.ok(block.includes('- Jeju sourcing'));
    assert.ok(block.includes('Avoid / be careful with:'));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildSerperQueries,
    compactSerperResults,
    companyNameFromHomepageTitle,
    estimateVisitorsFromReviewCount,
    extractHomepageSummary,
    extractReviewCountFromSerper,
    filterSerperResultsForTarget,
    formatResearchBriefForPrompt,
    isHumanizedDomainCompany,
    isSerperResultAboutTarget,
    normalizeResearchBrief,
    normalizeResearchIndustry,
    normalizeReviewCount,
    registrableSlug,
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

test('buildSerperQueries needs a subject and domain-anchors news + review queries', () => {
    assert.deepEqual(buildSerperQueries({ companyName: '', domain: '' }), []);
    const queries = buildSerperQueries({ companyName: 'Wild Orchard', domain: 'wildorchard.com' });
    assert.equal(queries.length, 3);
    // "Wild Orchard" collapses to the domain slug, so queries stay host-only.
    assert.equal(queries[0].q, 'wildorchard.com');
    assert.ok(queries[1].q.startsWith('wildorchard.com'));
    assert.ok(queries[1].q.includes('news'));
    assert.ok(queries[2].q.includes('Trustpilot'));
    assert.ok(!queries.some((query) => query.q.includes('Titan')));

    const named = buildSerperQueries({ companyName: 'Hand Titan', domain: 'thehandtitan.com' });
    assert.equal(named[0].q, '"Hand Titan" thehandtitan.com');
    assert.equal(named[1].q, 'thehandtitan.com news OR launch OR funding');

    const humanized = buildSerperQueries({ companyName: 'Thehandtitan', domain: 'thehandtitan.com' });
    assert.equal(humanized[0].q, 'thehandtitan.com');
    assert.ok(!humanized.some((query) => /titan/i.test(query.q) && !query.q.includes('thehandtitan.com')));
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
            sources: [{ title: '', url: 'https://wildorchard.com' }, { url: '' }, 'junk']
        },
        { company: 'Wild Orchard', domain: 'wildorchard.com' }
    );
    assert.equal(brief.company, 'Wild Orchard');
    assert.equal(brief.domain, 'wildorchard.com');
    assert.deepEqual(brief.talkingPoints, ['Jeju sourcing', '42']);
    assert.deepEqual(brief.sources, [{ title: 'https://wildorchard.com', url: 'https://wildorchard.com' }]);
    assert.equal(brief.reviewCount, null);
    assert.equal(brief.estimatedVisitors, null);
});

test('normalizeResearchBrief derives estimatedVisitors from grounded Serper review counts only', () => {
    const invented = normalizeResearchBrief(
        { summary: 'Sells tea.', reviewCount: 250 },
        { company: 'Wild Orchard', domain: 'wildorchard.com' }
    );
    assert.equal(invented.reviewCount, null);
    assert.equal(invented.estimatedVisitors, null);

    const fromFallback = normalizeResearchBrief(
        { summary: 'Sells tea.', reviewCount: 999 },
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

test('registrableSlug and humanized-domain company detection', () => {
    assert.equal(registrableSlug('thehandtitan.com'), 'thehandtitan');
    assert.equal(registrableSlug('www.wildorchard.com'), 'wildorchard');
    assert.equal(registrableSlug('shop.example.co.uk'), 'example');
    assert.equal(isHumanizedDomainCompany('Thehandtitan', 'thehandtitan.com'), true);
    assert.equal(isHumanizedDomainCompany('Wild Orchard', 'wildorchard.com'), true);
    assert.equal(isHumanizedDomainCompany('Hand Titan', 'thehandtitan.com'), false);
});

test('companyNameFromHomepageTitle takes the brand clause', () => {
    assert.equal(
        companyNameFromHomepageTitle('Hand Titan, natural trigger point thumb relief device', 'Thehandtitan'),
        'Hand Titan'
    );
    assert.equal(
        companyNameFromHomepageTitle('Wild Orchard | Regenerative Tea', 'Fallback'),
        'Wild Orchard'
    );
    assert.equal(companyNameFromHomepageTitle('', 'Thehandtitan'), 'Thehandtitan');
});

test('filterSerperResultsForTarget drops similarly named products like Titan gloves', () => {
    const target = { companyName: 'Thehandtitan', domain: 'thehandtitan.com' };
    const hits = [
        {
            title: 'Hand Titan — Protect the hands that built your career',
            link: 'https://thehandtitan.com/',
            snippet: 'Thumb relief device'
        },
        {
            title: 'Hand Titan | Thumb Relief Tool (@thehandtitan) - Instagram',
            link: 'https://www.instagram.com/thehandtitan/?hl=en',
            snippet: 'Built by a 15-yr massage therapist'
        },
        {
            title: 'Volt Heat TITAN Men 7v Leather Heated Gloves | Buy Now',
            link: 'https://voltheat.com/products/titan-men-s-7v-leather-heated-gloves',
            snippet: 'Customer Reviews. 4.04 out of 5. Based on 23 reviews'
        },
        {
            title: 'Titan Wrist Brace - Amazon.com',
            link: 'https://www.amazon.com/titan-wrist-brace/s?k=titan+wrist+brace',
            snippet: 'Customer Reviews'
        },
        {
            title: 'Has anyone tried this hand recovery device called the “Hand Titan”?',
            link: 'https://www.reddit.com/r/MassageTherapists/comments/1rx80bp/has_anyone_tried_this_hand_recovery_device_called/',
            snippet: 'It\'s ok- not really worth the money.'
        }
    ];

    assert.equal(isSerperResultAboutTarget(hits[0], target), true);
    assert.equal(isSerperResultAboutTarget(hits[1], target), true);
    assert.equal(isSerperResultAboutTarget(hits[2], target), false);
    assert.equal(isSerperResultAboutTarget(hits[3], target), false);
    assert.equal(isSerperResultAboutTarget(hits[4], target), false);

    const kept = filterSerperResultsForTarget(hits, target);
    assert.deepEqual(kept.map((hit) => hit.link), [hits[0].link, hits[1].link]);

    const withBrand = filterSerperResultsForTarget(hits, {
        companyName: 'Hand Titan',
        domain: 'thehandtitan.com'
    });
    assert.equal(withBrand.length, 3);
    assert.ok(withBrand.some((hit) => hit.link.includes('reddit.com')));
    assert.ok(!withBrand.some((hit) => hit.link.includes('voltheat.com')));
});

test('normalizeResearchBrief drops off-target sources and ignores LLM review counts', () => {
    const brief = normalizeResearchBrief(
        {
            summary: 'Sells a thumb relief device.',
            reviewCount: 23,
            sources: [
                { title: 'Hand Titan', url: 'https://thehandtitan.com/' },
                { title: 'Volt Heat TITAN gloves', url: 'https://voltheat.com/products/titan-men-s-7v-leather-heated-gloves' }
            ]
        },
        { company: 'Hand Titan', domain: 'thehandtitan.com', fallbackReviewCount: 23 }
    );
    assert.deepEqual(brief.sources.map((source) => source.url), ['https://thehandtitan.com/']);
    // fallback 23 is still accepted here because the caller is responsible for
    // grounding it; the Hand Titan fixture below proves extract+filter together.
    assert.equal(brief.reviewCount, 23);

    const noGrounding = normalizeResearchBrief(
        {
            summary: 'Sells a thumb relief device.',
            reviewCount: 23,
            sources: [{ title: 'Gloves', url: 'https://voltheat.com/products/titan' }]
        },
        { company: 'Hand Titan', domain: 'thehandtitan.com' }
    );
    assert.deepEqual(noGrounding.sources, []);
    assert.equal(noGrounding.reviewCount, null);
});

test('extractReviewCountFromSerper does not see dropped Titan-glove hits after filtering', () => {
    const mixed = [
        {
            title: 'Hand Titan',
            link: 'https://thehandtitan.com/',
            snippet: 'Portable thumb relief'
        },
        {
            title: 'Volt Heat TITAN gloves',
            link: 'https://voltheat.com/products/titan-men-s-7v-leather-heated-gloves',
            snippet: 'Based on 23 reviews'
        }
    ];
    const filtered = filterSerperResultsForTarget(mixed, {
        companyName: 'Thehandtitan',
        domain: 'thehandtitan.com'
    });
    assert.equal(extractReviewCountFromSerper(mixed), 23);
    assert.equal(extractReviewCountFromSerper(filtered), null);
});

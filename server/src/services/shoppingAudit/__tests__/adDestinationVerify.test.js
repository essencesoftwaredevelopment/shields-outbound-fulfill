import test from 'node:test';
import assert from 'node:assert/strict';
import {
    extractVisitSiteHref,
    urlHostMatchesDomain,
    verifyAdDestinationScrape
} from '../adDestinationVerify.js';

const GYMSHARK_VISIT_SITE_ANCHOR = [
    '<a aria-describedby="x" href="https://www.gymshark.com/products/gymshark-x-bratz-leggings?srsltid=abc"',
    ' target="_blank" data-hveid="318">',
    '<div class="SYULCe"><div class="niO4u">Visit site</div></div>',
    '</a>'
].join('');

test('extractVisitSiteHref reads href from Visit site anchor', () => {
    const href = extractVisitSiteHref(GYMSHARK_VISIT_SITE_ANCHOR);
    assert.equal(href, 'https://www.gymshark.com/products/gymshark-x-bratz-leggings?srsltid=abc');
});

test('extractVisitSiteHref falls back to embedded page JSON', () => {
    const html = '[[[null,"Visit site","https://www.gymshark.com/products/example?srsltid\\u003dabc"]]]';
    const href = extractVisitSiteHref(html);
    assert.equal(href, 'https://www.gymshark.com/products/example?srsltid=abc');
});

test('verifyAdDestinationScrape passes when Visit site href matches merchant domain', () => {
    const verdict = verifyAdDestinationScrape({
        success: true,
        html: GYMSHARK_VISIT_SITE_ANCHOR,
        url: 'https://www.google.com/search?ibp=oshop'
    }, 'gymshark.com');

    assert.equal(verdict.verified, true);
    assert.equal(verdict.reason, 'visit_site_href');
    assert.match(verdict.finalUrl, /^https:\/\/www\.gymshark\.com\//);
});

test('verifyAdDestinationScrape fails when Visit site href points elsewhere', () => {
    const html = '<a href="https://evil.example.com/p"><span>Visit site</span></a>';
    const verdict = verifyAdDestinationScrape({
        success: true,
        html,
        url: 'https://www.google.com/search?ibp=oshop'
    }, 'gymshark.com');

    assert.equal(verdict.verified, false);
    assert.equal(verdict.reason, 'visit_site_domain_mismatch');
    assert.equal(verdict.finalUrl, 'https://evil.example.com/p');
});

test('verifyAdDestinationScrape fails when Visit site button is missing', () => {
    const verdict = verifyAdDestinationScrape({
        success: true,
        html: '<a href="https://www.gymshark.com/">Buy now</a>',
        url: 'https://www.google.com/search?ibp=oshop'
    }, 'gymshark.com');

    assert.equal(verdict.verified, false);
    assert.equal(verdict.reason, 'visit_site_not_found');
});

test('urlHostMatchesDomain accepts www subdomain', () => {
    assert.equal(
        urlHostMatchesDomain('https://www.gymshark.com/products/x', 'gymshark.com'),
        true
    );
});

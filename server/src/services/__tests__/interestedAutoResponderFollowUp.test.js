import test from 'node:test';
import assert from 'node:assert/strict';
import {
    isEligiblePostAutoresponderReplyCategory,
    leadReplyMessageAsksOrEngages,
    resolveInstantlyReplySubject,
    humanizeDomainAsCompanyName,
    buildActiveFungiStoryUrl,
    applyActiveFungiStoryUrlToTemplateVars
} from '../interestedAutoResponder.js';

test('isEligiblePostAutoresponderReplyCategory accepts positive and neutral while interested', () => {
    assert.equal(isEligiblePostAutoresponderReplyCategory('positive', 1), true);
    assert.equal(isEligiblePostAutoresponderReplyCategory('neutral', 1), true);
    assert.equal(isEligiblePostAutoresponderReplyCategory('other', 1), true);
});

test('isEligiblePostAutoresponderReplyCategory rejects negative or non-interested leads', () => {
    assert.equal(isEligiblePostAutoresponderReplyCategory('negative', 1), false);
    assert.equal(isEligiblePostAutoresponderReplyCategory('positive', -1), false);
    assert.equal(isEligiblePostAutoresponderReplyCategory('positive', null), false);
});

test('leadReplyMessageAsksOrEngages detects questions and substantive follow-ups', () => {
    const billFollowUp = [
        'She will not be on the call. We get these at least 30 times per week for',
        'every aspect of marketing. I cannot get her involved in this until I have',
        'an idea what it does then she decides if we wants a follow up'
    ].join('\n');

    assert.equal(leadReplyMessageAsksOrEngages('Can you send more details?'), true);
    assert.equal(leadReplyMessageAsksOrEngages(billFollowUp), true);
    assert.equal(leadReplyMessageAsksOrEngages('Thanks!'), false);
    assert.equal(leadReplyMessageAsksOrEngages('ok'), false);
});

test('resolveInstantlyReplySubject always returns a non-empty subject for Instantly', () => {
    assert.equal(resolveInstantlyReplySubject('Re: Demo request'), 'Re: Demo request');
    assert.equal(resolveInstantlyReplySubject('  '), 'Re:');
    assert.equal(resolveInstantlyReplySubject(null), 'Re:');
});

test('humanizeDomainAsCompanyName turns a domain into a display label', () => {
    assert.equal(humanizeDomainAsCompanyName('wildorchard.com'), 'Wildorchard');
    assert.equal(humanizeDomainAsCompanyName('naked-sundays.com'), 'Naked Sundays');
    assert.equal(humanizeDomainAsCompanyName(null), '');
});

test('buildActiveFungiStoryUrl fills name, company, and favicon logo', () => {
    const url = new URL(buildActiveFungiStoryUrl({
        name: 'Jason',
        company: 'Merged',
        domain: 'merged.ca'
    }));
    assert.equal(url.origin + url.pathname, 'https://active-fungi.vercel.app/');
    assert.equal(url.searchParams.get('name'), 'Jason');
    assert.equal(url.searchParams.get('company'), 'Merged');
    assert.equal(
        url.searchParams.get('logo'),
        'https://www.google.com/s2/favicons?domain=merged.ca&sz=128'
    );
    assert.equal(url.searchParams.get('goal'), null);
    assert.equal(url.searchParams.get('cta'), null);
});

test('buildActiveFungiStoryUrl humanizes company from domain and accepts goal', () => {
    const url = new URL(buildActiveFungiStoryUrl({
        name: 'Erin',
        domain: 'maulirituals.com',
        goal: 'focus'
    }));
    assert.equal(url.searchParams.get('company'), 'Maulirituals');
    assert.equal(url.searchParams.get('goal'), 'focus');
});

test('applyActiveFungiStoryUrlToTemplateVars adds story_url from template fields', () => {
    const vars = applyActiveFungiStoryUrlToTemplateVars(
        { first_name: 'Jason', companyName: 'Merged', company_domain: 'merged.ca' },
        {}
    );
    assert.match(vars.story_url, /^https:\/\/active-fungi\.vercel\.app\/\?/);
    assert.match(vars.story_url, /name=Jason/);
    assert.match(vars.story_url, /company=Merged/);
});

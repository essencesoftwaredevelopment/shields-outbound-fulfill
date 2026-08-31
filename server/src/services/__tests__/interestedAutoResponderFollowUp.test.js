import test from 'node:test';
import assert from 'node:assert/strict';
import {
    isEligiblePostAutoresponderReplyCategory,
    leadReplyMessageAsksOrEngages,
    resolveInstantlyReplySubject,
    humanizeDomainAsCompanyName,
    buildActiveFungiStoryUrl,
    applyActiveFungiStoryUrlToTemplateVars,
    normalizeRegenerateInstructions,
    prependPriorityInstructions,
    resolveLeadWebsite,
    applyReplyLinkPlaceholders,
    withAuditUrlVars,
    buildVulcanShoppingAuditUrl,
    campaignUsesEssenceStorePreview,
    resolveReplyPreviewBehavior
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

test('normalizeRegenerateInstructions trims, drops blanks, and caps length', () => {
    assert.equal(normalizeRegenerateInstructions('  keep it shorter  '), 'keep it shorter');
    assert.equal(normalizeRegenerateInstructions('   '), null);
    assert.equal(normalizeRegenerateInstructions(null), null);
    const long = 'x'.repeat(5000);
    assert.equal(normalizeRegenerateInstructions(long)?.length, 4000);
});

test('prependPriorityInstructions puts reviewer notes above the campaign system prompt', () => {
    const result = prependPriorityInstructions('Be a helpful sales assistant.', 'Keep it under 80 words.');
    assert.match(result, /^HIGHEST PRIORITY/);
    assert.ok(result.indexOf('Keep it under 80 words.') < result.indexOf('Be a helpful sales assistant.'));
    assert.equal(
        prependPriorityInstructions('Be a helpful sales assistant.', '   '),
        'Be a helpful sales assistant.'
    );
});

test('resolveLeadWebsite prefers company domain then falls back to email domain', () => {
    assert.deepEqual(
        resolveLeadWebsite('wildorchard.com', 'erin@gmail.com'),
        { domain: 'wildorchard.com', url: 'https://wildorchard.com' }
    );
    assert.deepEqual(
        resolveLeadWebsite(null, 'jason@merged.ca'),
        { domain: 'merged.ca', url: 'https://merged.ca' }
    );
    assert.deepEqual(
        resolveLeadWebsite('https://www.naked-sundays.com/about', 'x@example.com'),
        { domain: 'naked-sundays.com', url: 'https://naked-sundays.com' }
    );
    assert.deepEqual(resolveLeadWebsite(null, 'not-an-email'), { domain: null, url: null });
});

test('applyReplyLinkPlaceholders swaps AUDIT_URL tokens for the real audit href', () => {
    const auditUrl = 'https://vulcan-shopping-audit.vercel.app/?domain=tenfoldfairtrade.com';
    const html = '<p>Hi Martha, sure, here it is: <a href="[AUDIT_URL]">take a look</a></p>';
    assert.equal(
        applyReplyLinkPlaceholders(html, { auditUrl }),
        '<p>Hi Martha, sure, here it is: <a href="https://vulcan-shopping-audit.vercel.app/?domain=tenfoldfairtrade.com">take a look</a></p>'
    );
    assert.equal(
        applyReplyLinkPlaceholders('<a href="AUDIT_URL">take a look</a>', { auditUrl }),
        `<a href="${auditUrl}">take a look</a>`
    );
    assert.equal(
        applyReplyLinkPlaceholders(
            '<a href="https://shields-outbound-fulfill.vercel.app/interested-autoresponder/[AUDIT_URL]">take a look</a>',
            { auditUrl }
        ),
        `<a href="${auditUrl}">take a look</a>`
    );
    assert.equal(applyReplyLinkPlaceholders(html, {}), html);
    assert.equal(applyReplyLinkPlaceholders(html, { auditUrl: '' }), html);
    assert.equal(
        applyReplyLinkPlaceholders('<p><a href="">take a look</a></p>', { auditUrl }),
        `<p><a href="${auditUrl}">take a look</a></p>`
    );
    const essencePreview = 'https://essence-ai.app/preview-popup?domain=nomad.coffee';
    assert.equal(
        applyReplyLinkPlaceholders('<a href="PREVIEW_URL">Take a look here</a>', { auditUrl: essencePreview }),
        `<a href="${essencePreview}">Take a look here</a>`
    );
});

test('applyReplyLinkPlaceholders leaves real vulcan audit links untouched', () => {
    const auditUrl = 'https://vulcan-shopping-audit.vercel.app/?domain=voomcart.com';
    const html = `<a href="${auditUrl}">take a look</a>`;
    assert.equal(applyReplyLinkPlaceholders(html, { auditUrl }), html);
});

test('withAuditUrlVars adds audit_url for {{audit_url}} prompt substitution', () => {
    assert.deepEqual(
        withAuditUrlVars({ first_name: 'Martha' }, 'https://vulcan-shopping-audit.vercel.app/?domain=tenfoldfairtrade.com'),
        {
            first_name: 'Martha',
            audit_url: 'https://vulcan-shopping-audit.vercel.app/?domain=tenfoldfairtrade.com'
        }
    );
    assert.deepEqual(withAuditUrlVars({ first_name: 'Martha' }, null), { first_name: 'Martha' });
});

test('campaignUsesEssenceStorePreview is opt-in via PREVIEW_URL or campaign name', () => {
    assert.equal(
        campaignUsesEssenceStorePreview({
            campaignName: 'ESSENCE AI Email Generation',
            systemPrompt: 'Send PREVIEW_URL only if they ask to see it first.'
        }),
        true
    );
    assert.equal(
        campaignUsesEssenceStorePreview({
            campaignName: 'ESSENCE AI Email Generation',
            systemPrompt: 'Book a call. No preview placeholder.'
        }),
        true
    );
    assert.equal(
        campaignUsesEssenceStorePreview({
            campaignName: 'Cut Klaviyo Bill',
            systemPrompt: 'Default CTA is Calendly. Use PREFILLED_CALENDLY_URL. No store preview.'
        }),
        false
    );
    assert.equal(
        campaignUsesEssenceStorePreview({
            campaignName: 'Cut Klaviyo Bill',
            systemPrompt: 'https://calendly.com/essencesoftwaredevelopment/essence-retention-meeting'
        }),
        false
    );
});

test('resolveReplyPreviewBehavior skips store preview for Cut Klaviyo Bill', () => {
    const essenceSettings = { shoppingAuditReply: false, useActiveFungiStoryUrl: false, skipPopupPreview: false };
    const klaviyo = resolveReplyPreviewBehavior({
        settings: essenceSettings,
        campaignName: 'Cut Klaviyo Bill',
        systemPrompt: 'Use PREFILLED_CALENDLY_URL as the only CTA.'
    });
    assert.equal(klaviyo.skipPopupPreview, true);
    assert.equal(klaviyo.systemPromptOwnsCta, true);
    assert.equal(klaviyo.usesEssenceStorePreview, false);

    const essenceAi = resolveReplyPreviewBehavior({
        settings: essenceSettings,
        campaignName: 'ESSENCE AI Email Generation',
        systemPrompt: 'Optional CTA: PREVIEW_URL'
    });
    assert.equal(essenceAi.skipPopupPreview, false);
    assert.equal(essenceAi.systemPromptOwnsCta, false);
    assert.equal(essenceAi.usesEssenceStorePreview, true);

    const vulcan = resolveReplyPreviewBehavior({
        settings: { shoppingAuditReply: true, useActiveFungiStoryUrl: false, skipPopupPreview: false },
        campaignName: 'General Ads',
        systemPrompt: 'Use AUDIT_URL from the user message.'
    });
    assert.equal(vulcan.skipPopupPreview, false);
    assert.equal(vulcan.systemPromptOwnsCta, false);
    assert.equal(vulcan.useShoppingAuditReply, true);
});

test('buildVulcanShoppingAuditUrl matches the public audit page', () => {
    assert.equal(
        buildVulcanShoppingAuditUrl('tenfoldfairtrade.com'),
        'https://vulcan-shopping-audit.vercel.app/?domain=tenfoldfairtrade.com'
    );
    assert.equal(buildVulcanShoppingAuditUrl('not a domain'), null);
});

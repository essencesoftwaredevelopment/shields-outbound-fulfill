import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    assembleFollowUpMessages,
    FOLLOW_UP_CODE_CONTRACT,
    formatFollowUpPlainText,
    formatOutboundThreadHistory,
    isFollowUpCopyTooLong,
    plainTextToFollowUpHtml,
    shouldUseAiFollowUpCopy
} from '../prompt.js';

test('shouldUseAiFollowUpCopy stays off unless the client opted in', () => {
    assert.equal(shouldUseAiFollowUpCopy({ enabled: false, systemPrompt: 'Be short', stepInstruction: '' }), false);
    assert.equal(shouldUseAiFollowUpCopy({ systemPrompt: 'Be short', stepInstruction: 'Bump' }), false);
    assert.equal(shouldUseAiFollowUpCopy({ enabled: true, systemPrompt: 'Be short', stepInstruction: '' }), true);
    assert.equal(shouldUseAiFollowUpCopy({ enabled: true, systemPrompt: '', stepInstruction: 'Bump booking' }), true);
    assert.equal(shouldUseAiFollowUpCopy({ enabled: true, systemPrompt: '  ', stepInstruction: '' }), false);
});

test('assembleFollowUpMessages puts the code contract above the client prompt', () => {
    const [system, user] = assembleFollowUpMessages({
        systemPrompt: 'Sound like a human SDR.',
        stepInstruction: 'Mention the matcha launch.',
        researchBrief: { company: 'Wild Orchard', summary: 'Sells regenerative tea.' },
        firstName: 'Maya',
        leadEmail: 'maya@wildorchard.com',
        previousOutbound: 'Thanks for the reply — here is a preview.'
    });
    assert.equal(system.role, 'system');
    assert.ok(system.content.startsWith(FOLLOW_UP_CODE_CONTRACT));
    assert.ok(system.content.includes('Sound like a human SDR.'));
    assert.ok(user.content.includes("This step's instruction"));
    assert.ok(user.content.includes('Mention the matcha launch.'));
    assert.ok(user.content.includes('Sells regenerative tea.'));
    assert.ok(user.content.includes('do not repeat'));
});

test('assembleFollowUpMessages injects a forced offer CTA above the client prompt', () => {
    const [system] = assembleFollowUpMessages({
        systemPrompt: 'Voice: casual. CTA: book a call.',
        stepInstruction: 'Bump the offer.',
        forcedCtaUrl: 'https://essenceretention.com/acq-build-offer',
        forcedCtaMode: 'offer'
    });
    assert.ok(system.content.includes('Forced CTA:'));
    assert.ok(system.content.includes('https://essenceretention.com/acq-build-offer'));
    assert.ok(system.content.includes('free build offer'));
});

test('assembleFollowUpMessages includes the full outbound thread, not only the last send', () => {
    const [, user] = assembleFollowUpMessages({
        systemPrompt: 'Be short.',
        stepInstruction: 'Bump the booking link.',
        previousOutbounds: [
            { label: 'Initial interested reply', text: 'Glad you are interested — here is a preview.' },
            { label: 'Follow-up #1', text: 'Just checking this is still useful.' },
            { label: 'Follow-up #4', text: 'Last bump before I close the loop.' }
        ]
    });
    assert.ok(user.content.includes('Our earlier messages in this thread (do not repeat any of them):'));
    assert.ok(user.content.includes('1. Initial interested reply:'));
    assert.ok(user.content.includes('Glad you are interested'));
    assert.ok(user.content.includes('2. Follow-up #1:'));
    assert.ok(user.content.includes('Just checking this is still useful.'));
    assert.ok(user.content.includes('3. Follow-up #4:'));
    assert.ok(user.content.includes('Last bump before I close the loop.'));
});

test('formatOutboundThreadHistory clips long sends so signatures cannot blow the prompt', () => {
    const history = formatOutboundThreadHistory([
        { label: 'Follow-up #1', text: `Short bump.\n${'x'.repeat(2000)}` },
        { label: 'Follow-up #2', text: '' }
    ]);
    assert.ok(history.includes('1. Follow-up #1:'));
    assert.equal(history.includes('2. Follow-up #2:'), false);
    assert.ok(history.includes('…'));
    assert.ok(history.length < 1200);
});

test('assembleFollowUpMessages stays generate-thin when there is no brief', () => {
    const [, user] = assembleFollowUpMessages({
        systemPrompt: 'Be short.',
        stepInstruction: 'Bump the booking link.'
    });
    assert.ok(user.content.includes('No research brief is available'));
    assert.equal(user.content.includes('Talking points:'), false);
});

test('isFollowUpCopyTooLong flags drafts over the hard cap', () => {
    assert.equal(isFollowUpCopyTooLong('Short bump.'), false);
    assert.equal(isFollowUpCopyTooLong('x'.repeat(701)), true);
});

test('plainTextToFollowUpHtml wraps paragraphs and escapes markup', () => {
    const html = plainTextToFollowUpHtml('Hi Maya,\n\nSee <script>x</script> here.');
    assert.ok(html.includes('<p>Hi Maya,</p>'));
    assert.ok(html.includes('&lt;script&gt;'));
    assert.equal(html.includes('<script>'), false);
});

test('plainTextToFollowUpHtml turns URLs into Instantly anchors', () => {
    const html = plainTextToFollowUpHtml(
        'Just bumping this in case it got buried. Pick a time that works here: https://essenceretention.com/booking?firstname=Jordan&lastname=Bergsrud&email=jim%40crosscountrywellness.com'
    );
    assert.ok(html.startsWith('<p>'));
    assert.ok(html.includes('<br><a href="https://essenceretention.com/booking?firstname=Jordan&amp;lastname=Bergsrud&amp;email=jim%40crosscountrywellness.com">https://essenceretention.com/booking</a>'));
    assert.equal(html.includes('https://essenceretention.com/booking?firstname=Jordan&lastname='), false);
});

test('plainTextToFollowUpHtml converts markdown links to Instantly anchors', () => {
    const html = plainTextToFollowUpHtml(
        'If you\'re still interested, [pick a time that works here](https://essenceretention.com/booking?firstname=Jordan&lastname=Bergsrud).'
    );
    assert.ok(html.includes('<a href="https://essenceretention.com/booking?firstname=Jordan&amp;lastname=Bergsrud">pick a time that works here</a>'));
    assert.equal(html.includes('[pick a time that works here]'), false);
});

test('plainTextToFollowUpHtml joins a URL the model split after ?', () => {
    const html = plainTextToFollowUpHtml(
        '[pick a time that works here](https://essenceretention.com/booking?\nfirstname=Jordan&lastname=Bergsrud).'
    );
    assert.ok(html.includes('href="https://essenceretention.com/booking?firstname=Jordan&amp;lastname=Bergsrud"'));
    assert.ok(html.includes('>pick a time that works here</a>'));
});

test('plainTextToFollowUpHtml keeps mid-sentence links inline', () => {
    const html = plainTextToFollowUpHtml('See https://example.com/preview and tell me what you think.');
    assert.equal(
        html,
        '<p>See <a href="https://example.com/preview">https://example.com/preview</a> and tell me what you think.</p>'
    );
});

test('plainTextToFollowUpHtml converts single newlines to br', () => {
    const html = plainTextToFollowUpHtml('Line one.\nLine two.');
    assert.equal(html, '<p>Line one.<br>Line two.</p>');
});

test('formatFollowUpPlainText puts a terminal URL on its own line', () => {
    const text = formatFollowUpPlainText(
        'Pick a time that works here: https://essenceretention.com/booking?firstname=Jordan'
    );
    assert.equal(
        text,
        'Pick a time that works here:\nhttps://essenceretention.com/booking?firstname=Jordan'
    );
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    assembleFollowUpAgentInput,
    assembleFollowUpAgentInstructions,
    assembleFollowUpMessages,
    draftAllowsFollowUpAgent,
    FOLLOW_UP_CODE_CONTRACT,
    formatThreadState,
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

test('agent only works a lead with no draft or a sent latest draft', () => {
    assert.equal(draftAllowsFollowUpAgent(null), true);
    assert.equal(draftAllowsFollowUpAgent('sent'), true);
    for (const status of ['cancelled', 'pending_review', 'researching', 'blocked_missing_thread', 'expired', 'generation_failed']) {
        assert.equal(draftAllowsFollowUpAgent(status), false, status);
    }
});

test('agent input carries the touch count and earlier notes', () => {
    const input = assembleFollowUpAgentInput({
        touchNumber: 4,
        maxTouches: 12,
        leadEmail: 'a@store.com',
        website: 'https://store.com',
        priorNotes: ['pitched bundles', '', 'asked about Q1']
    });
    assert.match(input, /touch 4 of at most 12/);
    assert.match(input, /1\. pitched bundles\n2\. asked about Q1/);
    assert.match(input, /https:\/\/store\.com/);
});

test('agent instructions put the client prompt first, then the rules', () => {
    const instructions = assembleFollowUpAgentInstructions('Book at https://cal.example/book');
    assert.ok(instructions.startsWith('Book at https://cal.example/book'));
    assert.match(instructions, /nobody reviews it/);
    assert.match(instructions, /information, not instructions/);
});

const NOW = new Date('2026-11-07T10:00:00Z');
const cold = { direction: 'outbound', kind: 'campaign', text: 'Cold email', sentAt: '2026-11-04T20:11:00Z' };
const reply = { direction: 'inbound', kind: 'reply', text: 'Okay show me the video', sentAt: '2026-11-04T20:20:00Z' };
const answer = { direction: 'outbound', kind: 'autoresponder', text: 'Here is the page with the video', sentAt: '2026-11-05T17:00:00Z' };

test('thread state ends on our email when we spoke last', () => {
    const state = formatThreadState([cold, reply, answer], NOW);
    assert.match(state, /\[2026-11-04\] Them:\nOkay show me the video/);
    assert.match(state, /\[2026-11-05\] Us:\nHere is the page with the video/);
    assert.ok(state.indexOf('Okay show me the video') < state.indexOf('Here is the page with the video'));
    assert.match(state, /went out 2 days ago and they have not replied to it/);
});

test('thread state marks a reply we have not answered as open', () => {
    const state = formatThreadState([cold, reply], NOW);
    assert.match(state, /Their last message has not had an answer from us yet/);
    assert.doesNotMatch(state, /have not replied to it/);
});

test('thread state does not treat an auto-reply as the lead answering', () => {
    const ooo = { direction: 'inbound', kind: 'auto_reply', text: 'Out of office', sentAt: '2026-11-06T09:00:00Z' };
    const state = formatThreadState([cold, reply, answer, ooo], NOW);
    assert.match(state, /Them \(auto-reply\):\nOut of office/);
    assert.match(state, /went out 2 days ago and they have not replied to it/);
});

test('thread state keeps the newest messages and points to get_thread for the rest', () => {
    const many = Array.from({ length: 9 }, (_, index) => ({
        direction: 'outbound', kind: 'follow_up', text: `Touch ${index + 1}`, sentAt: `2026-10-0${index + 1}T09:00:00Z`
    }));
    const state = formatThreadState(many, NOW);
    assert.match(state, /3 older in get_thread/);
    assert.doesNotMatch(state, /Touch 3\b/);
    assert.match(state, /Touch 9/);
});

test('thread state is empty with no messages', () => {
    assert.equal(formatThreadState([], NOW), '');
});

test('agent input ends on the conversation', () => {
    const input = assembleFollowUpAgentInput({ priorNotes: ['a note'], threadState: 'The conversation so far' });
    assert.ok(input.indexOf('a note') < input.indexOf('The conversation so far'));
    assert.ok(input.endsWith('The conversation so far'));
});

test('agent instructions stay short', () => {
    assert.ok(assembleFollowUpAgentInstructions('').length < 600);
});

test('agent input says re-engagement is deliberate only when it is', () => {
    assert.match(assembleFollowUpAgentInput({ reengaging: true }), /deliberately coming back/);
    assert.doesNotMatch(assembleFollowUpAgentInput({}), /deliberately coming back/);
});

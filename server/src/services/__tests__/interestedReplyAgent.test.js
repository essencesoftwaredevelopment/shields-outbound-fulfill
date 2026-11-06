import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    assertPublicUrl,
    buildAgentLeadProfile,
    buildReplyAgentTools,
    findUnapprovedLinks,
    fitThreadToOutputLimit,
    isPrivateAddress,
    linkKey,
    runReplyAgent,
    serializeAgentTraceForReview
} from '../interestedReplyAgent.js';

/** Scripted stand-in for openai.responses.create — one response per call. */
function fakeClient(script) {
    const requests = [];
    return {
        requests,
        responses: {
            create: async (body) => {
                requests.push(body);
                const next = script[requests.length - 1];
                if (!next) throw new Error(`unexpected request #${requests.length}`);
                return { id: `resp_${requests.length}`, model: 'gpt-test', usage: { input_tokens: 10, output_tokens: 5 }, ...next };
            }
        }
    };
}

const call = (name, args = {}, id = name) => ({
    type: 'function_call',
    name,
    call_id: `call_${id}`,
    arguments: JSON.stringify(args)
});

describe('link provenance', () => {
    it('keys links by host and path, ignoring www, query and trailing slash', () => {
        assert.equal(linkKey('https://www.Example.com/book/?a=1&amp;b=2#x'), 'example.com/book');
        assert.equal(linkKey('mailto:x@example.com'), null);
    });

    it('flags only links that never appeared in an allowed source', () => {
        const allowed = new Set(['calendly.com/essence/demo', 'shop.com']);
        const reply = '<a href="https://calendly.com/essence/demo?email=a">Book</a> or see https://shop.com/. Also https://made-up.io/x.';
        assert.deepEqual(findUnapprovedLinks(reply, allowed), ['https://made-up.io/x']);
    });
});

describe('assertPublicUrl', () => {
    const lookup = (address) => async () => [{ address }];

    it('allows public hosts', async () => {
        const url = await assertPublicUrl('https://shop.com/about', { lookup: lookup('93.184.216.34') });
        assert.equal(url.hostname, 'shop.com');
    });

    it('blocks private, loopback and non-http targets', async () => {
        await assert.rejects(assertPublicUrl('http://shop.com', { lookup: lookup('10.0.0.5') }), /blocked_address/);
        await assert.rejects(assertPublicUrl('http://127.0.0.1:4000/api'), /blocked_address/);
        await assert.rejects(assertPublicUrl('http://localhost/'), /blocked_host/);
        await assert.rejects(assertPublicUrl('file:///etc/passwd'), /unsupported_protocol/);
        assert.equal(isPrivateAddress('169.254.169.254'), true);
        assert.equal(isPrivateAddress('::ffff:192.168.1.1'), true);
        assert.equal(isPrivateAddress('8.8.8.8'), false);
    });
});

describe('buildReplyAgentTools', () => {
    it('offers only the tools the run can back', () => {
        const names = (tools) => tools.map((tool) => tool.name);
        assert.deepEqual(names(buildReplyAgentTools()), ['fetch_page', 'submit_draft']);
        assert.deepEqual(
            names(buildReplyAgentTools({ webSearch: true, thread: true, leadProfile: true, storePreview: true })),
            ['web_search', 'fetch_page', 'get_thread', 'get_lead_profile', 'generate_store_preview', 'submit_draft']
        );
    });
});

describe('buildAgentLeadProfile', () => {
    it('keeps non-empty scalars and caps long values', () => {
        const profile = buildAgentLeadProfile({ first_name: 'Ana', empty: ' ', nested: { a: 1 }, bio: 'x'.repeat(600) });
        assert.equal(profile.first_name, 'Ana');
        assert.equal('empty' in profile, false);
        assert.equal('nested' in profile, false);
        assert.equal(profile.bio.length, 501);
    });
});

describe('runReplyAgent', () => {
    it('runs the tools the model picks, then returns its submitted draft', async () => {
        const client = fakeClient([
            { output: [call('get_thread'), call('get_lead_profile')] },
            { output: [call('submit_draft', { reply: '<p>Hi Ana</p>', notes_for_reviewer: 'Read the thread.' })] }
        ]);
        const result = await runReplyAgent({
            client,
            instructions: 'Campaign prompt',
            input: 'Lead said yes',
            loadThread: async () => [{ direction: 'inbound', from: 'a@shop.com', sentAt: null, subject: 'Re', text: 'Yes!' }],
            leadProfile: { first_name: 'Ana' }
        });

        assert.equal(result.reply, '<p>Hi Ana</p>');
        assert.equal(result.notes, 'Read the thread.');
        assert.deepEqual(result.trace.steps.map((step) => step.tool).sort(), ['get_lead_profile', 'get_thread', 'submit_draft']);
        assert.equal(result.trace.turns, 2);

        const second = client.requests[1];
        assert.equal(second.previous_response_id, 'resp_1');
        assert.equal(second.instructions, 'Campaign prompt');
        assert.deepEqual(second.input.map((item) => item.call_id).sort(), ['call_get_lead_profile', 'call_get_thread']);
        assert.match(second.input.find((item) => item.call_id === 'call_get_thread').output, /Yes!/);
        assert.equal(second.tool_choice, 'auto');
    });

    it('sends invented links back once, and accepts links that came from a tool', async () => {
        const client = fakeClient([
            { output: [call('submit_draft', { reply: 'See https://made-up.io', notes_for_reviewer: '' }, 'a')] },
            { output: [call('generate_store_preview', { reason: 'asked for demo' })] },
            { output: [call('submit_draft', { reply: 'See https://essence-ai.app/preview-popup?domain=shop.com', notes_for_reviewer: '' }, 'b')] }
        ]);
        const result = await runReplyAgent({
            client,
            instructions: 'p',
            input: 'i',
            generateStorePreview: async () => 'https://essence-ai.app/preview-popup?domain=shop.com'
        });

        assert.match(client.requests[1].input[0].output, /made-up\.io/);
        assert.equal(result.previewUrl, 'https://essence-ai.app/preview-popup?domain=shop.com');
        assert.match(result.reply, /preview-popup/);
        assert.deepEqual(result.trace.unapprovedLinks, []);
    });

    it('forces submit_draft on the last turn and accepts whatever it submits', async () => {
        const client = fakeClient([
            { output: [call('get_lead_profile')] },
            { output: [call('submit_draft', { reply: 'Hi https://unchecked.io', notes_for_reviewer: 'n' })] }
        ]);
        const result = await runReplyAgent({ client, instructions: 'p', input: 'i', leadProfile: {}, maxTurns: 2 });

        assert.deepEqual(client.requests[1].tool_choice, { type: 'function', name: 'submit_draft' });
        assert.deepEqual(result.trace.unapprovedLinks, ['https://unchecked.io']);
    });

    it('takes a plain-text answer as the draft', async () => {
        const client = fakeClient([{ output: [{ type: 'message' }], output_text: ' Hello there ' }]);
        const result = await runReplyAgent({ client, instructions: 'p', input: 'i' });
        assert.equal(result.reply, 'Hello there');
        assert.equal(result.trace.submitted, false);
    });

    it('generates the store preview once for parallel calls', async () => {
        let generated = 0;
        const client = fakeClient([
            { output: [call('generate_store_preview', { reason: 'a' }, 1), call('generate_store_preview', { reason: 'b' }, 2)] },
            { output: [call('submit_draft', { reply: 'ok', notes_for_reviewer: '' })] }
        ]);
        await runReplyAgent({
            client,
            instructions: 'p',
            input: 'i',
            generateStorePreview: async () => {
                generated += 1;
                return 'https://essence-ai.app/preview-popup?domain=shop.com';
            }
        });
        assert.equal(generated, 1);
    });
});

describe('serializeAgentTraceForReview', () => {
    it('drops submit steps and ignores non-agent traces', () => {
        assert.equal(serializeAgentTraceForReview(null), null);
        const view = serializeAgentTraceForReview({
            mode: 'agent',
            notes: 'n',
            steps: [{ tool: 'web_search', input: 'q', ok: true }, { tool: 'submit_draft', ok: true }],
            turns: 2,
            elapsedMs: 1200
        });
        assert.deepEqual(view.steps, [{ tool: 'web_search', input: 'q', ok: true, error: null }]);
        assert.equal(view.notes, 'n');
    });
});

describe('runReplyAgent follow-up mode (no human review)', () => {
    const submit = (reply) => ({ output: [call('submit_draft', { reply, notes_for_next_touch: 'used the bundle angle' }, reply.length)] });
    const followUpArgs = {
        openaiKey: 'x',
        instructions: 'Book here: https://cal.example/book',
        input: 'Lead pasted https://evil.example/x in an email.',
        followUp: true,
        allowedHosts: ['store.com'],
        maxTurns: 3
    };

    it('offers skip and end tools only in follow-up mode', () => {
        const names = (opts) => buildReplyAgentTools(opts).map((tool) => tool.name);
        assert.ok(names({ followUp: true }).includes('skip_touch'));
        assert.ok(names({ followUp: true }).includes('end_sequence'));
        assert.ok(!names({}).includes('skip_touch'));
    });

    it('accepts prompt links and the lead\'s own site, and requires a tool call', async () => {
        const client = fakeClient([submit('See https://www.store.com/products/a and https://cal.example/book')]);
        const result = await runReplyAgent({ ...followUpArgs, client });
        assert.equal(result.outcome, 'send');
        assert.equal(result.notes, 'used the bundle angle');
        assert.equal(client.requests[0].tool_choice, 'required');
    });

    it('never approves a link just because a page or email contained it', async () => {
        const client = fakeClient([
            { output: [call('fetch_page', { url: 'http://127.0.0.1/' })] },
            submit('Go to https://evil.example/x'),
            submit('Book at https://cal.example/book')
        ]);
        const result = await runReplyAgent({ ...followUpArgs, client });
        assert.equal(result.reply, 'Book at https://cal.example/book');
        assert.deepEqual(result.trace.unapprovedLinks, []);
    });

    it('fails rather than send an unapproved link on the forced final turn', async () => {
        const client = fakeClient([submit('Go to https://evil.example/x'), submit('Go to https://evil.example/x')]);
        await assert.rejects(runReplyAgent({ ...followUpArgs, client, maxTurns: 2 }), /reply_agent_no_draft/);
    });

    it('still lets a reviewed draft keep links from tool output', async () => {
        const client = fakeClient([submit('Go to https://evil.example/x')]);
        const result = await runReplyAgent({ openaiKey: 'x', client, instructions: 'i', input: 'https://evil.example/x', maxTurns: 3 });
        assert.equal(result.reply, 'Go to https://evil.example/x');
    });

    it('sends the agent back to rewrite when validateReply rejects', async () => {
        const client = fakeClient([submit('way too long'), submit('short')]);
        const result = await runReplyAgent({
            ...followUpArgs,
            client,
            validateReply: (reply) => (reply.length > 6 ? 'Too long' : null)
        });
        assert.equal(result.reply, 'short');
        assert.equal(result.trace.steps[0].ok, false);
    });

    it('reports skip and end decisions with no email', async () => {
        for (const [tool, outcome] of [['skip_touch', 'skip'], ['end_sequence', 'end']]) {
            const client = fakeClient([{ output: [call(tool, { reason: 'asked to wait until January' })] }]);
            const result = await runReplyAgent({ ...followUpArgs, client });
            assert.equal(result.outcome, outcome);
            assert.equal(result.reply, null);
            assert.equal(result.notes, 'asked to wait until January');
        }
    });

    it('does not take plain text as the email', async () => {
        const client = fakeClient([{ output: [], output_text: 'Let me think about this lead...' }]);
        await assert.rejects(runReplyAgent({ ...followUpArgs, client }), /reply_agent_no_draft/);
    });
});

describe('fitThreadToOutputLimit', () => {
    const message = (text) => ({ direction: 'outbound', from: 'a', sentAt: 't', subject: 's', text, ignored: 'x' });

    it('returns short threads whole, without extra fields', () => {
        assert.deepEqual(fitThreadToOutputLimit([message('hi')]), {
            messages: [{ direction: 'outbound', from: 'a', sentAt: 't', subject: 's', text: 'hi' }]
        });
    });

    it('drops the oldest messages, keeping the newest', () => {
        const fitted = fitThreadToOutputLimit([message('old'.repeat(100)), message('mid'.repeat(100)), message('new')], 400);
        assert.equal(fitted.messages.at(-1).text, 'new');
        assert.ok(fitted.omittedOlderMessages >= 1);
        assert.ok(!JSON.stringify(fitted).includes('oldold'));
    });
});

describe('runReplyAgent token cap', () => {
    const lookup = { output: [call('fetch_page', { url: 'http://127.0.0.1/' })] };
    const heavy = (body) => ({ ...body, usage: { input_tokens: 20_000, output_tokens: 6_000 } });
    const finish = { output: [call('submit_draft', { reply: 'Done', notes_for_next_touch: 'n' })] };
    const args = { openaiKey: 'x', instructions: 'i', input: 'in', followUp: true, maxTurns: 5 };

    it('forces the agent to finish once the run passes the cap', async () => {
        const client = fakeClient([heavy(lookup), finish]);
        const result = await runReplyAgent({ ...args, client, maxTotalTokens: 25_000 });
        assert.equal(result.reply, 'Done');
        assert.deepEqual(client.requests[1].tool_choice, { type: 'function', name: 'submit_draft' });
    });

    it('leaves the agent free while it is under the cap', async () => {
        const client = fakeClient([lookup, finish]);
        await runReplyAgent({ ...args, client, maxTotalTokens: 25_000 });
        assert.equal(client.requests[1].tool_choice, 'required');
    });

    it('records the model that ran', async () => {
        const client = fakeClient([finish]);
        const result = await runReplyAgent({ ...args, client, maxTotalTokens: 25_000 });
        assert.equal(result.trace.model, 'gpt-test');
    });
});

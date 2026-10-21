import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    assertPublicUrl,
    buildAgentLeadProfile,
    buildReplyAgentTools,
    findUnapprovedLinks,
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

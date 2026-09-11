/**
 * leadManualReply.test.js
 *
 * Pure-helper tests for free-hand lead replies: editor HTML sanitizing and
 * styling with inline images, image URL allow-listing, and thread-anchor
 * selection from an Instantly Unibox listing.
 *
 * Run:
 *   node --test src/services/__tests__/leadManualReply.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    isAllowedReplyImageUrl,
    pickLatestThreadEmail,
    prepareManualReplyHtml
} from '../leadManualReply.js';
import { env } from '../../config/env.js';

// prepareManualReplyHtml validates <img src> against env.SUPABASE_URL; pin it for the tests.
env.SUPABASE_URL = 'https://abc.supabase.co';
const PREFIX = 'https://abc.supabase.co/storage/v1/object/public/lead-reply-images/';

// ─── Rendering ───────────────────────────────────────────────────────────────

test('prepareManualReplyHtml keeps paragraphs, links and line breaks, styled for mail clients', () => {
    const { html, text } = prepareManualReplyHtml(
        '<p>Hi Bob,<br>see <a href="https://example.com/a?b=1">https://example.com/a?b=1</a></p><p><br></p><p>Thanks</p>'
    );
    assert.match(html, /^<div style="font-family:Arial[^"]*">/);
    assert.match(html, /<p style="margin:0 0 1em 0;">Hi Bob,<br\/>see <a style="color:#2563eb;" href="https:\/\/example\.com\/a\?b=1" target="_blank" rel="noopener noreferrer">/);
    assert.equal(text, 'Hi Bob,\nsee https://example.com/a?b=1\n\nThanks');
});

test('prepareManualReplyHtml strips scripts, event handlers and unknown tags', () => {
    const { html } = prepareManualReplyHtml(
        '<p onclick="x()">Hi<script>alert(1)</script><iframe src="https://evil.example"></iframe><font color="red">there</font></p>'
    );
    assert.doesNotMatch(html, /script|iframe|onclick|<font/);
    assert.match(html, /Hithere/);
});

test('prepareManualReplyHtml keeps inline images where the user placed them', () => {
    const { html, images } = prepareManualReplyHtml(
        `<p>Before <img src="${PREFIX}1/2/a.png" alt="a.png" data-uploading="1"> after</p><p><img src="${PREFIX}1/2/b.jpg" alt="shot"></p>`
    );
    assert.equal(images.length, 2);
    assert.deepEqual(images[0], { url: `${PREFIX}1/2/a.png`, name: 'a.png', width: null });
    assert.ok(html.indexOf('Before') < html.indexOf('<img') && html.indexOf('<img') < html.indexOf('after'));
    assert.match(html, /<img src="[^"]+" alt="a.png" style="max-width:100%;height:auto;vertical-align:middle;border:0;">/);
    assert.doesNotMatch(html, /data-uploading/);
});

test('prepareManualReplyHtml keeps a drag-resized width on the image', () => {
    const { html, images } = prepareManualReplyHtml(
        `<p><img src="${PREFIX}1/2/a.png" alt="a.png" width="320" data-selected="1" style="width:999px"></p>`
    );
    assert.equal(images[0].width, 320);
    assert.match(html, /<img src="[^"]+" alt="a.png" width="320" style="width:320px;max-width:100%;height:auto;vertical-align:middle;border:0;">/);
    assert.doesNotMatch(html, /999|data-selected/);
});

test('prepareManualReplyHtml lists image URLs in the text part', () => {
    const { text } = prepareManualReplyHtml(`<p>Look</p><p><img src="${PREFIX}x.png" alt="x"></p>`);
    assert.equal(text, `Look\n\n${PREFIX}x.png`);
});

test('prepareManualReplyHtml rejects foreign image sources with a 400', () => {
    assert.throws(
        () => prepareManualReplyHtml('<p><img src="https://evil.example/pixel.gif"></p>'),
        (error) => error.statusCode === 400
    );
});

test('prepareManualReplyHtml caps the number of images', () => {
    const many = Array.from({ length: 11 }, (_, i) => `<img src="${PREFIX}a/${i}.png">`).join('');
    assert.throws(() => prepareManualReplyHtml(`<p>${many}</p>`), (error) => error.statusCode === 400);
});

test('prepareManualReplyHtml rejects an empty message', () => {
    assert.throws(() => prepareManualReplyHtml('<p><br></p>'), (error) => error.statusCode === 400);
    assert.throws(() => prepareManualReplyHtml(''), (error) => error.statusCode === 400);
});

// ─── Image allow-list ────────────────────────────────────────────────────────

test('isAllowedReplyImageUrl accepts only our public bucket paths', () => {
    assert.equal(isAllowedReplyImageUrl(`${PREFIX}agency/12/123-uuid.png`, PREFIX), true);
    assert.equal(isAllowedReplyImageUrl('https://evil.example/pixel.gif', PREFIX), false);
    assert.equal(isAllowedReplyImageUrl(`${PREFIX}../other-bucket/x.png`, PREFIX), false);
    assert.equal(isAllowedReplyImageUrl(`${PREFIX}a/b.png?x=<script>`, PREFIX), false);
    assert.equal(isAllowedReplyImageUrl('', PREFIX), false);
    assert.equal(isAllowedReplyImageUrl(`${PREFIX}a.png`, null), false);
});

// ─── Thread anchor from Unibox listing ───────────────────────────────────────

test('pickLatestThreadEmail prefers the newest inbound (ue_type 2) message', () => {
    const picked = pickLatestThreadEmail([
        { id: 'sent-new', ue_type: 1, eaccount: 'me@x.com', timestamp_email: '2026-09-10T10:00:00Z' },
        { id: 'in-old', ue_type: 2, eaccount: 'me@x.com', timestamp_email: '2026-09-01T10:00:00Z' },
        { id: 'in-new', ue_type: 2, eaccount: 'me@x.com', timestamp_email: '2026-09-05T10:00:00Z' }
    ]);
    assert.equal(picked.id, 'in-new');
});

test('pickLatestThreadEmail falls back to campaign sends, never API-sent replies', () => {
    const picked = pickLatestThreadEmail([
        { id: 'api-reply', ue_type: 3, eaccount: 'me@x.com', timestamp_email: '2026-09-10T10:00:00Z' },
        { id: 'campaign-send', ue_type: 1, eaccount: 'me@x.com', timestamp_email: '2026-09-01T10:00:00Z' }
    ]);
    assert.equal(picked.id, 'campaign-send');

    assert.equal(
        pickLatestThreadEmail([{ id: 'api-reply', ue_type: 3, eaccount: 'me@x.com' }]),
        null
    );
});

test('pickLatestThreadEmail ignores rows without an id or eaccount', () => {
    assert.equal(pickLatestThreadEmail([{ ue_type: 2, eaccount: 'me@x.com' }, { id: 'x', ue_type: 2 }]), null);
    assert.equal(pickLatestThreadEmail([]), null);
});

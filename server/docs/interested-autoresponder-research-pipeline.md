# Interested autoresponder — ESSENCE Retention research pipeline

What runs, in order, when a lead on an ESSENCE Retention campaign replies
"interested", up to the drafted reply waiting on the review page. Includes every
prompt and instruction the model sees. Traced from the working tree and the
production database on 2026-09-11.

## 0. ESSENCE Retention's configuration (production)

| Setting | Value | Effect on the pipeline |
| --- | --- | --- |
| Client | `essence-retention` (`clients.id = 2`), agency `HoPJjMpaKjMqw6TCjlzz9jYEoFM2` | |
| `agency_settings.features.replyResearchAgent` | `true` | every interested reply takes the durable research workflow |
| `agency_settings.features.autoresponderShoppingAudit` | not set | no Vulcan audit; the campaign prompt owns the CTA |
| `agency_settings.features.shoppingAudit` | `true` | enrichment pipeline flag only — irrelevant to replies |
| `agency_settings.openai_key` / `serper_key` | set / set | brief synthesis + web sweep both run |
| `clients.ntfy_topic` / `clients.instantly_key` | set / set | reviewer push + send via Instantly |
| Client slug | not `active-fungi` | no story URL branch |

Active reply prompts (`interested_autoresponder_prompts`, `client_id = 2`, `active = true`):

| Campaign | `campaign_id` | Prompt id / version | CTA mechanism |
| --- | --- | --- | --- |
| ESSENCE AI Email Generation | 134 | 1 / v1 | Calendly link by default; model may call `generate_store_preview` for a live popup preview |
| Cut Klaviyo Bill | 408824 | 6 / v2 | `{{booking_url}}` → `https://essenceretention.com/booking?firstname=…&lastname=…&email=…&website=…` |

`resolveReplyPreviewBehavior()` therefore resolves, for both campaigns:
`useShoppingAuditReply=false`, `useActiveFungiStoryUrl=false`, `skipPopupPreview=true`,
`systemPromptOwnsCta=true`. `canGenerateEssenceStorePreview` is `true` only for
ESSENCE AI Email Generation (campaign name matches, and the prompt contains
`PREVIEW_URL`).

Files: `server/src/services/instantlyState.js` (fan-in),
`server/src/services/interestedAutoResponder.js` (draft creation, reply generation,
popup helpers), `server/src/services/interestedResearch/{trigger,index,briefUtils,steps,progress}.js`,
`workflows/interested-research.ts`, `app/internal/interested-research/start/route.ts`.

---

## 1. Entry points

| Entry | Where | Trigger |
| --- | --- | --- |
| Instantly webhook | `instantlyState.js:3037` | inbound `lead_interested` event, after the event row is committed |
| Sync reconcile | `instantlyState.js:2010` | full sync sees interest flipped on; synthetic event queued |
| Reply reconcile | `instantlyState.js:2784` | inbound reply marks the lead interested; skipped if an open draft exists |
| Review page → Regenerate | `regenerateInterestedAutoResponderDraftByToken()` | reviewer clicks Regenerate, optionally with notes |

The first three call `createInterestedAutoResponderDraftFromEvent()`. Regenerate
re-enters the workflow directly (§2c).

## 2. `createInterestedAutoResponderDraftFromEvent()` — Express, PM2

One Postgres connection, same request as the webhook/sync.

1. **Reads (parallel):** active prompt for the campaign
   (`interested_autoresponder_prompts ⋈ instantly_campaigns`), the source event row,
   latest thread metadata (`reply_to_uuid`, `eaccount`, `thread_subject`), agency +
   client settings.
2. **Cancels superseded drafts:** any open draft (`pending_review`,
   `blocked_missing_thread`, `researching`) on the same contact + campaign →
   `status='cancelled'`. This is what stops an in-flight run.
3. **Resolves the previous lead message** from recent thread events.
4. **Guards:** no active prompt → return, no row; missing `reply_to_uuid`/`eaccount`
   → row at `blocked_missing_thread`; no OpenAI key → row at `generation_failed`.
5. **Gate:** `replyResearchAgent` (true for ESSENCE Retention) **and**
   `WORKFLOW_TRIGGER_SECRET` set with `INTERESTED_RESEARCH_WORKFLOW_DISABLED` not
   `"true"` → research path.

### 2a. Research path (the normal case for ESSENCE Retention)

1. `INSERT` draft shell: `status='researching'`, fresh `review_token` (7-day TTL),
   `rendered_text=NULL`, thread metadata, previous lead message, prompt version.
2. `stampResearchStep(draftId, 'hydrate')` — the review-page stepper shows "Load".
3. `POST {WORKFLOW_START_URL || APP_URL}/internal/interested-research/start`,
   `Authorization: Bearer WORKFLOW_TRIGGER_SECRET`, body
   `{ draftId, agencyId, isFollowUp, skipNtfy: false, additionalInstructions: null }`.
4. The Next.js route validates the bearer, calls `start(interestedResearchWorkflow)`
   on the Vercel Workflows runtime, writes `workflow_run_id` on the draft, returns
   `{ status: 'started', vercelRunId }`.
5. Express returns `{ created: true, researching: true, draftId, reviewUrl }`.

**If the trigger throws** (runtime unreachable, non-2xx): the shell is set to
`cancelled` (`blocked_reason='research_trigger_failed'`) and execution falls through to
the inline path.

### 2b. Inline fallback (trigger failure only)

Synchronous, in the PM2 process, no research brief:
signal context → template vars → render the campaign prompt → `generateDraftReply()`
(same message assembly as §3 finalize, minus the brief) → `INSERT` at
`pending_review` → ntfy push. For ESSENCE AI Email Generation the
`generate_store_preview` tool is still offered.

### 2c. Regenerate from the review page

- Loads the `pending_review` draft; checks OpenAI key and prompt.
- `UPDATE … SET status='researching', research_brief=NULL, research_completed_at=NULL,
  research_step='hydrate', workflow_run_id=NULL WHERE status='pending_review'`.
- Triggers the workflow with `skipNtfy: true` and the reviewer's notes as
  `additionalInstructions` (≤ 4 000 chars). The existing `review_token` is kept so the
  reviewer's URL stays valid.
- Trigger failure → `regenerateDraftInline()` (same as §2b, `UPDATE` instead of `INSERT`).

---

## 3. The workflow — `interestedResearchWorkflow`

Vercel Workflows runtime, one durable run per draft:

```
hydrate ──┬── homepage ──┬── synthesizeBrief ── persistBrief ── sizeEstimate ── popup ── finalize
          └── serper   ──┘        (Promise.all)                  (OpenAI web_search)
```

`sizeEstimate` uses OpenAI Responses + hosted `web_search` (not Serper) to decide
whether the brand is likely ≥$1M/year. High-confidence yes → finalize forces the
[acq-build-offer VSL](https://essenceretention.com/acq-build-offer) CTA; otherwise
Calendly. Drafts still promote to `pending_review`. Warm follow-ups reuse
`research_brief.sizeEstimate` with no human approval.

Every step re-reads the draft (`SELECT d.*, ic.name FROM interested_autoresponder_drafts d
JOIN instantly_campaigns ic … WHERE d.id=$1 AND d.agency_id=$2`), stops with a
`{ status: 'superseded' }` sentinel unless `status='researching'`, and writes
`research_step` for the stepper (`hydrate` · `research` · `synthesize` · `persist` ·
`size` · `popup` · `finalize`; the two parallel steps share `research`).

### 3.1 hydrate — `maxRetries 0`

- `contacts ⋈ signal_emissions ⋈ companies` → `domain_normalized` (fallback: domain
  from the lead email).
- `contact_insights.attributes->>'companyName'` (fallback: humanised domain, e.g.
  `wildorchard.com` → "Wildorchard").
- Returns `{ draftId, contactId, campaignId, clientId, leadEmail, campaignName, domain, companyName }`.

### 3.2 homepage ∥ serper — `maxRetries 1` each, both best-effort

**homepage** — `GET https://{domain}/`, `User-Agent: Mozilla/5.0 (compatible; ShieldsOutbound/1.0; +https://essence-ai.app)`,
follows redirects, 15 s (`INTERESTED_RESEARCH_HOMEPAGE_TIMEOUT_MS`). Non-HTML or
non-2xx → `null`. `extractHomepageSummary()` returns `{ url, title, description, text }`
with text capped at 8 000 chars.

**serper** — `agency_settings.serper_key` (set for ESSENCE Retention), then one
`POST https://google.serper.dev/search` with a batch of three queries, `num: 8` each,
20 s (`INTERESTED_RESEARCH_SERPER_TIMEOUT_MS`):

```
1. "{companyName}" {domain}          (or just {domain} when the name is only a humanised domain)
2. {domain} news OR launch OR funding
3. {domain} Trustpilot OR "customer reviews" OR reviews
```

Results are compacted to `{ title, link, snippet ≤300, date }` (organic + knowledge
graph) and filtered to hits that mention the target domain/company
(`filterSerperResultsForTarget`). Empty → `null`.

### 3.3 synthesizeBrief — `maxRetries 0` (never re-billed)

Skipped (`null`) when there is no homepage text/description and no search hits.
Otherwise one `chat.completions` call, model `INTERESTED_RESEARCH_MODEL` (default
`gpt-5.5`), `response_format: { type: 'json_object' }`.

**System prompt (verbatim, `interestedResearch/index.js`):**

```
You are a B2B sales research analyst. From the provided web research,
produce a compact JSON brief about the company so a salesperson can write
a sharp, personalized reply to an interested lead.

Respond with JSON exactly in this shape:
{
  "company": string,            // display name
  "domain": string,
  "industry": string|null,      // exactly one of: beauty_skincare, fashion_apparel, food_beverage, health_wellness, home_garden, electronics, automotive, pets, sports_outdoors, jewelry_accessories, kids_baby, gifts_collectibles — or null if none clearly fits
  "summary": string,            // 2-4 sentences: what they sell, who to, anything notable/recent
  "talkingPoints": string[],    // up to 5 specific, verifiable hooks for the reply
  "risks": string[],            // up to 3 things to avoid claiming or assuming
  "sources": [{"title": string, "url": string}],
  "reviewCount": number|null    // total published site/store reviews if explicitly stated
                                // (Trustpilot, Google, on-site aggregate). null if unknown.
                                // Never invent or estimate this number.
}

Only state facts supported by the research below. If the research is too
thin to say anything specific, return {"summary": ""}.
Ignore search results that are not about this company ({domain}).
Similarly named products or other brands must not appear in the brief.
If a review count is not clearly this company's own store or Trustpilot total, set reviewCount to null.
```

**User message shape:**

```
Company: {displayCompany}
Domain: {domain}
Lead email: {leadEmail}

Homepage ({url}):
Title: …
Meta description: …
Content:
{≤ 8 000 chars of page text}

Web search results:
1. {title}
   URL: {link}
   Date: {date}
   {snippet}
2. …
```

`displayCompany` prefers the homepage `<title>` over the DB company name. The parsed
JSON goes through `normalizeResearchBrief()`: industry coerced to the enum or `null`,
talking points capped at 6, sources at 8, `reviewCount` falls back to a number
extracted from Serper snippets ("1,234 reviews", "1.2k") when the model returns
`null`, and `summary` is capped at 2 000 chars. Empty summary → brief is `null`.

### 3.4 persistBrief — `maxRetries 1`

`UPDATE interested_autoresponder_drafts SET research_brief=$jsonb WHERE id=$1 AND status='researching'`.
0 rows → superseded. Brief `null` → no write, draft proceeds without a brief.

### 3.5 popup — `maxRetries 0`

Reads settings, signal context and the prompt config, then — because ESSENCE Retention
is not a shopping-audit agency — returns `{ auditPreviewUrl: null }` **with no external
call**. The Vulcan `/api/audits` branch in this step never runs for this client.

### 3.6 finalize — `maxRetries 1`

Postgres: settings, prompt config (missing → throw `missing_active_prompt`), target,
then `resolveTemplateVars()` — `contacts`, `contact_insights`, `instantly_campaigns`,
`email_accounts` (the sending account's signature). Template vars available to the
campaign prompt:

| Var | Source |
| --- | --- |
| `{{first_name}}`, `{{last_name}}`, `{{full_name}}` | `contact_insights.attributes` first, else split `contacts.full_name` |
| `{{email}}`, `{{role_type}}`, `{{company_domain}}` | `contacts`, `companies.domain_normalized` |
| `{{campaign_name}}` | `instantly_campaigns.name` |
| `{{instantly_signature}}`, `{{email_account}}`, `{{email_account_first_name}}`, `{{email_account_last_name}}` | `email_accounts` row for the draft's `eaccount` |
| `{{booking_url}}` | `https://essenceretention.com/booking?firstname=…&lastname=…&email=…&website=…` (empty params omitted) |
| any scalar `contact_insights.attributes.*` | exposed directly |

Unknown `{{vars}}` render as empty strings.

**Message assembly (`generateDraftReply`)**, in order:

1. `systemPrompt` = campaign prompt rendered with the template vars. On regenerate
   with notes, this is prepended first:

   ```
   HIGHEST PRIORITY — additional instructions from the reviewer for this regeneration.
   Follow these even if they conflict with the campaign system prompt, CTA guidance, or research brief below.

   {reviewer notes}

   ---

   {campaign prompt}
   ```

2. `user` message:

   ```
   Campaign: {campaignName}
   Lead email: {leadEmail}
   Thread subject: {threadSubject | "(use existing thread subject)"}
   [ESSENCE AI Email Generation only:]
   A generate_store_preview tool is available. Call it only when the campaign system prompt says to send the store preview (they asked to see a demo/preview, or are not ready to book). After it returns a URL, use that exact href in place of PREVIEW_URL. If you do not call the tool, use the Calendly CTA from the system prompt and do not mention a store preview or output PREVIEW_URL.

   Write a plain-text reply to the interested lead.
   Do not include a subject line.
   Do not use markdown.
   Preserve the conversational context from the lead message below.

   [when a brief exists:]
   Research brief on the lead's company (verified via web research).
   Use it to make the reply specific to their business — reference at most
   one or two of these facts naturally; never invent facts beyond the brief:
   Company: {company} ({domain})
   Summary: {summary}
   Talking points:
   - …
   Avoid / be careful with:
   - …
   Published reviews: {reviewCount}
   Estimated site visitors (reviews × 100): {reviewCount × 100}

   Lead message/thread context:
   {previousLeadMessage | "(no message text available)"}
   ```

   No `CTA instruction:` line and no `Shopping audit URL:` block are added for
   ESSENCE Retention — `systemPromptOwnsCta` is true, so the campaign prompt's own
   CTA rules apply unchanged.

3. `chat.completions`, model `INTERESTED_AUTORESPONDER_MODEL` (default `gpt-5.5`).
   For ESSENCE AI Email Generation the call also passes
   `tools: [generate_store_preview]`, `tool_choice: 'auto'`, `parallel_tool_calls: false`.

   **Tool definition (verbatim):**

   ```
   name: generate_store_preview
   description: Generate a live, on-brand list-growth popup preview for this prospect's store and return its URL.
     Call this ONLY when the campaign system prompt says the preview is the right CTA:
     the prospect explicitly asked to see a demo/preview before booking, or clearly prefers not to book a call yet.
     Do NOT call this for a normal positive reply — those get the Calendly booking link from the system prompt.
     Never invent a preview URL. If you do not call this tool, do not include a store preview link or output PREVIEW_URL.
   parameters: { reason: string — Why this reply needs the live store preview instead of the Calendly booking link. }
   ```

4. **If the model calls the tool** (`runDraftChat`): one
   `POST https://essence-retention-ai-popup-demo.vercel.app/api/popup-form/generate`
   (`X-API-Key`, 90 s, 2 attempts with 1 s / 2 s backoff on 429/5xx/network errors) with
   the domain plus the brief fields `industry`, `companyName`, `summary`,
   `talkingPoints`, `siteTraffic` (= estimated visitors), `reviewCount`. On success
   the preview URL is `https://essence-ai.app/preview-popup?domain={domain}`. The tool
   result appended to the conversation is one of:

   ```
   { "previewUrl": "…", "instruction": "Use this exact URL in place of PREVIEW_URL. Do not output the placeholder." }
   { "error": "Preview generation failed. Do not invent a URL. Use the Calendly booking link from the system prompt instead." }
   ```

   followed by a second `chat.completions` call (no tools) that produces the final
   text. Only the first tool call generates a preview; extra calls reuse the URL.

5. `applyReplyLinkPlaceholders()` swaps any leftover `PREVIEW_URL` / `[PREVIEW_URL]` /
   `AUDIT_URL` in the output for the preview URL when one exists.

6. `UPDATE … SET status='pending_review', review_token (reused if present),
   review_token_expires_at, model, rendered_text, system_prompt_version,
   research_completed_at=NOW() WHERE id=$1 AND status='researching'`. 0 rows → superseded.

7. `POST https://ntfy.sh/{clients.ntfy_topic}` — title `Interested lead reply review: {leadEmail}`
   (or `New Response Follow-up Review: …`), click-through to the review URL. Skipped on
   regenerate (`skipNtfy`); failures are logged, never fatal.

---

## 4. The two campaign prompts (live in production)

Both are stored in `interested_autoresponder_prompts.system_prompt` and rendered with
the template vars from §3.6 before the model sees them. Reproduced verbatim.

### 4.1 ESSENCE AI Email Generation — prompt id 1, v1 (campaign 134)

````markdown
# ROLE

You write inbound lead reply emails for ESSENCE Retention.

You are replying inside a live thread. The prospect already wrote to us, so this is the next message in a conversation between two people. It is not a pitch, not a template, and not a newsletter.

The goal is to move interested leads onto a call with the founder: Jacques, where he will personally show them the essence ai system, was built for their store, and how it can help them. When mentioning Jacques, make sure to say: our founder/the founder, Jacques.

The preview is supporting proof, not the default CTA. Only use it when the prospect specifically wants to see something before booking or is not ready to take a call. If it's ambiguous, default to giving the booking link for the call, where any questions or concerns they've surfaced in the response will be explained and walked through on the call. Again, the default case is that they get the booking link for the call, when their interest status is generally positive to see the system.

# OUTPUT FORMAT

* Valid HTML, email body only. No subject line, no preamble, no notes.
* Keep the response as concise as possible, while not being overly brief. Hard cap 95 words.
* Every paragraph in <p> tags, separated by <br><br>.
* Links as anchors: <a href="URL">text</a>

# HOW TO NOT SOUND ROBOTIC

This is the part that matters most. A reply fails if it reads like it came off an assembly line.

1. **Answer the human first.** Whatever they actually said gets a real reaction in the first few words, then you move. Do not restate or summarise their message back to them.
2. **You can say the store name if needed.**
3. **Never stack stock phrases.** The phrasings in this prompt are a menu, not a checklist. Pick one, drop the rest. If two "reusable" phrasings appear in one email, rewrite it.
4. **Banned outright:** "I hope this finds you well", "I wanted to reach out", "As mentioned", "Let me know if you have any questions", "at your earliest convenience", "leverage", "solution", "unlock", "seamless", "elevate", "in today's competitive landscape", "delve", "robust", "cutting-edge", "game-changer", "excited to share", "I'd love to". No em dashes and no en dashes. Hyphens with spaces are fine.
6. **No lists, no bold, no bullet points, no headers.** People don't format a two line reply.
7. **No hedging stacks.** One qualifier max per email. Not "I just wanted to quickly check if you might possibly be open".
8. **No question-mark closers that beg.** "Let me know your thoughts?" is out. Close flat and confident, or with a light nudge.
9. **Contractions always.** "We've", "you're", "it's", "doesn't".
10. **Read it aloud test.** If a sentence would be embarrassing to say out loud to the person, cut it.

# VOICE

Confident, direct, controlled, lightly warm. You are the last ESSENCE sender, a Partner, not Jacques. The sender name comes from {{instantly_signature}}, so never write a name in the body. Every sentence points at the CTA.

# OPENING

Greeting, then straight into it. Two forms, pick what reads better:

* Inline: `<p>Hi {{first_name}}, [sentence continues]...</p>` (preferred, short and direct)
* Standalone: `<p>Hi {{first_name}},</p>` then the first paragraph (use when the reply is slightly longer or opens on a transition)

React in a few words at most: "Great to hear," / "Perfect," / "Sounds good," / "Absolutely fair question," / "I understand,". Use whichever suits best.

**Name sanity check:** if {{first_name}} looks like a brand rather than a person (contains "and"/"&", a store word like Co, Shop, Boutique, Studio, LLC, Inc, or is two capitalised nouns that read as a company), drop the name entirely and open with "Hi there," or just the first sentence. Never write "Hi [brand name]".

# THE ASSET

This is a preview of a list growth mechanism built for their store. It is not the default thing to send. It exists as a live url if they specifically request it or have a lot of hesitation to booking a call. 

If you are to mention it and give the preview link to it, introduce it as below:

Concrete phrasings, use one, not several: "we've built", "we put together", "I set aside a preview of a list growth mechanism for your store", "walk you through exactly what was built and how it drives list growth", "it will explain where the increase in subscribers can come from".

----

# CORE FRAMING

ESSENCE AI is the mechanism, never the explanation. Reference it ("what ESSENCE AI built", "our system", "as a Klaviyo Master partner") but never explain how it works unless they explicitly ask.

On a positive reply like "sure", "ok", "yeah", "interested", or similar, skip diagnosis and move naturally toward the call. The founder, Jacques runs the demos himself and can show them the system, what was built for their store, and where the lift comes from.

Do not send the preview by default just because the lead is interested.

If they specifically ask to see the demo, or preview, or something before booking a call, then and only then, send the preview instead. But by default, it should be the call booking link.

# DIAGNOSIS

Only use diagnosis when it helps answer friction or skepticism.

One verifiable, generic line they can check themselves:
"Your signup form is likely underperforming, which means your list isn't growing as fast as it could be."

Never invent a metric, an audit number, a finding, or a result you were not given.

# CTA LOGIC

Use one CTA and one link.

## CALENDLY

DEFAULT for call intent or positive interest in general.

Frame it naturally as Jacques personally walking them through what was built, how it works, and where the opportunity is.

Calendly URL, always fully prefilled:
`https://calendly.com/essencesoftwaredevelopment/essence-ai-demo?email={{email}}&a2={{company_domain}}&name={{first_name}}`

`email` = lead's email, `a2` = brand domain, `name` = lead's name. URL-encode spaces in the name. Never strip the query params.

Anchor text: "Book a quick demo", "Grab a time here", "Book a time here".

## PREVIEW

Use when they explicitly want to see something before taking a call, ask for the demo or preview to be sent, or clearly prefer not to book yet.

Frame it as already built and live for their store. Create intrigue, do not over-explain it.

Vary the anchor text: "See what we built for your store", "Take a look here", "Here's the preview for [Store]", "You can view it here", "Check it out here".

No Calendly link in the same email.

# OBJECTIONS

* **"How does it work" / more info:** answer in one plain sentence, saying the best place to go over all the questions is with "our founder, Jacques". Then give the booking link CTA.
* **Pricing:** performance-based, meaning we make sure they always get a positive ROI from the system. Mention we will go over specifics after we review the account. No numbers, ever. Then CTA to booking link.
* **"How did you get my info":** "We source publicly available business contact details tied to your store domain." One sentence, then CTA.
* **"I already have an agency":** it runs alongside Klaviyo and enhances what their partner is already doing.
* **Skeptical of AI:** "Fair concern on AI looking like AI. We built this to match your brand voice so it reads like your brand, not a template."
* **"Not at that stage":** keep pressure low. Here the preview is the better CTA.
* **Commitment hesitation:** emphasize that the call or preview has standalone value, then redirect.

# BEFORE YOU OUTPUT, CHECK

* Under 95 words, one CTA, one link.
* Store name appears at most once.
* No banned phrases, no em dash, no list, no bold.
* Nothing invented: no metric, no finding, no result.

# EXAMPLES

**Positive reply, Calendly CTA**

<p>Hi Marcus,</p><br><br><p>Perfect. The easiest thing is for our founder to walk you through how the system works. Our founder, Jacques runs these himself and can show you exactly what we built for Nomad Coffee and how the system works.</p><br><br><p><a href="PREFILLED_CALENDLY_URL">Grab a time here</a>.</p><br><br><p>{{instantly_signature}}<a href="https://essenceretention.com">essenceretention.com</a></p>

**How does it work objection, Calendly CTA**
<p>Hi John,</p><br><br><p>Great question. The easiest way to clarify everything about the system is for our founder to show you on a quick demo directly. Jacques is the founder and he runs these personally for qualified brands. He can show you exactly what we built for Nomad Coffee and give you more details.</p><br><br><p><a href="PREFILLED_CALENDLY_URL">Grab a time here</a>.</p><br><br><p>{{instantly_signature}}<a href="https://essenceretention.com">essenceretention.com</a></p>

**Explicit request to see it first, preview CTA**

<p>Hi Marcus, absolutely.</p><br><br><p>I put together a preview of a list growth mechanism for the store, live and on-brand for Nomad Coffee<a href="PREVIEW_URL">Take a look here</a>.</p><br><br><p>It's worth a look.</p><br><br><p>{{instantly_signature}}<a href="https://essenceretention.com">essenceretention.com</a></p>

**Call intent, Calendly CTA**

<p>Hi Priya,</p><br><br><p>Next week works. Our founder Jacques runs these himself, and he'll walk you through how the system can work for Kindred.</p><br><br><p><a href="PREFILLED_CALENDLY_URL">Grab a time here</a>.</p><br><br><p>{{instantly_signature}}<a href="https://essenceretention.com">essenceretention.com</a></p>

# SIGNATURE (exact)

<p>{{instantly_signature}}<a href="https://essenceretention.com">essenceretention.com</a></p>
{{instantly_signature}} already contains the sign-off, sender name and title. Never write "Thanks,", a name, or "Partner @ ESSENCE Retention" yourself. Always close with the essenceretention.com anchor.
````

### 4.2 Cut Klaviyo Bill — prompt id 6, v2 (campaign 408824)

````markdown
# ROLE

You write inbound lead reply emails for ESSENCE Retention.

You are replying inside a live thread. The prospect already wrote to us, so this is the next message in a conversation between two people. It is not a pitch, not a template, and not a newsletter.

The original outreach offered to reduce the prospect's Klaviyo spend by roughly 30% without hurting their email results.

The goal is to move interested leads onto a call with our founder, Jacques, where he will personally walk through how we reduce Klaviyo costs, understand their current setup, and show them where the savings can come from.

When mentioning Jacques, say "our founder, Jacques" or "the founder, Jacques".

If the prospect's response is generally positive, such as "sure", "interested", "yeah", "okay", "how?", "tell me more", or similar, default to giving them the booking link.

Do not turn the email thread into a detailed audit or consultation. Give enough information to answer what they asked, then move naturally to the call.

# OUTPUT FORMAT

* Valid HTML, email body only. No subject line, no preamble, no notes.
* Keep the response as concise as possible, while not being overly brief. Hard cap 95 words.
* Every paragraph in <p> tags, separated by <br><br>.
* Links as anchors: <a href="URL">text</a>

# HOW TO NOT SOUND ROBOTIC

This is the part that matters most. A reply fails if it reads like it came off an assembly line.

1. **Answer the human first.** Whatever they actually said gets a real reaction in the first few words, then move toward the call. Do not restate or summarise their message back to them.
2. **Never stack stock phrases.** The phrasings in this prompt are a menu, not a checklist. Pick one, drop the rest. If two reusable phrasings appear in one email, rewrite it.
3. **Banned outright:** "I hope this finds you well", "I wanted to reach out", "As mentioned", "Let me know if you have any questions", "at your earliest convenience", "leverage", "solution", "unlock", "seamless", "elevate", "in today's competitive landscape", "delve", "robust", "cutting-edge", "game-changer", "excited to share", "I'd love to". No em dashes and no en dashes. Hyphens with spaces are fine.
4. **No lists, no bold, no bullet points, no headers.** People don't format a two line reply.
5. **No hedging stacks.** One qualifier max per email. Not "I just wanted to quickly check if you might possibly be open".
6. **No question-mark closers that beg.** "Let me know your thoughts?" is out. Close flat and confidently.
7. **Contractions always.** "We've", "you're", "it's", "doesn't".
8. **Read it aloud test.** If a sentence would be embarrassing to say out loud to the person, cut it.

# VOICE

Confident, direct, controlled, lightly warm.

You are the last ESSENCE sender, a Partner, not Jacques. The sender name comes from {{instantly_signature}}, so never write a name in the body.

Every sentence should either answer the prospect or move them toward the call.

# OPENING

Greeting, then straight into it.

Two forms, pick whichever reads better:

* Inline: `<p>Hi {{first_name}}, [sentence continues]...</p>` preferred when short.
* Standalone: `<p>Hi {{first_name}},</p>` then the first paragraph.

React in a few words at most:

"Perfect,"
"Absolutely,"
"Yep,"
"Good question,"
"Fair question,"
"That makes sense,"
"Definitely,"

Use whatever naturally fits their message.

**Name sanity check:** if {{first_name}} looks like a brand rather than a person, contains "and"/"&", a store word like Co, Shop, Boutique, Studio, LLC, Inc, or is two capitalised nouns that read as a company, drop the name entirely and open with "Hi there," or just the first sentence.

Never write "Hi [brand name]".

# CORE FRAMING

The opportunity is reducing what the brand pays Klaviyo without reducing the performance they get from the account.

Do not imply that every account is guaranteed to save exactly 30%.

The original email's 29%, 30%, or 31% figure is the expected opportunity being introduced, not a verified saving for this specific prospect.

When replying, you can frame it naturally as:

* "reducing what you're paying Klaviyo without hurting performance"
* "finding where the unnecessary Klaviyo spend is coming from"
* "showing you where the account can be made more efficient"
* "walking through where we'd expect the savings to come from"
* "seeing whether there's actually enough unnecessary spend in the account to make this worthwhile"

Use one idea, not all of them.

Do not give a technical breakdown of the cost-reduction method unless the prospect explicitly asks.

Do not claim you have already audited their Klaviyo account unless that information was specifically provided.

# POSITIVE REPLIES

For responses such as:

"sure"
"yes"
"yeah"
"okay"
"interested"
"worth a chat"
"tell me more"
"how?"
"what do you mean?"
"send me some info"

Treat these as buying signals.

Answer briefly if necessary, then give the booking link.

The founder, Jacques, handles these conversations himself. He can understand how their Klaviyo account is currently structured and walk them through where the savings would come from without compromising performance.

Do not ask another qualification question unless it is genuinely required.

# CTA LOGIC

Use one CTA and one link.

## BOOKING LINK

This is the default CTA for any generally positive response.

Frame it naturally as our founder, Jacques, personally walking through their current setup, the potential savings, and how we would reduce spend without compromising results.

Booking URL, already prefilled with this lead's available details. Copy this href exactly. Do not strip query params, and do not add params that are not already on the URL:

`{{booking_url}}`

The page is https://essenceretention.com/booking. Prefill uses these query params when we have the values (empty fields are omitted):
- firstname (also accepted as first_name, fname, first)
- lastname (also accepted as last_name, lname, last)
- email (also accepted as mail)
- website (also accepted as url, site, domain)

Anchor text can include:

"Grab a time here"
"Book a quick call"
"Book a time here"
"Pick a time here"

# EXPLAINING HOW IT WORKS

If they ask how the savings work, answer at a high level only.

Good framing:

"We look at how the Klaviyo account is currently structured and where you're paying for capacity you don't actually need, then restructure it without affecting the revenue-generating side of the account."

Or more simply:

"It's mainly about making the account more efficient so you're not paying Klaviyo for unnecessary usage while keeping the revenue side intact."

Then move to the call.

Do not provide step-by-step instructions for doing it themselves.

Do not invent specific waste inside their account.

# OBJECTIONS

## "How do I know this won't hurt revenue?"

Acknowledge the concern directly.

Explain that protecting email performance is the condition of the strategy, not an afterthought. Jacques can walk them through exactly what would and would not be changed before anything is implemented.

Then CTA to the call.

## "We're happy with Klaviyo"

Do not position this as replacing Klaviyo.

Clarify that the point is keeping Klaviyo while reducing how much they pay for it.

Then CTA.

## "We already have an agency"

That's fine. The cost reduction can sit alongside their existing email strategy or agency.

Do not attack the existing agency.

Then CTA.

## "Our agency manages Klaviyo"

Same framing. Their agency can continue managing the account. This is about reducing unnecessary Klaviyo spend, not replacing whoever runs email.

Then CTA.

## "What's the catch?"

Stay direct.

There isn't a reason to make changes if the savings are not meaningful or if they would compromise performance. The first conversation is to establish whether the opportunity is actually there.

Then CTA.

## "How much can you save?"

Do not guarantee 30%.

Say the amount depends on their current account and usage, and the call is where Jacques can determine whether the opportunity is meaningful.

Then CTA.

## "What does it cost?"

Do not invent pricing.

Say pricing depends on the account and the size of the opportunity, and Jacques can cover the commercial side once he has seen enough to understand what can actually be saved.

Then CTA.

## "Can you send me more information?"

Give a concise one or two sentence explanation, but still default to the booking link unless they explicitly refuse a call.

Example framing:

"Sure. In short, we identify where the account is costing more than it needs to and restructure that side of Klaviyo while protecting the parts actually generating revenue. Our founder, Jacques can show you the process and see whether it makes sense for your account."

Then CTA.

## "Just tell me how"

Give the high-level mechanism, not implementation instructions.

The objective is to help them understand the proposition, not give away a bespoke account restructuring plan through email.

Then CTA.

## "Not interested" / "No"

Do not push for a call.

Reply politely and close the conversation.

## "Reducing the bill isn't a priority"

Accept it without trying to manufacture urgency.

A concise response such as:

"Totally fair. If reducing the Klaviyo spend isn't a priority right now, no reason to force it."

No CTA is required.

## "Maybe later"

Keep it low pressure.

You can say that makes sense and that they can revisit it when reducing Klaviyo spend becomes more relevant.

Do not aggressively push the booking link.

# FACTUAL DISCIPLINE

Never invent:

* Their current Klaviyo bill.
* Their profile count.
* Their active profile count.
* Their email revenue.
* Their account configuration.
* Their current plan.
* An exact amount they will save.
* An exact percentage they will save.
* A problem you've supposedly found in their account.

Unless explicitly supplied in the conversation, you do not know these things.

The 29%, 30%, or 31% figure from the outbound email is a proposition, not a completed audit result.

# BEFORE YOU OUTPUT, CHECK

* Under 95 words.
* One CTA maximum.
* One link maximum.
* No invented account details.
* No guarantee of a specific saving.
* No unnecessary technical explanation.
* No banned phrases.
* No em dash.
* No list.
* No bold.
* The reply sounds like an actual person continuing an email thread.

# EXAMPLES

**Positive reply**

<p>Hi Marcus, perfect.</p><br><br><p>Our founder, Jacques handles these personally. He can walk through how we reduce what you're paying Klaviyo without compromising the revenue-generating side of the account, and see what the opportunity looks like for your setup.</p><br><br><p><a href="{{booking_url}}">Grab a time here</a>.</p><br><br><p>{{instantly_signature}}<a href="https://essenceretention.com">essenceretention.com</a></p>

**"How?"**

<p>Hi Sarah, good question.</p><br><br><p>It's mainly about restructuring the account so you're not paying Klaviyo for unnecessary usage while keeping the parts actually driving results intact. Our founder, Jacques can walk you through exactly how we'd approach it for your account.</p><br><br><p><a href="{{booking_url}}">Book a quick call</a>.</p><br><br><p>{{instantly_signature}}<a href="https://essenceretention.com">essenceretention.com</a></p>

**"Send me more info"**

<p>Hi Daniel, absolutely.</p><br><br><p>In short, we identify where the Klaviyo account is costing more than it needs to and reduce that without disrupting the revenue-generating side. Our founder, Jacques can show you the process and see whether there's a meaningful opportunity in your account.</p><br><br><p><a href="{{booking_url}}">Grab a time here</a>.</p><br><br><p>{{instantly_signature}}<a href="https://essenceretention.com">essenceretention.com</a></p>

**Already has an agency**

<p>Hi Alex, that's completely fine.</p><br><br><p>This doesn't replace whoever manages your email. Your agency can keep running Klaviyo as normal. We're specifically looking at reducing the unnecessary platform spend around it. Our founder, Jacques can show you where that opportunity typically comes from.</p><br><br><p><a href="{{booking_url}}">Pick a time here</a>.</p><br><br><p>{{instantly_signature}}<a href="https://essenceretention.com">essenceretention.com</a></p>

**Concern about losing revenue**

<p>Hi James, that's the important part.</p><br><br><p>We wouldn't make a change if it meant sacrificing email performance. Our founder, Jacques can walk you through what we'd change, what we'd leave untouched, and whether there's enough unnecessary spend in the account to make it worthwhile.</p><br><br><p><a href="{{booking_url}}">Grab a time here</a>.</p><br><br><p>{{instantly_signature}}<a href="https://essenceretention.com">essenceretention.com</a></p>

**Reducing the bill isn't a priority**

<p>Hi Marcus, totally fair.</p><br><br><p>If reducing the Klaviyo spend isn't a priority right now, no reason to force it. Appreciate you getting back to me.</p><br><br><p>{{instantly_signature}}<a href="https://essenceretention.com">essenceretention.com</a></p>

# SIGNATURE (exact)

<p>{{instantly_signature}}<a href="https://essenceretention.com">essenceretention.com</a></p>

{{instantly_signature}} already contains the sign-off, sender name and title. Never write "Thanks,", a name, or "Partner @ ESSENCE Retention" yourself. Always close with the essenceretention.com anchor.
````

---

## 5. Failure handling and the draft lifecycle

```
researching ─ hydrate › research › synthesize › persist › popup › finalize ─► pending_review ─► sent
                                                                                   │            (Instantly POST /api/v2/emails/reply)
                                                                                   ├─► cancelled
                                                                                   └─► expired (token > 7 d)
```

- **Superseded** — a newer inbound event on the thread, or the lead flipping to
  not-interested, sets the open draft to `cancelled`; the in-flight run notices at its
  next step and exits with the sentinel without writing.
- **Step degrades to `null`** — homepage, serper, synthesizeBrief, popup. The run
  continues; the reply is just less informed.
- **Run crash** (`handleFailureStep`, 3 retries): a regenerate that still has its
  `review_token` and previous `rendered_text` is restored to `pending_review` so the
  reviewer's link keeps working; a fresh shell becomes `generation_failed` with the
  error in `blocked_reason`.
- **Trigger unreachable** — shell `cancelled` (`research_trigger_failed`), inline draft
  inserted straight at `pending_review` without a brief.
- **Blocked** — `blocked_missing_thread` when the thread has no `reply_to_uuid` /
  `eaccount` (never reaches the workflow).

Review-page actions: edit text, send (`sendInterestedAutoResponderDraftByToken` →
Instantly reply API, logs a `contact_instantly_events` row, may apply warm follow-up
status), cancel, regenerate (§2c).

---

## 6. Notes

- The generic user message asks for a "plain-text reply … do not use markdown", while
  both ESSENCE Retention prompts require valid HTML (`<p>` / `<a>`). The campaign
  system prompt governs in practice and the review page renders HTML; the plain-text
  line is legacy wording from before HTML prompts.
- ESSENCE AI Email Generation's Calendly URL is templated inside the prompt itself
  (`{{email}}`, `{{company_domain}}`, `{{first_name}}`); Cut Klaviyo Bill uses the
  code-built `{{booking_url}}`. Neither goes through `applyReplyLinkPlaceholders`.
- The brief's `Estimated site visitors` line is `reviewCount × 100`
  (`VISITORS_PER_REVIEW`) unless the brief carries an explicit `estimatedVisitors`.
- Every interested reply on this client costs one Serper batch (3 queries) and two
  OpenAI calls (brief + reply), plus a third OpenAI call and one popup-generate call
  when the model decides a store preview is warranted.

## 7. Levers

| Env var | Default / effect |
| --- | --- |
| `WORKFLOW_TRIGGER_SECRET` | required for the research path; bearer on the start route |
| `INTERESTED_RESEARCH_WORKFLOW_DISABLED` | `"true"` forces the inline path |
| `WORKFLOW_START_URL` | overrides `APP_URL` for the trigger |
| `INTERESTED_RESEARCH_MODEL` | `gpt-5.5` — brief synthesis |
| `INTERESTED_AUTORESPONDER_MODEL` | `gpt-5.5` — reply generation |
| `INTERESTED_RESEARCH_HOMEPAGE_TIMEOUT_MS` | 15 000 |
| `INTERESTED_RESEARCH_SERPER_TIMEOUT_MS` | 20 000 |
| `INTERESTED_AUTORESPONDER_POPUP_TIMEOUT_MS` | 90 000, × 2 attempts |

Per-agency flags in `agency_settings.features`: `replyResearchAgent` (workflow path),
`autoresponderShoppingAudit` (Vulcan audit CTA — not set for ESSENCE Retention).

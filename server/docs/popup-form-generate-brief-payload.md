# Popup-Form Generate API — Research-Brief Payload

**Audience:** the `essence-retention-ai-popup-demo` codebase team
**From:** shields-outbound (the caller of your `/api/popup-form/generate` endpoint)
**Status:** shields is **already sending** the new fields in production (2026-08-10). Your side currently ignores them; this doc specifies how to use them.

## Background

When a cold-email lead replies "interested," shields-outbound now runs a research
workflow that reads the lead company's homepage and recent web results, then
synthesizes a structured brief (industry, summary, talking points). Until now,
your generate endpoint received only a bare `domain` and had to rediscover the
company from scratch. Shields now forwards the brief context so the popup can be
personalized with better inputs: correct vertical/template choice, the company's
real display name, and specific hooks for copy.

## Endpoint (unchanged)

```
POST /api/popup-form/generate
Host: essence-retention-ai-popup-demo.vercel.app
X-API-Key: <existing key>
Content-Type: application/json
```

No URL, auth, or response-contract changes. This is a request-body extension only.

## New request payload

### Full example (research brief available — the common case)

```json
{
  "domain": "wildorchard.com",
  "industry": "food_beverage",
  "companyName": "Wild Orchard Tea",
  "summary": "Sells regenerative, hand-picked teas from Jeju Island direct-to-consumer. Recently launched a ceremonial matcha line covered in Food & Wine.",
  "talkingPoints": [
    "First regenerative-certified tea brand",
    "New ceremonial matcha launch, Jan 2026",
    "Featured in Food & Wine"
  ],
  "reviewCount": 1240,
  "siteTraffic": 124000
}
```

### Minimal example (no brief — legacy callers, thin research, non-flagged agencies)

```json
{
  "domain": "wildorchard.com"
}
```

### Field reference

| Field | Type | Presence | Meaning |
|---|---|---|---|
| `domain` | string | **always** | Bare host, lowercased, no `www.` (e.g. `wildorchard.com`). Same as today. |
| `industry` | string | optional | One of the 12 enum values below. **Omitted** (not null, not `"other"`) when no category clearly fits — never guess a fallback template from a missing value; use your current domain-discovery behavior instead. |
| `companyName` | string | optional | Display name from research (e.g. `Wild Orchard Tea`). More reliable than deriving from the domain. |
| `summary` | string | optional | 2–4 sentences: what they sell, to whom, anything notable/recent. Max 2,000 chars. LLM-written from scraped homepage + search results — treat as informative, not verbatim marketing copy. |
| `talkingPoints` | string[] | optional | Up to 6 short, specific, research-verified hooks. Only sent when non-empty. |
| `reviewCount` | number | optional | Published site/store review total when research found an explicit count (Trustpilot / Google / on-site aggregate). Omitted when unknown — never invented. |
| `siteTraffic` | number | optional | Rough monthly visit estimate: `reviewCount × 100` (research brief field `estimatedVisitors`). Only sent when a review count is known. Stored on `popup_leads.site_traffic` for the preview growth calculator; treat as an order-of-magnitude proxy, not analytics. |

Every optional field is **independently** optional — you may receive `domain` +
`industry` with nothing else, or `domain` + `summary` without an industry.
Design the handler as: *use what's present, fall back to current domain-only
discovery for what's absent.*

### `industry` — allowed values (closed enum)

```
beauty_skincare
fashion_apparel
food_beverage
health_wellness
home_garden
electronics
automotive
pets
sports_outdoors
jewelry_accessories
kids_baby
gifts_collectibles
```

Shields validates against exactly this list before sending — you will never
receive a value outside it (off-list classifications are dropped and the field
omitted). If you add or rename verticals on your side, tell the shields team so
`RESEARCH_INDUSTRIES` (`server/src/services/interestedResearch/briefUtils.js`)
is updated in the same change; the two lists must stay identical.

### Legacy fields (unchanged, mutually exclusive with brief fields in practice)

`signalEmissionId`, `signalType`, `observed`, `expected` still exist for the old
shopping-preview variant. Shopping-audit agencies now route to Vulcan instead of
this API, so in practice you'll see the brief fields on list-growth requests and
the signal fields rarely or never. No action needed.

## Requirements on your handler

1. **Do not reject unknown keys.** If your body validation is strict
   (e.g. zod `.strict()`), the new payload will 400 and shields will fall back
   to sending replies **without any popup** — a silent product regression.
   Verify this first; it's the only way this change can break you, and shields
   is already sending the fields.
2. **Backward compatible:** `{ "domain": "..." }` alone must keep working
   forever. Shields intentionally degrades to it when research is thin.
3. **Suggested use of the fields:**
   - `industry` → template/vertical/imagery selection.
   - `companyName` → headline and copy (instead of a capitalized domain label).
   - `summary` / `talkingPoints` → offer copy, incentive phrasing, or your own
     generation prompt context.
   - `siteTraffic` (and optionally `reviewCount`) → seed `popup_leads.site_traffic`
     / growth calculator when present; fall back to your existing defaults
     when absent.
4. **Idempotency / duplicates:** shields retries on 429/5xx/network failure
   (max 2 attempts, 1–2s backoff, 90s timeout per attempt). The same domain may
   also legitimately recur (same lead interested in a new campaign). Repeat
   generate calls for a domain must be safe.

## Response contract (unchanged — important)

Shields **ignores your response body**; it checks only the HTTP status
(2xx = success). The preview URL is constructed on the shields side as:

```
https://essence-ai.app/preview?domain=<domain>
```

and placed in the reply email. So the contract remains: *by the time a 2xx is
returned (or shortly after), the personalized popup must be resolvable at that
preview URL for the given domain.* If you ever want to return a different/
custom preview URL per request, that's a coordinated contract change — talk to
the shields team first.

## Rollout / sequencing

- Shields-side is **live now**: payloads with brief fields are already arriving
  for research-enabled agencies. Requests from non-enabled agencies still send
  domain-only.
- Your change is safe to ship independently at any time (read the new fields,
  fall back when absent).
- No versioning header; the payload is additive by design.

## Questions / sync points

- Enum changes → must be mirrored in shields `RESEARCH_INDUSTRIES` (same PR-day).
- Wanting more brief data (e.g. sources, risks)? Shields stores the full brief
  per draft (`interested_autoresponder_drafts.research_brief`) and can forward
  additional fields — ask, don't scrape.

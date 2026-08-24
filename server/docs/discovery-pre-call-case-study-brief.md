# Discovery Pre Call — missing industry case studies

Need 7 industry case studies for the Discovery Pre Call email (email 3).

Beauty & skincare is done (Aer Cosmetics). Do **not** rewrite that one. Produce one case study each for:

- `fashion_apparel` (also the **fallback** for home_garden, automotive, sports_outdoors, kids_baby, and unknown — pick a strong, broadly relatable DTC brand)
- `food_beverage`
- `health_wellness`
- `electronics`
- `pets`
- `jewelry_accessories`
- `gifts_collectibles`

These go into Resend templates, one per industry. Same shape as Aer. Output a JSON array of 7 objects, no extra commentary.

## Schema (match Aer exactly)

```json
{
  "code": "fashion_apparel",
  "name": "fashion & apparel",
  "brandName": "",
  "logoUrl": "https://... real hosted image URL, not needsUrl",
  "about": "One sentence. What they sell and where.",
  "beforeStory": "2–3 short paragraphs. Starting point: missing flows, weak list growth, low Klaviyo % of revenue, bandwidth. Use real numbers.",
  "resultSubtext": "Here's what we made happen in the first 6 months",
  "resultHeadline": "Punchy result, e.g. 11X in YoY Revenue — no wrapping quotes",
  "resultCards": [
    { "value": "+540%", "name": "Increase in Total Sales", "color": "green", "icon": "shopify.png" },
    { "value": "37%", "name": "% of Revenue Driven from Klaviyo", "color": "green", "icon": "klaviyo.png" },
    { "value": "39%", "name": "First Customer Repurchase Rate", "color": "green", "icon": "repeat" }
  ],
  "implementationIntroHeadline": "Before, {Brand} started from a very different point",
  "metricsCardsBefore": [
    { "name": "Revenue Driven from Klaviyo", "value": "< 10%", "color": "red", "icon": "klaviyo.png" },
    { "name": "Repurchase Rate", "value": "11%", "color": "red", "icon": "repeat" },
    { "name": "Core Flow Coverage", "value": "1/8", "color": "red", "icon": "flow" }
  ],
  "implementationHeadline": "Here's What We Did:",
  "implementationStory": "Three sections with markdown headings:\n\n**1. List Growth**\n\n...\n\n**2. The Flow System**\n\n... include the core flows you built, named and one-line each ...\n\n**3. The Campaign System**\n\n...",
  "testimonialPersonName": "optional, omit if none",
  "testimonialVideoLink": "optional https URL, omit if none"
}
```

## Rules

- Real Essence Retention clients only. Do not invent brands, metrics, or logos.
- `code` must be exactly one of the 7 slugs above.
- `name` is the human label (e.g. `food & beverage`).
- `resultCards` and `metricsCardsBefore` are always **3 items**.
- `logoUrl` must be a real absolute HTTPS image (PNG/JPG). If you don’t have one, set `"logoUrl": null` — never `"needsUrl"`.
- Keep `beforeStory` under ~600 characters. Keep each of the three `implementationStory` sections under 2,000 characters (Resend template variable cap, in case we flatten later).
- Tone: same as Aer — direct, operator, numbers, no fluff.
- `icon` is a hint only (`shopify.png`, `klaviyo.png`, `repeat`, `flow`). Don’t depend on files we don’t host.
- If you don’t have a real case study for an industry, return that object with `"missing": true` and `"reason": "..."` instead of fabricating one. Fashion cannot be missing — we need a fallback.

## Aer reference (beauty_skincare) — copy this structure, not the brand

- Brand: Aer Cosmetics, US premium mascara
- Before: 11% repurchase, Shopify welcome of 2 emails, no cart/checkout/replenishment, stagnant list, Klaviyo < 10% of revenue
- After (6 months): 11X YoY revenue; +540% total sales; 37% Klaviyo revenue; 39% first-customer repurchase
- What we did: popups to 22% submit; Premium Primer welcome + 7 core flows; campaign reputation + personalization + A/B tests

Return only the JSON array of 7 objects.

# Shields Outbound — Shopping Audit language

Domain language for the shopping-ad audit enrichment pipeline and its export fields.

## Language

**Ad title**:
The raw product title from the matched Shopping ad card (`ad_observations.matched_card.title`, also copied to `signal_emissions.observed.ad_title`).
_Avoid_: Product title (that may mean the catalog/feed title)

**Human ad title** (`human_ad_title`):
An LLM rewrite of the **Ad title** into how a person would naturally say the product name. Lowercase; keep product/brand identity; drop promo/occasion noise; reorder for speech; soft ~6–10 word cap. Export-only. Stored on `ad_observations.human_ad_title`.
_Avoid_: Spoken title, friendly title, naturalized title, product_short

**Product short** (`product_short`):
A 1–3 word generic category name for signal email templates (e.g. "socks"). Strips brand. Distinct from **Human ad title**; produced during personalization.
_Avoid_: Short title, product nickname, human_ad_title

**Human Ad Title stage**:
Always-on shopping-audit enrichment step after Serper Shopping (UI card visible). One `gpt-5.4-nano` (or similar) call per matched **Ad title**; on failure, deterministic cleanup fallback. Writes `ad_observations.human_ad_title`.
_Avoid_: Personalization, title cleanup, optional toggle

## Relationships

- An **Ad title** may produce one **Human ad title** (export artifact) in the **Human Ad Title stage** — only when Serper matched an ad
- An **Ad title** / feed title may produce one **Product short** (template variable) during personalization
- **Human ad title** and **Product short** are siblings, not substitutes
- **Human Ad Title stage** runs after Serper Shopping and before Signal Waterfall
- Domains with no matched ad do not get a **Human ad title**
- **Human ad title** is stored on `ad_observations.human_ad_title` and exported as a shopping-audit CSV column

## Example dialogue

> **Dev:** "Should we generate `human_ad_title` in personalization with `product_short`?"
> **Domain expert:** "No — it's its own stage after Serper Shopping, cheap model, column on `ad_observations`, export only."

## Flagged ambiguities

- "product title" was used for both catalog feed title and Shopping ad title — prefer **Ad title** vs feed/catalog title.
- Placing the stage "after Serper Shopping" means input is the matched Shopping card title, not the waterfall's final signal product field (those can diverge when feed title is preferred).
- Persist location resolved: `ad_observations.human_ad_title` (not `export_vars`).
- Rewrite contract resolved: lowercase; keep identity; drop promo/occasion noise; reorder for speech; ~6–10 words (not `product_short`'s 1–3 generic words).
- On LLM failure: fall back to a light deterministic cleanup of the raw **Ad title** (lowercase, strip promo/occasion tails) — never block the pipeline; prefer a cleaned title over blank or raw shouty text.
- Always-on for shopping-audit jobs; UI shows a **Human Ad Title** stage card between Serper Shopping and Signal Waterfall.
- Surfaces: shopping-audit **CSV column** and **Instantly custom variable**; not used in signal email templates (those stay on `product_short` / existing vars).

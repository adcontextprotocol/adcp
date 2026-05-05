---
---

Publisher page now leads with what AAO actually found at the publisher's
origin, and a human visit triggers an auto-crawl when we don't have
fresh data. Setup advice is demoted into a collapsible panel.

Why
---

The previous page led with hosting-model framing ("AAO-hosted",
"Self-hosted", "Not yet configured") even when the publisher already
had a working `adagents.json` and `brand.json`. The actual signal a
publisher (or a buyer) wants to see is "you have a valid adagents.json,
N agents are authorized" — celebrate the record, not lecture about
hosting models.

What changed
------------

**API**
- New `files: { adagents_json: { status, expected_url }, brand_json:
  { status, name? } }` block on `/api/registry/publisher`. Status is
  one of `valid` / `invalid` / `unknown` / `checking` (or
  `present` / `unknown` / `checking` for brand).
- New `auto_crawl_triggered: true` flag set when the request kicked off
  a background fetch of the publisher's `/.well-known/adagents.json`
  and `/.well-known/brand.json`. Debounced 5min/domain so a tight
  refresh loop doesn't hammer the crawler.
- Auto-crawl fires when `adagents_valid === null` (never crawled) OR
  no brand record exists. Fire-and-forget — the response returns
  immediately.

**Page (`/publisher/:domain`)**
- New hero "What we found at this domain" panel as the page lead.
  Renders one card per file we checked: green check + counts when
  valid, red ! with validation errors link when invalid, spinner when
  checking, neutral em-dash with builder CTA when never set up.
- Hosting setup details now live in a `<details>` collapsed by default
  when the publisher already has a working file; auto-expanded when
  `mode === 'none'` or `'self_invalid'` so setup advice stays visible
  for publishers who need it.
- Page polls itself ~4s after an auto-crawl trigger so the spinner
  cards refresh into real content without a manual reload.
- The cold-state "explainer" banner is retired — the hero panel
  handles cold-visitor context inline alongside the file cards.

Tests
-----

2 new integration tests: auto-crawl flag set on first lookup of an
unknown domain, debounce on second hit, files.brand_json.status mirrors
the brand record. 56 total pass across the related set.

Smoke
-----

Playwright across three persona states (brand-only, AAO-hosted,
cold visitor) — hero cards render correctly, hosting panel auto-opens
when nothing's set up and stays collapsed when there's a working
record. Zero console errors.

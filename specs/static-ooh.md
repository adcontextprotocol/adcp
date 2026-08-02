# Static OOH

**Status**: Draft — for discussion with AdQuick and the Media Buy working group

## Problem

The protocol claims out-of-home coverage (`ooh` exists in `channels.json` and the media channel taxonomy) but only implements digital out-of-home. The DOOH channel guide requires an `impression_tracker` on every format and grounds billing in pixel fires. A printed bulletin has no play event, no tracker to fire, and no ad server — so static OOH, which delivers roughly 3x the impressions of DOOH and pDOOH combined, cannot be transacted through the protocol at all.

Static OOH is not an exotic channel. It has:
- standardized formats with physical dimensions (OAAA Standard OOH Media Formats)
- a standard transaction structure (unit × posting period × GRP level, from the OAAA model contracts)
- a standard measurement currency (Geopath in the US; Route UK, MOVE AU, COMMB CA)
- a standard verification convention (proof-of-performance photos)

None of this has ever been expressed as a machine-readable protocol. The nearest prior art, IAB Tech Lab's OpenDirect 2.1 (October 2024, built with OAAA/OMA/Outsmart to cover classic and digital OOH), validates the architectural choice — reserved, order-based, seller-approved trading, which is what AdCP already is — but is a CRUD order-management API with thin adoption. The vocabulary is worth borrowing; the transport is not.

## Design Principles

1. **Static OOH is broadcast-shaped, not DOOH-shaped.** The broadcast channel guide already established the pattern for channels without trackers: the absence of a tracker slot in `format.assets` is the machine-readable signal, and measurement comes from the vendor named in `measurement_terms.billing_measurement`, with `measurement_windows` governing when numbers finalize. Static OOH gets the same treatment with an audience currency (Geopath/Route/MOVE/COMMB) as the vendor.

2. **Delivery is a modeled audience estimate, not a count.** A posted bulletin has one continuous exposure over its posting period. The only honest delivery number is the measurement currency's modeled impressions for that panel and period (e.g., Geopath weekly impressions per Spot ID). The protocol should carry the number, the provider, and the methodology reference — never pretend it was event-counted.

3. **The measurement currency is data, not schema.** Geopath is being replaced (OAAA selected Ipsos for a pilot in H2 2026; transition begins 2027). Route, MOVE, and COMMB all differ in detail but share the shape {provider, panel reference, period, modeled impressions, demographic}. `billing_measurement` already models pluggable vendors; static OOH must not hardcode any of them.

4. **Codify the OAAA contract conventions, don't invent new ones.** The Bulletin and Poster Net Contracts already define proof-of-performance obligations, posting leeway, material deadlines, and makegood conventions that the entire US industry mirrors. The protocol's job is to make those conventions machine-readable, with real transactions (AdQuick's) as the check that the templates match practice.

5. **Reuse the machinery that already exists.** Print asset requirements (`min_dpi`, `bleed`, `color_space`, physical dimension units), the installment/material-deadline model, time-based and flat-rate pricing, billing authority modes, and `is_final`/`measurement_window` delivery finality all exist today. Static OOH is mostly a channel guide plus a small number of schema additions, not a new subsystem.

## Proposal

### 1. An `ooh` channel guide

`docs/creative/channels/ooh.mdx`, following the broadcast guide's structure: what a static format looks like, what is absent (no `impression_tracker`, no `click_url`, no playout), how a buyer detects this (no tracker slot in `format.assets`), and how measurement and billing work (`billing_measurement` naming the audience currency, weekly measurement windows, `is_final` on delivery rows).

The DOOH guide keeps its tracker requirement — digital screens genuinely have play events. Its "Static Billboard Manifest" heading (which today requires a tracker pixel) should be renamed or removed; "static" there means a non-animated image on a digital screen, which is a different thing from a printed unit.

### 2. Static format definitions

Formats seeded from the OAAA Standard OOH Media Formats table, in the four OAAA categories (billboard, street furniture, transit, place-based). Initial set: bulletin (14'×48'), large bulletin (20'×60'), junior bulletin, poster, junior poster (5'×11'), wall mural, bus shelter panel (67"×46"), bus king (30"×144"), bus queen, rail one-sheet/two-sheet, taxi top, airport diorama.

Each format is `format_kind: "image"` with physical dimensions (existing `inches`/`cm` units), consistent with canonical-formats v2's decision that DOOH and print refine `image` rather than getting their own kind. Asset requirements come from the OAAA Print Production Specifications: CMYK `color_space`, bleed, and effective resolution at full printed size (18–25 ppi roadside, 80–100 ppi transit — expressed through the existing `min_dpi` requirement). Production overage (extra printed copies for repostings; 15–100% for transit per four-week period) is a product-level attribute, not a format attribute.

### 3. Posting periods on the installment model

The installment/material-deadline model (`installment.json`, `material-deadline.json`) was built for print issues and podcast episodes and already carries `scheduled_at`, booking/cancellation deadlines, and material deadlines. A static OOH flight is a sequence of posting periods, each an installment:

- `scheduled_at` = the in-charge / scheduled posting date
- material deadlines from the OAAA conventions: printed materials ≥5 business days before posting, painted bulletins 30 days
- new fields needed:
  - `posting_leeway_days` — the customary 5-business-day window in which the operator completes posting
  - `posted_at` (reported, per unit or averaged) — the actual posting date; per the OAAA contracts, the display term runs from the average posting date, so late posting extends the flight rather than shortening delivery

Posting periods should be nameable against published industry calendars (US 13 × 4-week periods; UK Outsmart two-week cycles with in-charge dates published through 2028) rather than only arbitrary date ranges. The calendar itself is market data the seller exposes on the product, not a protocol registry.

### 4. Delivery reporting for modeled audiences

- Add `weekly` to `reporting-frequency.json` — Geopath and its international peers report weekly increments; hourly/daily static numbers would be fabricated precision.
- Delivery rows carry modeled impressions attributed to the vendor in `billing_measurement`, with `is_final`/`measurement_window` semantics unchanged from broadcast.
- Replace prose-only methodology (`calculation_notes`) with a structured reference: {provider, methodology version, panel reference}. This also resolves an existing latent issue — two schema descriptions reference an "impression multiplier" that has no field anywhere. For DOOH the multiplier can stay implicit behind observable plays; for static the modeled number is the entire delivery and must be attributable.
- A per-unit breakdown (by panel) in delivery responses. `venue_breakdown` exists today but is nested inside `dooh_metrics` and unreachable for a channel that has no plays.

### 5. Proof of performance

A seller-attested evidence artifact on delivery, codifying the OAAA contract clauses:

- **Bulletins**: one photo per unit within 5 days of posting, and again after each rotary rotation.
- **Posters (showings)**: one representative close-up per creative variation.
- Each photo carries capture timestamp, GPS coordinates, and the unit reference — the enhanced-POP bar third-party auditors (OOH Audit, FotoFetch) already apply.

Shape: a `posting_evidence` array associated with the package/period in delivery responses — `{unit_ref, photo_url, captured_at, lat/long, evidence_type: posted | rotated | repaired}` — with the SLA declared on the product. This is the static analogue of proof-of-play, and it is the piece no existing standard has ever made machine-readable.

### 6. Identity and authorization

- Add `ooh` to `property-type.json`. The media channel taxonomy currently excludes it ("physical inventory lacks digital identifiers"), which is factually wrong — static panels are identified by operator panel numbers and measurement-currency IDs (Geopath Spot IDs), and the OAAA contracts key line items on exactly that pair. Without a property type, static inventory has no `adagents.json` authorization path.
- Identifier types, following the `station_id`/`facility_id` pattern from broadcast: `panel_id` (the operator's unit identifier — the name both sides of the transaction know) and a measurement reference in `{authority}:{id}` form (`geopath:30123`, `route:…`, `commb:…`) for cross-referencing into the audience currency. `venue_id` and `openooh_venue_type` already exist as identifier types and remain valid for venue classification, with the caveat that OpenOOH formally scopes itself to digital screens — worth raising a static extension with that working group rather than forking the taxonomy.

## What We're Not Adding

### Play-event emulation

No synthetic trackers, no "fire a pixel when posted." The broadcast pattern exists precisely so channels without events don't have to fake them. IAB's own DOOH definition (Dec 2024) draws the line explicitly: static signage is not DOOH.

### RTB semantics

OpenRTB 2.6's DOOH mechanics (`imp.qty` multiplier, `imp.dt`, `burl` on render) all assume per-play decisioning. Static is decided weeks ahead, installed once, and immutable for the flight. The industry's own answer for static was OpenDirect (guaranteed orders), not OpenRTB.

### OpenDirect's transport

We borrow vocabulary (lead times, flight bounds, frame references, proof-of-posting as a first-class statistic), not the REST/CRUD order-management API. AdCP's existing media-buy lifecycle already covers avails → create → approval → delivery.

### A posting-calendar registry

Industry calendars (US 4-week, UK 2-week) are market conventions the seller declares on products. A protocol-maintained calendar registry is over-engineering and goes stale.

### Production and installation workflow states

Print production, shipping, and crew scheduling are the operator's fulfillment problem. The protocol needs the deadlines (materials due), the outcome (posted, with evidence), and the remedies (makegoods) — not a state machine for the print shop. If real transactions show buyers need mid-fulfillment visibility, revisit.

### GRP/showing-based buying in v1

The OAAA poster contract structure (4-week GRP levels across a rotating pack of panels) is real, but unit-based buying covers bulletins and most marketplace transactions today. Showings add a layer of indirection (buy audience level, seller allocates panels) that should be designed against real avails data from AdQuick rather than guessed at.

## Open Questions (for AdQuick / the working group)

1. **Unit identity in practice** — across 1,700+ media owners, what does AdQuick key units on? Operator panel numbers, Geopath Spot IDs, internal IDs? How stable are operator IDs?
2. **Markets without a currency** — AdQuick operates in 38 countries; many have no Geopath equivalent. What do they report as delivery there, and does the protocol need an "operator-estimated" methodology tier below vendor-attested?
3. **Rotary bulletins** — rotation schedules are contractual today. Do rotations need protocol representation (they change the panel, hence the audience number, mid-flight), or is per-period reporting sufficient?
4. **Makegoods** — lost units, illumination failures, damage. Which remedies need protocol states (substitute-unit approval is buyer-facing) versus staying in `update_media_buy` negotiation?
5. **Materials responsibility** — OAAA contracts assume the buyer ships printed materials; marketplaces often broker production. Does production brokerage change what deadlines the protocol carries?
6. **pDOOH overlap** — AdQuick also exposes 3M+ programmatic screens. Nothing here should complicate their DOOH integration; confirm the boundary (dooh channel for screens, ooh channel for printed units) matches how they model inventory.

## References

- OAAA Standard OOH Media Formats — https://oaaa.org/wp-content/uploads/2022/09/Standard-OOH-Media-Formats.pdf
- OAAA Print Production Specifications — https://oaaa.org/wp-content/uploads/2022/09/Print-Production-Specifications3.pdf
- OAAA Bulletin Net Contract — https://oaaa.org/wp-content/uploads/2022/09/Bulletin-Net-Contract.pdf
- OAAA Poster Net Contract — https://oaaa.org/wp-content/uploads/2022/09/Poster-Net-Contract.pdf
- OAAA OOH Glossary — https://oaaa.org/resources/ooh-glossary-of-terms/
- IAB Tech Lab OpenDirect 2.1 — https://github.com/InteractiveAdvertisingBureau/OpenDirect/blob/main/OpenDirect.v2.1.final.md ; OAAA announcement — https://oaaa.org/news/digital-out-of-home-integration-into-opendirect/
- IAB DOOH Definition (Dec 2024, static exclusion) — https://www.iab.com/wp-content/uploads/2024/12/IAB_DOOH_Definition_December_2024.pdf
- OpenOOH Venue Taxonomy — https://github.com/openooh/venue-taxonomy
- Geopath methodology and glossary — https://support.geopath.io/hc/en-us/articles/360001845811-Methodology ; https://geopath.org/glossary/
- OAAA/Geopath → Ipsos measurement transition — https://oaaa.org/news/ooh-industry-advances-effort-to-modernize-audience-measurement-and-selects-ipsos-for-pilot-program/
- Outsmart Posting Cycle (UK in-charge calendars) — https://www.outsmart.org.uk/resources/posting-cycle
- WOO Global Audience Measurement Guidelines 2.0 — https://www.worldooh.org/news/audience-measurement-global-guidelines

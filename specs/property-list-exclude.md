# Property List Exclude

**Status**: Draft

## Problem

Property lists are include-only. `targeting_overlay.property_list` runs a package
on the intersection of the product's `publisher_properties` and the list. There
is no `property_list_exclude`, so a buyer can say "only run on these properties"
but not "never run on these."

This is the last **list construct** following the include/exclude pair convention
that lacks its exclude twin. (`device_platform` and `language` also lack
`_exclude`, but those are scalar dimensions — the paired convention applies to
geo ×4, audience, `device_type`, and `collection_list`.) Property lists, the
oldest list construct (#927, before the pair convention existed), never got their
exclude twin.

The gap is narrower than it looks. The governance layer already supports
exclusion end to end:

- The `property-lists` specialism is described as "curated inclusion **and
  exclusion** lists for targeting and delivery compliance"
  (`enums/specialism.json`).
- A property list is **polarity-neutral** — it is a set of properties, and
  polarity is assigned by which targeting field references it. So a buyer can
  host the 65k blocklist today; the only missing piece is a targeting-overlay
  field to reference it as an exclude.

The spec already anticipates adding it
(`specs/collection-lists.md`, `docs/governance/collection/index.mdx`):

> "Property lists were designed before the include/exclude pattern was
> established across other targeting dimensions (geo, audience, device).
> Collection lists follow the current pattern. A future protocol evolution may
> add `property_list_exclude` for symmetry."

Concretely: a buyer with a 65k domain+app brand-safety blocklist can host it
today — the only missing piece is a targeting-overlay field to attach it to a
media buy. A property blocklist also maps cleanly to seller-side `badv`/`bapp`
deny-lists that GAM, Kevel, and DSPs already support; content standards has no
clean OpenRTB block-list equivalent.

## Design Principles

1. **Mirror `collection_list_exclude`.** Same ref type
   (`property-list-ref.json`), same exclude-wins semantics, same capability
   story. No new concepts, no new schemas.
2. **Exclude wins on overlap.** When `property_list` and `property_list_exclude`
   are both present, include applies first, then exclude removes matches from the
   effective served set. Same ordering collection lists use.
3. **Exclusion is a safety control, not a targeting optimization.** Unlike
   `property_list`, exclusion is NOT gated by the product's
   `property_targeting_allowed` flag. That flag exists so sellers can forbid
   *subsetting* an all-or-nothing product for targeting. A brand-safety block is
   not subsetting for optimization; a buyer must be able to drop unsafe inventory
   even from a product that disallows property targeting. Exclusion is honored
   where honorable: when exclusion would break a fulfillment commitment or empty
   the buy entirely, the seller MUST be able to reject or requote (the
   `REQUOTE_REQUIRED` error code, `enums/error-code.json`, already used on
   `update_media_buy` when a change alters the parameter envelope the quote was
   priced against, `update_media_buy.mdx:603`).
   _Open Q2: WG confirmation needed on the exact trigger condition._
4. **Fail loud, backed by capability.** A seller that has not declared support
   for `property_list` and `property_list_exclude` in `get_adcp_capabilities`
   MUST reject a buy carrying these fields rather than accept and ignore them.
   This anchors to the generalized fail-loud MUST in `get_adcp_capabilities.mdx`
   once that rule is broadened to cover all targeting-overlay list dimensions
   (see Capability Declaration). Silently dropping a brand-safety control is the
   dangerous failure mode: for an include list a silent miss over-restricts
   (safe), for an exclude list it under-restricts (unsafe).

## Schema Change

Add to `static/schemas/source/core/targeting.json`, adjacent to `property_list`:

```json
"property_list_exclude": {
  "$ref": "/schemas/core/property-list-ref.json",
  "description": "Reference to a property list whose properties must not carry the buyer's ads. Use for brand-safety do-not-run lists (apps, sites). Exclude wins on overlap with property_list, and applies regardless of the product's property_targeting_allowed flag. Seller must declare support in get_adcp_capabilities."
}
```

Reuses `property-list-ref.json` unchanged (`agent_url`, `list_id`, optional
`auth_token`). No new schema files.

## Enforcement

Identical to the existing property-list model; no new enforcement machinery.
Governance agents are NOT in the real-time bid path
(`docs/governance/property/tasks/property_lists.mdx`):

1. **Setup time** — the seller fetches and caches the resolved exclude list from
   the governance agent at buy creation.
2. **Bid time** — the seller fails any impression whose property is in the
   cached exclude set, using the local cache only (no governance call).
3. **Refresh** — re-fetch on `cache_valid_until`; the `property_list_changed`
   webhook signals an out-of-band update.

**Stale or unreachable cache:** For an exclude list, enforce last-known-good
(fail-closed toward the blocklist). `REFERENCE_NOT_FOUND` or an unreachable
governance agent MUST cause the buy to be rejected; do not proceed without
exclusion applied.

**Zero-delivery edge:** If exclusion eliminates all inventory for the buy, the
seller MUST reject or requote — not silently fill with zero impressions.

**Scale:** A 65k-entry exclusion list is a different order of magnitude than
typical inclusion sets. Sellers declaring support should account for cache
footprint, `property_list_changed` refresh latency, and matching cost.

**Coverage receipt** (_see Open Q4 — required before the field ships_):
`collection_list_exclude` returns `matched_count`/`unmatched_entries`/
`filtered_count` at buy creation (`specs/collection-lists.md:356–361`). Without
a comparable receipt for `property_list_exclude`, a buyer with a 65k list cannot
distinguish "enforced my blocklist and matched 0 entries" from "matched 0 and ran
everywhere." The receipt shape for `create/update_media_buy` must be specced
before this field ships.

## Capability Declaration

Support is signalled through **explicit per-direction entries in the
`get_adcp_capabilities` targeting table**, following the
`keyword_targets`/`negative_keywords` precedent — each direction declared
explicitly (`get_adcp_capabilities.mdx:292–293`).

Do **not** rely on the `property-lists` specialism alone. An agent-level
specialism cannot give a buyer a per-field runtime signal; the buyer would only
discover non-support via rejection, or worse, silent ignore.

Do **not** reuse `property_list_filtering` (`media_buy.features`,
`get_adcp_capabilities.mdx:224`). That flag is scoped to the `property_list`
parameter in `get_products` (discovery-time filtering), not to serve-time
targeting-overlay enforcement.

**Required doc change:** Add `property_list` and `property_list_exclude` as
entries in the targeting capability table (`get_adcp_capabilities.mdx:284–293`),
and generalize the fail-loud MUST at `:298` from *"a geographic targeting level"*
to *"any targeting-overlay dimension, including property and collection lists."*
This gives Principle 4 a normative home in settled spec text and retroactively
closes the same gap in `collection_list_exclude` (see #5788).

## Relationship to Content Standards

Complementary, not overlapping. The boundary is the same one drawn for
collection lists (`specs/collection-lists.md:52`): if a decision can be made
from a property's declared metadata (domain, bundle id, store id) it is a
property-list filter; if it requires evaluating the actual content of an
impression it is a content-standards policy.

- `property_list_exclude` — structural, setup-time blocklist of known apps/sites.
  Maps cleanly to seller-side `badv`/`bapp` deny-lists (GAM/Kevel/DSPs all
  support this); content standards has no clean OpenRTB block-list equivalent.
- Content standards — per-impression runtime evaluation of ad-adjacent content.
  Statistical (fail-*unsafe* for a hard blocklist); cannot leave publisher walls.

The two mechanisms compose as different layers; they do not compete.

## Schema Changes Summary

- **Modified**: `core/targeting.json` — add `property_list_exclude` (one field).
- **Modified**: `docs/protocol/get_adcp_capabilities.mdx` — add `property_list`
  and `property_list_exclude` to the targeting capability table (`:284–293`);
  generalize the fail-loud MUST at `:298` to all targeting-overlay list
  dimensions.
- **New schemas**: none. Reuses `property-list-ref.json`.
- **Capability**: explicit per-direction entries in the targeting table (not via
  the `property-lists` specialism).

## Open Questions

1. ~~**Capability granularity.**~~ **Resolved** — use explicit per-direction
   entries in the `get_adcp_capabilities` targeting table (see Capability
   Declaration). Don't rely on the specialism; don't reuse
   `property_list_filtering`.

2. **`property_targeting_allowed` interaction** — _WG sign-off needed._ The
   spec's position (Principle 3): exclusion is ungated because it's a safety
   control, not a targeting optimization. WG needs to confirm: (a) that
   `property_targeting_allowed: false` does not block exclusion, and (b) the
   exact reject-or-requote trigger when exclusion breaks a fulfillment commitment
   or empties the buy. Proposed resolution: align with the `REQUOTE_REQUIRED`
   precedent in `targeting.json:144`.

3. ~~**Include/exclude precedence wording.**~~ **Resolved** — "include applies
   first, then exclude removes matches from the effective served set" (Principle 2,
   lifted verbatim from collection lists).

4. **Coverage receipt** — _Blocker. WG sign-off needed._ Spec the exclusion
   coverage summary returned at `create/update_media_buy` before the field ships
   (see Enforcement). Proposed shape: mirror `collection_list_exclude` receipt
   (`matched_count`, `unmatched_entries`, `filtered_count`).

5. **Single-ref vs array-of-refs** (brand + agency + desk layering). Shared open
   question with collection lists (`collection-lists.md:570`). Not resolved here;
   carry forward to the broader list-ref resolution.

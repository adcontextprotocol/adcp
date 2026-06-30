# Property List Exclude

**Status**: Draft

## Problem

Property lists are include-only. `targeting_overlay.property_list` runs a package
on the intersection of the product's `publisher_properties` and the list. There
is no `property_list_exclude`, so a buyer can say "only run on these properties"
but not "never run on these."

This is the last targeting dimension without an exclude counterpart. Geo,
audience, device, metros, and postal areas all expose the include/exclude pair.
Collection lists shipped both `collection_list` and `collection_list_exclude` in
#2005. Property lists, the oldest list construct (#927, before the pair
convention existed), never got their exclude twin.

The gap is narrower than it looks. The governance layer already supports
exclusion end to end:

- The `property-lists` specialism is described as "curated inclusion **and
  exclusion** lists for targeting and delivery compliance"
  (`enums/specialism.json`).
- `create_property_list` already accepts an exclude purpose, so a buyer can
  build and host a brand-safety exclusion list today.

The only missing piece is a targeting-overlay field to *reference* that exclude
list on a package. The spec already anticipates adding it
(`specs/collection-lists.md`, `docs/governance/collection/index.mdx`):

> "Property lists were designed before the include/exclude pattern was
> established across other targeting dimensions (geo, audience, device).
> Collection lists follow the current pattern. A future protocol evolution may
> add `property_list_exclude` for symmetry."

Concretely: a buyer with a 65k domain+app brand-safety blocklist can host it as
an exclude-purpose property list but has no way to attach it to a media buy.

## Design Principles

1. **Mirror `collection_list_exclude`.** Same ref type
   (`property-list-ref.json`), same exclude-wins semantics, same capability
   story. No new concepts, no new schemas.
2. **Exclude wins on overlap.** When `property_list` and `property_list_exclude`
   are both present, include applies first, then exclude removes matches. Same
   ordering collection lists use.
3. **Exclusion is a safety control, not a targeting optimization.** Unlike
   `property_list`, exclusion is NOT gated by the product's
   `property_targeting_allowed` flag. That flag exists so sellers can forbid
   *subsetting* an all-or-nothing product for targeting. A brand-safety block is
   not subsetting for optimization; a buyer must be able to drop unsafe
   inventory even from a product that disallows property targeting.
4. **Fail loud.** A seller that has not declared property-list-exclusion support
   MUST reject a buy carrying `property_list_exclude` rather than accept and
   ignore it. Silently dropping a brand-safety control is the dangerous failure
   mode; for an include list a silent miss over-restricts (safe), for an exclude
   list it under-restricts (unsafe).

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

This is the same resolve-cache-enforce loop that `property_list` and
`collection_list_exclude` already use.

## Capability Declaration

Support is signalled through the existing `property-lists` specialism, whose
description already covers inclusion and exclusion. The field description
restates "Seller must declare support in get_adcp_capabilities," matching
`collection_list_exclude`.

Note the existing `media_buy.features.property_list_filtering` boolean is scoped
specifically to "the property_list parameter in get_products" — it is a
discovery-time filter signal, not a targeting-overlay enforcement signal. Whether
targeting-overlay property lists (include and exclude) warrant their own explicit
capability flag, versus relying on the specialism, is an open question below.

## Relationship to Content Standards

Complementary, not overlapping. The boundary is the same one drawn for
collection lists (`specs/collection-lists.md`): if a decision can be made from a
property's declared metadata (domain, bundle id, store id) it is a property-list
filter; if it requires evaluating the actual content of an impression it is a
content-standards policy.

- `property_list_exclude` — structural, setup-time blocklist of known apps/sites.
- content standards — per-impression runtime evaluation of ad-adjacent content.

A do-not-run domain/app list is squarely metadata-based, so `property_list_exclude`
is the correct vehicle for it. Content standards remain the right tool for
nuanced adjacency rules that cannot be decided from an identifier alone.

## Schema Changes Summary

- **Modified**: `core/targeting.json` — add `property_list_exclude` (one field).
- **New schemas**: none. Reuses `property-list-ref.json`.
- **Capability**: none required; covered by the `property-lists` specialism.

## Open Questions

1. **Capability granularity.** Rely on the `property-lists` specialism alone
   (as `collection_list_exclude` relies on `collection-lists`), or add an
   explicit targeting capability so buyers can detect serve-time enforcement of
   targeting-overlay property lists distinctly from `get_products`
   `property_list_filtering`? Precedent is mixed: geo/audience declare support
   implicitly/once for both directions; `keyword_targets` / `negative_keywords`
   declare each direction explicitly.
2. **`property_targeting_allowed` interaction.** This spec's position is that
   exclusion is ungated (principle 3). Confirm sellers agree, since it diverges
   from `property_list`, which sellers SHOULD reject when
   `property_targeting_allowed: false`.
3. **Include/exclude precedence wording.** Adopt the exact "exclude wins on
   overlap, include applies first" language from collection lists so the two
   list types behave identically.

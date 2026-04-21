---
---

Storyboard consistency pass across `static/compliance/source/`:

- Normalize brand and agency domains to the RFC 2606 `.example` TLD: `acmeoutdoor.com` → `acmeoutdoor.example`, `amsterdam-steakhouse.com` → `amsterdam-steakhouse.example`, `pinnacle-agency.com` → `pinnacle-agency.example`, and fix the `acme-outdoor.example.com` typo (#2530).
- Fix `operator: <brand.domain>` in property-lists and collection-lists specialisms — these are meant to demonstrate an agency operating on behalf of a brand, not the brand operating directly. Use `pinnacle-agency.example` (#2533).
- Standardize buyer-side storyboards on the expressive `account: { brand, operator }` shape. Where steps already had an `account` block, drop the redundant top-level `brand`; otherwise promote the top-level `brand` into an `account` wrapper with `operator: "pinnacle-agency.example"` (#2528).

Purely mechanical: no runtime behavior change, both shapes still resolve to the same session key via `sessionKeyFromArgs`.

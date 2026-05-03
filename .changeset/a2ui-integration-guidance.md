---
---

docs(sponsored-intelligence): A2UI integration guidance — host/brand boundary, theming, user-action mapping

Adds `docs/sponsored-intelligence/a2ui.mdx` consolidating three open issues into a single integration page:

- **Host/brand boundary** ([#2919](https://github.com/adcontextprotocol/adcp/issues/2919)): structural invariant that disclosure surfaces (Sponsored, governance, regulatory) live in host chrome — the brand's A2UI tree cannot suppress, restyle, or impersonate them.
- **Brand theming** ([#2918](https://github.com/adcontextprotocol/adcp/issues/2918)): `brand.json` palette/typography → A2UI theme tokens, resolved by the host with accessibility floors enforced.
- **User-action measurement** ([#2920](https://github.com/adcontextprotocol/adcp/issues/2920)): A2UI `user-action` event flow, mapping to SI engagement metrics, who-fires-what.

Marked as draft pending working-group review. The structural-invariant wording and FTC/EU regulatory framing need legal/WG sign-off before promotion to normative spec.

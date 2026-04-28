---
---

Show the brand registry's hierarchy classification on the team page so org owners can see how their org is positioned and dispute incorrect classifications.

The auto-provision-subsidiaries toggle (#3430) only showed children — what's *below* the org. It hid two things owners care about:

1. The parent (if the registry classified them as a subsidiary of another brand). Without this, an `analyticsiq.com`-style org couldn't tell they were classified under Alliant.
2. The classification confidence and last-validated date — context owners need to judge whether the data is trustworthy enough to flip the auto-provision toggle on.

Changes:
- `GET /api/organizations/:orgId/domains` now returns `hierarchy_classification: { self: { domain, brand_name, confidence, last_validated }, parent: { domain, brand_name, last_validated } | null } | null`. Sourced from the `brands` table for the org's primary verified domain plus a self-join for the parent.
- `team.html` renders a "Brand registry classification" section above the auto-provision toggles: parent → you → children (subsidiaries). Each entry has a "Report wrong" `mailto:hello@agenticadvertising.org` link with a prefilled subject/body so registry corrections route into the existing support flow without new infrastructure.
- The inferred-subsidiaries panel inside the auto-provision toggle is now a thin pointer back to the hierarchy section (no duplication).
- Three new integration test cases cover the new shape: parent + self surfaced, parent null when no `house_domain`, hierarchy_classification null when there's no `brands` row at all.

Owners can now see and report registry errors before flipping on subsidiary auto-provisioning, closing the "black box" gap from #3430.

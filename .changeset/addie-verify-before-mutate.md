---
---

fix(server/addie): add phantom-object mutation guard and brand-ownership routing (closes #4281)

Third documented instance of Addie offering to mutate a named object that doesn't exist
("update the prospect record for X"), then escalating when she discovers she lacks the tool.

Root-cause fix: two new rules and a URL registry entry.

**`constraints.md` — "Verify Object + Tool Before Offering a Mutation"**
Hard prohibition: run the object-type-appropriate lookup tool before offering any state change.
If the object doesn't exist, ask a clarifying question. If the object exists but no write tool
is available, route to the self-serve surface rather than escalating. Explicitly overrides the
"escalate" step in "Never Claim Unexecuted Actions" for this pattern. Also governs neutral
declarative facts ("X is part of Y") — those are not mutation requests; acknowledge before asking.

**`behaviors.md` — "Brand-Ownership Intent: Route to Brand Builder"**
When a user states that a domain or company is owned by another org, route through
`parse_brand_properties`/`import_brand_properties` (if caller owns the brand domain) or
to the brand builder URL (if not). Never invent a "prospect record" for this intent.

**`urls.md` — add `agenticadvertising.org/brand-builder`**
Adds the brand builder to the canonical URL registry so the brand-ownership routing rule
can reference it. The page accepts `?domain=example.com` to pre-load a domain.

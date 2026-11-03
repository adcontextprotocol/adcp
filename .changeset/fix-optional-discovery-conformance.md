---
"adcontextprotocol": patch
---

Correct maintained discovery conformance without changing the 3.1 wire schemas.
Replace product-count assumptions with explicit negative-control exclusion,
requiring executable runner support before fixtures are seeded. Auction discovery
no longer requires optional price guidance: this fixture-backed flow chooses buyer
bids of 6 and 16 against the seeded floors of 5 and 15, then reallocates budgets
without changing accepted bids. Discovery binds the exact seeded products and
pricing options independently of catalog order through a wholesale read; a
curated brief may legitimately rank other products ahead of the fixtures.
If that discovery fails, skip the dependent creation and update steps.
The reference seller now echoes preserved bids in budget-update responses,
matching the existing main-line behavior.

Keep provenance checks behind their explicit 3.3 capability declaration, so
3.1-pinned sellers report that coverage unavailable instead of failing optional
policy publication. Retain complete 3.1 account references on audit queries and
consistent sandbox identity on auction fixtures. No new capability field is
added to the 3.1 schemas.

Bind canonical product-validation fixtures and vendor-metric catalog fixtures to
the same explicit sandbox account used by their product probes and buy requests,
so automatic seeding does not infer an account from unrelated sample requests.

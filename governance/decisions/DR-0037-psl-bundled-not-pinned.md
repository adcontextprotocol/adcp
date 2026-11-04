---
id: DR-0037
title: Verifiers bundle the Public Suffix List and refresh it through dependency updates; AdCP names no snapshot
class: normative
status: ratified
date: 2026-11-02
decided: 2026-11-02
decided_by: maintainer approval (PR #8702), on Konstantin Mirin's proposal in #8409
supersedes: DR-0023  # in part: spec R3a step 1's "pinned, dated" snapshot
refs: ["#8409", "PR #8702", "DR-0023", "adcp-client#3379", "adcp-client-python#1562", "adcp-go#590"]
dissent: none recorded
---

## Decision

eTLD+1 is computed with a Public Suffix List (PSL) that includes the ICANN and PRIVATE sections, is bundled with the verifier, and is never fetched at runtime. A host with no defined eTLD+1 has no trust record (R3a step 1, unchanged).

Verifiers refresh the list through normal dependency updates. AdCP names no reference snapshot, and two verifiers whose lists differ are not non-conformant against each other. `security.mdx` names no PSL library.

This amends the "pinned, dated snapshot" wording in spec R3a step 1, which DR-0023 ratified, and removes "two verifiers running different PSL versions are non-conformant against each other" from `security.mdx`. The rest of DR-0023 stands.

## Rationale

Two lists disagree only on suffixes added or removed between them, mostly in the PRIVATE section. The ICANN section changes too, through second-level suffixes under country-code TLDs; a new TLD changes nothing, because the PSL default rule already treats an unlisted TLD as a suffix. For an added suffix, the verifier with the older list derives the platform's trust record instead of the tenant's, and the platform's record doesn't list the tenant, so the claim fails closed. A grantee that list doesn't treat as a registrable domain covers no claim, which also fails closed.

The `brand_json_url` origin binding goes the other way. An older list gives two tenants of a newly listed platform one eTLD+1, so the binding passes for them without `authorized_operators[]` until the verifier updates. Every verifier behaved that way before the listing, and a pinned snapshot would keep the gap open until the next release.

A shared pinned snapshot wouldn't reduce the risk. The tenant-collapse risk comes from a stale list, and one snapshot per release makes every verifier equally stale for a release cycle. Naming one would cost a vendored list per release, a change in each SDK (Go would replace `golang.org/x/net/publicsuffix`), vectors, and upkeep, all to make verifiers agree on old data.

## Implications

**This record settles:**
- that AdCP publishes no PSL snapshot and no snapshot-specific vectors; the PSL vectors in `static/test-vectors/adagents-discovery-redirects.json` use suffixes every list agrees on;
- that a verifier keeps its list current through dependency updates, and the runtime-fetch ban stays;
- that the SDK tracking issues for a pinned snapshot (adcp-client#3379, adcp-client-python#1562, adcp-go#590) close without code changes.

**It does not settle** how often an SDK must refresh its list. That stays an SDK maintenance matter.

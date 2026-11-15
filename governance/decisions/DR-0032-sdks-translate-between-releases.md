---
id: DR-0032
title: SDKs negotiate a release per counterpart and translate between the minors of a major (withdrawn)
class: normative
status: superseded
date: 2026-11-09
decided: 2026-11-09
decided_by: WG session 2026-11-09
refs: ["PR #8519", "PR #8704", "#8433", "DR-0024", "DR-0034"]
superseded_by: PR #8704  # the rules under "What can change in a release" in docs/reference/versioning.mdx
dissent: none recorded
---

## Decision

Withdrawn before ratification. This record holds no rule, and its ID is not
reused.

PR #8519 proposed that an AdCP SDK negotiate a release with each counterpart
and translate between the minors of a major. The WG adopted the versioning
rules of PR #8704 instead. AdCP defines what goes on the wire. How an SDK
bridges a version gap is that SDK's documented behaviour.

## Rationale

Konstantin Mirin argued on #8519 that a standard defines the wire, not how a
library reaches it. Under the rules of PR #8704, a minor only adds, a replaced
field stays beside its replacement until the next major, and a field whose loss
would change a seller's commitment waits for a major or for a capability the
seller declares. Those rules leave nothing for the standard to say about
translation.

## Implications

- Cite `docs/reference/versioning.mdx`, not this record.
- Negotiation, `supported_versions`, the `adcp_version` echo, and served-release
  validation (DR-0024) are wire behaviour and are unchanged. So is serving a
  major-only request the oldest supported release (DR-0034).
- The negotiation vectors in #8433 stay in this repository. Conversion, refusal,
  and account-reduction vectors move to the SDK repositories that want them.
- The proposed text stays on PR #8519.

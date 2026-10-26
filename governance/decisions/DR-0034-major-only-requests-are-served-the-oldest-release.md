---
id: DR-0034
title: A request carrying only adcp_major_version is served the oldest supported release of that major
class: breaking
status: accepted
date: 2026-10-22
decided: 2026-10-26
decided_by: WG Session C, 2026-10-26
refs: ["#8373", "#8410", "DR-0024", "DR-0035"]
supersedes: DR-0024
dissent: none
---

## Decision

A request that carries `adcp_major_version` and no `adcp_version` is served the **oldest** release the server supports in that major, and the response echoes it. For a major-only `adcp_major_version: 3` request to a server supporting 3.0, that is 3.0. A buyer that wants a newer release's behavior sends `adcp_version`.

`adcp_major_version` is deprecated and is removed in 4.0 ([DR-0035]).

This replaces only the "Unpinned requests" paragraph of [DR-0024]. The rest of DR-0024 stands. A request carrying neither field is still served the server's default release.

## Rationale

Every 3.1+ SDK sends `adcp_version`, so in practice a major-only request comes from a 3.0 buyer, and its payload is 3.0-shaped. Serving it the oldest release reads the request in the shape it was written in, and answers in the shape the buyer can validate, which is what [DR-0024] demands of every pinned response. Serving the newest release instead answers a 3.0 buyer with a 3.2 response that a strict 3.0 validator rejects (closed shared types, the removed media-buy `status` alias). An earlier view that serving the newest release is safe was corrected in the session.

## Implications

- **Changes a default.** `specs/version-negotiation.md` §4 and `docs/reference/versioning.mdx` ("Omitted" and the major-only example) say a major-only request is served the highest supported release. Both are updated to this rule.
- **In-house clients** that stay on `adcp_major_version` are served the oldest supported 3.x release, and they lose newer fields until they send `adcp_version`. They should move to `adcp_version` now; the field is removed in 4.0 regardless ([DR-0035]).
- **3.x only.** The rule ends with `adcp_major_version` at 4.0. In 4.x a request without `adcp_version` is served the server's default release.
- The TypeScript server framework already serves the oldest release for major-only requests (`@adcp/sdk` `selectServedAdcpRelease`). The Go SDK serves the newest and aligns (adcontextprotocol/adcp-go#588).

[DR-0024]: ./DR-0024-responses-conform-to-served-release.md
[DR-0035]: ./DR-0035-adcp-major-version-removed-in-4-0.md

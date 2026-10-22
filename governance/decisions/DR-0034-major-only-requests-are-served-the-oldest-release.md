---
id: DR-0034
title: A request carrying only adcp_major_version is served the oldest supported release of that major
class: breaking
status: proposed
date: 2026-10-22
refs: ["#8373", "DR-0024", "DR-0032"]
supersedes: DR-0024
dissent: open, see Implications
---

## Decision

A request that carries `adcp_major_version` and no `adcp_version` is served the **oldest** release the server supports in that major, and the response echoes it. A buyer that wants a newer release's behavior sends `adcp_version`.

This replaces only the "Unpinned requests" paragraph of [DR-0024]. The rest of DR-0024 stands. A request carrying neither field is still served the server's default release.

## Rationale

Every 3.1+ SDK sends `adcp_version`, so in practice a major-only request comes from a 3.0 buyer, and its payload is 3.0-shaped. Serving it the oldest release reads the request in the shape it was written in and answers in the shape the buyer can validate. That is what [DR-0024] demands of every pinned response. Serving the highest release instead answers a 3.0 buyer with a 3.2 response that a strict 3.0 validator rejects (closed shared types, the removed media-buy `status` alias). With [DR-0032], servers convert between releases, so serving the oldest release costs the handler nothing.

## Implications

- **Changes a default.** Today's text (`specs/version-negotiation.md` §4, `docs/reference/versioning.mdx` "Omitted" and the major-only example) says a major-only request is served the highest supported release. This record classes the change as Breaking, so it needs WG or Board ratification.
- **Open concern.** The versioning docs explicitly allow in-house clients to stay on `adcp_major_version` through all of 3.x. Such a client written against 3.2 would now be served 3.0 and lose newer fields until it sends `adcp_version`. Ratification should decide whether that cost is acceptable. Possible mitigations: deprecation guidance, a grader warning, or keeping "highest" only for sellers that do not translate.
- The TypeScript server framework already serves the oldest release for major-only requests (`@adcp/sdk` `selectServedAdcpRelease`), so it is off-spec until this record or a contrary one is ratified.

[DR-0024]: ./DR-0024-responses-conform-to-served-release.md
[DR-0032]: ./DR-0032-sdks-translate-between-releases.md

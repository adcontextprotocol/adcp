---
"adcontextprotocol": patch
---

Clarify how a `signing_keys` pin combines when more than one `authorized_agents[]` entry in `adagents.json` matches the same agent (adcp#9016), for example an origin-only entry and an entry with the agent's full URL, or every entry at a Web Bot Auth signer's origin.

- The rule counts only the entries that both match the agent and authorize the message's scope. Such an entry resolves to the property, is inside its effective window, and covers the country, collection and placement. An entry that authorizes nothing for the message neither pins nor unpins it.
- Among those entries, the agent is pinned only if every one carries `signing_keys`. One of them with no `signing_keys` (absent or empty) leaves it unpinned.
- When every one pins, the accepted keys are the union of their pins.
- A message about several of the publisher's properties gets one pin per property, and the key must satisfy each, just as pins from different publishers intersect.
- When copies of a pinned key differ in `revoked_at`, the earliest `revoked_at` applies, whatever the entry order.
- On a shared host, one tenant's unpinned path entry does not affect another tenant. An unpinned origin-only entry affects every tenant.
- The per-entry verifier MUST now reads "if the publisher pins the agent for the message's scope".
- The directory's `signing_keys_pinned` is documented as a scope-agnostic summary that ignores entries outside their effective window.

Updated:
- `docs/governance/property/adagents.mdx`: Agent URL matching and `signing_keys`.
- `docs/building/by-layer/L1/security.mdx`: Publisher pin precedence and Agent resolution step 3.
- `docs/reference/migration/agent-identity-3-3.mdx` and `docs/reference/migration/3-2-to-3-3.mdx`.
- `docs/aao/directory-api.mdx`.
- The `signing_keys` and `signing_keys_pinned` descriptions in `core/authorized-agent-base.json` and `aao/agent-publishers.json`.

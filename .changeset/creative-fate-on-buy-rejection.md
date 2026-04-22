---
"adcontextprotocol": patch
---

spec(media-buy + creative): pin creative lifecycle on buy rejection/cancellation — assignments released, creatives remain in library (closes #2254, closes #2262)

External contributor filed #2254 flagging that the spec did not define what happens to synced creatives when a media buy is subsequently rejected or canceled. Two defensible interpretations existed:

- **Atomic** — buy rejection unwinds the creative create; the creative never existed in the library.
- **Decoupled** — the creative enters the library regardless; buy rejection only releases the assignment.

Partial text was added to `creative-libraries.mdx:252` adopting the decoupled interpretation, but the rule wasn't discoverable from the media-buy side (a seller implementer reading the Media Buy State Transitions section wouldn't learn it) and #2262's open questions (review flow fate, capability-flag scope, inline vs sync equivalence) were left implicit. This PR closes the loop.

**Changes:**

- `docs/media-buy/specification.mdx` (Media Buy State Transitions): adds a normative bullet stating that creative assignments are released on buy rejection or cancellation; creatives remain in the library and MAY be referenced by `creative_id` in a subsequent `create_media_buy` or `sync_creatives` call — including inline creatives submitted on the rejected/canceled create. Creative review proceeds independently; sales agents MUST NOT implicitly reject a creative because its containing buy was rejected. After a transition to `rejected` or `canceled`, released assignments no longer appear in `get_media_buys` responses for that buy.
- `docs/media-buy/specification.mdx` (Package-level lifecycle): clarifies that package cancellation releases assignments on the canceled package only; creatives on other active packages on the same buy are unaffected.
- `docs/creative/creative-libraries.mdx` (Path 2 inline): adds the reverse cross-reference to the media-buy rule, a MUST on deliberate-review-decision rejections (no implicit cascade from buy status), and a capability-flag scope note clarifying that `inline_creative_management: true` advertises inline acceptance, not a lifecycle tie to the buy.

**Retention.** Adds a SHOULD-90-days retention placeholder referencing the normative retention contract tracked under #2260. Without a floor, "reusable by creative_id" would be a semantic promise with no operational teeth; 90 days matches the variant-retention guidance already present in `sales-agent-creative-capabilities.mdx`. The full retention contract stays on 3.1 (#2260).

**Scope deliberately excludes:**

- **Final retention floor** (#2260) — the normative number and the per-status differentiation (approved vs pending_review vs rejected). Needs implementer agreement; 3.1.
- **Purge notification webhook** — part of the broader creative-lifecycle webhook work; 3.1.

**Rejection-reason cascade on policy-based buy rejection** is resolved: no implicit cascade. If a creative triggered a policy-based buy rejection, the sales agent MAY reject the creative via the normal review path (with its own `rejection_reason`), but the buy's `rejected` status is not itself sufficient.

No schema change. Sales agents that already keep inline creatives in the library after a buy rejection stay conformant; sales agents that unwind the library entry on buy rejection need to change before 3.0 GA.

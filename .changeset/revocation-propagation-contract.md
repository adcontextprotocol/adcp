---
---

docs+test(adagents): lock revocation propagation contract through the crawler diff path

Closes #4506 part B. The in-memory `AuthorizationIndex` revocation propagation chain works through the existing infrastructure built by PR #4538 (writer soft-delete) plus the existing crawler-diff event flow:

1. Writer's revocation branch (`upsertAdagentsCache` when `revoked_publisher_domains[]` lists the source) soft-deletes catalog rows.
2. Next crawl pass re-snapshots `(agent, publisher_domain)` pairs via `federatedIndex.getAllAgentDomainPairs()`, which reads from `v_effective_agent_authorizations` — soft-deleted rows are excluded by the partial index.
3. Pre/post diff in `crawler.produceEventsFromDiff` detects the dropped pair and emits `authorization.revoked`.
4. `registry-sync` consumes the event and calls `authorizationIndex.removeEntry`.

What's added here:

- **Snapshot-contract test** in `server/tests/integration/registry-catalog-agent-auth-writer.test.ts`. Calls `federatedIndex.getAllAgentDomainPairs()` before and after a revocation manifest write; asserts the `(TEST_AGENT_CANON, TEST_PUB)` pair is present before and absent after. This is the contract step (2) depends on — if it ever breaks, the crawler diff misses the change and the in-memory index keeps authorizing the revoked publisher until the next full re-index.
- **Doc paragraph** in `managed-networks.mdx` under "Publisher revocation" documenting the propagation flow, the one-crawl-interval steady-state latency, and a SHOULD for validators that don't run a per-publisher crawl to apply revocation eagerly on adopt.

Out of scope (kept as named follow-up): per-`authorized_agents[]` `last_updated` partial-walk indexing. Optional optimization — the spec explicitly marks it advisory. Writer projection completes in milliseconds today; adding the per-entry index has nontrivial schema + reader-side cost. Punted.

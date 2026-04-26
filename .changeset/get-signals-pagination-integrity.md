---
---

Adds `get_signals_pagination_integrity` — the second universal pagination-integrity storyboard, mirroring the cursor↔has_more invariant that gates `list_creatives` (#3095/#3100) onto `get_signals`. Sends a broad `signal_spec` ("audience") with `pagination.max_results: 1` and asserts the first page is non-terminal (`has_more=true` with cursor present). Page 2 follows the captured cursor and asserts schema conformance — the catalog size depends on the agent so the terminal state is not pinned, with the static lint covering cursor invariants on any sample fixture.

Fixes the training agent's `get_signals` to honor `pagination.max_results` / `pagination.cursor` and emit a proper pagination block. Previously it capped internally at `MAX_SIGNAL_RESULTS=10` and returned no pagination field — exactly the dishonest shape this storyboard exists to catch. Negative-test verified: flipping the agent back to `has_more: false` fires the page-1 assertion with `Expected true, got false`.

Generalizes the cursor codec from #3095 (`encodeCreativeCursor` / `decodeCreativeCursor`) into a `kind`-prefixed pair (`encodeOffsetCursor`, `decodeOffsetCursor`) so a list_creatives cursor can't decode to a meaningful offset on a different list endpoint. Existing list_creatives behavior preserved.

---
---

Fixes a missed code path in the banned-ritual stripper. Prod redteam against the just-deployed Sonnet+stripper combo showed 3 ritual-phrase leaks ("the honest answer is", "that's a fair question", "here's the honest answer") despite the stripper being in place. Tracing showed the strip was applied at three response-emission sites in `claude-client.ts` but missed a fourth: the `end_turn` path at line 763 that handles multi-text-block responses (used by web-search-returning answers). That path returned `text` unstripped to the caller. Now consistent with the other three return points — collect rawText, run through `stripBannedRituals`, return the cleaned form. No semantic change to non-end_turn paths.

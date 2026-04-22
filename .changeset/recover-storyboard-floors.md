---
---

Rebaseline storyboard CI non-regression floors after #2666 recovered the training-agent responses (#2667).

#2666 restored the fixture/handler shapes the `@adcp/client` 5.6→5.8.1 bump had broken, but left the CI floors at the post-regression values of 27/271 legacy and 19/226 framework. The non-regression gate should track the recovered baseline so future regressions actually fail CI.

- `.github/workflows/training-agent-storyboards.yml`: floors raised to legacy **36 clean / 295 passing** and framework **21 clean / 241 passing**, matching the post-recovery counts reported in #2666.
- `.gitignore`: exclude `/dist/compliance/assertions/` from the tracked `/dist/compliance/` tree so `tsc` output from `server/src/compliance/**` (the assertion modules landed in #2663) doesn't collide with the published spec tarball.
- `server/src/training-agent/property-handlers.ts`: comment clarifying why `violations[]` was moved into the closed-shape `features[]` channel, for readers landing in the handler after #2666.

No behavior change — the floor move is the operational gate.

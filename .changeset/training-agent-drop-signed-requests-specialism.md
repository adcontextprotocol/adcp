---
---

chore(training-agent): drop deprecated `signed-requests` specialism claim

Follow-up to #3077: the training agent's capability advertisement no longer claims `specialisms: ['signed-requests']`. Per the universal storyboard's narrative, advertising `request_signing.supported: true` is now the sole correct mechanism — the deprecated specialism claim is redundant and the runner emits an informational notice when it sees one. The training agent is the dogfood reference, so it goes first.

Touches both dispatch paths (`task-handlers.ts` legacy and `framework-server.ts` framework-default) plus the integration tests that previously asserted the deprecated claim was present. Test fixture in `tests/lint-storyboard-test-kits.test.cjs` updated from `applies_to.specialism: 'signed-requests'` to `applies_to.universal_storyboard: 'signed-requests'` to match the post-reclassification syntax.

No protocol surface change — the spec already deprecated the enum value in #3076 and #3077.

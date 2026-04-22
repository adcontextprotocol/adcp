---
---

Guard against raw JSON envelopes reaching Slack message bodies. A new `guardBareJsonEnvelope` helper wraps any outbound response that is a bare JSON object or array (from a tool result Claude echoed verbatim) in a ```json fenced code block, and logs a warning so we can observe occurrences. Applied across all five Slack send paths in `bolt-app.ts`. Prompt rules tightened: the "copy tool output" instruction is now scoped strictly to `draft_github_issue`, and a new explicit rule forbids echoing raw JSON from other tools.

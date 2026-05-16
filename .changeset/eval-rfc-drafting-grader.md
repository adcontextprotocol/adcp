---
---

Add RFC-drafting grader and Jeffrey-Mayer scenario fixtures to the qualitative
replay runner. Catches the same-Addie-different-answers failure mode where
web-Addie drafts a GitHub issue from a member's framing without verifying the
gap against the spec, then a different surface (Slack) corrects it. Runs as
`REPLAY_FILTER=rfc npx tsx server/tests/qualitative/replay-prod-scenarios.ts`.

The grader scores three independent dimensions per scenario — router tool-set
selection, in-conversation tool calls (search_docs / get_schema), and response
substance (field citations + premise pushback) — so a fix shows up in exactly
one dimension and regressions are localizable. Stub spec tools live next to
the grader so the runner can measure tool use without standing up real MCP
infrastructure.

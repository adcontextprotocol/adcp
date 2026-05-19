---
---

Add `ai-review.yml` workflow (Argus) — an LLM PR reviewer that posts `--approve`, `--comment`, or `--request-changes` on every non-dependabot PR. Adapted from `scope3data/agentic-api`'s Argus workflow, with AdCP-specific MUST-FIX gates: spec drift on `static/schemas/source/**`, breaking wire changes without a `major` changeset, missing changeset on wire-touching PRs, and `oneOf` discriminator regressions against the audit walker baseline.

Reads the diff, delegates to AdCP subagents in parallel (`code-reviewer`, `ad-tech-protocol-expert`, `security-reviewer`, etc.) when relevant, and writes the review in bokelley's voice. Reviews post as the AAO release/triage GitHub App (`RELEASE_APP_ID` / `RELEASE_APP_PRIVATE_KEY` — already configured) and count toward branch-protection's required-approvals check, satisfying the "1 approving review" rule without admin-merge.

Trivial-skip re-review on `synchronize` when changes since the last bot APPROVED review only touch `.changeset/`, `.md`/`.mdx`, `mintlify-docs/`, `static/schemas/cache/` (generated), test files, or `package-lock.json`. Force-pushes fall back to full review.

Requires `ANTHROPIC_API_KEY` to be added to repo or org secrets before the workflow can complete.

Reviewer prompt at `.github/ai-review/expert-adcp-reviewer.md`.

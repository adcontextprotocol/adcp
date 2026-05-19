---
---

Add `ai-review.yml` workflow (Argus) — an LLM PR reviewer that posts `--approve`, `--comment`, or `--request-changes` on every non-dependabot PR. Adapted from `scope3data/agentic-api`'s Argus workflow, with AdCP-specific MUST-FIX gates: spec drift on `static/schemas/source/**`, breaking wire changes without a `major` changeset, missing changeset on wire-touching PRs, and `oneOf` discriminator regressions against the audit walker baseline.

Reads the diff, delegates to AdCP subagents in parallel (`code-reviewer`, `ad-tech-protocol-expert`, `security-reviewer`, etc.) when relevant, and writes the review in bokelley's voice. Reviews post as the AAO release/triage GitHub App (`RELEASE_APP_ID` / `RELEASE_APP_PRIVATE_KEY` — already configured) and count toward branch-protection's required-approvals check, satisfying the "1 approving review" rule without admin-merge.

Trivial-skip re-review on `synchronize` when changes since the last bot APPROVED review only touch `.changeset/`, `.md`/`.mdx`, `mintlify-docs/`, `static/schemas/cache/` (generated), test files, or `package-lock.json`. Force-pushes fall back to full review.

Requires `ANTHROPIC_API_KEY` to be added to repo or org secrets before the workflow can complete.

Reviewer prompt at `.github/ai-review/expert-adcp-reviewer.md`.

Security hardening applied per Argus's self-review of the workflow on the smoke-test PR (#4816):

- Prompt loaded from the PR's base SHA via `git show $BASE_SHA:...` rather than the working tree, so the prompt that runs is always the version on the base branch — closes the prompt-injection vector even on PRs that don't directly modify the prompt file
- Workflow-mod gate: PRs that modify `.github/ai-review/**` or `.github/workflows/ai-review.yml` alongside other files are not auto-reviewed; the bot posts a `--comment` requesting human review
- Verifier filter pinned to the Argus bot login (`aao-release-bot`) instead of matching any bot user, so changesets-release[bot] or other bot comments in the same window don't false-positive
- `Bash(gh api:*)` allowlist narrowed to read-only PR/contents/issues patterns instead of the wildcard
- Third-party actions pinned to commit SHAs (`actions/checkout`, `actions/create-github-app-token`, `actions/github-script`, `anthropics/claude-code-action`) to close the moving-tag supply-chain vector
- Skip-check filter pinned to the Argus bot login so stale approvals from other bots can't trigger trivial-skip
- Heredoc sentinel randomized so prompt content can't accidentally break framing
- macOS `date` fallback removed (workflow runs on `ubuntu-latest`)

Branch-protection assumption documented in workflow comments: "Require approval of the most recent reviewable push" MUST be enabled on `main` for the trivial-skip path to be safe — without it, a bot approval can persist across a force-push that touches only trivial paths.

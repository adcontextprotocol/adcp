# Context Refresh — Routine Prompt

You maintain `.agents/current-context.md` in `adcontextprotocol/adcp`. It
is the shared snapshot of what's active right now — roadmap items, open
initiatives, recent merged PRs, upstream spec issues, known in-flight
work. Other routines (triage, review) read it to avoid asking questions
already answered by recent activity.

## Every run

1. Read the existing `.agents/current-context.md` so you know what's
   already tracked and what may be stale.
2. Gather fresh signal:
   - `gh issue list --limit 100 --state open --json number,title,labels,updatedAt`
   - `gh pr list --limit 30 --state merged --json number,title,mergedAt`
     (last 30 days)
   - `gh pr list --limit 30 --state open --json number,title,labels`
   - Any issue/PR with labels like `roadmap`, `in-progress`, `tracking`
3. Also scan `adcontextprotocol/adcp-client` and
   `adcontextprotocol/adcp-client-python` for open PRs and recent
   merges — these are the spec's clients and their velocity is part of
   current context.
4. Identify themes. Group by major initiative (e.g., "v2 sunset",
   "upstream spec issues", "release cadence", "new task/capability").
   Drop themes that haven't had activity in 60 days.
5. Rewrite `.agents/current-context.md` as a fresh snapshot. Keep it
   under 200 lines. Each entry should be one bullet with a
   why/status/link, not an explainer.

## Output rules

- Absolute dates, not relative ("2026-04-23", not "last week")
- Link every entry (`#1234`, `PR adcp-client#456`)
- Status values: `active`, `blocked`, `review`, `shipped`, `deferred`
- Drop stale entries — staleness is a feature

## Open a PR

Branch: `claude/refresh-current-context-YYYY-MM-DD`
Title: `chore(agents): refresh current-context snapshot`
Body: short diff summary and `Session: https://claude.ai/code/${CLAUDE_CODE_REMOTE_SESSION_ID}`
Include an empty changeset (`npx changeset --empty`, renamed).
Draft PR, not ready-for-review — a human should eyeball.

## Never

- Never merge the PR yourself
- Never delete the existing file without writing a replacement
- Never include speculation or editorial about priorities — just
  surface what's active based on repo signal

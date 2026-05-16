---
---

ci(triage): convert webhook-miss sweep filter to heredoc-fed temp file

`.github/workflows/triage-webhook-miss-sweep.yml` used the same inline single-quoted `jq -n '...'` pattern that just bit `claude-issue-triage.yml` (PR #3907). The RECOVERY SWEEP prose is apostrophe-free today, so the workflow runs — but the next prose edit could trip it the same way and silently break recovery sweeps.

Filter now goes through `cat > /tmp/sweep-payload.jq <<'JQ_FILTER' … JQ_FILTER` written once before the per-issue loop, then `jq -n --arg … -f /tmp/sweep-payload.jq` inside the loop. Filter body is unchanged; only the bash wrapping changed.

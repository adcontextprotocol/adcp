---
---

ci(triage): move jq payload filter to heredoc-fed temp file

The `Fire triage routine` step in `.github/workflows/claude-issue-triage.yml` built its routine payload via an inline single-quoted `jq -n '...'` filter. Apostrophes inside the prose (`issue's`, `doesn't`) closed the bash quote prematurely, exposing parens and backticks elsewhere in the filter as shell tokens — every fired run died with `syntax error near unexpected token '('`. PR #3325 fixed the same class of bug once already.

Filter now goes through `cat > /tmp/triage-payload.jq <<'JQ_FILTER' … JQ_FILTER` and `jq -f`. The quoted heredoc delimiter means bash never interprets the contents, so apostrophes, backticks, parens, and `$` characters all stay literal. Restored the natural `issue's` / `doesn't` wording in the LABEL POLICY text (PR #3479).

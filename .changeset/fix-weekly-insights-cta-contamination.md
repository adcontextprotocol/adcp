---
---

Fix weekly-insights theme counts inflated by CTA-chip clicks and assistant-side keyword matches (issue #3408). Filters rehearsal threads and known CTA strings from conversation samples, restricts LLM theme analysis to user messages only, removes population-extrapolation from the prompt, and renames `count` → `estimated_count` with sample-basis disclosure in the Slack post.

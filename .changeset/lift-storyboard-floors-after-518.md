---
---

CI: lift Training Agent Storyboards floors to match the post-5.18.0 baseline. Framework dispatch jumped from 374→401 passing / 42→53 clean once `@adcp/client` 5.18.0's schema-aware injection (adcp-client#943, the fix for #940) landed; legacy ticked up 384→388 with `force_task_completion` (#3194). The reduced framework floor was set as a temporary measure during the 5.17.0 regression and is no longer needed.

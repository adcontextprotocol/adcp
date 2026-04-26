---
---

Stage 1 of persona-driven Addie suggested prompts (#2299). Replaces the static three-tier `buildDynamicSuggestedPrompts` with a unified rule registry that drives prompts in Slack Assistant threads, the App Home tab, and the web home. Adds rules for persona, profile completeness, lapsed re-engagement, low-login soft re-engagement, working-group leader/member, Explorer-tier upgrade, and solo-org-owner invite-team. Persona prompts now fire correctly (the previous web builder used persona IDs that did not match the actual codes).

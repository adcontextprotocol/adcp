---
---

fix: ensure tool documentation is always included in Addie's system prompt

Tool documentation was only present in a hardcoded fallback prompt that wasn't used
when database rules existed. Now tool reference is always appended to the system prompt,
ensuring Addie knows about meeting scheduling and other tools regardless of DB state.

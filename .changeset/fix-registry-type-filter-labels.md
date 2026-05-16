---
---

Fix registry page Type filter labels: Measurement and Governance buttons were both rendering as "Unclassified" because `typeLabel()` in `server/public/agents.html` was missing cases for those agent types and falling through to the default. Add explicit mappings so each button shows its correct label.

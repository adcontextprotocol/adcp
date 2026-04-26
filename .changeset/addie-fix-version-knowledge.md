---
---

fix(addie): remove hardcoded version info from rules, defer to search_docs

Addie was answering version/maturity questions from stale hardcoded rules
instead of looking them up from the live docs. No protocol changes.

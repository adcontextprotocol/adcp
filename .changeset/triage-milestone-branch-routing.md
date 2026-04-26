---
---

Triage routine now routes every drafted PR to the correct milestone and base branch based on the changeset bump level: major → next-major milestone on main; minor → next-minor milestone (e.g., 3.1.0) on main; patch → patch milestone on the X.Y.x branch (flag-for-human if no patch branch is open yet); --empty → no milestone, main. Replaces the conservative "only milestone on explicit signal" rule.

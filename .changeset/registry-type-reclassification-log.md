---
---

Add `type_reclassification_log` table — append-only audit trail capturing every agent type transition the system makes (backfill script, crawler disagreement, member-write). Future audits ("when did Bidcliq flip from buying to sales?") answer with a row, not a stdout-grep. Stacked on #3541. Closes #3550.

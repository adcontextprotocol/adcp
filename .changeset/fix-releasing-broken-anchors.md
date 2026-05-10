---
---

Docs: convert two markdown links in `RELEASING.md` that pointed at `.agents/playbook.md` anchors into plain-text references. Mintlify's broken-link checker can't resolve anchors in files outside the docs root, so it flagged them on every PR that touches a docs path. The playbook anchors do exist as headings; the references now match the existing plain-text style elsewhere in the file.

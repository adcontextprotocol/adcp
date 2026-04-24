---
---

Flip the triage routine's default from "flag unless obviously a small bug" to "execute unless the change is breaking, ambiguous, or high-risk." Drops the <150-line scope cap, the classification-only-Bug-or-Doc gate, and the blanket prohibition on `static/schemas/source/**` edits. Adds a crisp non-breaking-vs-breaking definition as the primary Execute/Flag binary, adds evergreen content as a first-class always-PR-able bucket, and guards `infra/agents` bucket as always-Flag (self-modification risk). CODEOWNERS + human review still gate every merge.

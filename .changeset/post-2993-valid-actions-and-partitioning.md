---
---

spec(media-buy): close the empty-`valid_actions` loophole and specify where partitioning belongs

Post-#2993 follow-up tightening, surfaced by expert review of the Tier-2 conformance PR (#2965). The merged #2993 rules say a seller MUST return every account-owned buy and MUST NOT mark non-AdCP buys read-only — but they also say an action MAY be omitted from `valid_actions` for "business reasons." Those two clauses combined let a seller technically comply by returning non-AdCP buys with a systematically empty `valid_actions`, which is indistinguishable from hiding the buy and defeats the normative intent.

Two clarifications:

1. **Creation surface is never a business reason.** Sales agents MUST NOT omit an action from `valid_actions` — or return `INVALID_STATE` on an otherwise-valid update — solely because the buy was created outside AdCP. `valid_actions` omissions are legitimate only when grounded in contractual, platform, or policy constraints that would apply equally to an AdCP-created buy in the same state. A systematically-empty `valid_actions` set on non-AdCP buys is non-conformant.

2. **Partitioning belongs at the account boundary.** When a seller has a legitimate reason to keep a set of buys outside a caller's operational reach (child-seller models, NDA-scoped PMP deals, sandbox-vs-prod separation, tenant-level privacy partitions), the correct mechanism is expressing that as a separate account the caller is not authorized to reference — not filtering a subset of the caller's authorized account. Within-account filtering reintroduces the shadow-ledger problem #2963 forbade.

Updated: `docs/media-buy/specification.mdx` (new "Partitioning belongs at the account boundary" subsection under Account Ownership vs. Creation Surface; strengthened MUST NOTs), `docs/media-buy/task-reference/get_media_buys.mdx`, `docs/media-buy/task-reference/update_media_buy.mdx`.

No schema changes. Closes the gap flagged on PRs #2994 and #3001 reviews.

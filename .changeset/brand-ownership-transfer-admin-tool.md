---
---

Add `transfer_brand_ownership` admin tool to Addie's admin panel.

Admins can now transfer a brand domain from one organization to another via a single tool call — no more direct database surgery for acquisitions, org renames, or "original uploader left" cases. The operation writes a revision to the `brand_revisions` audit trail before updating `brands.workos_organization_id`.

Two items from the issue that need more design are deferred: the soft-claim model (spoofing risk when `brand_manifest` is non-empty) and the `claim_disputed_brand` member tool (better modeled as a `dispute_type: brand_ownership` escalation using the existing escalation system).

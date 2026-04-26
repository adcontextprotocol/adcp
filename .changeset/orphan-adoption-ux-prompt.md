---
---

Member-profile dashboard now surfaces the orphan-adoption choice when saving brand identity for a previously-registered domain.

When `PUT /api/me/member-profile/brand-identity` returns 409 with `code: 'orphan_manifest_decision_required'` (the explicit-decision contract added in #3168), the form shows an inline prompt naming the prior owner and offering "Adopt prior identity" or "Start fresh." Either button re-fires the save with `adopt_prior_manifest` set explicitly. Cancel dismisses without writing.

The success message after a claim reflects the choice ("Brand identity saved — adopted prior identity." vs "started fresh."), so members can confirm what landed.

Closes the "members hit a generic 409 with no way to pick" gap from the #3168 reviewer feedback. Without a UI surface, the orphan-decision-required design was invisible to the people it's meant to serve.

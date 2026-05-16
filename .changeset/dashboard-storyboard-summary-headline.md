---
---

Adds a "X / Y storyboards passing" headline element on the dashboard agent card, with a tooltip explaining that storyboard counts are the canonical compliance unit (each applicable specialism, protocol baseline, and universal check is one storyboard) and that the track pills below are the SDK's coarse roll-up. Resolves the Evgeny-shape disconnect surfaced by escalation #329: track summary showed "30/30 passing" (correctly, per the SDK's silent-track semantics) while the underlying storyboards were partial — the dashboard had no surface to communicate which number to trust. The track pills also gain a tooltip pointing readers at the Verification panel for the per-storyboard view. Follows from the adtech-product review feedback on PR #4364.

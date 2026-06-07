---
---

fix(compliance): avoid lifecycle-shaped unknown-package storyboard probes

Update the invalid-transitions storyboard so the unknown-package scenario probes
with a budget mutation instead of `paused: true`. This keeps the scenario
focused on package lookup errors without colliding with lifecycle preflight for
pending creatives or seller-specific creative-management paths.

---
---

Addie: extend the storyboard hint fix-plan formatter to render Diagnose / Locate / Fix / Verify playbooks for the four hint kinds 5.18.0 added beyond `context_value_rejected` — `shape_drift`, `missing_required_field`, `format_mismatch`, and `monotonic_violation`. Each kind dispatches to its own templated playbook off the structured fields the runner emits; unknown future kinds drop silently from the fix-plan section while the upstream `hint.message` still surfaces them at the consumer's discretion. Trust model documented per-kind in the formatter's docstring.

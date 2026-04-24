---
---

Addie: render `context_value_rejected` hints in `run_storyboard` and `run_storyboard_step` output. When `@adcp/client` ≥5.17.x attaches a `hints[]` array to a failing step result, Addie now surfaces each hint inline below the error/validation lines so Claude can present the root-cause diagnosis conversationally.

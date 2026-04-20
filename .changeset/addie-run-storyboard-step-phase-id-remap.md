---
---

Addie: `run_storyboard_step` now accepts a phase ID and transparently remaps it to the first step of that phase. When a completely unknown ID is passed, the error response lists both valid step IDs and phase→first-step hints so the model can self-correct. Fixes spurious "Step not found" failures when Addie confuses phase IDs (e.g. `protocol_discovery`) with step IDs.

---
"adcontextprotocol": patch
---

Let the `STORYBOARD_RUNNER` repository variable choose the runner for the training-agent storyboard and sales orchestrator CI matrices, falling back to `ubuntu-latest` when unset. Storyboard selection, floors and results are unchanged.

---
"adcontextprotocol": minor
---

Add generated_creative_ref for creative refinement. build_creative responses now include an optional ephemeral reference that buyers pass back in subsequent build_creative or preview_creative requests to refine or preview without resending the full manifest. preview_creative accepts generated_creative_ref as an alternative to creative_manifest. Document iterative refinement patterns for both build_creative and get_signals.

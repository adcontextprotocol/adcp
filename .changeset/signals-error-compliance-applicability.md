---
"adcontextprotocol": patch
---

Make shared signals error compliance runnable for discovery-only owned agents. Use malformed get_signals requests for error-code and context checks; move activation negatives into a required signal-marketplace scenario so marketplaces retain their activation checks. The training agent rejects non-string signal_spec inputs instead of silently dropping them and returning a catalog. Missing required tools, controller evidence and genuine assertion failures remain blocking. Existing released bundles are unchanged.

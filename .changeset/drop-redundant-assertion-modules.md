---
"adcontextprotocol": patch
---

Update `universal/idempotency.yaml` comment to reflect that built-in cross-step assertions now come from `@adcp/client` 5.9+ via auto-registered `default-invariants` — runners no longer need to load anything explicitly. The previous "import the module first" instruction was accurate for the in-repo assertion modules that #2771 transitioned from local-only to SDK-bundled with a stricter local override for `context.no_secret_echo` (adcp-client#751).

No behavior change; comment-only refresh of the storyboard's self-documentation.

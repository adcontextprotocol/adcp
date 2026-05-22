---
---

docs: explain why `security_baseline/assert_mechanism` returns `actual: []` for Bearer-only agents

Adds a dedicated troubleshooting section for the `assert_mechanism: actual: []` failure pattern. The root cause is that `--auth TOKEN` (runner session credential) and `test_kit.auth.api_key` (api_key_path probe credential) are separate concerns; agents need to accept the `demo-<kit>-v1` prefix token from the test kit to satisfy the `api_key_path` phase. Updates the `known-ambiguities` entry to cross-link to the new section and include the concrete fix.

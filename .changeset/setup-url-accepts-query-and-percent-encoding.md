---
"adcontextprotocol": minor
---

Fix `core/agent-reporting-destination-state.json#/properties/setup/properties/setup_url` so its pattern is `^https://` (#8398). The old character-class pattern rejected `%`, `#` and `?`, so a conforming URL library that percent-encodes could not produce a valid value and a `setup_url` could not carry a query string, and it accepted `{`. The schema now checks the scheme and `format: uri`; the rule that the URL carries no credential, userinfo, or signed component remains normative for receivers. This loosens a pattern, so a 3.2 sender's value still validates.

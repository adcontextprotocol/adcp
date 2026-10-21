---
"adcontextprotocol": patch
---

Docs: the 3.3 status pages now show the agent identity work as merged (DR-0023's profile, identities, binding and walkthrough; DR-0025; and DR-0026, which moves JWS artifacts to the Web Bot Auth key directory). Two pending changesets are corrected: Web Bot Auth `signing_profile` works on reporting and artifact webhooks now that #8177 made `authentication` optional, and the `impressions` version gate follows the served-release rule (DR-0024). `security.mdx` drops a stale dependency note.

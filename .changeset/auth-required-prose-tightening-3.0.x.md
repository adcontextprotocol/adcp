---
"adcontextprotocol": patch
---

spec(errors): tighten `AUTH_REQUIRED` prose to warn on retry storms (3.0.x prose-only backport of #3739)

`AUTH_REQUIRED` conflates two operationally distinct cases — credentials missing (genuinely correctable) and credentials presented but rejected (terminal — needs human rotation). A buyer agent treating both as `correctable` will retry-loop on revoked tokens, hammering seller SSO endpoints in a pattern indistinguishable from a brute-force probe.

The 3.1 line splits this into `AUTH_MISSING` and `AUTH_INVALID` (#3739). 3.0.x cannot adopt the split — adding new enum values violates the maintenance line's semver rules. This change is the prose-only backport: the wire code stays `AUTH_REQUIRED` with `recovery: correctable`, but the description and `enumMetadata.suggestion` now spell out the two sub-cases and the SHOULD-NOT-auto-retry rule for the rejected-credential case. SDKs running against 3.0.x sellers can apply the operational distinction at the application layer.

Updates:

- `static/schemas/source/enums/error-code.json` — `enumDescriptions.AUTH_REQUIRED` and `enumMetadata.AUTH_REQUIRED.suggestion` rewritten to call out both sub-cases and the retry-storm risk; cross-references the 3.1 split.
- `docs/building/implementation/error-handling.mdx` — adds an `AUTH_REQUIRED sub-cases` callout under the Authentication and Access table; updates the example switch to branch on whether credentials were attached.

Wire format unchanged. No new enum values. No recovery classification change at the structured level. Senders that already emit `AUTH_REQUIRED` keep working; receivers gain the documented sub-case discipline.

Closes the 3.0.x portion of #3730. The full split lands in 3.1.0 via #3739.

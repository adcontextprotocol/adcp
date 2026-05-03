---
"adcontextprotocol": patch
---

spec(errors): tighten `AUTH_REQUIRED` prose to warn on retry storms

`AUTH_REQUIRED` conflates two operationally distinct cases — credentials missing (genuinely correctable) and credentials presented but rejected (terminal — needs human rotation). A buyer agent treating both as `correctable` will retry-loop on revoked tokens, hammering seller SSO endpoints in a pattern indistinguishable from a brute-force probe.

The 3.1 line will eventually split this into `AUTH_MISSING` and `AUTH_INVALID` via #3739. Until that split ships, the prose tightening is the only operational guidance against the retry-storm pattern. The wire code stays `AUTH_REQUIRED` with `recovery: correctable`; the description and `enumMetadata.suggestion` now spell out the two sub-cases and the SHOULD-NOT-auto-retry rule for the rejected-credential case. Agents apply the operational distinction at the application layer by branching on whether credentials were attached to the failing request.

Updates:

- `static/schemas/source/enums/error-code.json` — `enumDescriptions.AUTH_REQUIRED` and `enumMetadata.AUTH_REQUIRED.suggestion` rewritten to spell out both sub-cases and the retry-storm risk. The description follows the same summary-then-`Sub-cases (full guidance).` shape already used by `GOVERNANCE_DENIED` / `GOVERNANCE_UNAVAILABLE`, with a cross-reference to `error-handling.mdx#auth_required-sub-cases`.
- `docs/building/implementation/error-handling.mdx` — adds an `AUTH_REQUIRED sub-cases` Mintlify `<Warning>` callout under the Authentication and Access table; the recovery example switch now derives `requestHadCredentials` locally from `error.request_had_credentials` so a reader pasting the snippet doesn't hit `ReferenceError`.

Wire format unchanged. No new enum values. No recovery classification change at the structured level. Senders that already emit `AUTH_REQUIRED` keep working; receivers gain the documented sub-case discipline.

Also drops two stale forward-merge changeset leftovers (`envelope-field-present-check-type`, `fix-asset-union-dedup`) whose work has already shipped to 3.0.x and is also already in-tree on `main` — without this cleanup the next 3.1.0 cut would emit duplicate CHANGELOG entries.

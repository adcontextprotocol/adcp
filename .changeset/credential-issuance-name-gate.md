---
---

fix(certification): block credential issuance when learner has no name, recover conversationally (#4782)

Closes #4782 — the safety net behind escalation #382. Even after the auth-callback Slack fallback (PR #4781) and the onboarding name-capture gate, an exotic auth path could still drop a learner at credential-issuance time without a name. Today that produced an email-on-certificate ("tom@example.com"); now it produces a one-turn conversational recovery instead.

- **Gate**: `issueCertifierBadge` returns a `NAME_REQUIRED` sentinel (without calling Certifier) when `users.first_name` is empty.
- **Recovery loop**: `checkAndFormatCredentials` now also retries previously-deferred Certifier issuances on every call, so the post-`set_my_name` retry finalizes the certificate that was held back.
- **`set_my_name` tool**: new learner-self tool (member-tools) wrapping the same write-through-to-WorkOS path the onboarding form uses. Sage's prompt rule (`Credential name recovery`) instructs her to ask for first + last on seeing the marker, call `set_my_name`, then call `check_credentials` to finalize.
- **`check_credentials` tool**: new tool that runs the award + issue pass on demand (previously the only triggers were `complete_certification_module` / exam). Used by the recovery flow.
- The `NAME_REQUIRED_MARKER` constant is exported and referenced from all three sites (sentinel, warning line, Sage rule) so they can't drift — guarded by a unit test.

---
"adcontextprotocol": minor
---

Add `REFERENCE_NOT_FOUND` to the standard error-code vocabulary (closes #2686).

- New canonical code in `static/schemas/source/enums/error-code.json` for "the referenced identifier, grant, session, or other resource does not exist or is not accessible by the caller" — the generic fallback for resource types without a dedicated not-found code (property lists, content standards, rights grants, SI offerings, proposals, catalogs, event sources).
- Adds **Not-found precedence**, **Polymorphic parameters**, and **Uniform response for inaccessible references** guidance to `docs/building/implementation/error-handling.mdx`:
  - Sellers SHOULD use the resource-specific code when the resolved type is known from the request (`PRODUCT_NOT_FOUND`, `PACKAGE_NOT_FOUND`, `MEDIA_BUY_NOT_FOUND`, `CREATIVE_NOT_FOUND`, `SIGNAL_NOT_FOUND`, `SESSION_NOT_FOUND`, `ACCOUNT_NOT_FOUND`) and fall back to `REFERENCE_NOT_FOUND` only when no dedicated code fits.
  - Sellers MUST use `REFERENCE_NOT_FOUND` when the unresolved identifier came in via a polymorphic or untyped parameter — using the resource-specific code there leaks the resolved type to an unauthorized caller.
  - The cross-tenant-enumeration MUST is now stated on the docs page (not only the schema): all not-found codes return uniformly for "exists but unauthorized" and "does not exist"; for `REFERENCE_NOT_FOUND`, sellers MUST NOT leak the resolved type via `error.field`, `error.details`, or a resource-qualified `error.message`.
- Updates the `CODE_RECOVERY` fallback map in `docs/building/implementation/transport-errors.mdx` so Level-1 clients get correct recovery classification for the new code (and picks up previously-missing codes: `MEDIA_BUY_NOT_FOUND`, `PACKAGE_NOT_FOUND`, `CREATIVE_NOT_FOUND`, `SIGNAL_NOT_FOUND`, `SESSION_NOT_FOUND`, `SESSION_TERMINATED`, `VALIDATION_ERROR`).
- **Migration note for sellers moving from custom `*_not_found` codes to `REFERENCE_NOT_FOUND`:** do NOT preserve the previous custom code in `error.details` (e.g., `details.legacy_code: "property_list_not_found"`). Preserving the old code reintroduces exactly the cross-tenant enumeration channel this code exists to close. Clients that need to branch on type should do so from request context, not from a legacy-code side channel.
- Promotes the de facto convention already expected by `adcp fuzz` conformance tooling (`bin/adcp-fuzz.js`, `docs/guides/CONFORMANCE.md`) and emitted by `@adcp/client` stock adapters (`PropertyListAdapter`, `ContentStandardsAdapter`, `SISessionManager`, `ProposalManager`) from "spec-permitted custom code" to "standard" — gives conformance tooling a stable name to key on.

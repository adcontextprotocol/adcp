---
"adcontextprotocol": minor
---

Agent identity, P3 (#8118, DR-0023): `security.mdx` adds a **Web Bot Auth identities** section, experimental.

- **Identity** is the canonical origin named by the covered `Signature-Agent` member, verified under a key from that origin's key directory and checked against the origin's revocation list. There is no capabilities fetch.
- **Trust record:** the operator's record is derived at `https://{eTLD+1(origin)}/.well-known/trust.json` and evaluated only where something is gated on it (binding, grants, `open` onboarding), never on the signature path. The section covers its freshness rules and the operator's ability to revoke by delisting.
- **Coexistence** with the RFC 9421 profile: profile selection and no downgrade keyed by origin.

**The RFC 9421 profile is deprecated in 3.3.** It stays fully functional through 3.x and is removed in 4.0.

**Revocation lists** gain optional RFC 5280 `revocation_details` (`reason`, `invalidity_date`), and entries are never weakened once published. Committed work stands on revocation. A request accepted under a `keyCompromise` key at or after its invalidity date is suspect, and sellers SHOULD show the buyer the affected buys.

The trust.json schema, reference page, and experimental-status row now name the Web Bot Auth profile as the record's reader.

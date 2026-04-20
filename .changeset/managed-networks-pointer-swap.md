---
---

spec(governance): close the per-publisher pointer-swap gap in managed-networks security

The prior `§Security considerations` section covered the *wide-and-shallow*
network-CDN threat ("compromise the network CDN, every publisher is
affected") but it did not cover the complementary *narrow-and-deep*
per-publisher threat: an attacker who writes to one publisher's
`/.well-known/adagents.json` silently changes the `authoritative_location`
and redirects validators to an attacker-controlled authoritative file —
one publisher hijacked, but through a surface the network cannot
monitor. The existing fetch semantics (HTTPS, no redirects, size caps,
5xx cache-serve) and change-detection diffs do not close this — TLS is
valid on the attacker's origin because the attacker is serving *from
the publisher's edge*, and a pointer change reads as a legitimate
delegation handoff. The final line of the section previously deferred
the real fix as "a separate protocol change rather than a
security-section requirement," leaving operators with no normative
floor at all.

Adds a new **Pointer integrity** subsection that names the threat and
specifies validator behavior on pointer change without requiring a new
protocol primitive:

- **MUST NOT** auto-adopt a changed `authoritative_location`; hold the
  prior cached authoritative file during confirmation. (Minimum
  normative floor.)
- SHOULD require either out-of-band confirmation or a 24 h minimum
  stability grace window before honoring the new location; the 24 h
  window is a fallback for the unconfirmed path and MUST NOT be
  imposed as a floor when OOB confirmation is available.
- Specifies what "announced network transition" means for OOB
  confirmation (verifiability over publicity — signed announcements,
  operator-verified `brand.json` updates, or established trusted
  publisher channels; not a blog post).
- SHOULD cross-check the candidate authoritative file against the
  publisher's `brand.json` `agents[]`, with a `last_updated` ordering
  rule so stale `brand.json` during a legitimate migration falls back
  to the confirmation paths rather than blocking adoption outright.
- Refuse-to-adopt on mixed signals (pointer change + `last_updated`
  regression, domain-wide delegation-type downgrade, or a first-seen
  sales agent). *Regression* is defined as strictly earlier than the
  cached `last_updated` by more than a 60 s clock-skew tolerance, to
  avoid false positives from multi-edge non-monotonicity.

Also adds a **Signed pointers (planned)** subsection that replaces the
old "separate protocol change" disclaimer with an honest forward
pointer: the full close requires a publisher-controlled signature over
the canonical `(authoritative_location, last_updated)` object,
anchored out-of-band (publisher-attested in `brand.json`, or via the
future centralized publisher-key registry). This is a planned 4.0
addition; implementers publishing pointer files today SHOULD keep the
pointer object to exactly `authoritative_location` and `last_updated`
(no additional top-level fields) so a detached signature can later be
attached without colliding with custom fields added in the interim.

No schema change. Pure documentation tightening — the schema already
permits (and requires) the pointer pattern; this specifies how
validators must behave when the pointer moves and how publishers
should shape pointer files now to be forward-compatible with signed
pointers without waiting for 4.0.

---
---

spec(governance): close the per-publisher pointer-swap gap in managed-networks security

The prior `§Security considerations` section covered the network-wide
blast radius ("compromise the network CDN, every publisher is
affected") but it did not cover the complementary per-publisher threat:
an attacker who writes to one publisher's `/.well-known/adagents.json`
silently changes the `authoritative_location` and redirects validators
to an attacker-controlled authoritative file. The existing fetch
semantics (HTTPS, no redirects, size caps, 5xx cache-serve) and
change-detection diffs do not close this — TLS is valid on the
attacker's origin because the attacker is serving *from the
publisher's edge*, and a pointer change reads as a legitimate
delegation handoff. The final line of the section previously deferred
the real fix as "a separate protocol change rather than a
security-section requirement," leaving operators with no normative
floor at all.

Adds a new **Pointer integrity** subsection that names the threat and
specifies validator behavior on pointer change without requiring a new
protocol primitive:

- Do not auto-adopt a changed `authoritative_location`; hold the prior
  cached authoritative file during confirmation.
- SHOULD require either out-of-band confirmation or a 24 h minimum
  stability grace window before honoring the new location.
- SHOULD cross-check the candidate authoritative file against the
  publisher's `brand.json` `agents[]` — an authoritative file
  authorizing sales agents absent from `brand.json` is a strong signal
  of pointer compromise.
- Refuse-to-adopt on mixed signals (pointer change + `last_updated`
  regression, domain-wide delegation-type downgrade, or a first-seen
  sales agent).

Also adds a **Signed pointers (planned)** subsection that replaces the
old "separate protocol change" disclaimer with an honest forward
pointer: the full close requires a publisher-controlled signature over
the canonical `(authoritative_location, last_updated)` object,
anchored out-of-band (publisher-attested in `brand.json`, or via the
future centralized publisher-key registry). This is a planned 4.0
addition; implementers publishing pointer files today SHOULD keep the
pointer object shape stable so a detached signature can later be
attached without breaking existing consumers.

No schema change. Pure documentation tightening — the schema already
permits (and requires) the pointer pattern; this specifies how
validators must behave when the pointer moves and how publishers
should shape pointer files now to be forward-compatible with signed
pointers without waiting for 4.0.

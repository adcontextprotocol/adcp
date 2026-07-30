---
id: DR-0004
title: Language surfaces use BCP 47 sets; don't enumerate an open corpus
class: normative
status: recorded
date: 2026-07-03
decided: ~2026-06
decided_by: maintainer practice (implementation in flight for 3.2)
refs: ["#5706", "#5720"]
dissent: none
---

## Decision

Language capability and targeting surfaces reference **BCP 47** language tags
rather than maintaining AdCP-owned language enums. The capabilities `language`
surface widens from boolean to an object carrying `supported_languages`
(BCP 47); the targeting-overlay `language` pattern relaxes from `^[a-z]{2}$` to
BCP 47. Capability gating treats the value as a **set** (membership), and
buyer/seller language coercion is a union AND — not either/or.

## Rationale

BCP 47 is already the repo convention; the boolean capability and the
two-letter overlay regex were outliers. Enumerating languages (or any open,
externally-governed corpus) in AdCP schemas creates a mirror the WG must
maintain forever and that is stale on arrival.

## Implications

- The general principle — reference the external standard (BCP 47, ISO, IANA)
  instead of mirroring it — applies beyond language: currencies, regions,
  timezones.
- Regulatory language requirements (e.g., Quebec/Bill 96) are served by
  geo-region targeting plus brief disclosures; the overlay change is parity,
  not an unblocker.

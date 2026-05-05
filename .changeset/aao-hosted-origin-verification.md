---
---

Origin verification for AAO-hosted publishers, closes #4109.

When a publisher uses AAO hosting, AAO writes their authorization rows
into the federated index with `source='aao_hosted'` (less trusted than
`adagents_json`) until origin verification confirms the publisher's own
`/.well-known/adagents.json` actually points at us. This change adds
the verification round-trip and the source-label promotion.

How it works
------------

1. Publisher creates a hosted property; sync writes
   `source='aao_hosted'` rows.
2. Verifier (manual trigger or future scheduled) fetches
   `https://{publisher_domain}/.well-known/adagents.json` via SSRF-defended
   `safeFetch`. Two paths count as verified:
   - **Stub:** body has `authoritative_location` exactly matching
     AAO's hosted URL for this domain.
   - **Document echo:** body's `authorized_agents` URL set matches
     AAO's hosted manifest.
3. On verification success: `agent_publisher_authorizations` rows for
   agents in the manifest are UPDATEd from `source='aao_hosted'` to
   `source='adagents_json'`. `hosted_properties.origin_verified_at` is
   stamped.
4. On verification failure (404, JSON parse, mismatched pointer):
   `origin_verified_at` is cleared; if the publisher was previously
   verified, the promoted rows are demoted back to `aao_hosted`.
5. On transient errors (timeout, ECONNRESET): persisted state is left
   untouched — only an explicit publisher-origin response can demote.

Why
---

`adagents_json` carries the trust weight of "the publisher's own DNS+TLS
attests this." `aao_hosted` is less than that. Promotion is gated on a
publisher-origin round-trip so the source label remains honest. Without
this step, AAO-hosted publishers carry a permanent buy-side trust deficit
relative to self-hosters.

Surface
-------

- `POST /api/properties/hosted/:domain/verify-origin` — admin/owner-gated
  trigger. Runs the verifier synchronously, returns `{ verified, reason,
  checked_at, detail? }`.
- `/api/registry/publisher` `hosting` block now includes
  `origin_verified_at` and `origin_last_checked_at` (ISO timestamps,
  null when not applicable). Lets the publisher page render
  "verified X minutes ago" or "checked, not yet verified".

Schema
------

Migration 467 adds `origin_verified_at` and `origin_last_checked_at`
TIMESTAMPTZ columns to `hosted_properties`. Partial index on the verified
column for "verified publishers" queries.

Tests
-----

10 integration tests across two files covering: stub-points-at-AAO
(promotes), 404 (demotes), 5xx (transient — does NOT demote a
previously-verified row, per spec 7-day cap), wrong pointer (demotes),
document-echo path is now explicitly rejected, demote-after-previous-
success, NXDOMAIN classified as permanent unresolvable, transient
errors stamp last_checked but leave verified alone, trigger-endpoint
plumbing, and the squat-prevention auth gate (NULL-ownership rows
can't be verified by non-admins).

Review fixes
------------

Protocol review (ad-tech-protocol-expert):
- URL comparison now uses `canonicalTargetUri` from `@adcp/sdk/signing`
  (RFC 3986 + IDN A-label + remove_dot_segments + default-port stripping
  + fragment removal) instead of a custom `normalizeUrl`. Matches the
  spec's eight-step canonical algorithm exactly so default ports,
  punycode, dot-segments, etc. compare correctly.
- Document-echo path dropped. The spec recognizes only two adagents.json
  shapes (inline body OR stub with `authoritative_location`); accepting
  a third "agent-set match" shape had no spec footing and could be
  exploited by a malicious publisher echoing only the agent-URL set
  while serving forged `properties[]`.
- Demotion semantics tightened. 5xx / 429 / 3xx are now classified as
  `transient` and leave the persisted state alone (spec mandates a
  7-day cap on transient failures, which a per-fetch demote violates).
  Only 404 + parseable-but-mismatched bodies trigger demotion.

Code review:
- Sync now skips writing `aao_hosted` rows for agents that already have
  a promoted `adagents_json` row, eliminating the duplicate-row leak
  on re-sync after verification.
- Transient errors now stamp `origin_last_checked_at` (without touching
  `origin_verified_at`) via the new `touchOriginLastCheckedAt` helper.
  Previously the UI could show "never checked" after a successful API
  call that landed in the transient branch.
- DNS NXDOMAIN / SSRF-validation throws are reclassified as
  `unresolvable` (permanent), no longer silently masked as transient.

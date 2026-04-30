---
---

backend(verification): brand.json + /verification carry per-version badge detail. Stage 5 of #3524 — the final stage.

## What ships

`aao_verification` blocks served via brand.json enrichment now include a `badges[]` array — one entry per `(role, adcp_version)` with full per-version detail:

\`\`\`jsonc
"aao_verification": {
  "verified": true,
  "verified_at": "2026-04-30T...",
  "badges": [
    { "role": "media-buy", "adcp_version": "3.1", "verification_modes": ["spec", "live"], "verified_at": "..." },
    { "role": "media-buy", "adcp_version": "3.0", "verification_modes": ["spec"], "verified_at": "..." }
  ],
  "roles": ["media-buy"],
  "modes_by_role": { "media-buy": ["spec", "live"] }
}
\`\`\`

`badges[]` is the canonical forward-compat shape (Q6 of [#3524's resolved decisions](https://github.com/adcontextprotocol/adcp/issues/3524#issuecomment-4348265184)). One entry per parallel-version badge; preserved order matches the API's version-DESC sort. Adding future axes to a badge (e.g. a third verification mode) doesn't change the array shape.

`roles[]` and `modes_by_role` are kept as deprecated aliases for one release. Their values reflect "the current best mark" — highest-version badge per role. Clients reading them today keep working when parallel-version badges ship; new clients should read `badges[]` for the full picture. **Removal target: AdCP 4.0.**

## /verification endpoint

`GET /api/registry/agents/{url}/verification` (decentralized public verifier surface) now includes `adcp_version` on each `badges[]` entry. Validated through the same shape regex the API uses for the `/compliance` endpoint (defense in depth — a poisoned DB row returns `null` rather than passing through unchecked).

## What this PR does NOT change

- `verified_at` semantics: still the most-recent-state-change timestamp across any badge.
- `verified` boolean: still true when any active badge exists.
- Wire format on the badge JWTs (already carries `adcp_version` via Stage 2).
- Badge issuance, heartbeat fan-out, SVG rendering, panel UX — all upstream of brand.json enrichment.

## Stage tracker

- ✓ Stage 1 (#3568) — data model + per-version isolation
- ✓ Stage 2 (#3579) — heartbeat fan-out + JWT `adcp_version` claim
- ✓ Stage 3 (#3595) — badge SVG version segment + version-pinned URLs
- ✓ Stage 4 (#3600) — verification panel renders per-version rows
- ✓ Stage 5 (this PR) — brand.json + /verification carry per-version detail

#3524 is fully shipped after this PR. Deferred panel polish tracked in #3603.

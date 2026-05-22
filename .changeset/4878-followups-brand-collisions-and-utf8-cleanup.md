---
"adcontextprotocol": minor
---

spec/chore(envelope-fold): close 3 brand-schema body-`status` collisions surfaced by #4878, normalize schema-source UTF-8, harden pre-push hook.

Follow-up bundle to PR #4896 (envelope-fold). Three brand response schemas had body-level `status` collisions with the envelope `status` (TaskStatus) that the fold didn't carve out; left unfixed they were jointly unsatisfiable on the per-task validator. Two non-spec improvements (UTF-8 normalization, pre-push hook trap) landed alongside since they were touching the same surface.

## Brand-schema body-`status` renames

Same pattern as #4895 (media-buy) and #4897 (governance), applied to three brand-protocol response schemas:

- **`brand/verify-brand-claim-response.json`** — `status` → `verification_status` ($ref unchanged: `brand/verification-status.json`). Updated `required[]` and the error branch's `not.anyOf` discriminator clause. Schema is NOT `x-status: experimental` but is pre-3.1-GA, so beta-cycle rename is acceptable.
- **`brand/creative-approval-response.json`** — `status` → `approval_status` (const discriminator: `approved` | `rejected` | `pending_review`). Renamed across all four oneOf branches (3 success + 1 error), all `required[]` lists, and the error branch's `not.anyOf` clause. Not experimental.
- **`brand/acquire-rights-response.json`** — `status` → `rights_status` (const discriminator: `acquired` | `pending_approval` | `rejected`). Renamed across all four oneOf branches, all `required[]` lists, and the error branch's `not.anyOf` clause. Schema is `x-status: experimental` so hard rename is sanctioned.

Docs swept:
- `docs/brand-protocol/tasks/verify_brand_claim.mdx` — 10 example bodies renamed `status` → `verification_status`.
- `docs/brand-protocol/tasks/acquire_rights.mdx` — 4 example bodies renamed `status` → `rights_status`.
- `docs/brand-protocol/walkthrough-rights-licensing.mdx` — 4 example bodies renamed `status` → `rights_status`.

Why now (vs deferring to a separate PR): the doc-injector in #4878 correctly skipped these three files because the schema-level collision was detectable in advance. Closing them in the same PR keeps the envelope-fold contract whole — every per-task response schema admits at least one valid response with envelope `status: "completed"` post-merge.

## Training-agent envelope-status fixes (server, not spec)

`server/src/training-agent/task-handlers.ts`:

- **Idempotency replay path** (L4547-4561) now stamps `status: 'completed'` if the cached inner response lacks one. Older cache entries written pre-envelope-fold are auto-upgraded on replay. Without this, every cache hit on a folded schema fails its own per-task validator.
- **`handleCreateMediaBuy` / `handleUpdateMediaBuy` cancel branch / `handleUpdateMediaBuy` non-cancel branch** now emit `media_buy_status: MediaBuyStatus` instead of body `status: MediaBuyStatus` (canonical 3.1 form per #4895). The envelope-stamp guard at L4622-4623 then sets envelope `status: 'completed'` cleanly. Without this, MediaBuyStatus values like `pending_creatives` / `active` would survive the guard and fail TaskStatus validation.

Nested `media_buys[].status` and `media_buy_deliveries[].status` (get_media_buys and get_media_buy_delivery handlers) are intentionally left as `status` — the cascade is deferred to 4.0 (#4905) per #4895's Option-E-pure scope.

## Doc fix (signals/activate_signal)

`docs/signals/tasks/activate_signal.mdx:466` — "Error Response (Failed)" example was mis-injected with `status: "completed"`. Corrected to `status: "failed"`. Aligns with the `error-handling.mdx` two-layer model: envelope `status: "failed"` + `errors[]` + optional `adcp_error`.

## Schema-source UTF-8 normalization (chore)

48 schema source files re-encoded by some prior tooling using `\uXXXX` escape sequences for printable non-ASCII characters (em-dashes, en-dashes, smart quotes). Same character semantically, but inflates diffs and obscures real changes — was the dominant source of noise in #4896's review.

- `scripts/normalize-schema-utf8.mjs` — targeted normalizer that only rewrites `\uXXXX` escapes for printable non-ASCII BMP characters. Does NOT touch JSON-required escapes, surrogates, control characters, whitespace, property order, or anything else. Round-trip sanity check via `JSON.parse`.
- `npm run fix:schema-utf8` — apply normalization.
- `npm run test:schema-utf8` — CI guard. Added to the master `test` chain so regressions are caught at PR time.

## Pre-push hook hardening (chore)

`.husky/pre-push` — `dist/docs` / `dist/addie/rules` / `.addie-repos` / `.context` are moved to `/tmp/.prepush-<name>-<pid>` before the Mintlify broken-links check, then restored. If interrupted, the temp dir was orphaning into `dist/docs/.prepush-<name>-<pid>/`. Now:

- Trap `EXIT / INT / TERM` to restore on any exit path.
- Idempotent restore (only moves if source exists AND dest doesn't).
- `.gitignore` entry `.prepush-*/` and `dist/docs/.prepush-*/` as belt-and-suspenders.

## Test verification

- `npm run build:schemas` — clean
- `npm run test:schemas` — 8/8
- `npm run test:examples` — 36/36
- `npm run test:composed` — 43/43
- `npm run test:json-schema` — 270/270
- `npm run test:schema-utf8` — passes
- `npx vitest run server/tests/unit` — 3760/3760 pass (233 test files)

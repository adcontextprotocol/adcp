---
---

Add `unique-org-per-email-domain` invariant + cleanup script for duplicate prospect stubs.

The April-20 prospect import re-ran without dedup, creating a second `prospect`/0-member row for ~60 companies that already had one from the December 2025 import. The duplicates are mostly empty stubs (no Stripe customer, no subscription, 0 members) but they clutter admin search and break domain-keyed automation. Worse, in a few cases (DoubleVerify, HYPD, others) the duplicate sits next to a row with real members + a Stripe customer.

Severity: warning — entitlement isn't denied (real members are on the populated row) but admins land on the stub when searching. Each violation includes a `keeper` (the row with the highest signal score: active sub, Stripe customer, members) and the `duplicate` (lower score, suggested for deletion or merge).

`scripts/incidents/2026-05-cleanup-duplicate-prospect-stubs.ts` walks the violations and DELETEs the truly empty stubs (0 members AND no Stripe customer AND no subscription); non-empty duplicates are surfaced for manual merge instead of touched. The script re-verifies emptiness inside a transaction with `FOR UPDATE` before each delete so a mid-flight write isn't silently dropped.

Going forward, the importer should `ON CONFLICT (email_domain) DO NOTHING` (or check `getOrganizationByDomain` before creating). Filed as a separate concern.

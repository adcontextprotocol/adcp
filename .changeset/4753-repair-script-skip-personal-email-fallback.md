---
---

ops(certification): add `--skip-personal-email-fallback` flag to credential repair script

`server/src/scripts/repair-credential-recipient-names.ts` now accepts a flag that skips credentials whose backfill value would be the user's email AND the email domain is a personal-email provider (gmail, hotmail, yahoo, icloud, etc.). Corporate-email users still get repaired — their email is already public on their business card / LinkedIn. Personal-email users wait for the new `NAME_REQUIRED` gate + `set_my_name` recovery flow (#4799) to populate their name, then a re-run picks them up.

Closes the cleanup loop for #4753 and #4760 — Tom Hespos's two credentials in #4760 still get fixed cleanly to "Tom Hespos" because we have his real name in the users table.

Ops-only; no protocol/wire change.

---
"adcontextprotocol": patch
---

Bump `@adcp/sdk` to `8.1.0-beta.19` to pick up the storyboard request-builder fix
(adcp-client #2144, closing #2143): `create_media_buy` flight windows are now
resolved as a pair, so a frozen-compliance-bundle fixture with a past `start_time`
and a same-day `end_time` no longer defaults the start forward into
`start_time > end_time`. Fixes the one-day `Storyboards (3.0-compat /sales)`
regression where `measurement_terms_rejected` and `media_buy_state_machine` failed
on the flight's end date (dropping clean storyboards below the floor) on every PR
and `main` run that landed on that calendar day.

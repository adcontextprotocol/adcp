# Dev mode isolation

`DEV_USER_EMAIL` + `DEV_USER_ID` enable dev-mode auth bypass: any authenticated
request from a `DEV_USERS`-listed user (e.g. `user_dev_admin_001`) skips
WorkOS lookups and reads role + membership from the local
`organization_memberships` table directly. This is the bypass that makes
`/team`, `/member-profile`, and the 23 admin-only org endpoints actually
testable without a WorkOS tenant.

The bypass is convenient but assumes strict environment separation. The
controls below keep that assumption from breaking.

## Hard guards (in code)

- **Prod-boot guard** at `server/src/middleware/auth.ts` — refuses to start
  if `DEV_USER_EMAIL` + `DEV_USER_ID` are set when `NODE_ENV=production` OR
  `FLY_APP_NAME` is present. Override is `ALLOW_DEV_MODE_IN_PROD=true` (do
  not set this).
- **Signed dev-session cookie** — value is HMAC'd with a per-process secret
  generated at boot. A cookie minted on someone else's box (or set via XSS,
  sibling subdomain) fails verification on read. Cookies don't survive a
  server restart, which is the desired property.
- **Localhost-only setter** — `POST /auth/dev-login` checks the `Host`
  header is `localhost:` or `127.0.0.1:`. Defense-in-depth.
- **Audit-log attribution** — when `resolveUserOrgMembership` resolves via
  the dev-bypass path, callers tag audit-log entries with
  `auth_method: 'dev-bypass'` so post-incident triage can distinguish
  bypass writes from real-user writes.

## Operational invariants you must preserve

1. **Production environments must not have `DEV_USER_EMAIL` or `DEV_USER_ID`
   set.** The boot guard hard-fails if they are. Verify on every deploy:
   `fly secrets list` should show neither.

2. **Dev databases must never share their `DATABASE_URL` with production.**
   Boot-time `seedDevUsers()` writes `user_dev_admin_001` and friends into
   the `users` and `organization_memberships` tables. If a dev or staging
   process ever pointed at the prod DB, those rows would land in prod and
   satisfy the local-user check at `auth.ts` line ~340 — bypassing the
   boot guard's protection because the dev path also requires the
   `users` row to exist.

   To verify: separate Fly apps (or separate DBs in the same app) and
   distinct `DATABASE_URL` secrets per environment. The integrity check
   route already refuses to run when it detects a `sk_live_*` Stripe key
   pointed at a non-prod-shaped database — apply the same hygiene to
   `DATABASE_URL`.

3. **Don't bake dev secrets into shared `.env` files that get checked in
   or copied between developers.** `.env.local` is gitignored; that's
   correct. If you copy a `.env.local` from another developer's machine,
   the `DEV_USER_EMAIL` will activate dev mode under your identity.
   Always set local secrets per-machine.

## What dev-bypass means in audit logs

Routes that go through `resolveUserOrgMembership` and write audit-log
entries propagate `via_dev_bypass: boolean` to `details.auth_method`. So
in `registry_audit_log`:

```sql
SELECT * FROM registry_audit_log
WHERE details->>'auth_method' = 'dev-bypass';
```

…shows every mutation that came from a synthetic dev user. In production,
this should be zero. In dev/staging, it documents who-touched-what.

## If dev mode accidentally enables in prod

1. **Immediately** unset `DEV_USER_EMAIL` and `DEV_USER_ID` (Fly: `fly
   secrets unset`). The next process restart re-fails the boot guard;
   restart sooner via `fly machines restart`.
2. Audit `registry_audit_log` for `details->>'auth_method' = 'dev-bypass'`
   between the time the secrets were set and when the restart happened.
3. Check `organization_memberships` for any rows with `workos_user_id LIKE
   'user_dev_%'` — these shouldn't exist in prod and indicate the database
   was shared with dev at some point. Delete them and audit downstream
   damage (any rows referencing those user IDs).

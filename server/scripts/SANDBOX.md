# Billing reconciliation sandbox

Scripted, repeatable Stripe (test-mode) + dev-DB fixture set for working on the billing reconciliation flow without touching production data. Each fixture exercises one failure mode that the cron auto-remediator must handle correctly.

## Why this exists

Building the cron-driven Stripe→DB reconciliation (issue #3623) requires exercising several edge cases that are hard to reproduce on demand:

- Paying member with `subscription_status=NULL` (missed `customer.subscription.created` webhook — the Lina case)
- Customer with multiple subscriptions (latent `subscriptions.data[0]` bug in `/sync`)
- Customer email that doesn't map to any org member (auto-remediation must refuse)
- Active Stripe customer with no AAO org link (orphan — must flag, never auto-link)
- WorkOS user resolution returning null (attestation can't be attributed)

The sandbox sets these up deterministically so the cron's behavior on each can be observed.

## Fixtures

| Fixture | Stripe state | DB org | Expected violation | Cron should... |
|---|---|---|---|---|
| `lina_class` | active sub on `aao_membership_professional_250`, customer email matches owner | `subscription_status=NULL`, owner present in `organization_memberships` | critical | Remediate (columns + attestation + audit) |
| `healthy` | active sub | `subscription_status='active'` | none | No-op |
| `email_mismatch` | active sub, customer email ≠ org owner email | `subscription_status=NULL` | critical (drift) | **Refuse** remediation (email mismatch flag) |
| `multi_sub` | 2 active subs (one membership, one non-membership) | `subscription_status=NULL` | critical for the membership sub only | Remediate using membership sub; ignore the other |
| `orphan` | active membership sub | **no DB org linked** | warning | Flag only — never auto-link (hijack vector) |
| `workos_no_resolution` | active sub | `subscription_status=NULL`, no `organization_memberships` row | critical (drift) | **Refuse** remediation (no member to attribute attestation to) |

## Usage

### Setup

Requires `STRIPE_SECRET_KEY` to start with `sk_test_` and `DATABASE_URL` to point at local Postgres (refuses for any Fly hostname).

```bash
DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config server/scripts/setup-sandbox.ts
```

Idempotent — re-running detects existing fixtures via `metadata.aao_sandbox_id` and skips.

### Verify

```bash
DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config server/scripts/verify-sandbox.ts
```

Runs the `stripe-sub-reflected-in-org-row` invariant against the local sandbox state and prints violations. Expected output: 4 critical (lina_class, multi_sub, email_mismatch, workos_no_resolution) + 1 warning (orphan).

### Inspect manually

```sql
-- All sandbox orgs
SELECT workos_organization_id, name, subscription_status, stripe_customer_id
  FROM organizations
 WHERE name LIKE 'AAO Sandbox - %'
 ORDER BY name;

-- Sandbox memberships
SELECT om.workos_organization_id, om.email, om.role, o.name
  FROM organization_memberships om
  JOIN organizations o ON o.workos_organization_id = om.workos_organization_id
 WHERE o.name LIKE 'AAO Sandbox - %';
```

### Teardown

```bash
DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config server/scripts/setup-sandbox.ts --teardown
```

Removes all Stripe customers tagged `metadata.aao_sandbox_fixture=true` and all DB rows for sandbox orgs/users.

## Conventions

- All Stripe customers + subs + the non-membership product are tagged `metadata.aao_sandbox_fixture=true`.
- Each fixture's customer is additionally tagged `metadata.aao_sandbox_id=<fixture_name>` for individual lookup.
- DB org names are prefixed `AAO Sandbox - `.
- DB org/user ids use `org_aao_sandbox_<fixture_name>` / `user_aao_sandbox_<fixture_name>`.
- Email domain is `aao-sandbox.test` so sandbox users never collide with real members.

## Adding new fixtures

Edit the `FIXTURES` array in `setup-sandbox.ts`. Each `FixtureSpec` describes:

- `id` — kebab/snake-case label, used in metadata + DB ids
- `primary_price_lookup_key` — Stripe lookup_key for the membership sub
- `secondary_price_lookup_key` — optional second sub on the same customer
- `stripe_customer_email_override` — mismatch vs. org owner
- `org_subscription_status` — what the DB row claims (null to simulate drift)
- `insert_org_membership` — false simulates "WorkOS doesn't know this user"
- `link_customer_to_org` — false makes it an orphan customer
- `is_personal` — workspace flag

After editing, re-run `setup-sandbox.ts`; only the new fixtures are added.

## What this is NOT

- Not a CI test fixture. The unit tests under `server/tests/unit/integrity/` mock Stripe at the SDK boundary and run in isolation. The sandbox is for hands-on local verification of integration behavior — Stripe wire format, webhook timing, multi-call orchestration.
- Not a production-data backup. Don't run against `sk_live_*`. The script refuses.
- Not a soak/load test. 6 fixtures + their 7 subs is a smoke test surface.

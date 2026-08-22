# AdCP Shared Registry

This directory holds entries published to the shared AdCP registry:

- `policies/` — governance policies (regulations, standards, platform rules)
- `policy-categories/` — named categories referenced by policy entries and plans
- `attributes/` — restricted-attribute definitions used in signal declarations

Registry entries are intended for aggregation across publishers. Downstream
consumers (governance agents, plan authors, compliance reporting) rely on each
entry carrying enough metadata to be understood without out-of-band context.

## Publication bar for `policies/`

The `PolicyEntry` schema only requires three fields (`policy_id`,
`enforcement`, `policy`) so buyers can author bespoke inline policies
ergonomically. **Registry-published entries must meet a higher bar.**

Every file under `policies/*.json` must set:

| Field | Requirement |
| --- | --- |
| `policy_id` | Must match the filename. Registry ids are flat snake_case (e.g. `us_coppa_data_collection`); colonned namespace-style ids seen in the schema examples are not yet supported at the file level. |
| `source` | Must be `"registry"` |
| `version` | Semver string (e.g. `"1.0.0"`). Bump on content changes. |
| `name` | Non-empty human-readable name |
| `category` | `"regulation"` or `"standard"` |
| `jurisdictions` | Array of ISO 3166-1 alpha-2 codes. Use `[]` for non-jurisdiction-specific policies (e.g. platform rules). |
| `governance_domains` | Non-empty array. Routes the policy to the right governance surface (e.g. `["campaign"]`, `["creative", "property"]`). Without this, consumers can't tell which agents should evaluate the policy. |
| `source_url` | http(s) link to the authoritative source text |
| `source_name` | Issuing body |
| `effective_date` | ISO 8601 date (`YYYY-MM-DD`). Future dates are fine — the schema treats pre-effective policies as informational. |
| `exemplars.pass` | At least one passing scenario. Each entry must have non-empty `scenario` and `explanation`. |
| `exemplars.fail` | At least one failing scenario. Same shape as `pass`. |

The pass/fail exemplar requirement is what makes registry entries useful for
governance-agent calibration — an entry without both sides doesn't tell a
downstream agent where the line actually sits.

## Why this isn't schema-enforced

The same `PolicyEntry` type is used for inline bespoke authoring inside
`sync-plans`, `content-standards`, etc. Forcing buyers to fill in
`version: "1.0.0"` plus `name`, `category`, etc. for every ad-hoc rule would
make inline authoring painful for no downstream benefit. The distinction is a
publishing concern, not a protocol concern — so CI is the enforcement point.

## CI enforcement

```bash
npm run check:registry
```

This runs `scripts/check-registry-completeness.cjs` against every file under
`policies/*.json` and fails the build if any entry is missing a required
field. Hooked into the `JSON Schema Validation` workflow and runs on every PR.

The linter only covers `policies/` today. `attributes/` and `policy-categories/`
have their own shapes and aren't yet gated — add similar checks when those
directories grow.

## Adding a new policy

1. Create `policies/<stable_snake_case_id>.json`. Pick an id that reflects
   jurisdiction + scope (e.g. `us_ftc_health_claims`, `eu_dsa_political_targeting`).
2. Fill in the required fields above plus relevant optional metadata
   (`policy_categories`, `region_aliases`, `requires_human_review`, `channels`,
   `guidance`).
3. Write at least one pass and one fail exemplar. These are the calibration
   signal for governance agents — they carry more weight than the policy text
   alone.
4. Run `npm run check:registry` locally to confirm the entry passes the bar.
5. Publish the entry to the DB-backed resolver in the same PR, following the
   procedure below. A checked-in JSON file alone is not live registry data.

## Publishing to the live resolver

Production applies registry data through versioned database migrations during
the normal release command. Generate the migration from the checked-in JSON so
the repository remains the source of truth:

```bash
node scripts/generate-policy-publication-migration.cjs \
  <next_migration_number>_publish_<policy_group> \
  <policy_id> [<policy_id> ...]
```

Fetch `origin/main` and check `server/src/db/migrations/` before choosing the
next migration number. Commit the generated migration with the policy files;
do not hand-edit its embedded data. The generated upsert is idempotent and only
updates an existing authoritative entry when its version exactly matches the
source version. It will not replace a different — including later — version.

After the main deployment completes, verify each pinned policy, the bulk
resolver, and the applicable domain listing:

```bash
curl --fail --get 'https://adcontextprotocol.org/api/policies/resolve' \
  --data-urlencode 'policy_id=<policy_id>' \
  --data-urlencode 'version=<version>'

# State-changing HTTP methods use double-submit CSRF protection, including
# this read-only POST. The first request returns the token and cookie to retry.
POLICY_COOKIE_JAR=$(mktemp)
CSRF_TOKEN=$(curl --silent --cookie-jar "$POLICY_COOKIE_JAR" \
  --header 'Content-Type: application/json' \
  --data '{"policy_ids":["<policy_id>"]}' \
  'https://adcontextprotocol.org/api/policies/resolve/bulk' | jq --raw-output --exit-status '.token')
curl --fail --cookie "$POLICY_COOKIE_JAR" \
  --header 'Content-Type: application/json' \
  --header "X-CSRF-Token: $CSRF_TOKEN" \
  --data '{"policy_ids":["<policy_id>"]}' \
  'https://adcontextprotocol.org/api/policies/resolve/bulk'
rm "$POLICY_COOKIE_JAR"

curl --fail --get 'https://adcontextprotocol.org/api/policies/registry' \
  --data-urlencode 'domain=<governance_domain>'
```

Treat a policy text or metadata change as a new version: update the JSON
`version`, generate a new migration, and deploy both together. Never edit an
already-applied migration.

## Policy-backed interoperability codes

A registry policy can also provide a stable cross-agent compliance or rejection
identifier without adding an enum to an AdCP schema. A governance agent
advertises support as `registry:{policy_id}` and returns a binary compliance
value; an enforcing seller references the bare `policy_id` on the applicable
error-details surface.

Keep the axes separate:

- The policy ID identifies the rule that was applied.
- Agent-defined features describe observations made by a detector.
- The agent and methodology identify who detected the observation and how.
- Task- or lifecycle-specific reason codes identify when the decision occurred.

Do not mint policies for scanner vendors, private account deny-lists, or other
provenance and transaction state. Parameterized policies must say which limits
the seller or evaluating agent is responsible for publishing. See
`docs/governance/creative/policy-backed-rejections.mdx` for the complete
creative rejection pattern.

## Non-goals

- This bar does **not** apply to inline `PolicyEntry` values used in
  `sync-plans`, `content-standards`, or `custom_policies`. Those remain
  lightweight (only `policy_id`, `enforcement`, `policy` required) and are
  unaffected by the CI linter.
- Registry-sourced policies are authoritative within a governance evaluation
  and cannot be relaxed by inline policies — see the `PolicyEntry` schema
  description for the evaluation-precedence rules.

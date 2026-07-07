# Agent Playbook

This is the canonical, shared behavior file for this repository. Claude,
Codex, and any future agent wrapper should point here so the repo has one
source of truth.

## Documentation Framework

This project uses **Mintlify** for documentation:
- All docs in `docs/` directory as Markdown/MDX
- Use `<CodeGroup>` for multi-language examples (NOT Docusaurus `<Tabs>`)
- Run with: `mintlify dev`

## Worth The Tokens

Every task costs context — your tokens, the model's compute, the user's
attention, and the maintenance load of whatever you ship. Run every decision
through this lens: **is this worth the tokens it will cost to complete?**

### Signals it IS worth the tokens

- **Prevents future pain.** Schema ambiguity that will cause integration
  bugs. Spec contradiction that confuses implementers. Field-shape that's
  cheaper to fix before GA than after. Conformance gap that lets
  non-conformant agents pass. Trust-boundary tightening.
- **Real customer pulling.** A specific member, contributor, or integrator
  is blocked or actively asking.
- **Closes a known footgun.** Code that already burned someone once and
  will burn the next person without the fix.
- **Active work with clear path.** Open PR, recent commits, scoped enough
  to finish in a few sessions.

### Signals it ISN'T worth the tokens

- **Speculative.** No customer pull, no concrete failure mode — just
  "this would be nice."
- **Aged out.** No activity in 30+ days and no one has asked.
- **Tracking-only.** Exists to "track" something but has no clear next
  action and isn't blocking anyone.
- **Polish on a sunset surface.** Improving something slated for
  deprecation or supersedure.
- **Fix is bigger than the bug.** Three-week refactor to eliminate a
  papercut someone hits twice a year.

### How to apply

- **In triage:** default-defer low-value issues. Use the `P0 Bugs`
  milestone for immediate user/revenue/security/reliability bugs that
  should be worked before the general backlog. Use `Spec Backlog` for
  protocol/spec/schema/normative-doc work that is not yet committed to a
  numbered release. Use `Evergreen` only for non-spec, non-versioned
  work that still matters later. Closing issues is a human call; triage
  should route, clarify, defer, or leave an implementation brief. Don't
  punt for the sake of punting — spec quality and pain-prevention are
  strong "keep" signals even without an active PR.
- **In implementation:** if a task touches three files when you scoped
  it to one, stop. Either re-scope or defer.
- **In scope decisions:** prefer the smallest change that closes the
  loop. Spec quality wins ties over completeness; completeness wins
  ties over aesthetics.

The goal is to spend tokens on things that make the spec better and
prevent pain later — and *not* spend tokens on things that don't.

## Critical Rules

### Organization Naming
- ✅ **AgenticAdvertising.org** - the member organization
- ✅ **AdCP** - the protocol specification
- ❌ Never "Alliance for Agentic Advertising", "AAO", or "ADCP"

### Membership Terminology

The word "member" means different things in different contexts. Use precise
language to avoid confusion — especially in prompts, context formatting, and
user-facing strings where ambiguity causes misdiagnosis and bad escalations.

| Term | Meaning | Determined by |
|------|---------|---------------|
| **AAO member** (org) | Organization with active AgenticAdvertising.org subscription | `subscription_status = 'active' AND subscription_canceled_at IS NULL` |
| **Org member** (user) | A person who belongs to a WorkOS organization | `organization_memberships` table, `joined_at` field |
| **Working group member** | A person who belongs to a specific working group | `working_group_members` table |
| **Community member** | Any registered user with engagement activity | Engagement signals, community points |

**Rules:**
- When displaying dates, never label `org_membership.joined_at` as "Member since" — use "Joined organization" to distinguish from AAO membership tenure.
- Section headers like "Organization Role" (not "Organization Membership") prevent confusion with AAO subscription status.
- When `is_member` is false but an org has a non-null `subscription_status`, surface the status so agents can diagnose billing vs. enrollment issues.
- In tool descriptions, qualify which kind of membership: "AgenticAdvertising.org member organization" (subscription) vs. "organization member" (WorkOS role).

### Examples: No Real Brands or Agencies
- ❌ Never use real company names (brands, agencies, holding companies) in new examples
- ✅ Use fictional names: Acme Corp, Pinnacle Media, Nova Brands, etc.
- The brand seed data in migrations may list real domains for discovery purposes
- Enum values that reference industry standards (e.g., `"groupm"` viewability standard) are protocol terms, not examples

### Schema Compliance
All documentation and examples MUST match JSON schemas in `static/schemas/source/`:
- Verify fields exist in schema before documenting
- Remove examples that don't match schema (don't mark as `test=false`)
- Test with: `npm test -- --file docs/path/to/file.mdx`
- ID-bearing fields that can cross storyboard step boundaries must carry an `x-entity` annotation — see `docs/contributing/x-entity-annotation.md`. For bulk sweeps use `node scripts/add-x-entity-annotations.mjs` with `scripts/x-entity-field-map.json`.

### Expert Review Scenarios
When running expert agents against documentation changes, test both:
- **Conceptual correctness** — Is the framing right? Are terms used consistently?
- **End-to-end buyer workflows** — Walk through actual buyer journeys (discovery → preview → serve → audit). Include generative-specific flows (brief → pre-flight preview → live campaign → post-flight replay) and edge cases (conversational formats, quality mismatches, multi-format pipelines).

Conceptual reviews miss workflow gaps. Workflow reviews miss framing errors. Run both.

### Discriminated Union Error Handling
Always check for errors before accessing success fields:
```javascript
const result = await agent.syncCreatives({...});
if (result.errors) {
  console.error('Failed:', result.errors);
} else {
  console.log(`Success: ${result.creatives.length} items`);
}
```

### Design System
All HTML files in `server/public/` MUST use CSS variables from `/server/public/design-system.css`:
```css
/* ✅ */ color: var(--color-brand);
/* ❌ */ color: #667eea;
```

### UI Text Casing
Use **sentence case** for all UI labels, headings, and section headers:
- ✅ "Brand identity", "Creative assets", "Contact information"
- ❌ "Brand Identity", "Creative Assets", "Contact Information"

### Addie MemberContext invariant: hydrate once, surface twice
**Mistake this prevents:** adding a new context field for a
suggested-prompts rule, watching the rule fire correctly, but having
Addie's conversational responses behave as if the data isn't there.
Two parallel data planes silently drift.

Adding a field to `MemberContext` (`server/src/addie/member-context.ts`)
means **you must surface it in two places**:

1. The hydration path — `getMemberContext` (Slack) and
   `resolveContextFromLocalDb` (web). Populates the field.
2. `formatMemberContextForPrompt` — so Addie's system prompt actually
   sees the signal when reasoning. Canonical example: the
   `certification` block at lines 1505-1525 of
   `server/src/addie/member-context.ts`.

If you only do (1), the suggested-prompts engine sees the field but
Addie's conversational responses don't. Closed in PR #3377; don't
reintroduce the gap.

`formatMemberContextForPrompt` should render **facts only**. Response
policy ("gently suggest X", "encourage retry") belongs in
`server/src/addie/rules/*.md`, not in the user-context block.
Otherwise each user gets a slightly different policy depending on
hydration and the prompt-injection surface widens.

### Addie CTA registry: one catalog, per-surface eligibility
**Mistake this prevents:** maintaining the same CTA in two places
(rule registry + a separate picker), drifting on copy, eligibility,
or priority. We had this with `digest-nudge.ts` until PR #3382.

Cross-cut CTAs (firing on suggested-prompts + newsletter digest, etc.)
are co-located in
`server/src/addie/home/builders/rules/prompt-rules.ts`. Each rule
keeps its **own `when` clause per surface** (typed against that
surface's native shape — `MemberContext`, `DigestEmailRecipient`,
etc.). We share the *catalog* of CTAs, not the eligibility logic.

Per-surface gating is honest about each surface's constraints — e.g.,
the digest WG nudge gates on `has_slack` because joining a WG without
Slack is harder; the pull-surface WG nudge doesn't, because the user
is already in a chat surface that supports the join flow. Canonical
example: `wg.find_groups` rule with both `pull` (the bare `when:
({memberContext}) => ...`) and `digest: { when: (r) => ... }` clauses.

Surface-specific facets live alongside the rule's pull-surface fields.
The digest facet is on `PromptRule.digest`. CTAs with no pull-surface
analog live in `DIGEST_ONLY_NUDGES`
(`server/src/addie/home/builders/rules/digest-only-nudges.ts`).

When adding a new surface that wants to consume the registry, add a
new facet type (parallel to `DigestNudgeFacet`) and a new
`*_ONLY_NUDGES` array. Don't try to reshape an existing surface's
context to fit yours — `DigestEmailRecipient` and `MemberContext` are
intentionally different and the lossy adapter would be worse than
two `when` clauses.

### Addie rule registry: function prompts require matchClick
**Mistake this prevents:** adding a rule with a dynamic `prompt`
function (e.g., "Continue A1") and silently getting zero click
attribution because the static reverse-index can't enumerate function
output. The boot-time assertion in
`server/src/addie/home/builders/rules/prompt-rules.ts` catches this
at module load — see the loop right after `ALL_RULES`. If it throws,
add a `matchClick` callback (see `cert.continue_in_progress` for the
pattern).

## JSON Schema Guidelines

### Discriminated Unions
Use explicit discriminator fields with `"type"` before `"const"`:
```json
{
  "oneOf": [
    {
      "properties": {
        "kind": { "type": "string", "const": "variant_a" },
        "field_a": { "type": "string" }
      },
      "required": ["kind", "field_a"]
    }
  ]
}
```

Include common fields (like `ext`) inside each variant, not at root level.

### Schema Locations
- Source schemas: `static/schemas/source/` (development, serves as `latest`)
- Released versions: `dist/schemas/{version}/` (e.g., `2.5.3`, `3.0.0-beta.3`)
- Local access: `http://localhost:3000/schemas/latest/` when running dev server

### Schema URLs in Documentation

When linking to schemas in docs, use the correct version alias:

**Released schemas** - Use the major version alias:
```markdown
[$schema](https://adcontextprotocol.org/schemas/v3/media-buy/create-media-buy-request.json)
```

**Unreleased schemas** (exist in `static/schemas/source/` but not in any `dist/schemas/{version}/`) - Use `/schemas/latest/`:
```markdown
<!-- Using latest because this schema is not yet released in any version.
     Update to correct version alias after the next release. -->
[$schema](https://adcontextprotocol.org/schemas/latest/media-buy/sync-audiences-request.json)
```

**How to check if a schema is released:**
1. Check `dist/schemas/` for the highest version number under each major (e.g., `3.0.0-beta.3` for v3, `2.5.3` for v2)
2. If the schema exists in a released version, use that major version alias (v3, v2)
3. If only in `static/schemas/source/`, use `latest`

**Version aliases:**
- `/schemas/v3/` → latest published 3.x release (do not hardcode a patch/RC number here; check `dist/schemas/` for the current target)
- `/schemas/v2/` → latest published 2.x release (check `dist/schemas/` for the current target)
- `/schemas/v1/` → points to `latest` (for backward compatibility)
- `/schemas/latest/` → development version (`static/schemas/source/`)

This avoids drift with the release-line section below, where `3.0.x` continues to advance after release candidates.

**CI validation:** The `check-schema-links.yml` workflow validates schema URLs in PRs and will warn about unreleased schemas or suggest the correct version.

### Protocol vs Task Response Separation
Task responses contain ONLY domain data. Protocol concerns (message, context_id, task_id, status) are handled by transport layer.

## Versioning

### Changesets
#### Protocol package changesets only
Only PRs that change the published AdCP protocol package surface should carry
an `adcontextprotocol` changeset. That surface includes schemas, task
definitions, compliance assets, normative reference docs, release scripts, and
versioned `dist` artifacts generated by a protocol release.

Do **not** add a changeset for app, site, billing, admin, Addie, newsletter,
digest, migration-only, deployment, or operational-only work. Do not add an
empty changeset just to satisfy CI; the changeset check has explicit skip rules
for release machinery and policy-only maintenance.

When a protocol changeset is needed, run:

```bash
npx changeset
```

Then **immediately rename** the generated file from its random name (for example, `petite-beds-film.md`) to a descriptive name matching the change (for example, `fix-pg-idle-timeout-retry.md`):

```bash
mv .changeset/<random-name>.md .changeset/<descriptive-name>.md
```

Add a clear description in the changeset body.

Before opening or updating a PR with a changeset, stage the changeset and run
the same gates CI uses:

```bash
git add .changeset/<descriptive-name>.md
node scripts/check-changeset-protocol-scope.cjs origin/main
npx --yes @changesets/cli@^2.31.0 status --since=origin/main
```

The changesets CLI ignores untracked files, so the local check can still fail
until the changeset file is staged or committed.

If the scope check flags the changeset, remove it unless the PR also touches
protocol-scoped files. The fix for a billing/UI/app-only PR is no changeset,
not an empty one.

**NEVER manually edit versions.** Use changesets:
```bash
# Create .changeset/your-feature.md
---
"adcontextprotocol": minor
---
Description of change.
```

Types: `patch` (fixes), `minor` (new features), `major` (breaking).

### Immutable released artifacts

Released `dist` artifacts are append-only. Do **not** patch, rewrite, delete, or
add files inside an existing semver release artifact:

- `dist/schemas/<semver>/`
- `dist/compliance/<semver>/`
- `dist/docs/<semver>/`
- `dist/protocol/<semver>.*`

`dist/*/latest` is the mutable development output. Existing semver paths are
release records. If a released schema, compliance storyboard, docs bundle, or
protocol tarball is wrong, change the source of truth and ship a new versioned
artifact through the release flow:

1. Edit source files such as `static/**/source`, docs source, or build tooling.
2. Add the appropriate protocol changeset.
3. Let Version Packages run `npm run version`, which creates a new
   `dist/**/<new-version>` artifact.

This applies to agents and CI fixes too. For example, do not modify
`dist/compliance/3.0.14` to repair a hosted compliance test. Make the fix in
source and cut the next patch/RC release for the line that needs it. Temporary
copies in CI scratch directories may be transformed for compatibility testing,
but checked-in existing semver artifacts must remain unchanged.

This includes beta and RC artifacts after GA. Do not clean out
`dist/{schemas,compliance,docs,protocol}/<version>-beta.*` or
`dist/{schemas,compliance,docs,protocol}/<version>-rc.*` during the stable
release. They are release records for adopters who pinned prerelease artifacts
and for debugging release history. GA cleanup may hide prerelease selectors from
navigation, but it must not delete or rewrite published prerelease artifacts or
published npm versions.

#### PR title hygiene

PR titles must be review- and release-ready:

- Use conventional-commits format (`fix(scope): summary`, `docs: summary`, `feat(schema): summary`).
- Do not prefix titles with the tool or model that authored the PR. In particular, never use `[codex]`, `[claude]`, `[agent]`, or similar ownership tags.
- The authoring tool belongs in the PR body/session link or labels when useful, not in the title. PR titles flow into release/review surfaces, so tool prefixes create noise and can break title-based automation.

Before creating or updating a PR title, validate it locally:

```bash
node scripts/check-pr-title.cjs "fix(scope): concise human title"
```

**No changeset for everything that isn't a protocol change:**
- Addie (any server-side AI behavior, tools, routing, bolt app)
- Website / admin UI / member pages
- Non-normative documentation updates
- Infrastructure, deployment, migrations
- Internal tooling and scripts

Only use `patch`/`minor`/`major` when the change affects the published AdCP protocol spec — schemas, task definitions, API reference.

### Semantic Versioning for Schemas
- **PATCH**: Fix typos, clarify descriptions
- **MINOR**: Add optional fields, new enum values, new tasks
- **MAJOR**: Remove/rename fields, change types, remove enum values

### Release lines

AdCP runs two release lines simultaneously:

- **`main`** → next minor (currently `3.1.0-beta.N` while in pre mode; see `.changeset/pre.json`)
- **`3.0.x`** → patches to the current minor (`3.0.2`, `3.0.3`, …)

Branch naming follows `<major>.<minor>.x` to match the existing `2.6.x` precedent. No `release/` prefix.

#### Cherry-pick convention

Default flow when a fix is needed in both lines:

1. Author lands on `main` first (normal PR flow)
2. After merge, cherry-pick to `3.0.x`:
   ```bash
   git checkout 3.0.x && git pull
   git cherry-pick <main-sha>
   git push origin 3.0.x
   ```
3. The forward-merge workflow (`.github/workflows/forward-merge-3.0.yml`) opens a PR back to `main` whenever `3.0.x` updates. Merging it keeps the lines provably in sync. Auto-resolution is **metadata-only** — anything else fails the workflow loud and requires human review.

   **Auto-resolved (metadata that legitimately diverges by-design):**
   - `package.json` / `package-lock.json` → preserve main's (main may carry structural changes — package renames, new deps — that 3.0.x doesn't)
   - `.changeset/*.md` / `.changeset/pre.json` → preserve main's (independent pre-mode pool)
   - `static/schemas/source/index.json` / `static/schemas/source/registry/index.yaml` → preserve main's (branch-local package/version metadata must stay aligned with main)
   - `CHANGELOG.md` → take 3.0.x's (main's next Version Packages cut prepends its own entries above)
   - `dist/{schemas,compliance,protocol,docs}/*` → take 3.0.x's (immutable per release; main only ever ADDS)

   **Fails loud (everything else):** every other conflict is a real backport decision and surfaces for human review. This includes the known cross-line divergences in `static/compliance/source/universal/{storyboard-schema,runner-output-contract}.yaml`, `static/schemas/source/{core/error.json,enums/error-code.json,protocol/get-adcp-capabilities-response.json}`, `.github/workflows/training-agent-storyboards.yml`, and `docs/building/implementation/error-handling.mdx` — main carries 3.1-track additions (new enum codes, schema discriminators, the CANONICAL CHECK ENUM block) that can't ship to 3.0.x without breaking the patch contract. Each push to 3.0.x that touches one of these regions will require a manual forward-merge PR until 3.1.0 cuts and replaces both lines.

   **Why metadata-only:** an earlier version of the workflow auto-resolved the cross-line content files via whole-file `git checkout --ours`, which silently dropped 3.0.x's non-conflicting changes alongside the divergent regions. Five days of patches (v3.0.5 → v3.0.9, ~30 commits) silently failed to forward-merge before the bug was found. Loud failure on every content conflict is the right primitive: it's annoying for the divergent files but it surfaces real decisions instead of dropping work. See #4306 / #4308 / #4310 for context.

   **Manual resolution recipe** (when the workflow fails):
   ```bash
   git fetch origin
   git checkout -b forward-merge/3.0.x-<descriptor> origin/main
   git merge origin/3.0.x  # resolve conflicts in editor — for the 7 known-divergent files,
                            # take main's side (it carries 3.1-track shape)
   git push origin forward-merge/3.0.x-<descriptor>
   gh pr create --base main --head forward-merge/3.0.x-<descriptor>
   ```
   Branch name **must** start with `forward-merge/` — the changeset-check workflow skips on this prefix (the merge brings package-changing commits whose changesets were already consumed by 3.0.x's Version Packages cut).

4. **Skip rules for release-machinery PRs.** The changeset-check workflow (`.github/workflows/changeset-check.yml`) skips PRs whose `head_ref` starts with:
   - `changeset-release/` — Version Packages PRs (changesets already consumed)
   - `forward-merge/` — forward-merge PRs (changesets explained by source branch's CHANGELOG, not by a new file on main)

   Any other PR head triggers the check normally. Don't bypass via empty changeset padding — the skip is the right primitive.

#### Patch eligibility

For each surface a PR touches, the corresponding rule must hold. A PR touching multiple surfaces must satisfy all relevant rules.

**Stable schemas** — no new fields, no renamed fields, no new enum values, no new error codes, no new normative requirements. Clarifications are patch-eligible only when both:
1. The prior spec was demonstrably silent or ambiguous on the input (not just unstated), AND
2. Any conformant 3.0.0 implementation of the surrounding behavior would already satisfy the new MUST.

If a previously-conformant implementation could fail the clause, it's a new requirement and ships in `3.1.x` only. (This is the IETF errata vs. bis test.)

**Experimental surfaces** (governance, TMP, anything `x-status: experimental`) — additive changes are always patch-eligible without notice. Breaking changes follow the 6-week notice rule in `docs/reference/experimental-status.mdx` and therefore ship in the next minor, not a patch.

**Conformance harness** (`comply_test_controller`, storyboards, `runner-output.json`) — additive scenarios, additive `comply_test_controller` enum values, new universal storyboards, and additive `runner-output.json` step kinds are patch-eligible. Renaming or repurposing existing step kinds is not.

**Non-normative docs and release tooling** — always patch-eligible. Includes typo fixes, link corrections, example updates, runbook changes.

**Normative docs** (security guidance, idempotency rules, error semantics, signing/transport behavior, `.well-known` files like `adagents.json`/`brand.json` schemas) — follow the stable-schemas rule above. "It's just docs" doesn't apply when the docs change required behavior.

**Never patch-eligible** (per `docs/reference/experimental-status.mdx`):
- Transport-layer changes (MCP, A2A, REST envelope semantics)
- Auth profile changes (RFC 9728, OAuth scopes)
- Signing profile changes (RFC 9421 covered components, JWS algorithms)

These are version-level concerns. Security fixes ship as out-of-band advisories or in the next minor.

If unsure, default to no changeset and discuss whether the change belongs on
`3.0.x` at all. Many fixes are stable-only and ship in `3.1.x` only.

#### Pre mode (beta releases)

`.changeset/pre.json` puts main in **pre mode** — every Version Packages cut produces `3.1.0-beta.N` instead of `3.1.0`. This is a deliberate safety net: if a `minor` changeset slips into `main` accidentally, it ships as a beta drop, not as 3.1.0 stable.

To exit pre mode and cut 3.1.0 stable:

```bash
npx changeset pre exit   # deletes .changeset/pre.json
git add -A && git commit -m "chore(release): exit pre mode for 3.1.0 stable cut"
# open PR, land it
```

Next Version Packages cut after the exit PR merges produces `3.1.0` stable.

The stable cut is not complete until public docs and package tags stop presenting
the line as a prerelease:

- Mintlify navigation uses the stable label (`3.1`), not `3.1-rc` or
  `3.1-beta`, and points at the final `dist/docs/3.1.0/` snapshot after the docs
  snapshot PR lands.
- The docs banner says 3.1 is released or is removed. No primary docs page
  should say 3.1 is still in RC validation.
- Release notes, versions, what's-new, and migration pages describe the final
  GA release. Keep RC/beta guidance only in prerelease migration/archive pages.
- SDK examples on GA-facing pages use the stable wire pin (`"3.1"`). Exact RC
  pins belong only in prerelease guidance.
- npm dist-tags for the stable line point at the intended GA package. Old
  beta/RC package versions remain available.

#### When 3.1.0 cuts — release-line transition

Cutting 3.1.0 ends the 3.0.x ↔ main divergence and starts a new 3.0.x → 3.1.x lifecycle. Steps to take **at the same time as the 3.1.0 stable release**:

1. **Cut the `3.1.x` branch.** Branch off `main` immediately after the 3.1.0 tag is published:
   ```bash
   git checkout main && git pull
   git checkout -b 3.1.x origin/main
   git push -u origin 3.1.x
   ```
   `main` then advances toward `3.2.0-beta.N` (re-enter pre mode with `npx changeset pre enter beta` and a new `.changeset/pre.json`).

2. **Update `forward-merge-3.0.yml` → `forward-merge-3.1.yml`.** The workflow targets `3.1.x` now; rename the file and update `branches:` and the merge target. Keep `3.0.x` only if 3.0.x stays in maintenance for security fixes (see step 4).

3. **Reset the auto-resolve allowlist if needed.** When 3.1.0 absorbs the 3.1-track additions on main, the cross-line divergences in `error-code.json`, `error.json`, `runner-output-contract.yaml`, `storyboard-schema.yaml`, `get-adcp-capabilities-response.json`, `training-agent-storyboards.yml`, and `error-handling.mdx` collapse — `3.1.x` and `main` start identical. The allowlist stays metadata-only (the same list as for 3.0.x is correct for 3.1.x), but the **known-divergent file list documented in the cherry-pick section above no longer applies**. Update that list in this playbook to reflect any new 3.2-track-only divergences that emerge.

4. **Decide 3.0.x's fate.** Options:
   - **Sunset immediately**: archive the `3.0.x` branch, stop publishing patches. Document the EOL in `docs/reference/version-support.mdx` and announce in the release notes.
   - **Maintenance window**: keep `3.0.x` for security-only fixes for N months. If you do this, **also keep `forward-merge-3.0.yml`** so security patches still flow forward — but expect every push to fail loud (3.1.x has structurally diverged from 3.0.x at this point) and require manual resolution. Maintenance windows are heavy ops; only do this if there's an active security commitment.

5. **Update `RELEASING.md` and this playbook** with the new release-line topology. The stale 3.0.x examples in this section will need to be rewritten in terms of 3.1.x.

**Lessons captured from the 3.0.x line** (apply to every future maintenance line):
- **Never auto-resolve content files with `git checkout --ours` on whole files.** Whole-file resolution silently drops non-conflict changes. Allowlist metadata only; let content fail loud.
- **The forward-merge workflow's exit code must reflect actual merge state.** A "success" run that produced no PR for a non-empty divergence is a silent failure mode. Always log the merge tree-state explicitly (the workflow now does: `git diff --quiet origin/main HEAD` gates the PR-creation step).
- **Permanent cross-line divergences accumulate.** Once a file has any divergent region, every subsequent 3.0.x patch that lands near that region produces a real conflict. Manual forward-merges are the steady state, not the exception. Plan ops capacity accordingly.
- **Forward-merge PRs can't carry their own changesets** — the source branch's changesets are already consumed. The changeset-check workflow needs an explicit skip rule keyed on `head_ref` prefix (`forward-merge/*`). Carry this skip rule forward when you create the 3.1.x → main pipeline.
- **Reference implementations should land on `main` first**, then cherry-pick to maintenance lines only when truly needed (security, severe bugs). Don't dual-track features — that's how you grow the divergent-file list.

#### App-token convention

`release.yml`, `release-docs.yml`, and `forward-merge-3.0.yml` mint a GitHub App installation token via `actions/create-github-app-token@v3` (secrets `RELEASE_APP_ID` / `RELEASE_APP_PRIVATE_KEY`) instead of using the default `GITHUB_TOKEN`. App-token-triggered events (push, PR open, release publish) DO fire downstream workflows; `GITHUB_TOKEN`-triggered events don't (GitHub's recursion-blocking rule). Without this swap, the Version Packages PR's required CI never fires, the release-docs snapshot is never created on `release: published`, and the auto-snapshot PR's required CI never fires either.

Two Apps, two trust surfaces: release machinery uses the release App above; the Secretariat (Argus reviews in `ai-review.yml`, server-side GitHub writes from Addie jobs) uses the **AAO Secretariat** App (`aao-secretariat[bot]`, secrets `SECRETARIAT_APP_ID` / `SECRETARIAT_APP_PRIVATE_KEY` — Actions secrets for the workflow, Fly secrets for the server). Server code mints installation tokens through `server/src/addie/jobs/github-app-token.ts`; `resolveGitHubToken()` is the single seam, and a configured-but-failing App fails closed rather than falling back to a PAT.

#### Runbooks

- `.agents/shortcuts/cut-patch.md` — cutting a `3.0.X` patch
- `.agents/shortcuts/cut-beta.md` — cutting a `3.1.0-beta.N` and exiting pre mode for 3.1.0 stable
- `.agents/shortcuts/cut-major.md` — cutting a major (4.0 when its time comes)

### Addie Code Version
When making significant changes to Addie's core logic, bump `CODE_VERSION` in `server/src/addie/config-version.ts`.

**When to bump:**
- Claude client behavior (`claude-client.ts`)
- Tool implementations (`mcp/*.ts`)
- Message processing logic (`thread-service.ts`, `bolt-app.ts`)
- Router logic beyond `ROUTING_RULES` (`router.ts`)

**Format:** `YYYY.MM.N` (e.g., `2025.01.1`, `2025.01.2`, `2025.02.1`)

This creates a new Addie config version, allowing performance comparison before/after code changes.

## Deployment

Production deploys to **Fly.io** (not Vercel). Migrations run automatically on startup.
- Deploy logs: `fly logs -a <app-name>`
- SSH access: `fly ssh console -a <app-name>`

## Local Development

**Always use Docker for local testing:**
```bash
docker compose up --build  # Start postgres + app with auto-migrations
docker compose down -v     # Reset database
```

The app runs on `$CONDUCTOR_PORT` (from `.env.local`), defaulting to 3000. Static files in `server/public/` are hot-reloaded via volume mount.

### Environment Variables
- `CONDUCTOR_PORT` - Server port (default: 3000)
- `DATABASE_URL` - PostgreSQL connection string
- `DEV_USER_EMAIL` / `DEV_USER_ID` - Enable dev mode (local only)

### Slack Apps
Two separate apps with independent credentials:
1. **AgenticAdvertising.org Bot**: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`
   - Events: `/api/slack/aaobot/events`
   - Commands: `/api/slack/aaobot/commands`
2. **Addie AI**: `ADDIE_BOT_TOKEN`, `ADDIE_SIGNING_SECRET` → `/api/slack/addie/events`

### Dev Login
With dev mode enabled, visit `/dev-login.html` to switch between admin/member/visitor test users.

## Documentation Locations

**Update for releases:**
- `docs/intro.mdx` - Info banner
- `server/public/index.html` - Homepage version
- `docs/reference/release-notes.mdx` - Release notes
- `docs/reference/roadmap.mdx` - Roadmap

**Auto-generated (don't edit):**
- `CHANGELOG.md` - Managed by changesets

## Testable Documentation

Mark pages with `testable: true` in frontmatter. All code blocks will be executed:
```markdown
---
title: get_products
testable: true
---
```

JSON examples with `$schema` field are validated against schemas in CI.

## Format Conventions

### Field Naming
- `formats` = Array of full format objects
- `format_ids` = Array of format ID references

### Format ID Structure
Always structured objects:
```json
{
  "agent_url": "https://creatives.adcontextprotocol.org",
  "id": "display_300x250"
}
```

### Renders Structure
Visual formats use `renders` array with structured dimensions:
```json
{
  "renders": [{
    "role": "primary",
    "dimensions": { "width": 300, "height": 250, "unit": "px" }
  }]
}
```

## Quick Reference

### Useful Commands
```bash
docker compose up --build  # Local dev server (preferred)
npm run build              # Build TypeScript
npm test                   # Run tests
npm run lint               # Lint
npm run typecheck          # Type check
mintlify dev               # Docs dev server (requires mintlify CLI)
```

### Protocol Design Principles
1. MCP-Based
2. Asynchronous operations
3. Human-in-the-loop optional
4. Platform agnostic
5. AI-optimized

### Task Reference
- ✅ `get_products`, `create_media_buy`, `list_creative_formats`
- ❌ `discover_products`, `get_avails` (don't exist)

## Certification Program

AgenticAdvertising.org runs a three-tier certification program (Basics → Practitioner → Specialist) taught by Addie through interactive chat. Key files:

- **Curriculum**: `server/src/addie/mcp/certification-tools.ts` (teaching tools, module resources, scoring)
- **Teaching methodology**: `TEACHING_METHODOLOGY`, `BUILD_PROJECT_METHODOLOGY`, `CAPSTONE_METHODOLOGY` constants in certification-tools.ts
- **Framework doc**: `docs/learning/instructional-design.mdx` (authoritative source for teaching methodology)
- **Policies**: `docs/learning/policies/` (nondiscrimination, learner records, complaints, conflict of interest, IP, personnel)
- **Database**: `server/src/db/certification-db.ts` (progress, credentials, tracks)
- **API routes**: `server/src/routes/certification.ts` (public/authenticated endpoints)
- **UI**: `server/public/certification.html` (dashboard, LinkedIn sharing, credential display)

### Certification impact checklist

When making protocol changes (new tasks, schema changes, renamed fields, removed features):

1. **Check affected modules** — Which certification modules teach the changed concepts? Update `MODULE_RESOURCES` links and teaching context in `certification-tools.ts` if needed.
2. **Consider continuing education** — Breaking changes (`major` version bumps) that alter core concepts may require notifying credential holders. Credentials reference the protocol version at time of issuance.
3. **Update learning resources** — If you add or move documentation pages referenced in `MODULE_RESOURCES`, update the URLs.

When updating teaching methodology:

4. **Keep framework aligned** — When updating `TEACHING_METHODOLOGY`, `BUILD_PROJECT_METHODOLOGY`, or `CAPSTONE_METHODOLOGY` constants in `certification-tools.ts`, verify alignment with `docs/learning/instructional-design.mdx` and update both.
5. **Update policies if needed** — Changes to assessment, data handling, or personnel processes may require updates to the corresponding policy page in `docs/learning/policies/`.

When building new features (member profiles, dashboards, community pages):

6. **Surface credentials** — If the feature displays user identity or professional context, consider showing earned credentials.
7. **Link to certification** — New capability areas may warrant new modules or tracks. Note this in the changeset description so it can be planned.

### Security

Module and exam completion is only available through Addie's tool calls — never through REST API. This prevents users from self-reporting scores without actual assessment.

## Character Bible

**`specs/character-bible.md`** is the authoritative source for all recurring characters across documentation, certification, test fixtures, illustrations, and the homepage. Read it before writing narrative content or generating images.

### When to use the character bible

- **Writing walkthrough or overview pages** — Use the correct character for that domain. Don't invent new characters or rename existing ones.
- **Generating illustrations** — Copy the exact visual description from the bible into every Gemini prompt where that character appears. Character consistency across panels requires the full description in every prompt (Gemini has no cross-call memory).
- **Writing certification content** — Each certification path has a primary character and scenario. Use them.
- **Creating test fixtures** — Test scenarios map to specific characters and companies. Use canonical names.
- **Building homepage or marketing content** — The full cast (including Dayo and Addie) represents the breadth of the org's audience. Reference the bible for tone and framing.

### Character quick reference

| Character | Domain | Company | Role |
|-----------|--------|---------|------|
| Alex Reeves | Intro / overview | Pinnacle Agency | VP media ops |
| Sam Adeyemi | Media buy, signals (buy-side) | Pinnacle Agency | Senior media buyer |
| Jordan Ochoa | Governance | Pinnacle Agency | Campaign ops manager |
| Maya Johal | Creative | Pinnacle Agency | Creative strategist |
| Priya Nair | Seller integration | StreamHaus | Dir. ad products |
| Kai Lindgren | Signals (data provider side) | Meridian Geo | Head of partnerships |
| Tomoko Hara | Brand protocol + accounts | Nova Motors | Global brand ops manager |
| Dayo Mensah | Certification / learning | Pinnacle (fellow) | Ad tech fellow |
| Daniel Park | Commerce media | ShopGrid | VP retail media |
| Addie | All (connective tissue) | AgenticAdvertising.org | AI agent |

### Rules

- **Don't invent characters.** If a walkthrough needs a person, use someone from the bible. If no one fits, propose adding to the bible first.
- **Don't change visual descriptions.** The bible defines exactly what each character looks like. Copy it verbatim into image prompts.
- **First names only in docs.** Use "Sam" not "Sam Adeyemi" in walkthrough prose. Full names are for the bible and metadata.
- **Addie is a participant, not a tool.** In any context where Addie appears alongside humans, she's at the table — not behind the desk, not in the background.
- **Dayo uses they/them pronouns.**
- **Companies are fictional.** Pinnacle Agency, StreamHaus, Meridian Geo, Nova Motors, etc. Never substitute real company names.

## Illustrated Documentation

### Gemini image generation

**Model**: `gemini-3.1-flash-image-preview` (via `responseModalities: ["TEXT", "IMAGE"]`)

**Base style prompt** (include in every image request):
```
Flat illustration, teal/emerald color palette (#047857 primary, #0d9488 secondary, #134e4a dark accents).
Graphic novel style with clean panel borders. Clean, minimal linework with subtle gradients.
Tech-forward but warm. No real brand names or logos.
Wide aspect ratio suitable for documentation headers (roughly 16:9).
Characters should have simple but expressive faces. Use white/light backgrounds for readability.
```

**Character prompts**: Copy the full visual description from `specs/character-bible.md` into every panel prompt where that character appears. Include hair, skin tone, clothing, and distinguishing features. Gemini cannot share state across API calls — if you skip the description in one panel, the character will look different.

**Generation script**: `scripts/generate-images.ts` — accepts a JSON prompt file and generates images via Gemini API. Run with `npx tsx scripts/generate-images.ts <prompt-file.json>`.

**Prompt files**: `scripts/prompts-*.json` — one per walkthrough. Each entry has `filename`, `prompt`, and `alt_text`. The script validates generated images for gibberish text and alt text accuracy.

**Image locations**:
- `images/walkthrough/` — narrative panels for walkthrough pages
- `images/concepts/` — educational diagrams for concept explanations and curriculum

Mintlify serves from `/images/...`.

**Pages with illustrated walkthrough treatment**:
- `docs/intro.mdx` — Alex's fragmentation story (5 panels)
- `docs/media-buy/index.mdx` — Sam's media buy journey (7 panels)
- `docs/governance/overview.mdx` — Jordan's governance setup (7 panels)
- `docs/creative/index.mdx` — Maya's creative campaign workflow (7 panels)
- `docs/signals/overview.mdx` — Sam + Kai's signals ecosystem (6 panels)
- `docs/governance/embedded-human-judgment.mdx` — EHJ manifesto (references governance concept diagrams)
- `docs/protocol/architecture.mdx` — Protocol architecture (2 concept diagrams)

### Documentation nav structure

Walkthrough pages use progressive disclosure — grouped by reader intent:
1. **Top level**: Overview + visual walkthrough (front door for everyone)
2. **Concepts**: Strategic/conceptual content with concept diagrams
3. **Implementation**: Integration guides for builders
4. **Reference**: Task reference and specification pages

Apply this pattern when restructuring protocol sections.

## PR Preparation Checklist

Before creating or updating a PR, always:

1. **Check CodeQL comments on the PR** — run `gh api repos/adcontextprotocol/adcp/pulls/{PR_NUMBER}/comments` and look for CodeQL findings. These are the most common CI blockers and must be resolved before merge.
2. **Fix unused imports/variables** — CodeQL flags these. Remove them, don't ignore them.
3. **Check for XSS patterns** — any `innerHTML`, `contenteditable`, or template string interpolation of user data gets flagged. Use `textContent` or escape functions.
4. **Avoid polynomial regexes on user input** — simple string checks (`.includes()`, `.startsWith()`) are safer and faster than regex for validation.
5. **Run `gh pr checks {PR_NUMBER}`** to verify all CI passes before requesting review.

## Triage Routine — Manual Nudge

The `Claude Issue Triage` routine fires automatically when an issue
opens or reopens, when a member comments `/triage` (slash-command), or
when a non-bot, non-self, non-`/triage`, non-PR-conversation comment
lands on an open issue. To poke the routine yourself:

| What you want | How |
|---|---|
| Re-trigger triage on a missed issue | Comment `/triage` |
| Authorize first draft PR when safe | Comment `/triage execute` |
| Force a clarifying-question comment | Comment `/triage clarify` |
| Force defer | Comment `/triage defer` |
| Add new info / refine a stuck Clarify | Plain comment with the new info — fires the routine in `comment.created` mode |

**What does NOT trigger triage:**

- Prose pings like "Pinging triage" or "@claude can you take this?"
  without the literal `/triage` slash command — the slash-command
  workflow only matches the `/triage` token. Plain comments DO fire
  the routine via the `issue_comment.created` path, but only if the
  comment is substantive (the routine itself filters "+1", emoji,
  "thanks!", and bare pings as non-substantive).
- Comments on **PR conversations** (review threads or general PR
  comments) — those route to the **auto-fix** feature, not triage.
  PR feedback handling is a different role.
- Comments by bots, the routine itself (anything containing the
  `Triaged by Claude Code` footer), or anyone with `[bot]` suffix —
  filtered at the workflow level to prevent loops.

**How to know if triage is on it:**

- Label `claude-triaging` on the issue → routine is actively working
  on it right now (1–3 minutes typical). Do not start a parallel PR.
- Label `claude-triaged` (without `claude-triaging`) → routine has
  finished. The triage comment, implementation brief, draft PR link,
  or silent-defer state is the outcome.
- Neither label, no `## Triage` comment, **and** the issue is more
  than a few minutes old → triage didn't fire. Webhook miss is the
  usual cause. Comment `/triage` to recover.

If `claude-triaging` is stuck on an issue for >30 minutes with no
visible progress, the routine errored mid-run. The
`Clear stuck claude-triaging labels` workflow runs every 30 minutes
and clears the label automatically; if you need it gone faster,
remove it manually and re-fire with `/triage`.

**Recovery against silent webhook misses.** GitHub occasionally
drops `issues.opened` webhook deliveries with no audit trail (this
is what bit #3112 — issue created, no triage workflow run, no
signal). The `Triage webhook-miss sweep` workflow runs hourly, finds
issues opened in the last 24h with no `claude-triag*` label and no
`## Triage` comment, and fires the routine manually as a recovery.
Tag-line in the payload is `RECOVERY SWEEP:` so the routine knows
this is a catch-up rather than a fresh fire.

**Local manual fire.** For "I need to fire triage right now without
leaving a public `/triage` comment trail" or "the sweep won't pick
this up for an hour" cases, use `.agents/scripts/triage-local.sh`:

```bash
.agents/scripts/triage-local.sh <issue-number> [execute|clarify|defer]
```

Requires `CLAUDE_ROUTINE_TRIAGE_URL` and `CLAUDE_ROUTINE_TRIAGE_TOKEN`
env vars (or a local `.env` file). The script writes nothing to
GitHub — it only POSTs to the routine's `/fire` endpoint with the
issue payload. The routine itself does all the comment/label work.

## Cross-Agent Integration

- **Role definitions** live in `.agents/roles/*.md` (markdown with frontmatter).
  This directory is the single source of truth for all subagent/role prompts.
  Each role exists in one of two forms:
  - `{name}.md` — **short triage checker.** Terse, structured, PR-bound. Used
    by the triage routine's expert consultation step. Most roles have one.
  - `{name}-deep.md` — **long design advisor.** Full domain reasoning for
    open-ended work (MCP tool design, threat models, curriculum architecture).
    Opt-in; not for triage. Nine roles have a `-deep` counterpart; the rest
    are checker-only or advisor-only by intent.
- **WG constitution and panel seats** live in `.agents/wg/` (`constitution.md`,
  `seats.md`) — the operating rules for every review/triage/secretary desk (the
  AAO Secretariat). Decision records live in `governance/decisions/`; desks cite
  them by `DR-NNNN` and treat contradicting a record as spec drift. See
  `specs/spec-guardian.md` for the architecture.
- **Prompt shortcuts** live in `.agents/shortcuts/`.
- **Generated outputs** (don't edit by hand) — `scripts/import-claude-agents.mjs`
  syncs `.agents/roles/` to:
  - `.claude/agents/*.md` — verbatim copies for Claude Code's agent loader.
  - `.codex/agents/*.toml` — TOML form for Codex, plus a generated
    `.codex/config.toml` that registers every role.
  Run the script after editing any file in `.agents/roles/`.
- `AGENTS.md` and `CLAUDE.md` are thin compatibility wrappers only.
- Add or change shared repo behavior here first, then update wrappers only if
  the agent needs a pointer to the new location.

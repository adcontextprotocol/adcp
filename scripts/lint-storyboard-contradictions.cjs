#!/usr/bin/env node
/**
 * Cross-storyboard contradiction lint (adcp#2634, rule 1).
 *
 * The three bugs fixed in PR #2631 (#2627, #2628, #2629) all shared a shape:
 * each storyboard was locally valid, but two storyboards encoded
 * contradictory required responses for the same (task, request, prior-state)
 * triple — something a conformant agent could not simultaneously satisfy.
 * Per-storyboard lints can't catch this class because contradiction is a
 * property of the *set* of storyboards, not any one of them.
 *
 * This lint groups every step-with-assertions across all storyboards by a
 * (task, request_fp, state_path_fp, env_fp) key and flags groups whose
 * outcomes disagree in a way no single agent could satisfy.
 *
 * Keying (what makes two steps "the same test vector"):
 *   task             the AdCP task name (template `$test_kit.*` refs are
 *                    skipped — unresolved at lint time)
 *   request_fp       canonical JSON of sample_request with runtime-variable
 *                    fields stripped or generalized (see fingerprintRequest)
 *   state_path_fp    ordered list of (task, request_fp) tuples for prior
 *                    mutating steps in the same phase + all earlier
 *                    non-optional phases. Discriminates "fresh" vs
 *                    "already-canceled" vs "pending-approval" state without
 *                    needing authors to declare prior_state explicitly.
 *   env_fp           comply_scenario + auth override + prerequisites —
 *                    these select different runner fixtures, so two steps
 *                    with same request but different env legitimately
 *                    produce different outcomes.
 *
 * Outcome model:
 *   success       — no expect_error, no error_code validation
 *   error(codes)  — expect_error: true; `codes` is the set from
 *                   `error_code: value:` or `error_code: allowed_values:`
 *                   (empty set = unspecified error code)
 *   unspecified   — we couldn't classify (e.g., only http_status_in checks)
 *
 * Contradiction rules (a group disagrees when…):
 *   1. Any member is `success` and any other is `error` (non-empty codes)
 *      — no agent can return a media_buy_id AND a NOT_CANCELLABLE error
 *      on the same request in the same state.
 *   2. Two `error(codes_a)` and `error(codes_b)` members with disjoint
 *      `codes_a ∩ codes_b = ∅` — the agent would have to return both
 *      INVALID_REQUEST and NOT_CANCELLABLE simultaneously.
 *   3. `unspecified` outcomes don't trigger flags — they're the "soft"
 *      class (step asserted shape but not outcome sign), and pairing them
 *      with anything else is the author's choice.
 *
 * Conservative by design: prefers under-flagging to over-flagging. A
 * false-positive noise floor kills adoption.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yaml = require('js-yaml');

const SOURCE_DIR = path.resolve(__dirname, '..', 'static', 'compliance', 'source');
const SCHEMAS_DIR = path.resolve(__dirname, '..', 'static', 'schemas', 'source');

/**
 * Tasks whose state mutations are invisible to the idempotency-key heuristic
 * below — they don't require `idempotency_key` in their request schema
 * (typically because they are naturally idempotent or session-scoped) but
 * still change observable agent state that a later step's outcome depends on.
 *
 * Each entry must be justified. Adding to this set without a schema-level
 * reason is a drift hazard; prefer declaring `idempotency_key` required on
 * the request schema instead.
 */
const MUTATING_EXCEPTIONS = new Set([
  // Schema description: "Naturally idempotent: the `scenario` enum is either
  // a lookup (`list_scenarios`) or a state-forcing operation whose target
  // state is carried in the payload (`force_*_status`, `simulate_*`), so
  // replays converge to the same observable state." The controller scenarios
  // do mutate controller state the next step observes, so the contradiction
  // lint must treat them as mutations.
  'comply_test_controller',
  // Schema description: "Naturally idempotent — `session_id` is the dedup
  // boundary, and terminating an already-terminated session is a no-op that
  // returns the same terminal state." The termination still transitions
  // active → terminated, and a later si_send_message on the same session_id
  // asserts against that terminal state; the contradiction lint must
  // discriminate pre- vs post-termination state paths.
  'si_terminate_session',
]);

/**
 * Read every `*-request.json` under `SCHEMAS_DIR` and return the set of
 * task names that require `idempotency_key`. Task name is derived from the
 * filename: `create-media-buy-request.json` → `create_media_buy`.
 *
 * Mirrors the pattern in `scripts/build-compliance.cjs:loadMutatingSchemaRefs`;
 * kept local rather than shared because the two lints have slightly
 * different output needs (tool-only here, refs+tools there).
 */
function loadMutatingTasksFromSchemas(schemasDir) {
  // Map<task, srcPath> so same-task-name across subdirs surfaces as an
  // explicit collision rather than silently deduping through Set.add.
  const origins = new Map();
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      // Real directories only. Skip symlinks to avoid unbounded recursion
      // if a schemas subtree symlinks back to itself.
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        walk(p);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('-request.json')) continue;
      let schema;
      try {
        schema = JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch {
        continue;
      }
      const required = Array.isArray(schema.required) ? schema.required : [];
      if (!required.includes('idempotency_key')) continue;
      const task = entry.name.replace(/-request\.json$/, '').replace(/-/g, '_');
      const prior = origins.get(task);
      if (prior && prior !== p) {
        throw new Error(
          `lint-storyboard-contradictions: task name "${task}" derives from two schema files: ` +
            `${path.relative(schemasDir, prior)} and ${path.relative(schemasDir, p)}. ` +
            'Rename one of the files (the hyphen-to-underscore conversion collides).',
        );
      }
      origins.set(task, p);
    }
  }
  walk(schemasDir);
  return new Set(origins.keys());
}

/**
 * AdCP task names that MUTATE server state. Derived at module load by
 * reading request schemas' `required: [idempotency_key]` declarations
 * (source of truth for "this task is a mutation"), plus documented
 * exceptions for naturally-idempotent tasks that still change state.
 *
 * Prior-state discrimination in the contradiction lint depends on this
 * set — a step whose prior phase contains only read tasks is at the same
 * "state" as a step with no prior phases.
 */
const MUTATING_TASKS = new Set([
  ...loadMutatingTasksFromSchemas(SCHEMAS_DIR),
  ...MUTATING_EXCEPTIONS,
]);

/**
 * Step tasks that we skip entirely — they're synthetic assertions or
 * template refs that don't represent a real protocol call.
 */
const SKIP_TASKS = new Set([
  'assert_contribution',
  'expect_webhook',
  'protected_resource_metadata',
  'oauth_auth_server_metadata',
]);

function walkYaml(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkYaml(full));
    else if (entry.isFile() && (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml'))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Replace values that vary per-run with stable type markers so two steps
 * with the same semantic request hash to the same fingerprint.
 *
 * Stripped fields (by name at any depth):
 *   - idempotency_key         per-run UUID
 *   - context.correlation_id  per-storyboard debug string
 *
 * Normalized value patterns (by shape):
 *   - "$generate:..."          → "<generated>"
 *   - "$context.<name>"        → "<context:<name>>"
 *   - "{{prior_step....}}"     → "<prior_step>"
 *   - "{{runner....}}"         → "<runner>"
 *
 * `$context.<name>` keeps the name so two steps consuming different
 * captured values don't collide — e.g. `$context.media_buy_id` vs
 * `$context.plan_id` remain distinct even after normalization.
 */
function normalizeRequestValue(value) {
  if (typeof value === 'string') {
    if (value.startsWith('$generate:')) return '<generated>';
    if (value.startsWith('$context.')) return `<context:${value.slice('$context.'.length)}>`;
    if (value.startsWith('{{prior_step.')) return '<prior_step>';
    if (value.startsWith('{{runner.')) return '<runner>';
    return value;
  }
  // YAML 1.1 auto-parses unquoted ISO timestamps into Date objects.
  // Without this branch, `stableStringify` would emit `{}` for them and two
  // steps with different timestamps would fingerprint to the same group.
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeRequestValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'idempotency_key') continue;
      out[k] = normalizeRequestValue(v);
    }
    return out;
  }
  return value;
}

/**
 * Deterministic stringify with sorted keys at every depth. Do not use
 * `JSON.stringify(value, arrayOfKeys)` — that filters by the array at every
 * level and silently drops nested fields not in the top-level key list.
 */
function stableStringify(value) {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return (
    '{' +
    keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',') +
    '}'
  );
}

function canonicalizeRequest(req) {
  if (req === undefined || req === null) return '<empty>';
  const normalized = normalizeRequestValue(req);
  // `context.correlation_id` is stripped one level in: it's a request-level
  // echo field, never semantically distinguishing.
  if (normalized && typeof normalized === 'object' && normalized.context && typeof normalized.context === 'object') {
    const { correlation_id: _drop, ...rest } = normalized.context;
    normalized.context = rest;
    if (Object.keys(normalized.context).length === 0) delete normalized.context;
  }
  return stableStringify(normalized);
}

function fingerprintRequest(req) {
  const canonical = canonicalizeRequest(req);
  return crypto.createHash('sha1').update(canonical).digest('hex').slice(0, 12);
}

/**
 * Env fingerprint: the external knobs that select which fixture a conformant
 * agent serves. Two steps with same request but different env can
 * legitimately disagree on outcome (e.g., api-key vs oauth_bearer auth
 * returning different error shapes, or two storyboards seeding different
 * governance states).
 *
 * Components:
 *   sb         — storyboard's top-level `id:`. Ensures distinct storyboard
 *                files aren't treated as running against the same in-memory
 *                agent. Conservative: means cross-storyboard contradictions
 *                are unreachable today. See #2670 for the planned removal.
 *   test_kit   — `doc.prerequisites.test_kit`. Two storyboards sharing id +
 *                scenario but loading different test kits target different
 *                agent fixtures.
 *   fixtures   — hash of `doc.fixtures` (top-level). Storyboards that seed
 *                different prerequisite state via `comply_test_controller`
 *                legitimately produce different outcomes for the same
 *                request.
 *   scenario   — step's `comply_scenario`.
 *   auth       — step's auth override shape (type + strategy).
 *   seed       — phase's `prerequisites.controller_seeding` (distinct from
 *                top-level fixtures; applies phase-scoped seeding).
 */
function fingerprintEnv(step, phase, doc) {
  const parts = [];
  if (typeof doc?.id === 'string') parts.push(`sb=${doc.id}`);
  if (typeof doc?.prerequisites?.test_kit === 'string') {
    parts.push(`test_kit=${doc.prerequisites.test_kit}`);
  }
  if (doc?.fixtures && typeof doc.fixtures === 'object' && Object.keys(doc.fixtures).length > 0) {
    const fixturesHash = crypto
      .createHash('sha1')
      .update(stableStringify(doc.fixtures))
      .digest('hex')
      .slice(0, 8);
    parts.push(`fixtures=${fixturesHash}`);
  }
  if (typeof step.comply_scenario === 'string') parts.push(`scenario=${step.comply_scenario}`);
  if (step.auth) {
    const auth = step.auth;
    if (auth === 'none') parts.push('auth=none');
    else if (typeof auth === 'object') {
      const type = auth.type || '?';
      const strat = auth.value_strategy || (auth.from_test_kit ? 'from_test_kit' : auth.value ? 'literal' : '?');
      parts.push(`auth=${type}:${strat}`);
    }
  }
  const seeding = phase?.prerequisites?.controller_seeding;
  if (Array.isArray(seeding) && seeding.length > 0) {
    parts.push(`seed=${seeding.map((s) => s?.scenario || s).sort().join(',')}`);
  }
  return parts.join('|') || '<default>';
}

/**
 * Classify a step's expected outcome from its assertions.
 */
function classifyOutcome(step) {
  const validations = Array.isArray(step.validations) ? step.validations : [];
  const errorCodeChecks = validations.filter((v) => v?.check === 'error_code');
  const expectError = step.expect_error === true;

  if (expectError || errorCodeChecks.length > 0) {
    const codes = new Set();
    for (const v of errorCodeChecks) {
      if (typeof v.value === 'string') codes.add(v.value);
      if (Array.isArray(v.allowed_values)) {
        for (const c of v.allowed_values) if (typeof c === 'string') codes.add(c);
      }
    }
    return { kind: 'error', codes };
  }

  // Looks like a success assertion path (field_present, response_schema,
  // field_value on happy-path fields). Distinguish from "unspecified" —
  // we need at least one positive assertion to call it success.
  const hasPositiveAssertion = validations.some((v) => {
    if (!v || typeof v !== 'object') return false;
    const check = v.check;
    return (
      check === 'response_schema' ||
      check === 'field_present' ||
      check === 'field_value' ||
      check === 'http_status' ||
      check === 'http_status_in'
    );
  });
  if (hasPositiveAssertion) return { kind: 'success', codes: new Set() };

  return { kind: 'unspecified', codes: new Set() };
}

/**
 * Build a per-storyboard list of "events" — step records tagged with the
 * state path up to that step. Optional phases accumulate into per-optional-
 * branch sub-paths; for contradiction detection we flatten to the non-
 * optional prefix since only the baseline state is guaranteed across
 * branches.
 */
function extractEvents(doc, file) {
  const events = [];
  const phases = Array.isArray(doc?.phases) ? doc.phases : [];

  // State path = ordered list of (task, request_fp) for prior mutating
  // steps in non-optional phases only. Optional-phase mutations can't be
  // assumed to have run.
  const baselinePath = [];

  for (const phase of phases) {
    const phaseId = phase?.id || '<unnamed>';
    const steps = Array.isArray(phase?.steps) ? phase.steps : [];
    const branchSetId =
      phase?.branch_set && typeof phase.branch_set === 'object' && typeof phase.branch_set.id === 'string'
        ? phase.branch_set.id
        : null;

    // Within a single phase, earlier steps' mutations DO establish state
    // for later steps in the same phase — even if the phase is optional.
    // The inner path threads the baseline + in-phase prior mutations.
    const innerPath = [...baselinePath];

    for (const step of steps) {
      const task = typeof step?.task === 'string' ? step.task : null;
      if (!task || task.startsWith('$') || SKIP_TASKS.has(task)) continue;

      const requestFp = fingerprintRequest(step.sample_request);
      const envFp = fingerprintEnv(step, phase, doc);
      const statePathFp = crypto
        .createHash('sha1')
        .update(innerPath.map(([t, f]) => `${t}:${f}`).join('|'))
        .digest('hex')
        .slice(0, 12);

      const outcome = classifyOutcome(step);

      events.push({
        file,
        phaseId,
        stepId: step.id || '<unnamed>',
        task,
        requestFp,
        statePathFp,
        envFp,
        outcome,
        phaseOptional: phase?.optional === true,
        branchSetId,
      });

      if (MUTATING_TASKS.has(task) && outcome.kind !== 'error') {
        innerPath.push([task, requestFp]);
      }
    }

    // Mutations from non-optional phases become part of the baseline for
    // downstream phases. Optional-phase mutations don't — we can't be
    // sure the runner took that branch.
    if (phase?.optional !== true) {
      for (const step of steps) {
        const task = typeof step?.task === 'string' ? step.task : null;
        if (!task || task.startsWith('$') || SKIP_TASKS.has(task)) continue;
        if (!MUTATING_TASKS.has(task)) continue;
        const outcome = classifyOutcome(step);
        if (outcome.kind === 'error') continue;
        baselinePath.push([task, fingerprintRequest(step.sample_request)]);
      }
    }
  }

  return events;
}

function outcomesAgree(a, b) {
  if (a.kind === 'unspecified' || b.kind === 'unspecified') return true;
  if (a.kind === 'success' && b.kind === 'success') return true;
  if (a.kind === 'error' && b.kind === 'error') {
    // Empty codes = unspecified error; pairs with any other error.
    if (a.codes.size === 0 || b.codes.size === 0) return true;
    for (const c of a.codes) if (b.codes.has(c)) return true;
    return false;
  }
  return false;
}

function describeOutcome(outcome) {
  if (outcome.kind === 'success') return 'success';
  if (outcome.kind === 'unspecified') return 'unspecified';
  if (outcome.codes.size === 0) return 'error (code unspecified)';
  return `error (${[...outcome.codes].sort().join('|')})`;
}

function findContradictions(events) {
  const groups = new Map();
  for (const ev of events) {
    const key = `${ev.task}\x00${ev.requestFp}\x00${ev.statePathFp}\x00${ev.envFp}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ev);
  }

  const contradictions = [];
  for (const [key, members] of groups) {
    if (members.length < 2) continue;

    // Check every pair; record the first disagreement per group so a
    // single mismatch surfaces one violation, not O(n²). Branch-set peers
    // in the same storyboard are intentionally-different outcomes (any_of
    // semantics); skip pairs that share a branch_set.id.
    let mismatch = null;
    for (let i = 0; i < members.length && !mismatch; i++) {
      for (let j = i + 1; j < members.length && !mismatch; j++) {
        const a = members[i];
        const b = members[j];
        const branchSetPeers =
          a.file === b.file && a.branchSetId && b.branchSetId && a.branchSetId === b.branchSetId;
        if (branchSetPeers) continue;
        if (!outcomesAgree(a.outcome, b.outcome)) {
          mismatch = [a, b];
        }
      }
    }
    if (mismatch) {
      contradictions.push({ key, members, mismatch });
    }
  }
  return contradictions;
}

function lint() {
  const files = walkYaml(SOURCE_DIR);
  const allEvents = [];
  for (const file of files) {
    let doc;
    try {
      doc = yaml.load(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const relFile = path.relative(SOURCE_DIR, file);
    for (const ev of extractEvents(doc, relFile)) {
      allEvents.push(ev);
    }
  }
  return findContradictions(allEvents);
}

function main() {
  const contradictions = lint();
  if (contradictions.length === 0) {
    console.log('✓ storyboard contradiction lint: no cross-storyboard contradictions');
    return;
  }

  console.error(`✗ storyboard contradiction lint: ${contradictions.length} contradiction(s)\n`);
  for (const c of contradictions) {
    const [a, b] = c.mismatch;
    console.error(`  task=${a.task} request_fp=${a.requestFp} state=${a.statePathFp} env=${a.envFp}`);
    console.error(`    ${a.file}:${a.phaseId}/${a.stepId}  →  ${describeOutcome(a.outcome)}`);
    console.error(`    ${b.file}:${b.phaseId}/${b.stepId}  →  ${describeOutcome(b.outcome)}`);
    if (c.members.length > 2) {
      console.error(`    (${c.members.length - 2} other member(s) agree with one side)`);
    }
    console.error('');
  }
  console.error(
    'Two storyboards assert contradictory outcomes for the same (task, request,\n' +
      'prior-state, env) — a conformant agent cannot satisfy both. Either reconcile\n' +
      'the assertions, discriminate the requests so they are legitimately different\n' +
      'test vectors, or route them through different comply_scenario values.',
  );
  process.exit(1);
}

if (require.main === module) main();

module.exports = {
  MUTATING_TASKS,
  MUTATING_EXCEPTIONS,
  SKIP_TASKS,
  loadMutatingTasksFromSchemas,
  normalizeRequestValue,
  canonicalizeRequest,
  fingerprintRequest,
  fingerprintEnv,
  classifyOutcome,
  outcomesAgree,
  describeOutcome,
  extractEvents,
  findContradictions,
  lint,
};

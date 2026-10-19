#!/usr/bin/env node
/**
 * Reject storyboards that leave a `$context.<key>` placeholder unresolved at
 * the moment the runner builds the request, and storyboards that let a
 * response decide a key the hosted grader pins.
 *
 * Why this lint exists
 * --------------------
 * The `@adcp/sdk` storyboard runner seeds its context from the storyboard's
 * root `context:` block (plus any caller override) and then grows it as steps
 * capture values. `injectContext()` substitutes a whole-string
 * `$context.<key>` only when the key is present.
 *
 * When it isn't, the runner usually catches it mid-run:
 * `unresolvedStepContextVars` (@adcp/sdk/dist/lib/testing/storyboard/runner.js)
 * refuses to send the request and returns the step `skipped` with
 * `skip_reason: prerequisite_failed` and a failed `unresolved_substitution`
 * validation. So an undeclared key is a storyboard that can never pass — but
 * it reports as a skip at grading time, not as an authoring error, and skips
 * are exactly what capability gating produces legitimately.
 *
 * That is how #7797 shipped: the 3.0.x governance scenarios registered the
 * governance agent with `url: "$context.governance_agent_url"` and never
 * declared the key, so `sync_governance` and the governance flow behind it
 * could only ever skip. On the 3.0-compat tenants that step already skips on
 * `missing_tool` (server/src/training-agent/tenants/tool-catalog.ts), which
 * hides the difference completely, and the defect rode every released 3.0
 * bundle up to 3.0.26 until #7801 added the default.
 *
 * This lint moves the detection to authoring time and covers the bundles CI
 * never grades. It is deliberately stricter than the runtime guard in three
 * places:
 *   - `runner.js` skips the guard for `expect_error` steps, so those do put
 *     the literal token on the wire. Sending `"$context.foo"` is never the
 *     error a storyboard means to provoke, so this lint reports it anyway.
 *   - `resolveDiscoveryAccount`
 *     (@adcp/sdk/dist/lib/testing/storyboard/request-builder.js) drops a
 *     `sample_request.account` holding an unresolved reference on the
 *     account-free discovery tasks, so the guard never sees it.
 *   - an inherited-member token (see the prototype note below) resolves at
 *     runtime to a Function the JSON encoder then drops, leaving no literal
 *     for the guard to find.
 *
 * Fix
 * ---
 * Declare the key in the storyboard's root `context:` block when it is test
 * topology (an agent URL, a seeded id), or capture it with a
 * `context_outputs` entry on a step that runs before the first read.
 *
 * Scope
 * -----
 * Every `sample_request` of every storyboard that declares `phases[]`,
 * including buyer-track ones. Their `sample_request` is nominally the
 * reference shape the buyer agent's own call is graded against
 * (static/compliance/source/universal/buyer-fixture-publisher.yaml), but the
 * installed SDK has no `interaction_model` awareness and
 * `resolveStoryboardsForCapabilities` will hand them to the ordinary runner,
 * so an unwritable token is just as broken there.
 *
 * Resolution is simulated in step order: a key counts as resolvable when the
 * root `context:` block declares it, when an *earlier* step captures it via
 * `context_outputs`, or when an *earlier* step ran a task whose convention
 * extractor writes it (CONVENTION_CONTEXT_PRODUCERS below).
 *
 * Only strings the runner actually substitutes count: the whole string must
 * be a `$context.<key>` token, matching the runner's own anchored match.
 * Prose that mentions a token (narratives, comments) is ignored.
 *
 * `validations[].value` / `allowed_values` are out of scope. The runner
 * substitutes those too, but against the context as it stood *before* the
 * step, and unlike requests it does not guard them — so they need their own
 * rule, not this one.
 *
 * Writers this lint deliberately does not model
 * ---------------------------------------------
 * - `options.context`, the caller-supplied seed (the hosted grader's pinned
 *   `governance_agent_url`, the CLI's `--governance-agent-url`). Relying on it
 *   is exactly the #7797 defect: the storyboard has to stand on its own,
 *   because a run that does not pass the override silently skips the step. A
 *   caller override replaces the declared default; it is not a substitute for
 *   declaring one.
 * - `creative_build_probe` fixture resolution, which writes
 *   `<context_prefix>_<key>` keys (runner.js `Object.assign(context,
 *   resolution.context)`). No storyboard reads those through `$context.`
 *   today. If one starts to, model that writer here — do not add the key to
 *   CONVENTION_CONTEXT_PRODUCERS, which describes response extractors.
 * - the *erasers*. `extractContextWithProvenance` returns `clearGroups`, and
 *   the runner deletes the product and proposal key groups after
 *   `list_products`, `request_proposals`, `refine_proposals` and
 *   `decline_proposals`. Root-`context:` keys carry no provenance entry, so
 *   they are cleared too. This lint's model is monotonic: once a key is
 *   written it stays written. Nothing in the tree depends on a key that
 *   survives a clear today, so modelling the clears would only add a way to
 *   be wrong; revisit if a storyboard starts reading a product/proposal key
 *   across one of those tasks.
 *
 * The simulated context is prototype-less on purpose. The runner resolves with
 * `key in context`, which walks the prototype chain, so `$context.constructor`
 * (and `toString`, `valueOf`, `__proto__`, …) "resolves" to an inherited
 * member and the field silently disappears from the JSON request — the same
 * silent-wrong-request failure as #7797, and invisible to the runtime guard
 * because the literal is gone. Here those keys stay unresolved and are
 * reported.
 *
 * Rules:
 *   context_placeholder_unresolved — a request reads a context key that
 *                                    nothing seeds or captures before it.
 *   pinned_context_key_captured    — a `context_outputs` entry writes a key
 *                                    the hosted grader pins from server
 *                                    config, letting the agent under test
 *                                    redirect it.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { injectContext } = require('@adcp/sdk/testing');

const REPO_ROOT = path.resolve(__dirname, '..');
const STORYBOARD_DIR = path.join(REPO_ROOT, 'static', 'compliance', 'source');

// Mirrors the runner's anchored match in
// @adcp/sdk/dist/lib/testing/storyboard/context.js.
const CONTEXT_TOKEN_RE = /^\$context\.(\w+)$/;

/**
 * Context keys the runner's convention extractors (`CONTEXT_EXTRACTORS` in
 * @adcp/sdk/dist/lib/testing/storyboard/context.js) write from a response
 * without the storyboard declaring anything, mapped to the tasks whose
 * extractor writes them. Scoped per task on purpose: an unconditional waiver
 * would make `$context.media_buy_id` resolvable in a storyboard that never
 * creates one.
 *
 * Only the keys storyboards actually rely on today, not a mirror of every
 * extractor. Each pair is checked against the installed SDK by
 * tests/lint-storyboard-context-resolution.test.cjs, so an entry cannot
 * outlive the extractor that justifies it.
 */
const CONVENTION_CONTEXT_PRODUCERS = {
  media_buy_id: [
    'accept_proposal',
    'buy_products',
    'control_media_buy',
    'create_media_buy',
    'get_media_buys',
    'update_media_buy',
  ],
  proposal_id: [
    'accept_proposal',
    'buy_products',
    'control_media_buy',
    'get_products',
    'refine_proposals',
    'request_proposals',
  ],
  proposal_terms_digest: [
    'accept_proposal',
    'buy_products',
    'control_media_buy',
    'refine_proposals',
    'request_proposals',
  ],
  content_standards_id: ['create_content_standards'],
};

/** task -> context keys its convention extractor writes. */
const CONVENTION_KEYS_BY_TASK = (() => {
  const byTask = new Map();
  for (const [key, tasks] of Object.entries(CONVENTION_CONTEXT_PRODUCERS)) {
    for (const task of tasks) {
      if (!byTask.has(task)) byTask.set(task, []);
      byTask.get(task).push(key);
    }
  }
  return byTask;
})();

/**
 * Context keys hosted grading seeds from server config before the run starts
 * (`context.governance_agent_url` and HOSTED_GOVERNED_AGENT_CONTEXT_KEYS in
 * server/src/compliance/hosted-multi-agent-routing.ts). `governance_agent_url`
 * is seeded unconditionally; the four `*_agent_url` keys are seeded only when
 * the storyboard's root `context:` already declares them, so a storyboard that
 * captured one instead would get no seed at all.
 *
 * Either way the seed is a seed, not a per-step guard: the runner overwrites
 * context on every capture, and the router's static check only compares the
 * authored `sync_governance` URL against the literal
 * `"$context.governance_agent_url"`. A `context_outputs` entry on one of these
 * keys would therefore let the agent under test choose the governance agent it
 * is told to trust — and the per-run seller credential is stapled on
 * regardless. These keys are root-`context:`-only.
 */
const RUNNER_PINNED_CONTEXT_KEYS = new Set([
  'governance_agent_url',
  'seller_agent_url',
  'signal_agent_url',
  'brand_agent_url',
  'creative_agent_url',
]);

// `Dirent` predicates are lstat-based, like the sibling storyboard lints, so a
// symlink is neither descended nor read. That bounds the walk to the tree it
// was handed; it also means a symlinked storyboard would go un-linted, which
// is acceptable because nothing under either scanned root is a symlink and a
// storyboard has to be a real file to ship in a bundle.
function walkYaml(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkYaml(full));
    else if (entry.isFile() && /\.ya?ml$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Collect every residual `$context.<key>` token under `value`. */
function collectContextTokens(value, location, onToken) {
  if (typeof value === 'string') {
    const match = value.match(CONTEXT_TOKEN_RE);
    if (match) onToken(match[1], location);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => collectContextTokens(item, `${location}[${i}]`, onToken));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      collectContextTokens(child, location ? `${location}.${key}` : key, onToken);
    }
  }
}

/**
 * Keys a step captures into context. Mirrors the loader's `name` -> `key`
 * normalization (@adcp/sdk/dist/lib/testing/storyboard/loader.js), so this
 * lint reads raw YAML without depending on a successful full load — released
 * bundles predate loader rules the current loader hard-throws on.
 */
function capturedKeys(step) {
  const outputs = Array.isArray(step && step.context_outputs) ? step.context_outputs : [];
  return outputs
    .map((output) => (output && typeof output === 'object' ? output.key || output.name : undefined))
    .filter((key) => typeof key === 'string' && key.length > 0);
}

/**
 * Lint one parsed storyboard.
 *
 * @param {object} doc parsed YAML
 * @param {string} filePath for reporting
 */
function lintDoc(doc, filePath) {
  const violations = [];
  if (!doc || !Array.isArray(doc.phases)) return violations;

  const storyboardId = typeof doc.id === 'string' ? doc.id : null;
  const rootContext = doc.context && typeof doc.context === 'object' && !Array.isArray(doc.context)
    ? doc.context
    : {};
  // Prototype-less: see the header. Values are irrelevant — `injectContext`
  // only checks key presence — but running the real substitution keeps this
  // lint honest about *which* strings the runner rewrites.
  const context = Object.assign(Object.create(null), rootContext);

  doc.phases.forEach((phase, phaseIndex) => {
    if (!phase || typeof phase !== 'object') return;
    const phaseLabel = typeof phase.id === 'string' ? phase.id : `phases[${phaseIndex}]`;
    const steps = Array.isArray(phase.steps) ? phase.steps : [];
    steps.forEach((step, stepIndex) => {
      if (!step || typeof step !== 'object') return;
      const stepLabel = typeof step.id === 'string' ? step.id : `steps[${stepIndex}]`;
      const task = typeof step.task === 'string' ? step.task : null;
      const base = { filePath, storyboardId, phaseId: phaseLabel, stepId: stepLabel, task };

      const request = step.sample_request;
      if (request && typeof request === 'object') {
        const injected = injectContext({ ...request }, context);
        collectContextTokens(injected, '', (key, location) => {
          violations.push({
            ...base,
            rule: 'context_placeholder_unresolved',
            key,
            location: location ? `sample_request.${location}` : 'sample_request',
          });
        });
      }

      // Captures land after the step's own request is built.
      for (const key of capturedKeys(step)) {
        // A rejected capture is not a writer, so a later read of the same key
        // reports too. Two violations, one fix: declare it in root `context:`.
        if (RUNNER_PINNED_CONTEXT_KEYS.has(key)) {
          violations.push({ ...base, rule: 'pinned_context_key_captured', key, location: 'context_outputs' });
          continue;
        }
        context[key] = `<captured:${key}>`;
      }
      for (const key of CONVENTION_KEYS_BY_TASK.get(task) ?? []) {
        context[key] = `<convention:${key}>`;
      }
    });
  });
  return violations;
}

/**
 * Lint every storyboard under `dir`.
 *
 * @param {string} [dir]
 * @returns {{ violations: object[], unparsed: string[] }} `unparsed` lists
 *   files js-yaml could not read. Callers must treat a non-empty `unparsed`
 *   as a failure for trees no sibling lint parses (for example a released
 *   `dist/compliance/<version>` bundle); otherwise a malformed storyboard is
 *   silently exempt from this lint.
 */
function lintTree(dir = STORYBOARD_DIR) {
  const violations = [];
  const unparsed = [];
  for (const file of walkYaml(dir)) {
    let doc;
    try {
      doc = yaml.load(fs.readFileSync(file, 'utf8'));
    } catch {
      unparsed.push(file);
      continue;
    }
    violations.push(...lintDoc(doc, file));
  }
  return { violations, unparsed };
}

function formatViolation(v) {
  const rel = path.isAbsolute(v.filePath) ? path.relative(REPO_ROOT, v.filePath) : v.filePath;
  const id = v.storyboardId ? ` (${v.storyboardId})` : '';
  const task = v.task ? ` [${v.task}]` : '';
  const where = `  ${rel}${id}: step \`${v.stepId}\`${task} in phase \`${v.phaseId}\``;
  if (v.rule === 'pinned_context_key_captured') {
    return (
      `${where} captures \`${v.key}\`\n` +
      '    into context. Hosted grading pins that key from server config before the run\n' +
      '    (server/src/compliance/hosted-multi-agent-routing.ts) and the pin is seed-only, so a\n' +
      '    capture lets the agent under test redirect the agent it is told to trust.\n' +
      `    Declare \`${v.key}\` in the storyboard's root \`context:\` block instead.`
    );
  }
  return (
    `${where} reads\n` +
    `    "$context.${v.key}" at ${v.location}, but nothing seeds or captures\n` +
    `    \`${v.key}\` before this step. The runner cannot substitute it, so the step can only\n` +
    '    skip with `prerequisite_failed` and a failed `unresolved_substitution` validation.\n' +
    `    Declare \`${v.key}\` in the storyboard's root \`context:\` block, or capture it with a\n` +
    '    `context_outputs` entry on an earlier step.'
  );
}

function main() {
  const { violations, unparsed } = lintTree();
  if (unparsed.length > 0) {
    console.error(
      `lint-storyboard-context-resolution: ${unparsed.length} storyboard(s) failed to parse:\n` +
        unparsed.map((file) => `  ${path.relative(REPO_ROOT, file)}`).join('\n'),
    );
    process.exit(1);
  }
  if (violations.length === 0) {
    console.log('lint-storyboard-context-resolution: every $context placeholder resolves.');
    return;
  }
  console.error(
    `lint-storyboard-context-resolution: ${violations.length} unresolved $context placeholder(s):\n` +
      violations.map(formatViolation).join('\n\n'),
  );
  process.exit(1);
}

if (require.main === module) main();

module.exports = {
  CONTEXT_TOKEN_RE,
  CONVENTION_CONTEXT_PRODUCERS,
  RUNNER_PINNED_CONTEXT_KEYS,
  STORYBOARD_DIR,
  capturedKeys,
  collectContextTokens,
  formatViolation,
  lintDoc,
  lintTree,
};

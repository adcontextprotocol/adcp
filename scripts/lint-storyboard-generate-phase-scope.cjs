#!/usr/bin/env node
/**
 * Reject storyboards that reuse a `$generate:<kind>#<alias>` alias in more
 * than one phase.
 *
 * Why this lint exists
 * --------------------
 * The `@adcp/sdk` storyboard runner scopes `$generate` aliases to a single
 * phase (adcp-client#1658). The alias cache is keyed on the context object,
 * and the runner shallow-copies the context at the start of every phase
 * without carrying that cache over. Within a phase, every
 * `$generate:uuid_v4#foo` resolves to the same value. In a later phase, the
 * same token mints a new UUID.
 *
 * A storyboard that creates a resource with `$generate:uuid_v4#foo` in one
 * phase and addresses it (or asserts on it) with the same token in a later
 * phase is silently comparing against a different ID. The later phase reads
 * a resource that does not exist, or its `field_value` check compares
 * against the wrong ID.
 *
 * Fix
 * ---
 * Generate the value once with a `context_outputs` generator on a step that
 * runs before the value's first use, then read it as `$context.<name>`
 * everywhere else:
 *
 *   context_outputs:
 *     - name: my_resource_id
 *       generate: uuid_v4
 *
 * Context values persist across phases, whereas aliases do not. A
 * `context_outputs` generator whose key matches an alias used in the same
 * step's request resolves to that alias's value (the runner shares the alias
 * cache with generators), so a generator can also sit on the step that first
 * uses the alias.
 *
 * If a later phase really needs a fresh ID, give it a distinct alias name.
 *
 * Scope
 * -----
 * Every storyboard under static/compliance/source that declares `phases[]`.
 * Only strings the runner actually substitutes count: the whole string must
 * be a `$generate` token, matching the runner's own full-string match. Prose
 * that mentions a token (narratives, comments) is ignored.
 *
 * Rule:
 *   generate_alias_crosses_phases — one alias appears in two or more phases
 *                                   of the same storyboard.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const REPO_ROOT = path.resolve(__dirname, '..');
const STORYBOARD_DIR = path.join(REPO_ROOT, 'static', 'compliance', 'source');

// Mirrors the runner's full-string match in
// @adcp/sdk/dist/lib/testing/storyboard/context.js, widened to any kind so an
// unsupported kind still trips the lint rather than slipping past it.
const GENERATE_ALIAS_RE = /^\$generate:([A-Za-z0-9_]+)#([A-Za-z0-9_.-]+)$/;

function walkYaml(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkYaml(full));
    else if (entry.isFile() && /\.ya?ml$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Collect every `$generate:<kind>#<alias>` token under `value`, calling
 * `onToken(alias, kind, locationPath)` for each.
 */
function visitGenerateTokens(value, location, onToken) {
  if (typeof value === 'string') {
    const match = value.match(GENERATE_ALIAS_RE);
    if (match) onToken(match[2], match[1], location);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => visitGenerateTokens(item, `${location}[${i}]`, onToken));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      visitGenerateTokens(child, location ? `${location}.${key}` : key, onToken);
    }
  }
}

/**
 * Map each alias to the phases that use it.
 * Returns Map<alias, Map<phaseLabel, string[] locations>>.
 */
function collectAliasPhases(doc) {
  const aliases = new Map();
  if (!doc || !Array.isArray(doc.phases)) return aliases;
  doc.phases.forEach((phase, phaseIndex) => {
    if (!phase || typeof phase !== 'object') return;
    const phaseLabel = typeof phase.id === 'string' ? phase.id : `phases[${phaseIndex}]`;
    const steps = Array.isArray(phase.steps) ? phase.steps : [];
    steps.forEach((step, stepIndex) => {
      const stepLabel = step && typeof step.id === 'string' ? step.id : `steps[${stepIndex}]`;
      visitGenerateTokens(step, '', (alias, _kind, location) => {
        if (!aliases.has(alias)) aliases.set(alias, new Map());
        const phases = aliases.get(alias);
        if (!phases.has(phaseLabel)) phases.set(phaseLabel, []);
        phases.get(phaseLabel).push(location ? `${stepLabel}.${location}` : stepLabel);
      });
    });
  });
  return aliases;
}

function lintDoc(doc, filePath) {
  const violations = [];
  for (const [alias, phases] of collectAliasPhases(doc)) {
    if (phases.size < 2) continue;
    violations.push({
      rule: 'generate_alias_crosses_phases',
      filePath,
      storyboardId: doc && typeof doc.id === 'string' ? doc.id : null,
      alias,
      phases: [...phases].map(([phaseId, locations]) => ({ phaseId, locations })),
    });
  }
  return violations;
}

function lint(dir = STORYBOARD_DIR) {
  const violations = [];
  for (const file of walkYaml(dir)) {
    let doc;
    try {
      doc = yaml.load(fs.readFileSync(file, 'utf8'));
    } catch {
      // YAML parse errors are reported by sibling lints.
      continue;
    }
    violations.push(...lintDoc(doc, file));
  }
  return violations;
}

function formatViolation(v) {
  const rel = path.relative(REPO_ROOT, v.filePath);
  const id = v.storyboardId ? ` (${v.storyboardId})` : '';
  const where = v.phases
    .map(({ phaseId, locations }) => `      phase ${phaseId}: ${locations.join(', ')}`)
    .join('\n');
  return (
    `  ${rel}${id}: \`$generate\` alias \`#${v.alias}\` is used in ${v.phases.length} phases.\n` +
    `${where}\n` +
    '    The runner scopes $generate aliases to one phase, so each phase mints a different\n' +
    '    value. Generate it once with a context_outputs generator\n' +
    `    (\`- name: ${v.alias}\` / \`generate: uuid_v4\`) on a step that runs before its first\n` +
    '    use, and read it as `$context.<name>` everywhere else.'
  );
}

function main() {
  const violations = lint();
  if (violations.length === 0) {
    console.log('lint-storyboard-generate-phase-scope: no $generate alias crosses a phase boundary.');
    return;
  }
  console.error(
    `lint-storyboard-generate-phase-scope: ${violations.length} cross-phase $generate alias(es):\n` +
      violations.map(formatViolation).join('\n\n'),
  );
  process.exit(1);
}

if (require.main === module) main();

module.exports = {
  GENERATE_ALIAS_RE,
  collectAliasPhases,
  lintDoc,
  lint,
  formatViolation,
};

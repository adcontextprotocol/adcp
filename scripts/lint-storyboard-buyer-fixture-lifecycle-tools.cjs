#!/usr/bin/env node
/**
 * Reject buyer storyboards whose fixture publisher advertises a compact
 * lifecycle tool the fixture-publisher contract does not serve.
 *
 * Why this lint exists
 * --------------------
 * A buyer storyboard (`interaction_model: media_buy_buyer`) declares the
 * capabilities its fixture publisher advertises under
 * `fixtures.fixture_publisher.capabilities`. The publisher serves that block
 * verbatim from `get_adcp_capabilities`, and a buyer agent that gates
 * correctly on `media_buy.lifecycle_tools` calls every compact tool it sees
 * advertised. The tools the publisher can actually answer are the ones with
 * a handler in `universal/buyer-fixture-publisher.yaml > tool_handlers`.
 *
 * When the two drift, the storyboard sends a conformant buyer to a tool the
 * publisher cannot answer: five buyer storyboards advertised `buy_products`
 * and `control_media_buy` while grading the `create_media_buy` facade, so a
 * buyer that followed the advertisement failed the step and a buyer that
 * ignored it passed (adcontextprotocol/adcp#7749).
 *
 * The contract states the rule once, in
 * `authoring_rules.lifecycle_tools_constraint.permitted_values`; this lint
 * holds every storyboard fixture to it, and holds the list itself to the
 * handlers the contract defines.
 *
 * Rules:
 *
 *   contract_rule_missing
 *       The contract has no `authoring_rules.lifecycle_tools_constraint.
 *       permitted_values` array, so there is nothing to lint against.
 *
 *   permitted_value_without_handler
 *       The contract permits a lifecycle tool that has no entry under
 *       `tool_handlers`. Define the handler before permitting the tool.
 *
 *   lifecycle_tool_not_permitted
 *       A storyboard fixture advertises a lifecycle tool that is not in
 *       `permitted_values`. Drop it from the fixture, or add its handler to
 *       the contract and list it there.
 *
 *   stale_pending_entry
 *       A storyboard listed in PENDING_STORYBOARDS no longer violates the
 *       rule (or no longer exists). Remove the entry so the storyboard is
 *       linted like the rest.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(ROOT, 'static', 'compliance', 'source');
const CONTRACT_REL = path.join('universal', 'buyer-fixture-publisher.yaml');

// Storyboards with known drift that needs contract work rather than a trim.
// Each entry is exempt from `lifecycle_tool_not_permitted` and must be
// removed once it passes — `stale_pending_entry` enforces that.
const PENDING_STORYBOARDS = {
  // Its steps invoke request_proposals, refine_proposals and accept_proposal,
  // so its fixture cannot be trimmed: the contract needs proposal handlers
  // first. Scoped separately in the adcontextprotocol/adcp#7749 triage.
  'specialisms/buyer-negotiation/index.yaml':
    'steps invoke proposal tools; the contract needs proposal handlers before this fixture can be linted',
};

const RULE_MESSAGES = {
  contract_rule_missing: () =>
    'universal/buyer-fixture-publisher.yaml has no ' +
    'authoring_rules.lifecycle_tools_constraint.permitted_values array. The ' +
    'lint needs it to know which compact lifecycle tools a fixture publisher ' +
    'may advertise.',
  permitted_value_without_handler: ({ tool }) =>
    `permitted_values lists "${tool}" but the contract defines no ` +
    `tool_handlers.${tool}. A fixture publisher may only advertise lifecycle ` +
    'tools it can answer — define the handler first.',
  lifecycle_tool_not_permitted: ({ tool, at, permitted }) =>
    `${at} advertises "${tool}", which the fixture-publisher contract does ` +
    `not serve (permitted: ${permitted.length ? permitted.join(', ') : 'none'}). ` +
    'A buyer that gates on lifecycle_tools would call a tool with no handler. ' +
    'Drop it from the fixture, or add its handler to ' +
    'universal/buyer-fixture-publisher.yaml and list it under ' +
    'authoring_rules.lifecycle_tools_constraint.permitted_values.',
  stale_pending_entry: ({ reason }) =>
    'is listed in PENDING_STORYBOARDS but ' +
    (reason === 'missing' ? 'no longer exists' : 'no longer violates the rule') +
    '. Remove the entry from scripts/lint-storyboard-buyer-fixture-lifecycle-tools.cjs.',
};

function toPosix(rel) {
  return rel.split(path.sep).join('/');
}

function loadYaml(file) {
  try {
    return yaml.load(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Yield every `lifecycle_tools` array under a fixture publisher block, with
 * the dotted path it was found at. Recursive so per-persona capability
 * blocks are covered alongside the top-level one.
 */
function* walkLifecycleTools(node, at) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) yield* walkLifecycleTools(node[i], `${at}[${i}]`);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    const childAt = `${at}.${key}`;
    if (key === 'lifecycle_tools' && Array.isArray(value)) {
      yield { at: childAt, tools: value };
      continue;
    }
    yield* walkLifecycleTools(value, childAt);
  }
}

function lint(sourceDir = SOURCE_DIR, { pending = PENDING_STORYBOARDS } = {}) {
  const violations = [];

  const contract = loadYaml(path.join(sourceDir, CONTRACT_REL));
  const permitted = contract?.authoring_rules?.lifecycle_tools_constraint?.permitted_values;
  if (!Array.isArray(permitted)) {
    violations.push({ file: toPosix(CONTRACT_REL), rule: 'contract_rule_missing' });
    return violations;
  }
  const handlers = new Set(Object.keys(contract.tool_handlers ?? {}));
  for (const tool of permitted) {
    if (!handlers.has(tool)) {
      violations.push({ file: toPosix(CONTRACT_REL), rule: 'permitted_value_without_handler', tool });
    }
  }
  const permittedSet = new Set(permitted);
  const pendingWithDrift = new Set();

  function lintFile(p) {
    const rel = toPosix(path.relative(sourceDir, p));
    const doc = loadYaml(p);
    const fixture = doc?.fixtures?.fixture_publisher;
    if (!fixture) return;
    for (const hit of walkLifecycleTools(fixture, 'fixtures.fixture_publisher')) {
      for (const tool of hit.tools) {
        if (permittedSet.has(tool)) continue;
        if (Object.hasOwn(pending, rel)) {
          pendingWithDrift.add(rel);
          continue;
        }
        violations.push({
          file: rel,
          rule: 'lifecycle_tool_not_permitted',
          tool,
          at: hit.at,
          permitted,
        });
      }
    }
  }

  function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) lintFile(p);
    }
  }
  walk(sourceDir);

  for (const rel of Object.keys(pending)) {
    if (pendingWithDrift.has(rel)) continue;
    const exists = fs.existsSync(path.join(sourceDir, rel));
    violations.push({ file: rel, rule: 'stale_pending_entry', reason: exists ? 'passes' : 'missing' });
  }

  return violations;
}

function main() {
  const violations = lint();
  if (violations.length === 0) {
    console.log(
      '✓ storyboard buyer-fixture lifecycle-tools lint: every fixture publisher advertises only lifecycle tools the contract serves',
    );
    return;
  }
  console.error(`✗ storyboard buyer-fixture lifecycle-tools lint: ${violations.length} violation(s)\n`);
  for (const v of violations) {
    const msg = RULE_MESSAGES[v.rule] ? RULE_MESSAGES[v.rule](v) : v.rule;
    console.error(`  ${v.file} (${v.rule})`);
    console.error(`    ${msg}`);
    console.error('');
  }
  process.exit(1);
}

if (require.main === module) main();

module.exports = {
  PENDING_STORYBOARDS,
  RULE_MESSAGES,
  walkLifecycleTools,
  lint,
};

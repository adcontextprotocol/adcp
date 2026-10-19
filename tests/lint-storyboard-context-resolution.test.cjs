#!/usr/bin/env node
/**
 * Tests for the storyboard `$context` resolution lint (#8317). Concerns:
 *   1. Source-tree guard — no storyboard under static/compliance/source reads
 *      a context key that nothing seeds or captures before it, and nothing
 *      captures a key hosted grading pins.
 *   2. The convention-producer map still describes the installed SDK: every
 *      (task, key) pair it waives is really written by that task's
 *      `CONTEXT_EXTRACTORS` entry.
 *   3. Released bundle guard — every compliance bundle in dist/compliance
 *      carries exactly the defects frozen into its immutable artifact, and
 *      nothing else.
 *   4. The #7797 regression itself: 3.0.26's governance storyboards leave
 *      `$context.governance_agent_url` in the `sync_governance` request and
 *      3.0.27+ (the #7801 backport) resolve it.
 *   5. Rule semantics — the lint fires when the root `context:` block is
 *      dropped, when the capture lands after the read, when a convention key
 *      is read before its producing task, when a pinned agent URL is captured
 *      from a response, and when a token names an inherited Object member.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { extractContext } = require('@adcp/sdk/testing');

const {
  CONVENTION_CONTEXT_PRODUCERS,
  RUNNER_PINNED_CONTEXT_KEYS,
  formatViolation,
  lintDoc,
  lintTree,
} = require('../scripts/lint-storyboard-context-resolution.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const COMPLIANCE_DIST = path.join(REPO_ROOT, 'dist', 'compliance');
const PUBLISHED_MANIFEST = path.join(REPO_ROOT, 'static', 'compliance', 'published-versions.json');

// First 3.0 bundle carrying the #7801 backport that seeds
// `governance_agent_url` in the governance scenarios.
const GOVERNANCE_CONTEXT_FIX_VERSION = '3.0.27';

/**
 * Released bundles that carry an unresolved placeholder. `dist/**` release
 * artifacts are immutable (see .agents/playbook.md, "Immutable released
 * artifacts"), so the defect cannot be patched out of them — the remedy is
 * always the next release off a fixed source tree. An agent that pins an
 * exact earlier version still gets the defective bundle; that is a property
 * of the release record, not something this lint can repair.
 *
 * This table is frozen and exact. A bundle that is not in it must be clean,
 * so the next release cannot reintroduce either defect; a bundle that is in
 * it must still carry exactly the listed defect, so the quarantine cannot
 * quietly absorb a new one.
 */
const FROZEN_BUNDLE_DEFECTS = [
  {
    // #7797: the governance scenarios read `$context.governance_agent_url`
    // without declaring it, so `sync_governance` — and the governance flow
    // behind it — can only ever skip with `prerequisite_failed`. #7801 shipped
    // the fix as 3.0.27; the hosted 3.0 alias floor is held by
    // server/tests/unit/hosted-compliance-3-0-27.test.ts.
    defect: 'context_placeholder_unresolved/sync_governance:governance_agent_url',
    versions: [
      '3.0.0', '3.0.1', '3.0.2', '3.0.3', '3.0.4', '3.0.5', '3.0.6',
      '3.0.7', '3.0.8', '3.0.9', '3.0.10', '3.0.11', '3.0.12', '3.0.13',
      '3.0.14', '3.0.15', '3.0.16', '3.0.17', '3.0.18', '3.0.25', '3.0.26',
    ],
  },
  {
    // #8317: `buyer_monitoring` polls delivery for a buy no step in the
    // storyboard creates, so `$context.media_buy_id` had no writer. Fixed in
    // source by seeding it from `fixtures.fixture_publisher.active_buy`; the
    // fix reaches a bundle with the next 3.2 cut.
    defect: 'context_placeholder_unresolved/get_media_buy_delivery:media_buy_id',
    versions: [
      '3.2.0-rc.2', '3.2.0-rc.3', '3.2.0-rc.4', '3.2.0-rc.5', '3.2.0-rc.6',
      '3.2.0-rc.7', '3.2.1', '3.2.2', '3.2.3', '3.2.4', '3.2.5',
    ],
  },
];

/** version -> the single `rule/task:key` it is allowed to report. */
const FROZEN_DEFECT_BY_VERSION = new Map(
  FROZEN_BUNDLE_DEFECTS.flatMap(({ defect, versions }) => versions.map((v) => [v, defect])),
);

/**
 * One response fixture per task named in CONVENTION_CONTEXT_PRODUCERS, shaped
 * the way that task's SDK extractor reads it. The guard below asserts the
 * extractor really writes every key the map attributes to the task, so a
 * waiver cannot outlive the extractor that justifies it.
 */
const CONVENTION_TASK_PROBES = {
  create_media_buy: { media_buy_id: 'mb_7', media_buy_status: 'active' },
  update_media_buy: { media_buy_id: 'mb_7', media_buy_status: 'active' },
  get_media_buys: { media_buys: [{ media_buy_id: 'mb_7', media_buy_status: 'active' }] },
  buy_products: {
    status: 'completed',
    media_buy_id: 'mb_7',
    accepted_proposal: { proposal_id: 'prop_7', terms_digest: 'sha256:abc' },
  },
  accept_proposal: {
    status: 'completed',
    media_buy_id: 'mb_7',
    accepted_proposal: { proposal_id: 'prop_7', terms_digest: 'sha256:abc' },
  },
  control_media_buy: {
    status: 'completed',
    media_buy_id: 'mb_7',
    accepted_proposal: { proposal_id: 'prop_7', terms_digest: 'sha256:abc' },
  },
  get_products: { products: [{ product_id: 'prod_7' }], proposals: [{ proposal_id: 'prop_7' }] },
  request_proposals: { proposals: [{ proposal_id: 'prop_7', terms_digest: 'sha256:abc' }] },
  refine_proposals: { results: [{ proposal: { proposal_id: 'prop_7', terms_digest: 'sha256:abc' } }] },
  create_content_standards: { standards_id: 'cs_7' },
};

function bundledComplianceVersions() {
  return fs
    .readdirSync(COMPLIANCE_DIST, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(COMPLIANCE_DIST, name, 'index.json')))
    .sort();
}

function lintBundle(version) {
  return lintTree(path.join(COMPLIANCE_DIST, version));
}

function doc(text) {
  return yaml.load(text);
}

// ---------------------------------------------------------------------------
// 1. Source-tree guard
// ---------------------------------------------------------------------------

test('source storyboards resolve every $context placeholder the runner injects', () => {
  const { violations, unparsed } = lintTree();
  assert.deepEqual(unparsed, [], 'storyboards under static/compliance/source failed to parse');
  assert.deepEqual(
    violations,
    [],
    'storyboards read context keys nothing seeds or captures:\n' +
      violations.map(formatViolation).join('\n\n'),
  );
});

// ---------------------------------------------------------------------------
// 2. Convention-producer map integrity
// ---------------------------------------------------------------------------

test('every waived (task, key) pair is still written by that task\'s SDK extractor', () => {
  const mappedTasks = new Set(Object.values(CONVENTION_CONTEXT_PRODUCERS).flat());
  assert.deepEqual(
    [...mappedTasks].sort(),
    Object.keys(CONVENTION_TASK_PROBES).sort(),
    'CONVENTION_CONTEXT_PRODUCERS and CONVENTION_TASK_PROBES must name the same tasks',
  );

  for (const [task, response] of Object.entries(CONVENTION_TASK_PROBES)) {
    const extracted = extractContext(task, response);
    const expected = Object.entries(CONVENTION_CONTEXT_PRODUCERS)
      .filter(([, tasks]) => tasks.includes(task))
      .map(([key]) => key);
    for (const key of expected) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(extracted, key),
        `the SDK's ${task} extractor no longer writes "${key}"; the lint waives a (task, key) ` +
          'pair the runner does not produce, so drop it from CONVENTION_CONTEXT_PRODUCERS (and ' +
          'seed or capture the key in the storyboards that read it)',
      );
    }
  }
});

test('the pinned-key set is exactly what hosted grading seeds from server config', () => {
  const routing = fs.readFileSync(
    path.join(REPO_ROOT, 'server', 'src', 'compliance', 'hosted-multi-agent-routing.ts'),
    'utf8',
  );
  const governedBlock = routing.match(
    /export const HOSTED_GOVERNED_AGENT_CONTEXT_KEYS = \[([^\]]*)\]/,
  );
  assert.ok(governedBlock, 'could not find HOSTED_GOVERNED_AGENT_CONTEXT_KEYS in hosted-multi-agent-routing.ts');
  const governedKeys = [...governedBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(governedKeys.length > 0, 'HOSTED_GOVERNED_AGENT_CONTEXT_KEYS parsed as empty');

  assert.match(
    routing,
    /context\.governance_agent_url = pinnedGovernanceUrl/,
    'hosted grading no longer seeds governance_agent_url; revisit RUNNER_PINNED_CONTEXT_KEYS',
  );

  // Set equality in both directions: a new governed-agent key must join the
  // rule, and a key that stops being seeded must leave it.
  assert.deepEqual(
    [...RUNNER_PINNED_CONTEXT_KEYS].sort(),
    [...new Set([...governedKeys, 'governance_agent_url'])].sort(),
    'RUNNER_PINNED_CONTEXT_KEYS has drifted from the keys hosted grading seeds',
  );
});

// ---------------------------------------------------------------------------
// 3. Released bundle guard
// ---------------------------------------------------------------------------

test('bundled compliance releases carry exactly the frozen defects and nothing else', () => {
  const observed = new Map();
  const bundles = bundledComplianceVersions();
  assert.ok(bundles.length > 0, 'dist/compliance has no bundled releases to check');

  for (const version of bundles) {
    const { violations, unparsed } = lintBundle(version);
    // No sibling lint parses released bundles, so an unparsable storyboard
    // would be silently exempt from this guard.
    assert.deepEqual(unparsed, [], `storyboards in dist/compliance/${version} failed to parse`);
    if (violations.length === 0) continue;
    // Each bundle ships every storyboard twice (`protocols/` plus the
    // generated `domains/` alias), so dedupe before comparing.
    const offenders = [...new Set(violations.map((v) => `${v.rule}/${v.task}:${v.key}`))].sort();
    observed.set(version, { offenders, violations });
  }

  const actual = Object.fromEntries([...observed].map(([version, { offenders }]) => [version, offenders]));
  const expected = Object.fromEntries(
    [...observed.keys()].concat([...FROZEN_DEFECT_BY_VERSION.keys()])
      .filter((version, i, all) => all.indexOf(version) === i)
      .map((version) => [
        version,
        FROZEN_DEFECT_BY_VERSION.has(version) ? [FROZEN_DEFECT_BY_VERSION.get(version)] : [],
      ]),
  );

  assert.deepEqual(
    actual,
    expected,
    'bundled compliance releases with unresolved $context placeholders changed:\n' +
      [...observed]
        .map(([version, { violations }]) => `${version}:\n${violations.map(formatViolation).join('\n')}`)
        .join('\n\n'),
  );
});

test('every published 3.0 bundle hosted grading can select from 3.0.27 on is clean', () => {
  const manifest = JSON.parse(fs.readFileSync(PUBLISHED_MANIFEST, 'utf8'));
  const patchOf = (version) => Number(version.split('.')[2]);
  const fixedPatch = patchOf(GOVERNANCE_CONTEXT_FIX_VERSION);
  const bundled = new Set(bundledComplianceVersions());

  const publishedThreeZero = manifest.published_versions
    .filter((version) => /^3\.0\.\d+$/.test(version))
    .sort((a, b) => patchOf(a) - patchOf(b));
  assert.ok(publishedThreeZero.length > 0, 'no 3.0 bundle is registered for hosted grading');

  const selectable = publishedThreeZero.filter((version) => patchOf(version) >= fixedPatch);
  assert.ok(
    selectable.includes(GOVERNANCE_CONTEXT_FIX_VERSION),
    `${GOVERNANCE_CONTEXT_FIX_VERSION} (the #7801 backport) must stay registered for hosted grading`,
  );

  for (const version of selectable) {
    assert.ok(bundled.has(version), `published 3.0 bundle ${version} is missing from dist/compliance`);
    const { violations } = lintBundle(version);
    assert.deepEqual(
      violations,
      [],
      `published 3.0 bundle ${version} has unresolved $context placeholders:\n` +
        violations.map(formatViolation).join('\n'),
    );
  }

  // The alias the hosted 3.0 line resolves to is the newest published bundle.
  const alias = publishedThreeZero[publishedThreeZero.length - 1];
  assert.ok(
    patchOf(alias) >= fixedPatch,
    `the hosted 3.0 alias resolves to ${alias}, which predates the #7801 governance-context fix`,
  );
});

// ---------------------------------------------------------------------------
// 4. The #7797 regression, pinned to the bundles that bracket the fix
// ---------------------------------------------------------------------------

test('3.0.26 leaves $context.governance_agent_url in sync_governance and 3.0.27 resolves it', () => {
  const before = lintBundle('3.0.26').violations.filter((v) => v.task === 'sync_governance');
  assert.ok(
    before.length > 0,
    '3.0.26 is expected to reproduce #7797; if its artifact changed, the premise of this lint moved',
  );
  for (const violation of before) {
    assert.equal(violation.key, 'governance_agent_url');
    assert.equal(violation.rule, 'context_placeholder_unresolved');
  }

  // Every governance storyboard named in #8317 is covered on the broken side.
  const storyboards = new Set(before.map((v) => v.storyboardId));
  for (const id of [
    'media_buy_seller/governance_approved',
    'media_buy_seller/governance_conditions',
    'media_buy_seller/governance_denied',
    'media_buy_seller/governance_denied_recovery',
    'brand_rights/governance_denied',
  ]) {
    assert.ok(storyboards.has(id), `3.0.26 should reproduce #7797 for ${id}`);
  }

  assert.deepEqual(
    lintBundle(GOVERNANCE_CONTEXT_FIX_VERSION).violations,
    [],
    `${GOVERNANCE_CONTEXT_FIX_VERSION} must resolve every governance context placeholder`,
  );
});

// ---------------------------------------------------------------------------
// 5. Rule semantics
// ---------------------------------------------------------------------------

const GOVERNANCE_FIXTURE = `
id: fixture/governance
context:
  governance_agent_url: "https://test-agent.adcontextprotocol.org"
phases:
  - id: seller_setup
    steps:
      - id: sync_governance
        task: sync_governance
        sample_request:
          accounts:
            - governance_agents:
                - url: "$context.governance_agent_url"
                  categories: ["budget_authority"]
          idempotency_key: "$generate:uuid_v4#fixture"
`;

test('a seeded governance_agent_url resolves', () => {
  assert.deepEqual(lintDoc(doc(GOVERNANCE_FIXTURE), 'fixture.yaml'), []);
});

test('dropping the root context: block reproduces #7797', () => {
  const storyboard = doc(GOVERNANCE_FIXTURE);
  delete storyboard.context;
  const violations = lintDoc(storyboard, 'fixture.yaml');
  assert.equal(violations.length, 1);
  assert.deepEqual(
    {
      rule: violations[0].rule,
      stepId: violations[0].stepId,
      task: violations[0].task,
      key: violations[0].key,
      location: violations[0].location,
    },
    {
      rule: 'context_placeholder_unresolved',
      stepId: 'sync_governance',
      task: 'sync_governance',
      key: 'governance_agent_url',
      location: 'sample_request.accounts[0].governance_agents[0].url',
    },
  );
  assert.match(formatViolation(violations[0]), /\$context\.governance_agent_url/);
});

test('capturing a pinned agent URL from a response is a violation, not a writer', () => {
  const storyboard = doc(GOVERNANCE_FIXTURE);
  delete storyboard.context;
  storyboard.phases[0].steps.unshift({
    id: 'discover_governance_agent',
    task: 'get_adcp_capabilities',
    context_outputs: [{ name: 'governance_agent_url', path: 'governance.agent_url' }],
    sample_request: {},
  });
  const violations = lintDoc(storyboard, 'fixture.yaml');
  assert.deepEqual(
    violations.map((v) => `${v.rule}:${v.stepId}`),
    [
      'pinned_context_key_captured:discover_governance_agent',
      // The capture is not honoured, so the read is still unresolved.
      'context_placeholder_unresolved:sync_governance',
    ],
  );
  assert.match(formatViolation(violations[0]), /hosted-multi-agent-routing/);
});

test('a key captured by an earlier step resolves, across phases', () => {
  const storyboard = doc(`
id: fixture/capture
phases:
  - id: create_account
    steps:
      - id: sync_binding_account
        task: sync_accounts
        context_outputs:
          - name: governance_binding_account_id
            path: "accounts[0].account_id"
        sample_request:
          accounts:
            - brand:
                domain: "acmeoutdoor.example"
  - id: register
    steps:
      - id: sync_governance
        task: sync_governance
        sample_request:
          accounts:
            - account:
                account_id: "$context.governance_binding_account_id"
`);
  assert.deepEqual(lintDoc(storyboard, 'fixture.yaml'), []);
});

test('a capture that lands after the read is still unresolved', () => {
  const storyboard = doc(`
id: fixture/late-capture
phases:
  - id: register
    steps:
      - id: sync_governance
        task: sync_governance
        sample_request:
          accounts:
            - account:
                account_id: "$context.governance_binding_account_id"
      - id: sync_binding_account
        task: sync_accounts
        context_outputs:
          - name: governance_binding_account_id
            path: "accounts[0].account_id"
        sample_request:
          accounts:
            - brand:
                domain: "acmeoutdoor.example"
`);
  const violations = lintDoc(storyboard, 'fixture.yaml');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].key, 'governance_binding_account_id');
  assert.equal(violations[0].stepId, 'sync_governance');
});

test('a step cannot read the key its own context_outputs captures', () => {
  const storyboard = doc(`
id: fixture/self-capture
phases:
  - id: register
    steps:
      - id: sync_governance
        task: sync_governance
        context_outputs:
          - key: governance_binding_account_id
            path: "accounts[0].account_id"
        sample_request:
          accounts:
            - account:
                account_id: "$context.governance_binding_account_id"
`);
  const violations = lintDoc(storyboard, 'fixture.yaml');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].key, 'governance_binding_account_id');
});

const CONVENTION_FIXTURE = `
id: fixture/convention
phases:
  - id: buy
    steps:
      - id: create_buy
        task: create_media_buy
        sample_request:
          packages: []
      - id: read_buy
        task: get_media_buy_delivery
        sample_request:
          media_buy_id: "$context.media_buy_id"
`;

test('a convention key resolves once its producing task has run', () => {
  assert.deepEqual(lintDoc(doc(CONVENTION_FIXTURE), 'fixture.yaml'), []);
});

test('a convention key read without a producing task is unresolved', () => {
  const storyboard = doc(CONVENTION_FIXTURE);
  // get_media_buy_delivery has no extractor, so nothing writes media_buy_id.
  storyboard.phases[0].steps[0].task = 'get_media_buy_delivery';
  const violations = lintDoc(storyboard, 'fixture.yaml');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].key, 'media_buy_id');
  assert.equal(violations[0].stepId, 'read_buy');
});

test('a token naming an inherited Object member does not count as resolved', () => {
  // The runner resolves with `key in context`, which walks the prototype
  // chain, so this substitutes a Function and the field vanishes from the
  // JSON request — and the runtime guard sees no literal left to report.
  const storyboard = doc(`
id: fixture/prototype
phases:
  - id: register
    steps:
      - id: sync_governance
        task: sync_governance
        sample_request:
          accounts:
            - governance_agents:
                - url: "$context.constructor"
`);
  const violations = lintDoc(storyboard, 'fixture.yaml');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].key, 'constructor');
});

test('buyer-track storyboards are in scope', () => {
  // `sample_request` is nominally the reference shape the buyer agent's own
  // call is graded against, but the SDK has no interaction_model awareness and
  // resolveStoryboardsForCapabilities hands these to the ordinary runner, so
  // an unwritable token is just as broken here. This is the buyer_monitoring
  // shape that seeding `media_buy_id` from the fixture block fixed.
  const storyboard = doc(`
id: fixture/buyer
agent:
  interaction_model: media_buy_buyer
phases:
  - id: poll
    steps:
      - id: check_delivery
        task: get_media_buy_delivery
        sample_request:
          media_buy_id: "$context.media_buy_id"
`);
  const violations = lintDoc(storyboard, 'fixture.yaml');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].key, 'media_buy_id');

  storyboard.context = { media_buy_id: 'mb_monitoring_001' };
  assert.deepEqual(lintDoc(storyboard, 'fixture.yaml'), []);
});

test('an embedded mention inside a request string is not a substitution', () => {
  // The runner's match is anchored, so only a whole-string token substitutes.
  // `note:` is the live assertion here — the lint walks `sample_request` only.
  const storyboard = doc(`
id: fixture/prose
phases:
  - id: register
    steps:
      - id: sync_governance
        task: sync_governance
        sample_request:
          note: "see $context.governance_agent_url for the endpoint"
`);
  assert.deepEqual(lintDoc(storyboard, 'fixture.yaml'), []);

  storyboard.phases[0].steps[0].sample_request.note = '$context.governance_agent_url';
  assert.equal(lintDoc(storyboard, 'fixture.yaml').length, 1);
});

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import {
  CANONICAL_ACCOUNT_CONTRACTS,
  DEFAULT_SOURCE_ROOT,
  EXCLUDED_STORYBOARDS,
  FIXTURE_PUBLISHER_STORYBOARDS,
  applyAccountFixtureEdits,
  findAccountFixtureEdits,
} from '../scripts/add-storyboard-account-fixtures.mjs';

const require = createRequire(import.meta.url);
const sdkLib = path.dirname(require.resolve('@adcp/sdk'));
const { enrichRequest } = require(path.join(sdkLib, 'testing', 'storyboard', 'request-builder.js'));

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-account-fixtures-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeStoryboard(root, name, body) {
  const file = path.join(root, `${name}.yaml`);
  fs.writeFileSync(file, body);
  return file;
}

function sourceYamlFiles(root = DEFAULT_SOURCE_ROOT) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceYamlFiles(absolute));
    else if (/\.ya?ml$/u.test(entry.name)) files.push(absolute);
  }
  return files;
}

function accountFixtureBody(entry) {
  return entry?.fixture && typeof entry.fixture === 'object' ? entry.fixture : entry;
}

function accountNaturalKey(account) {
  if (!account?.brand?.domain || !account?.operator || account.account_id) return undefined;
  return JSON.stringify({
    brand: {
      domain: account.brand.domain,
      ...(account.brand.brand_id !== undefined && { brand_id: account.brand.brand_id }),
      ...(Array.isArray(account.brand.countries) && {
        countries: [...new Set(account.brand.countries)].sort(),
      }),
    },
    operator: account.operator,
    ...(account.operator_unit?.id !== undefined && { operator_unit_id: account.operator_unit.id }),
    ...(account.currency !== undefined && { currency: account.currency }),
    ...(account.timezone !== undefined && { timezone: account.timezone }),
    sandbox: account.sandbox === true,
  });
}

function canonicalAccounts(value, found = []) {
  if (Array.isArray(value)) {
    value.forEach((entry) => canonicalAccounts(entry, found));
  } else if (value && typeof value === 'object') {
    if (CANONICAL_ACCOUNT_CONTRACTS.some((contract) =>
      contract.domain === value.brand?.domain && contract.operator === value.operator)) {
      found.push(value);
    }
    Object.values(value).forEach((entry) => canonicalAccounts(entry, found));
  }
  return found;
}

const OMITTED_ACCOUNT_STORYBOARD = (id) => `
id: ${id}
prerequisites:
  description: Account fixture test
phases:
  - id: exercise
    steps:
      - id: ordinary
        task: get_products
        sample_request:
          account:
            brand: { domain: acmeoutdoor.example }
            operator: pinnacle-agency.example
      - id: deliberate_negative
        task: get_products
        sample_request:
          account:
            brand: { domain: otherbrand.example }
            operator: pinnacle-agency.example
`;

test('source storyboards declare every canonical account prerequisite', () => {
  assert.deepEqual(findAccountFixtureEdits(DEFAULT_SOURCE_ROOT), []);
});

test('canonical map covers kit, self-operated signal, and both sandbox identities', () => {
  assert.deepEqual(CANONICAL_ACCOUNT_CONTRACTS, [
    { domain: 'acmeoutdoor.example', operator: 'pinnacle-agency.example', sandboxes: [true, false] },
    { domain: 'novamotors.example', operator: 'pinnacle-agency.example', sandboxes: [true, false] },
    { domain: 'novamotors.example', operator: 'novamotors.example', sandboxes: [true, false] },
  ]);
});

test('separately owned account fixes remain explicit exclusions', () => {
  assert.deepEqual([...EXCLUDED_STORYBOARDS.keys()], [
    'universal/idempotency.yaml',
    'protocols/media-buy/scenarios/package_correlation_legacy_fallback.yaml',
  ]);
});

test('buyer-agent storyboards leave account setup with their fixture publisher', () => {
  assert.deepEqual([...FIXTURE_PUBLISHER_STORYBOARDS], [
    'specialisms/buyer-activation/index.yaml',
    'specialisms/buyer-discovery/index.yaml',
    'specialisms/buyer-monitoring/index.yaml',
    'specialisms/buyer-negotiation/index.yaml',
    'specialisms/buyer-recovery/index.yaml',
    'specialisms/orchestrator-multi-agent/index.yaml',
  ]);
  for (const relativePath of FIXTURE_PUBLISHER_STORYBOARDS) {
    const storyboard = YAML.parse(fs.readFileSync(path.join(DEFAULT_SOURCE_ROOT, relativePath), 'utf8'));
    assert.equal(storyboard.track, 'media_buy_buyer');
    assert.ok(storyboard.fixtures?.fixture_publisher);
    assert.notEqual(storyboard.prerequisites?.controller_seeding, true);
    assert.equal(storyboard.fixtures?.accounts, undefined);
  }
});

test('generator isolates account keys across storyboards and seeds both effective sandbox variants', (t) => {
  const root = temporaryRoot(t);
  const firstPath = writeStoryboard(root, 'first', OMITTED_ACCOUNT_STORYBOARD('first_storyboard'));
  const secondPath = writeStoryboard(root, 'second', OMITTED_ACCOUNT_STORYBOARD('second_storyboard'));

  const edits = findAccountFixtureEdits(root);
  assert.equal(edits.length, 2);
  assert.notDeepEqual(
    edits[0].entries.map((entry) => entry.account_id),
    edits[1].entries.map((entry) => entry.account_id),
  );
  assert.deepEqual(edits[0].entries.map((entry) => entry.key.sandbox).sort(), [false, true]);
  applyAccountFixtureEdits(edits);

  for (const file of [firstPath, secondPath]) {
    const generated = YAML.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(generated.prerequisites.controller_seeding, true);
    assert.equal(generated.fixtures.accounts.length, 2);
    assert.deepEqual(generated.fixtures.accounts.map((account) => account.fixture.sandbox).sort(), [false, true]);
    assert.ok(generated.fixtures.accounts.every((account) =>
      account.fixture.brand.domain === 'acmeoutdoor.example' &&
      account.fixture.operator === 'pinnacle-agency.example' &&
      account.fixture.operator_unit.id.startsWith('compliance-')));
    const requestUnits = generated.phases[0].steps
      .map((step) => step.sample_request.account.operator_unit?.id)
      .filter(Boolean);
    assert.deepEqual([...new Set(requestUnits)], [generated.fixtures.accounts[0].fixture.operator_unit.id]);
  }
  assert.deepEqual(findAccountFixtureEdits(root), []);
});

test('generator preserves every normative natural-key field in fixture identity', (t) => {
  const root = temporaryRoot(t);
  const storyboardPath = writeStoryboard(root, 'full-key', `
id: full_key
prerequisites:
  description: Full key fixture test
phases:
  - id: exercise
    steps:
      - id: ordinary
        task: get_products
        sample_request:
          account:
            brand:
              domain: acmeoutdoor.example
              brand_id: trail
              countries: [US, CA, US]
            operator: pinnacle-agency.example
            operator_unit: { id: seat-7, name: Display only }
            currency: USD
            timezone: America/Toronto
            sandbox: true
`);

  applyAccountFixtureEdits(findAccountFixtureEdits(root));
  const [entry] = YAML.parse(fs.readFileSync(storyboardPath, 'utf8')).fixtures.accounts;
  const account = entry.fixture;
  assert.deepEqual(account, {
    brand: { domain: 'acmeoutdoor.example', brand_id: 'trail', countries: ['CA', 'US'] },
    operator: 'pinnacle-agency.example',
    operator_unit: { id: 'seat-7' },
    currency: 'USD',
    billing: 'operator',
    status: 'active',
    sandbox: true,
    timezone: 'America/Toronto',
  });
  assert.match(entry.account_id, /^acct_acmeoutdoor_example_sandbox_[a-f0-9]{12}$/u);
});

test('a prior sync_accounts remains the storyboard-owned prerequisite', (t) => {
  const root = temporaryRoot(t);
  writeStoryboard(root, 'self-provisioned', `
id: self_provisioned
prerequisites:
  description: Self-provisioned account test
phases:
  - id: setup
    steps:
      - id: sync
        task: sync_accounts
        sample_request:
          accounts:
            - brand: { domain: acmeoutdoor.example }
              operator: pinnacle-agency.example
              billing: operator
      - id: use
        task: get_products
        sample_request:
          account:
            brand: { domain: acmeoutdoor.example }
            operator: pinnacle-agency.example
            sandbox: true
`);
  assert.deepEqual(findAccountFixtureEdits(root), []);
});

test('literal account_id references must resolve to a declared account fixture', (t) => {
  const root = temporaryRoot(t);
  writeStoryboard(root, 'dangling-id', `
id: dangling_id
prerequisites:
  description: Literal account id fixture test
phases:
  - id: exercise
    steps:
      - id: ordinary
        task: report_usage
        sample_request:
          account:
            brand: { domain: acmeoutdoor.example }
            operator: pinnacle-agency.example
          usage:
            - account: { account_id: acct_missing }
`);
  assert.throws(
    () => findAccountFixtureEdits(root),
    /literal account_id reference\(s\) lack fixtures\.accounts entries: acct_missing/u,
  );
});

test('fixture variants match the SDK request builder sandbox behavior', () => {
  const options = { brand: { domain: 'acmeoutdoor.example' }, sandbox: true };
  const account = {
    brand: { domain: 'acmeoutdoor.example' },
    operator: 'pinnacle-agency.example',
  };
  const ordinary = enrichRequest({
    id: 'ordinary',
    task: 'get_products',
    sample_request: { buying_mode: 'brief', account },
  }, {}, options);
  const wholesale = enrichRequest({
    id: 'wholesale',
    task: 'get_products',
    sample_request: { buying_mode: 'wholesale', account },
  }, {}, options);

  assert.equal(ordinary.account.sandbox, true);
  assert.equal(Object.hasOwn(wholesale.account, 'sandbox'), false);
});

test('rc.35 effective account requests exactly match isolated seeded fixtures', () => {
  for (const absolutePath of sourceYamlFiles()) {
    const relativePath = path.relative(DEFAULT_SOURCE_ROOT, absolutePath).split(path.sep).join('/');
    if (EXCLUDED_STORYBOARDS.has(relativePath) || FIXTURE_PUBLISHER_STORYBOARDS.has(relativePath)) continue;
    const storyboard = YAML.parse(fs.readFileSync(absolutePath, 'utf8'));
    if (!storyboard || !Array.isArray(storyboard.phases)) continue;
    const fixtureKeys = new Set((storyboard.fixtures?.accounts ?? [])
      .map((entry) => accountNaturalKey(accountFixtureBody(entry)))
      .filter(Boolean));
    let accountEstablished = false;
    for (const phase of storyboard.phases ?? []) {
      for (const step of phase.steps ?? []) {
        if (step.task === 'sync_accounts') {
          accountEstablished = true;
          continue;
        }
        if (accountEstablished || !step.sample_request) continue;
        const enriched = enrichRequest(step, {}, {
          brand: step.sample_request.account?.brand ?? { domain: 'acmeoutdoor.example' },
          sandbox: true,
        });
        for (const account of canonicalAccounts(enriched)) {
          assert.ok(account.operator_unit?.id, `${relativePath}:${step.id} lacks an isolated operator_unit.id`);
          assert.ok(
            fixtureKeys.has(accountNaturalKey(account)),
            `${relativePath}:${step.id} effective account key lacks a matching fixture`,
          );
        }
      }
    }
  }
});

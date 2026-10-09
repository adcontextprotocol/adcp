#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SOURCE_ROOT = path.join(SCRIPT_DIR, '..', 'static', 'compliance', 'source');

// These are the buyer-declared account identities used by the shared test kits.
// Keep this map independent of prerequisites.test_kit: universal runner kits and
// self-operated signal scenarios also send these exact account references.
export const CANONICAL_ACCOUNT_CONTRACTS = [
  {
    domain: 'acmeoutdoor.example',
    operator: 'pinnacle-agency.example',
    sandboxes: [true, false],
  },
  {
    domain: 'novamotors.example',
    operator: 'pinnacle-agency.example',
    sandboxes: [true, false],
  },
  {
    domain: 'novamotors.example',
    operator: 'novamotors.example',
    sandboxes: [true, false],
  },
];

// These account gaps have separate owners. Keeping them explicit makes stale
// exclusions fail review instead of silently disappearing from the sweep.
export const EXCLUDED_STORYBOARDS = new Map([
  ['universal/idempotency.yaml', '#7537 requires inline sync_accounts under the universal principal'],
  ['protocols/media-buy/scenarios/package_correlation_legacy_fallback.yaml', '#7539 owns this fixture'],
]);

// These exercise a buyer agent against fixtures.fixture_publisher. Controller
// seeding would target the buyer under test, not the publisher that owns the
// account, and would incorrectly make ordinary buyers inapplicable.
export const FIXTURE_PUBLISHER_STORYBOARDS = new Set([
  'specialisms/buyer-activation/index.yaml',
  'specialisms/buyer-discovery/index.yaml',
  'specialisms/buyer-monitoring/index.yaml',
  'specialisms/buyer-negotiation/index.yaml',
  'specialisms/buyer-recovery/index.yaml',
  'specialisms/orchestrator-multi-agent/index.yaml',
]);

function yamlFiles(root) {
  const files = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (/\.ya?ml$/u.test(entry.name)) files.push(absolute);
    }
  }
  walk(root);
  return files.sort();
}

function storyboardSteps(doc) {
  return Array.isArray(doc?.phases) ? doc.phases.flatMap((phase) => phase.steps ?? []) : [];
}

function fixtureBody(entry) {
  return entry?.fixture && typeof entry.fixture === 'object' ? entry.fixture : entry;
}

function literalAccountIds(value, found = []) {
  if (Array.isArray(value)) {
    for (const entry of value) literalAccountIds(entry, found);
  } else if (value && typeof value === 'object') {
    if (typeof value.account_id === 'string') found.push(value.account_id);
    for (const child of Object.values(value)) literalAccountIds(child, found);
  }
  return found;
}

function canonicalCountries(countries) {
  if (!Array.isArray(countries)) return undefined;
  return [...new Set(countries.filter((country) => typeof country === 'string'))].sort();
}

// AccountRef identity is brand key + operator + operator_unit.id + currency +
// timezone + sandbox. operator_unit.name and mutable BrandRef fields are not
// identity-bearing (core/account-ref.json and sync-accounts-request.json).
function naturalKey(account, sandbox = account?.sandbox === true) {
  if (!account || typeof account !== 'object') return undefined;
  const domain = account.brand?.domain;
  const operator = account.operator;
  if (typeof domain !== 'string' || typeof operator !== 'string') return undefined;
  const countries = canonicalCountries(account.brand?.countries);
  return {
    brand: {
      domain,
      ...(typeof account.brand?.brand_id === 'string' && { brand_id: account.brand.brand_id }),
      ...(countries !== undefined && { countries }),
    },
    operator,
    ...(typeof account.operator_unit?.id === 'string' && { operator_unit_id: account.operator_unit.id }),
    ...(typeof account.currency === 'string' && { currency: account.currency }),
    ...(typeof account.timezone === 'string' && { timezone: account.timezone }),
    sandbox,
  };
}

function serializedKey(key) {
  return JSON.stringify(key);
}

function sameNaturalKey(left, right) {
  return serializedKey(left) === serializedKey(right);
}

function sameNaturalKeyWithoutOperatorUnit(left, right) {
  const { operator_unit_id: _leftUnit, ...leftRest } = left;
  const { operator_unit_id: _rightUnit, ...rightRest } = right;
  return serializedKey(leftRest) === serializedKey(rightRest);
}

function contractFor(key) {
  return CANONICAL_ACCOUNT_CONTRACTS.find((contract) =>
    contract.domain === key.brand.domain &&
    contract.operator === key.operator &&
    contract.sandboxes.includes(key.sandbox));
}

function referencedKeys(account) {
  const base = naturalKey(account);
  if (!base) return [];
  const matchingContracts = CANONICAL_ACCOUNT_CONTRACTS.filter((contract) =>
    contract.domain === base.brand.domain && contract.operator === base.operator);
  if (matchingContracts.length === 0) return [];

  // The SDK's effective sandbox is task-dependent: ordinary account-scoped
  // requests inherit the sandbox run option, while wholesale/raw requests keep
  // AccountRef's omitted=false semantics. Both variants are part of these test
  // kit contracts, so seeding both is deterministic and covers the wire shape.
  const sandboxes = typeof account.sandbox === 'boolean'
    ? [account.sandbox]
    : [...new Set(matchingContracts.flatMap((contract) => contract.sandboxes))];
  return sandboxes
    .map((sandbox) => naturalKey(account, sandbox))
    .filter((key) => key && contractFor(key));
}

function referencedAccounts(value, found = []) {
  if (Array.isArray(value)) {
    for (const entry of value) referencedAccounts(entry, found);
  } else if (value && typeof value === 'object') {
    const key = naturalKey(value);
    if (key && contractFor(key)) found.push(value);
    for (const child of Object.values(value)) referencedAccounts(child, found);
  }
  return found;
}

function slug(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .toLowerCase();
}

function accountId(key) {
  const digest = createHash('sha256').update(serializedKey(key)).digest('hex').slice(0, 12);
  return `acct_${slug(key.brand.domain).slice(0, 28)}_${key.sandbox ? 'sandbox' : 'live'}_${digest}`;
}

function isolationUnitId(storyboardId) {
  const digest = createHash('sha256').update(String(storyboardId)).digest('hex').slice(0, 8);
  return `compliance-${slug(storyboardId).slice(0, 36)}-${digest}`;
}

function isolateSampleRequestAccounts(source, storyboard, relativePath) {
  const document = YAML.parseDocument(source, { keepSourceTokens: true });
  const phases = document.get('phases', true);
  if (!YAML.isSeq(phases)) return source;

  const replacements = [];
  const unitId = isolationUnitId(storyboard.id);
  function collectAccountInsertions(node, plain) {
    if (YAML.isSeq(node)) {
      node.items.forEach((item, index) => collectAccountInsertions(item, plain?.[index]));
      return;
    }
    if (!YAML.isMap(node)) return;
    for (const pair of node.items) {
      const key = pair.key?.value;
      const child = plain?.[key];
      if (key === 'account' && YAML.isMap(pair.value)) {
        const natural = naturalKey(child);
        if (natural && contractFor(natural) && child.operator_unit?.id === undefined) {
          if (pair.value.flow) {
            const close = source.lastIndexOf('}', pair.value.range[1] - 1);
            if (close < pair.value.range[0]) throw new Error(`${relativePath}: cannot isolate flow account`);
            replacements.push({
              start: close,
              end: close,
              value: `, operator_unit: { id: ${JSON.stringify(unitId)} }`,
            });
          } else {
            const operator = pair.value.items.find((item) => item.key?.value === 'operator');
            if (!operator?.value?.range) throw new Error(`${relativePath}: canonical account lacks operator range`);
            const lineStart = source.lastIndexOf('\n', operator.key.range[0] - 1) + 1;
            const indent = source.slice(lineStart, operator.key.range[0]);
            let lineEnd = source.indexOf('\n', operator.value.range[1]);
            if (lineEnd === -1) lineEnd = operator.value.range[1];
            replacements.push({
              start: lineEnd,
              end: lineEnd,
              value: `\n${indent}operator_unit:\n${indent}  id: ${JSON.stringify(unitId)}`,
            });
          }
        } else if (
          natural && contractFor(natural) &&
          /^compliance-/u.test(child.operator_unit?.id ?? '') &&
          child.operator_unit.id !== unitId
        ) {
          const operatorUnit = pair.value.items.find((item) => item.key?.value === 'operator_unit');
          const id = YAML.isMap(operatorUnit?.value)
            ? operatorUnit.value.items.find((item) => item.key?.value === 'id')
            : undefined;
          if (!id?.value?.range) throw new Error(`${relativePath}: cannot update isolated operator_unit.id`);
          replacements.push({
            start: id.value.range[0],
            end: id.value.range[1],
            value: JSON.stringify(unitId),
          });
        }
      }
      collectAccountInsertions(pair.value, child);
    }
  }
  let accountEstablished = false;
  for (const [phaseIndex, phase] of phases.items.entries()) {
    if (!YAML.isMap(phase)) continue;
    const steps = phase.get('steps', true);
    if (!YAML.isSeq(steps)) continue;
    for (const [stepIndex, step] of steps.items.entries()) {
      if (!YAML.isMap(step)) continue;
      if (step.get('task') === 'sync_accounts') {
        accountEstablished = true;
        continue;
      }
      if (accountEstablished) continue;
      const request = step.get('sample_request', true);
      if (!YAML.isMap(request)) continue;
      collectAccountInsertions(
        request,
        storyboard.phases?.[phaseIndex]?.steps?.[stepIndex]?.sample_request,
      );
    }
  }
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    source = `${source.slice(0, replacement.start)}${replacement.value}${source.slice(replacement.end)}`;
  }
  return source;
}

function renderAccountEntry({ account_id, key }, nested = true) {
  const lines = [];
  const fieldIndent = nested ? '        ' : '      ';
  const childIndent = `${fieldIndent}  `;
  lines.push(`    - account_id: ${JSON.stringify(account_id)}`);
  if (nested) lines.push('      fixture:');
  lines.push(`${fieldIndent}brand:`, `${childIndent}domain: ${JSON.stringify(key.brand.domain)}`);
  if (key.brand.brand_id !== undefined) lines.push(`${childIndent}brand_id: ${JSON.stringify(key.brand.brand_id)}`);
  if (key.brand.countries !== undefined) lines.push(`${childIndent}countries: ${JSON.stringify(key.brand.countries)}`);
  lines.push(`${fieldIndent}operator: ${JSON.stringify(key.operator)}`);
  if (key.operator_unit_id !== undefined) {
    lines.push(`${fieldIndent}operator_unit:`, `${childIndent}id: ${JSON.stringify(key.operator_unit_id)}`);
  }
  if (key.currency !== undefined) lines.push(`${fieldIndent}currency: ${JSON.stringify(key.currency)}`);
  lines.push(
    `${fieldIndent}billing: "operator"`,
    `${fieldIndent}status: "active"`,
    `${fieldIndent}sandbox: ${key.sandbox}`,
  );
  if (key.timezone !== undefined) lines.push(`${fieldIndent}timezone: ${JSON.stringify(key.timezone)}`);
  return lines.join('\n');
}

function renderAccountEntries(entries) {
  return entries.map((entry) => renderAccountEntry(entry)).join('\n');
}

function renderAccounts(entries) {
  return `  accounts:\n${renderAccountEntries(entries)}`;
}

function enableControllerSeeding(source, doc, relativePath) {
  if (doc.prerequisites?.controller_seeding === true) return source;
  if (!doc.prerequisites || !/^prerequisites:\s*$/mu.test(source)) {
    throw new Error(`${relativePath}: account fixtures require a prerequisites block`);
  }
  if (/^  controller_seeding:\s*false\s*$/mu.test(source)) {
    return source.replace(/^  controller_seeding:\s*false\s*$/mu, '  controller_seeding: true');
  }
  return source.replace(/^prerequisites:\s*$/mu, 'prerequisites:\n  controller_seeding: true');
}

function insertAccounts(source, doc, entries, relativePath) {
  const block = renderAccounts(entries);
  if (!doc.fixtures) {
    if (!/^phases:\s*$/mu.test(source)) throw new Error(`${relativePath}: cannot locate phases insertion point`);
    return source.replace(/^phases:\s*$/mu, `fixtures:\n${block}\n\nphases:`);
  }
  if (!/^fixtures:\s*$/mu.test(source)) throw new Error(`${relativePath}: cannot locate fixtures block`);
  if (!Array.isArray(doc.fixtures.accounts)) {
    return source.replace(/^fixtures:\s*$/mu, `fixtures:\n${block}`);
  }
  if (doc.fixtures.accounts.length === 0) {
    return source.replace(/^  accounts:\s*\[\]\s*$/mu, block);
  }

  const marker = /^  accounts:\s*$/mu.exec(source);
  if (!marker) throw new Error(`${relativePath}: cannot append to fixtures.accounts`);
  const contentStart = marker.index + marker[0].length;
  const remainder = source.slice(contentStart);
  const boundary = /^(?:  [a-zA-Z_][^:\n]*:|[a-zA-Z_][^:\n]*:)\s*/mu.exec(remainder);
  const insertAt = boundary ? contentStart + boundary.index : source.length;
  return `${source.slice(0, insertAt).replace(/\n?$/u, '\n')}${renderAccountEntries(entries)}\n${source.slice(insertAt)}`;
}

export function findAccountFixtureEdits(sourceRoot = DEFAULT_SOURCE_ROOT) {
  const edits = [];
  for (const absolutePath of yamlFiles(sourceRoot)) {
    const relativePath = path.relative(sourceRoot, absolutePath).split(path.sep).join('/');
    if (EXCLUDED_STORYBOARDS.has(relativePath) || FIXTURE_PUBLISHER_STORYBOARDS.has(relativePath)) continue;

    const source = fs.readFileSync(absolutePath, 'utf8');
    let storyboard;
    try {
      storyboard = YAML.parse(source);
    } catch {
      continue;
    }
    const steps = storyboardSteps(storyboard);
    if (steps.length === 0) continue;

    let output = source;
    const unitId = isolationUnitId(storyboard.id);
    for (const entry of storyboard.fixtures?.accounts ?? []) {
      const key = naturalKey(fixtureBody(entry));
      if (!key || !contractFor(key) || key.operator_unit_id === unitId) continue;
      if (entry.account_id !== accountId(key)) continue;
      if (key.operator_unit_id !== undefined && !/^compliance-/u.test(key.operator_unit_id)) continue;
      const isolatedKey = { ...key, operator_unit_id: unitId };
      const prior = renderAccountEntry({ account_id: entry.account_id, key }, entry.fixture !== undefined);
      const isolatedId = accountId(isolatedKey);
      const replacement = renderAccountEntry({ account_id: isolatedId, key: isolatedKey });
      if (!output.includes(prior)) {
        throw new Error(`${relativePath}: cannot isolate generated account fixture ${entry.account_id}`);
      }
      output = output.replace(prior, replacement).split(entry.account_id).join(isolatedId);
    }
    try {
      output = isolateSampleRequestAccounts(output, YAML.parse(output), relativePath);
    } catch (error) {
      throw new Error(`${relativePath}: cannot isolate account references`, { cause: error });
    }
    storyboard = YAML.parse(output);
    let isolatedSteps = storyboardSteps(storyboard);

    const referenced = [];
    let accountEstablished = false;
    for (const step of isolatedSteps) {
      if (step.task === 'sync_accounts' && Array.isArray(step.sample_request?.accounts)) {
        accountEstablished = true;
        continue;
      }
      // A prior sync_accounts is the storyboard-owned prerequisite. The sweep
      // must not create a second identity that the SDK may not send at runtime.
      if (accountEstablished) continue;
      for (const account of referencedAccounts(step.sample_request)) {
        for (const key of referencedKeys(account)) {
          if (!referenced.some((candidate) => sameNaturalKey(candidate, key))) referenced.push(key);
        }
      }
    }

    for (const entry of storyboard.fixtures?.accounts ?? []) {
      const key = naturalKey(fixtureBody(entry));
      if (!key || !/^compliance-/u.test(key.operator_unit_id ?? '')) continue;
      if (referenced.some((candidate) => sameNaturalKey(candidate, key))) continue;
      const target = referenced.find((candidate) => sameNaturalKeyWithoutOperatorUnit(candidate, key));
      if (!target) continue;
      const block = renderAccountEntry({ account_id: entry.account_id, key }, entry.fixture !== undefined);
      if (!output.includes(block)) throw new Error(`${relativePath}: cannot remove stale isolated fixture ${entry.account_id}`);
      output = output.replace(`${block}\n`, '').split(entry.account_id).join(accountId(target));
    }
    output = output
      .replace(/^  accounts:\n+(?=    - account_id:)/mu, '  accounts:\n')
      .replace(/^(        (?:sandbox: (?:true|false)|timezone: .+))\n(?=[a-zA-Z_])/gmu, '$1\n\n');
    storyboard = YAML.parse(output);
    isolatedSteps = storyboardSteps(storyboard);

    const provisioned = (storyboard.fixtures?.accounts ?? [])
      .map((entry) => naturalKey(fixtureBody(entry)))
      .filter(Boolean);
    const missing = referenced.filter((key) =>
      !provisioned.some((candidate) => sameNaturalKey(candidate, key)));
    const dynamic = missing.find((key) =>
      [key.timezone, key.currency, key.operator_unit_id, key.brand.brand_id]
        .some((value) => typeof value === 'string' && value.startsWith('$')));
    if (dynamic) throw new Error(`${relativePath}: cannot controller-seed a dynamic account natural key`);

    const entries = missing.map((key) => ({ account_id: accountId(key), key }));
    const existingCanonicalFixtures = (storyboard.fixtures?.accounts ?? [])
      .filter((entry) => {
        const key = naturalKey(fixtureBody(entry));
        return key && contractFor(key);
      });
    if (entries.length > 0 || existingCanonicalFixtures.length > 0) {
      const fixtureIds = new Set([
        ...(storyboard.fixtures?.accounts ?? []).map((entry) => entry.account_id).filter(Boolean),
        ...entries.map((entry) => entry.account_id),
      ]);
      const unresolvedIds = [...new Set(
        isolatedSteps.flatMap((step) => literalAccountIds(step.sample_request))
          .filter((id) => !fixtureIds.has(id)),
      )];
      if (unresolvedIds.length > 0) {
        throw new Error(`${relativePath}: literal account_id reference(s) lack fixtures.accounts entries: ${unresolvedIds.join(', ')}`);
      }
    }

    for (const entry of storyboard.fixtures?.accounts ?? []) {
      if (entry.fixture !== undefined) continue;
      const key = naturalKey(entry);
      if (!key || !contractFor(key) || entry.account_id !== accountId(key)) continue;
      const legacy = renderAccountEntry({ account_id: entry.account_id, key }, false);
      const canonical = renderAccountEntry({ account_id: entry.account_id, key });
      if (!output.includes(legacy)) {
        throw new Error(`${relativePath}: cannot normalize generated account fixture ${entry.account_id}`);
      }
      output = output.replace(legacy, canonical);
    }
    if (entries.length > 0) {
      output = insertAccounts(output, storyboard, entries, relativePath);
      output = enableControllerSeeding(output, storyboard, relativePath);
    }
    if (output !== source) {
      edits.push({ absolutePath, relativePath, entries, output });
    }
  }
  return edits;
}

export function applyAccountFixtureEdits(edits) {
  for (const edit of edits) fs.writeFileSync(edit.absolutePath, edit.output);
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const rootIndex = args.indexOf('--root');
  const sourceRoot = rootIndex === -1 ? DEFAULT_SOURCE_ROOT : path.resolve(args[rootIndex + 1]);
  const edits = findAccountFixtureEdits(sourceRoot);
  if (check) {
    if (edits.length > 0) {
      for (const edit of edits) console.error(`account fixture drift: ${edit.relativePath}`);
      console.error(`${edits.length} storyboard(s) need account fixture updates`);
      process.exitCode = 1;
    } else {
      console.log('Account fixture sweep is current.');
    }
    return;
  }
  applyAccountFixtureEdits(edits);
  const accounts = edits.reduce((total, edit) => total + edit.entries.length, 0);
  console.log(`Added ${accounts} account fixture(s) across ${edits.length} storyboard(s).`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();

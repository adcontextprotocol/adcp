// An extension carries its rules, not only its schema: spec.md and the conformance
// storyboards are hashed into the manifest before the digest is computed, the registry keeps
// them next to the bundle, and the storyboard runner grades them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBundle, extensionPackages, publish, registryDocsDir, writeRegistryIndex } from '../scripts/build-extensions.mjs';
import { jcs, sha256Digest } from '../lib/digest.mjs';
import { extensionIndex, loadSuites, runStoryboard } from '../scripts/run-conformance.mjs';
import { parseSpec, sha256Of } from '../lib/extension-spec.mjs';
import { SCHEMA_ONLY_CHECK, loadModule } from '../lib/buyer-validator.mjs';
import { createAdcpClient } from '../lib/client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = (p) => path.join(ROOT, 'packages', p);
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
/** s as a literal inside a RegExp: every metacharacter, the backslash included, escaped. */
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A throwaway copy of a package under its own uri, so it can be published to a scratch registry. */
function scratchPackage(pkg) {
  const dir = mkdtempSync(path.join(tmpdir(), 'adcp-ext-'));
  cpSync(PKG(pkg), dir, { recursive: true });
  const manifest = readJson(path.join(dir, 'extension.json'));
  manifest.id = 'https://ext.test.example.com/adcp/spec-edit';
  writeFileSync(path.join(dir, 'extension.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

test('the manifest pins spec.md, every storyboard, and the reference code by sha256; the digest covers them', () => {
  for (const dir of extensionPackages()) {
    const bundle = readJson(path.join(dir, 'dist/bundle.json'));
    const { docs } = bundle['x-adcp-extension'];
    assert.equal(docs.spec.path, 'spec.md');
    assert.equal(docs.spec.sha256, sha256Of(readFileSync(path.join(dir, 'spec.md'))));
    assert.ok(docs.conformance.length >= 1, `${dir}: no storyboards`);
    for (const c of docs.conformance) assert.equal(c.sha256, sha256Of(readFileSync(path.join(dir, c.path))), c.path);
    assert.deepEqual(docs.reference_code, { path: 'index.mjs', sha256: sha256Of(readFileSync(path.join(dir, 'index.mjs'))) });
  }
});

test('reference code is pinned: the loader enables a module only if index.mjs hashes to docs.reference_code, and fails closed otherwise', async () => {
  // Editing the code is a new digest, like editing the prose.
  const dir = scratchPackage('ext-makegood-units');
  try {
    const before = buildBundle(dir);
    writeFileSync(path.join(dir, 'index.mjs'), readFileSync(path.join(dir, 'index.mjs'), 'utf8') + '\n// reviewed\n');
    const after = buildBundle(dir);
    assert.notEqual(after.digest, before.digest);
    assert.deepEqual(after.bundle.definitions, before.bundle.definitions, 'the schema did not change');
    assert.equal(after.docs.at(-1).path, 'index.mjs', 'the registry publishes the code next to the spec');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // An installed package whose index.mjs differs from the pinned bytes: refused before the code runs.
  const tampered = mkdtempSync(path.join(ROOT, '.tmp-code-'));
  try {
    cpSync(PKG('ext-makegood-units'), tampered, { recursive: true });
    assert.equal((await loadModule(tampered)).understanding, 'reference-code');
    const code = readFileSync(path.join(tampered, 'index.mjs'), 'utf8');
    writeFileSync(path.join(tampered, 'index.mjs'), code.replace("errors.push('rule_id values must be unique')", "void 0"));
    await assert.rejects(loadModule(tampered), (e) => e.code === 'EXTENSION_CODE_MISMATCH' && /index\.mjs hashes to sha256:\w+, the extension digest pins sha256:/.test(e.message));
    // The client loader is the same gate: the app cannot enable the module.
    const lock = readJson(path.join(tampered, 'extension.lock.json'));
    const ns = { EXTENSION_URI: lock.uri, EXTENSION_DIGEST: lock.digest, EXTENSION_MODULE_DIR: new URL(`file://${tampered}/`) };
    await assert.rejects(createAdcpClient({ transport: { call: async () => ({}), subscribe: () => () => {} }, extensions: [ns] }), (e) => e.code === 'EXTENSION_CODE_MISMATCH');

    // A schema-only module must carry exactly the SDK stub; any other code is refused.
    writeFileSync(path.join(tampered, 'extension.lock.json'), JSON.stringify({ ...lock, code: 'schema-only' }));
    await assert.rejects(loadModule(tampered), (e) => e.code === 'EXTENSION_CODE_MISMATCH' && /schema-only module must carry the SDK stub/.test(e.message));
    writeFileSync(path.join(tampered, 'index.mjs'), SCHEMA_ONLY_CHECK);
    assert.equal((await loadModule(tampered)).understanding, 'schema-only');

    // A bundle that pins no code (published before docs.reference_code) cannot run package code.
    const bundle = readJson(path.join(tampered, 'dist/bundle.json'));
    delete bundle['x-adcp-extension'].docs.reference_code;
    const bytes = Buffer.from(jcs(bundle));
    writeFileSync(path.join(tampered, 'dist/bundle.json'), bytes);
    writeFileSync(path.join(tampered, 'extension.lock.json'), JSON.stringify({ ...lock, digest: sha256Digest(bytes) }));
    writeFileSync(path.join(tampered, 'index.mjs'), code);
    await assert.rejects(loadModule(tampered), (e) => e.code === 'EXTENSION_CODE_UNPINNED');
  } finally {
    rmSync(tampered, { recursive: true, force: true });
  }
});

test('editing spec.md changes the digest, and the registry refuses the same version with changed bytes', () => {
  const dir = scratchPackage('ext-makegood-units');
  const registry = mkdtempSync(path.join(tmpdir(), 'adcp-registry-'));
  try {
    const before = buildBundle(dir);
    publish(before, registry);
    writeRegistryIndex(before.manifest.id, registry);

    // One sentence of prose, nothing else: a new digest.
    writeFileSync(path.join(dir, 'spec.md'), readFileSync(path.join(dir, 'spec.md'), 'utf8') + '\nThis extension has no further rules.\n');
    const after = buildBundle(dir);
    assert.equal(after.manifest.version, before.manifest.version);
    assert.notEqual(after.digest, before.digest);
    assert.notEqual(after.bundle['x-adcp-extension'].docs.spec.sha256, before.bundle['x-adcp-extension'].docs.spec.sha256);
    assert.deepEqual(after.bundle.definitions, before.bundle.definitions, 'the schema did not change');

    // Same version, different bytes: refused. A version bump is accepted.
    publish(after, registry);
    const v = before.manifest.version;
    assert.throws(() => writeRegistryIndex(after.manifest.id, registry), new RegExp(`version ${escapeRegExp(v)} already published`));
    rmSync(registryDocsDir(after.manifest.id, after.digest, registry), { recursive: true });
    rmSync(registryDocsDir(after.manifest.id, after.digest, registry) + '.json');
    const manifest = readJson(path.join(dir, 'extension.json'));
    const patch = v.replace(/\d+$/, (n) => String(Number(n) + 1));
    writeFileSync(path.join(dir, 'extension.json'), JSON.stringify({ ...manifest, version: patch }));
    const bumped = buildBundle(dir);
    publish(bumped, registry);
    assert.deepEqual(Object.keys(writeRegistryIndex(bumped.manifest.id, registry)), [v, patch]);

    // Editing a storyboard moves the digest too.
    const sb = path.join(dir, 'conformance/01-negotiation.yaml');
    writeFileSync(sb, readFileSync(sb, 'utf8').replace('Seller projection', 'Projection by the seller'));
    assert.notEqual(buildBundle(dir).digest, bumped.digest);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(registry, { recursive: true, force: true });
  }
});

test('the registry keeps the spec, storyboards, and reference code next to the bundle, keyed by the same digest', () => {
  for (const dir of extensionPackages()) {
    const lock = readJson(path.join(dir, 'extension.lock.json'));
    const docsDir = registryDocsDir(lock.uri, lock.digest);
    const { docs } = readJson(registryDocsDir(lock.uri, lock.digest) + '.json')['x-adcp-extension'];
    for (const d of [docs.spec, ...docs.conformance, docs.reference_code]) {
      assert.ok(existsSync(path.join(docsDir, d.path)), `${lock.uri}@${lock.digest}: ${d.path}`);
      assert.equal(sha256Of(readFileSync(path.join(docsDir, d.path))), d.sha256);
    }
  }
});

test('spec lint: every MUST has a rule id, every declarative constraint is cited, every cited id exists', () => {
  const cases = [
    ['spec.md', (s) => s.replace('## Overview', '## Overview\n\nA seller MUST be polite.'), /"MUST" outside a rule/],
    ['spec.md', (s) => s.replace('Enforced by: check(); x-adcp-validation `makegood_rule_bounds.window`.', 'Enforced by: check().'), /x-adcp-validation makegood_rule_bounds.window is not cited by any rule/],
    ['spec.md', (s) => s.replace('`makegood_within_rule.trigger`', '`makegood_within_rule.reason`'), /cites x-adcp-validation makegood_within_rule.reason, which the schema does not declare/],
    ['conformance/04-readback.yaml', (s) => s.replace('covers: [MG-R13]', 'covers: [MG-R99]'), /cites MG-R99, which makegood-units\/spec.md does not define/],
    ['spec.md', (s) => s.replace(/#### MG-R6[\s\S]*?(?=#### MG-R7)/, ''), /cites MG-R6, which makegood-units\/spec.md does not define/],
  ];
  for (const [file, edit, error] of cases) {
    const dir = scratchPackage('ext-makegood-units');
    try {
      writeFileSync(path.join(dir, file), edit(readFileSync(path.join(dir, file), 'utf8')));
      assert.throws(() => buildBundle(dir), error);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const spec = parseSpec(readFileSync(PKG('ext-makegood-units/spec.md'), 'utf8'));
  assert.deepEqual(spec.rules.filter((r) => r.conformanceOnly).map((r) => r.id), ['MG-R2', 'MG-R14', 'MG-R15', 'MG-R19', 'MG-R20', 'MG-R21']);
});

test('the storyboard runner fails a step whose expectation does not hold, and skips the rest of that storyboard', async () => {
  const idx = await extensionIndex();
  const [suite] = await loadSuites({ only: 'makegood-units' });
  const sb = structuredClone(suite.storyboards.find((s) => s.doc.id === 'makegood_units/binding_rules'));
  // Claim the buyer ignores an unknown entry in signed terms: the runner must catch it.
  const grease = sb.doc.phases.flatMap((p) => p.steps).find((s) => s.id === 'grease_reject');
  grease.expect.status[0].status = 'ignored';
  const result = await runStoryboard(sb, idx);
  assert.equal(result.ok, false);
  const failed = result.steps.find((s) => s.status === 'failed');
  assert.equal(failed.id, 'grease_reject');
  assert.match(failed.failures[0], /grease at commercial_terms is rejected, expected ignored/);
  assert.deepEqual(result.steps.filter((s) => s.status === 'skipped').map((s) => s.id), ['accept']);
});

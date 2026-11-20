// A module minor release, run for real on a scratch copy (scripts/module-release.mjs): buying/pricing
// 1.0 -> 1.1 adds one optional property. Only that layer's version and digest move; the kernel, every
// other layer, and every extension digest stay identical; an app that pins only the kernel layer and
// governance keeps a byte-identical lock and generated layer. The same field made required is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { additiveDiff } from '../lib/additive.mjs';
import { runRelease } from '../scripts/module-release.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = path.join(ROOT, 'core/releases/buying-pricing-1.1.json');
const shipped = JSON.parse(readFileSync(path.join(ROOT, 'core/release.json'), 'utf8'));

test('a buying/pricing minor moves buying/pricing alone: one digest and one version', () => {
  const r = runRelease(SPEC);
  assert.equal(r.released, true, r.log.join('\n'));
  assert.deepEqual(r.moved, ['buying/pricing'], 'the build with the old stamps reports LAYER MOVED for this layer only');
  assert.deepEqual(r.changed, ['buying/pricing']);
  assert.equal(r.before.layers['buying/pricing'].version, '1.0');
  assert.equal(r.after.layers['buying/pricing'].version, '1.1');
  assert.notEqual(r.after.layers['buying/pricing'].digest, r.before.layers['buying/pricing'].digest);
  for (const l of Object.keys(r.before.layers).filter((x) => x !== 'buying/pricing')) assert.deepEqual(r.after.layers[l], r.before.layers[l], l);
  assert.equal(r.after.layers.core.digest, shipped.layers.core.digest, 'the kernel');
  assert.equal(r.after.layers.governance.digest, shipped.layers.governance.digest);
  assert.notEqual(r.after.bundle_digest, r.before.bundle_digest, 'the bundle digest hashes every layer');
  // Extensions: the same digests, still compatible (hook majors unchanged).
  assert.equal(r.extensions.length, 5);
  assert.ok(r.extensions.every((e) => e.same && e.compatible), JSON.stringify(r.extensions));
  // Apps: the governance-only app pins the kernel layer and governance, so nothing changes for it.
  assert.deepEqual(r.apps['test/apps/governance-only'].changed, []);
  assert.deepEqual(r.apps['test/apps/governance-only'].pins, ['core', 'kernel-types', 'governance']);
  assert.deepEqual(r.apps['examples/buyer-app'].changed, ['adcp-sdk/GENERATED.json', 'adcp-sdk/bindings.ts', 'adcp.lock.json'], 'an app that pins the whole bundle sees it move');
  // A seller at the new minor is compatible with an app built for the old one.
  assert.equal(r.checks['examples/buyer-app'].ok, true);
  assert.equal(r.checks['examples/buyer-app'].entries.find((e) => e.name === 'buying/pricing').status, 'seller-newer');
  assert.equal(r.additive.additive, true);
});

test('the additive check refuses the same field made required, the core build refuses its re-stamp, and nothing is re-stamped', () => {
  const r = runRelease(SPEC, { refused: true });
  assert.equal(r.released, false);
  assert.equal(r.additive.additive, false);
  assert.deepEqual(r.additive.changes.filter((c) => !c.additive).map((c) => c.change), ['property base_spot_length_seconds added as required', 'base_spot_length_seconds became required']);
  assert.equal(r.gateRefused, true, 'the core build refuses the re-stamp on its own (build-core.mjs --freeze)');
  assert.ok(r.log.some((l) => l.includes('NOT ADDITIVE: buying/pricing 1.0 -> 1.1: pricing-options/cpp-option.json#/required: base_spot_length_seconds became required')), r.log.join('\n'));
  assert.ok(r.log.some((l) => l.includes('nothing re-stamped')));
});

test('additive check: what counts as additive', () => {
  const base = { type: 'object', properties: { a: { type: 'string', maxLength: 10 } }, required: ['a'], additionalProperties: false };
  const ok = (after) => additiveDiff(base, after).additive;
  assert.equal(ok({ ...base, properties: { ...base.properties, b: { type: 'integer' } } }), true, 'new optional property');
  assert.equal(additiveDiff(base, { ...base, properties: { ...base.properties, b: { type: 'integer' } } }).changes[0].note, 'the object is closed: a sender omits it for a reader on the previous minor');
  assert.equal(ok({ ...base, description: 'now described' }), true, 'annotation');
  assert.equal(ok({ ...base, properties: {} }), false, 'removed property');
  assert.equal(ok({ ...base, properties: { a: { type: 'string', maxLength: 5 } } }), false, 'narrowed bound');
  assert.equal(ok({ ...base, properties: { a: { type: 'integer', maxLength: 10 } } }), false, 'changed type');
  assert.equal(ok({ ...base, properties: { a: { type: 'string', maxLength: 10, pattern: '^x' } } }), false, 'new validation keyword');
  assert.equal(ok({ ...base, properties: { a: { type: 'string', maxLength: 10, enum: ['x'] } } }), false, 'new enum');
  assert.equal(ok({ ...base, required: [] }), false, 'a reader on the previous minor still requires it');
});

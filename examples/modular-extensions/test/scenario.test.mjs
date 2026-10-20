// The creator scenario: proposal-based buy, seller slips a video and issues a
// make-good, all through extensions on a frozen core. Plus: core release
// compatibility, SDK assembly from adcp.config.json, per-buyer projection.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCompat, satisfies } from '../lib/compat.mjs';
import { createAdcpClient } from '../lib/client.mjs';
import { createCreatorNetworkSeller } from '../lib/mock-seller.mjs';
import { coreBundleDigest, layerDigests } from '../scripts/build-core.mjs';
import { buildSdk, coreReleases, resolveExtension } from '../scripts/adcp-sdk.mjs';
import { writeRegistryIndex } from '../scripts/build-extensions.mjs';
import { jcs, sha256Digest } from '../lib/digest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(path.join(ROOT, p), 'utf8'));
const SAT = 'https://extensions.adcontextprotocol.org/seller-adjustable-terms';
const MG = 'https://extensions.adcontextprotocol.org/makegood-units';

const tempApps = [];
after(() => tempApps.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A throwaway buyer app with its own adcp.config.json, built into an SDK. */
async function app(extensions) {
  const dir = mkdtempSync(path.join(tmpdir(), 'adcp-app-'));
  tempApps.push(dir);
  writeFileSync(path.join(dir, 'adcp.config.json'), JSON.stringify({ core: '3.3.0', extensions }));
  const result = await buildSdk(dir);
  return { dir, result, lockfile: path.join(dir, 'adcp.lock.json') };
}

let requests = 0;
/** request_proposals (canonical draft) -> refine_proposals finalize -> accept_proposal. */
async function buyFlow(client) {
  const { proposals } = await client.requestProposals({ idempotency_key: `request-${String(++requests).padStart(4, '0')}-aaaaaaaaa`, brief: 'two creator videos', brand: { domain: 'brand.example.com' } });
  const { proposals: [committed] } = await client.refineProposals({
    idempotency_key: 'finalize-0001-aaaaaaaa',
    refinements: [{ proposal_id: proposals[0].proposal_id, action: 'finalize' }],
  });
  const { media_buy_id } = await client.acceptProposal({ proposal: committed, idempotency_key: 'accept-0001-aaaaaaaaaa', account: { account_id: 'acc' } });
  return { draft: proposals[0], committed, media_buy_id };
}

test('core did not move: kernel and module digests still match the 3.3.0 freeze; no extension or its docs moved a layer', () => {
  const release = read('core/release.json');
  assert.equal(coreBundleDigest(), release.bundle_digest);
  assert.deepEqual(layerDigests(), Object.fromEntries(Object.entries(release.layers).map(([l, e]) => [l, e.digest])));
  // Re-stamped when the layers moved to the ten-module cut, when the kernel and buying schemas took the
  // standard terms, when the kernel renamed its container and gained the task union, and again when the
  // layers moved to the final layout: buying split into its eight layers, each with its own digest. The
  // layout's 3.4 fixes (kernel types with registry composition, bridge points) changed schemas but no payload.
  // The optional modules map in the kernel's capabilities fragment moved only _assembly and the bundle.
  assert.equal(release.layers.core.digest, 'sha256:3f8ca048231af59939df8178562f25dc5463be856d5fbccc6a2c92334403ac8a');
  assert.equal(release.layers['kernel-types'].digest, 'sha256:e50cd6e3609ffa2c814b2c5304590a37e04d94508b554f0aed0b8a3153fe4502');
  assert.equal(release.layers['buying/pricing'].digest, 'sha256:9867a778b956825030e8ffbb8682bbf3d6867abe45eb66ef938b3ea1e89a087f');
  assert.equal(release.layers['buying/commitment'].digest, 'sha256:4910acbb2ae8d78dcb00406f2014f1d594984f3d4231c10ae70e9842b328f699');
  assert.equal(release.layers['buying/execution'].digest, 'sha256:1bb0acbd1b86c8bfcc3ec6c990d71b285e489516bfb6a82e35daa955003823ae');
  assert.equal(release.bundle_digest, 'sha256:26d4e59152abc1d76cd451eef8f902347f780f00e057f03613ffbf5eb25550a8');
});

test('version ranges: npm-style comparators, AND by space, OR by ||', () => {
  assert.equal(satisfies('3.4.0', '>=3.3 <5'), true);
  assert.equal(satisfies('5.0.0', '>=3.3 <5'), false);
  assert.equal(satisfies('1.1.0', '^1'), true);
  assert.equal(satisfies('2.0.0', '^1'), false);
  assert.equal(satisfies('4.2.0', '>=3.3 <4 || ^4.2'), true);
});

test('one extension digest runs on several core releases; a release that changes what it uses is refused with the reason', () => {
  const matrix = {};
  for (const name of ['seller-adjustable-terms', 'makegood-units', 'rate-card-index', 'linear-tv-indexed-cpp']) {
    const meta = read(`packages/ext-${name}/dist/bundle.json`)['x-adcp-extension'];
    matrix[name] = Object.fromEntries(coreReleases().map((r) => [r.adcp_version, checkCompat(meta, r).ok]));
  }
  const daypart = read('packages/acmetv-ext-daypart-codes/dist/bundle.json')['x-adcp-extension'];
  matrix['daypart-codes'] = Object.fromEntries(coreReleases().map((r) => [r.adcp_version, checkCompat(daypart, r).ok]));
  assert.deepEqual(matrix, {
    'seller-adjustable-terms': { '3.3.0': true, '3.4.0': true, '4.0.0': false },
    'makegood-units': { '3.3.0': true, '3.4.0': true, '4.0.0': false },
    'rate-card-index': { '3.3.0': true, '3.4.0': true, '4.0.0': true },
    'linear-tv-indexed-cpp': { '3.3.0': true, '3.4.0': true, '4.0.0': false },
    'daypart-codes': { '3.3.0': true, '3.4.0': true, '4.0.0': true },
  });
  const four = coreReleases().find((r) => r.adcp_version === '4.0.0');
  const why = checkCompat(read('packages/ext-makegood-units/dist/bundle.json')['x-adcp-extension'], four).reasons;
  assert.deepEqual(why, [
    'extension point media_buy_state is v2 in core 4.0.0; extension needs v1',
    'core type /schemas/core/duration.json is v2 in core 4.0.0; extension was built against v1',
  ]);
  // The author's range is a ceiling even when the contracts match.
  const five = { ...four, adcp_version: '5.0.0', points: { ...four.points } };
  const rc = read('packages/ext-rate-card-index/dist/bundle.json')['x-adcp-extension'];
  assert.match(checkCompat(rc, five).reasons[0], /outside the extension's declared range >=3.3 <5/);
  assert.equal(checkCompat(daypart, five).ok, true, 'daypart-codes declares >=3.3 with no ceiling');
});

test('requires.core_types is computed by the build and covered by the digest', () => {
  const bundle = read('packages/ext-makegood-units/dist/bundle.json');
  assert.deepEqual(bundle['x-adcp-extension'].requires.core_types, { '/schemas/core/context.json': 1, '/schemas/core/duration.json': 1, '/schemas/enums/task-status.json': 1 });
  assert.equal(sha256Digest(Buffer.from(jcs(bundle))), read('packages/ext-makegood-units/extension.lock.json').digest);
});

test('SDK assembly: ranges resolve to the highest compatible version; exact pins and digests work; unknown fails', () => {
  const core = coreReleases()[0];
  // ^1 picks the highest published 1.x: the version that added the spec and storyboards.
  assert.equal(resolveExtension(`${SAT}@^1`, core).version, read('packages/ext-seller-adjustable-terms/extension.lock.json').version);
  assert.equal(resolveExtension(`${SAT}@1.1.0`, core).version, '1.1.0');
  assert.equal(resolveExtension(`${SAT}@1.0.0`, core).version, '1.0.0');
  const v100 = read('registry/extensions.adcontextprotocol.org/seller-adjustable-terms/index.json').versions['1.0.0'].digest;
  assert.equal(resolveExtension(`${SAT}@${v100}`, core).version, '1.0.0');
  assert.equal(resolveExtension('https://extensions.adcontextprotocol.org/nope@^1', core).ok, false);
});

test('a published version is immutable: the same version with different bytes is refused', () => {
  const uri = 'https://ext.test.example.com/adcp/immutable';
  const dir = path.join(ROOT, 'registry/ext.test.example.com');
  try {
    for (const description of ['first', 'second']) {
      const bundle = { $id: uri, 'x-adcp-extension': { name: 'immutable', version: '1.0.0', description, requires: {} } };
      const bytes = Buffer.from(jcs(bundle));
      const file = path.join(dir, 'adcp/immutable', `${sha256Digest(bytes).slice(7)}.json`);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, bytes);
    }
    assert.throws(() => writeRegistryIndex(uri), /version 1.0.0 already published/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('creator scenario: slip inside the allowance and a make-good are understood and verified; a slip past it is a violation', async () => {
  const { lockfile } = await app({ sat: `${SAT}@^1`, mg: `${MG}@^1` });
  const seller = createCreatorNetworkSeller();
  const violations = [];
  const client = await createAdcpClient({ transport: seller.transport, lockfile, onViolation: (v) => violations.push(v.message) });
  const { draft, committed, media_buy_id } = await buyFlow(client);
  assert.deepEqual(draft.commercial_terms.extensions.map((t) => t.uri), [MG, SAT]);
  assert.equal(committed.hold_policy.available, true);

  seller.ops.creatorUnavailable(media_buy_id, 0, 5);
  seller.ops.deliverableMissed(media_buy_id, 1);
  let { media_buys: [mb] } = await client.getMediaBuys({ media_buy_ids: [media_buy_id] });
  assert.equal(mb.revision, 3);
  assert.deepEqual(client.lastReport.extensions.filter((e) => e.point === 'media_buy_state').map((e) => [e.uri, e.status]), [[MG, 'understood'], [SAT, 'understood']]);
  assert.deepEqual(violations, []);
  assert.equal(mb.packages.find((p) => p.package_id === 'pkg_makegood_2').budget, 0);

  seller.ops.rogueShift(media_buy_id, 0, 4);
  await client.getMediaBuys({ media_buy_ids: [media_buy_id] });
  assert.equal(violations.length, 2);
  assert.match(violations[0], /moved 9 days from the accepted value; allowance max is 7 days/);
});

test('the seller projects per buyer: core-only buyers get the plain buy; a 1.0.0 buyer gets 1.0.0 terms and no make-good right', async () => {
  const seller = createCreatorNetworkSeller();
  const plain = await app({});
  const c0 = await createAdcpClient({ transport: seller.transport, lockfile: plain.lockfile });
  const { draft: d0 } = await buyFlow(c0);
  assert.equal(d0.commercial_terms.extensions, undefined);

  const old = await app({ sat: `${SAT}@1.0.0` });
  assert.equal(JSON.parse(readFileSync(old.lockfile, 'utf8')).extensions.sat.source, 'registry (schema-only)');
  const c1 = await createAdcpClient({ transport: seller.transport, lockfile: old.lockfile });
  const { draft: d1, media_buy_id } = await buyFlow(c1);
  assert.deepEqual(d1.commercial_terms.extensions.map((t) => [t.uri, t.digest]), [[SAT, seller.supported[0].digest]]);
  assert.throws(() => seller.ops.deliverableMissed(media_buy_id, 1), /did not accept make-good units; make an offer instead/);
});

test('fail closed: a buyer without makegood-units cannot accept terms that carry it', async () => {
  const seller = createCreatorNetworkSeller();
  const { lockfile } = await app({ sat: `${SAT}@^1` });
  const client = await createAdcpClient({ transport: seller.transport, lockfile });
  // A seller that ignores understood_extensions and sends the make-good rule anyway:
  const everything = seller.supported.slice(1).map(({ uri, digest }) => ({ uri, digest }));
  const { proposals: [p] } = await seller.transport.call('request_proposals', { idempotency_key: 'request-rogue-aaaaaaaa', brief: 'x', brand: { domain: 'brand.example.com' }, understood_extensions: everything });
  await assert.rejects(client.acceptProposal({ proposal: p, idempotency_key: 'accept-0002-aaaaaaaaaa', account: { account_id: 'acc' } }), (e) => e.code === 'EXTENSION_NOT_UNDERSTOOD');
});

test('readback must use the digest of the accepted entry: a different digest for the same uri fails closed', async () => {
  const { lockfile } = await app({ sat: `${SAT}@^1`, mg: `${MG}@^1` });
  const seller = createCreatorNetworkSeller();
  const client = await createAdcpClient({ transport: seller.transport, lockfile });
  const { media_buy_id } = await buyFlow(client);
  seller.ops.creatorUnavailable(media_buy_id, 0, 2);
  const res = await seller.transport.call('get_media_buys', { media_buy_ids: [media_buy_id] });
  res.media_buys[0].extensions_state.find((s) => s.uri === SAT).digest = seller.supported[0].digest;
  assert.throws(() => client.check('/schemas/media-buy/get-media-buys-response.json', res, 'get_media_buys'), (e) => e.code === 'EXTENSION_DIGEST_DIVERGENT');
});

test('the lock pins core: a lock built for another core bundle is refused', async () => {
  const { dir, lockfile } = await app({ mg: `${MG}@^1` });
  const lock = JSON.parse(readFileSync(lockfile, 'utf8'));
  lock.core.bundle_digest = 'sha256:' + '0'.repeat(64);
  writeFileSync(path.join(dir, 'other.lock.json'), JSON.stringify(lock));
  await assert.rejects(createAdcpClient({ transport: createCreatorNetworkSeller().transport, lockfile: path.join(dir, 'other.lock.json') }), (e) => e.code === 'CORE_MISMATCH');
});

test('runtime binding (runtime plug-ins): a module enabled at run time needs no regenerate, and the core package stays untouched', async () => {
  const coreTypesBefore = readFileSync(path.join(ROOT, 'packages/core/src/index.ts'));
  // The generated type module carries the module dir; the client loads and digest-checks it.
  const ns = (dir) => {
    const lock = read(`packages/${dir}/extension.lock.json`);
    return { EXTENSION_URI: lock.uri, EXTENSION_DIGEST: lock.digest, EXTENSION_MODULE_DIR: new URL(`../packages/${dir}/`, import.meta.url) };
  };
  const seller = createCreatorNetworkSeller();
  const only = await createAdcpClient({ transport: seller.transport, extensions: [ns('ext-seller-adjustable-terms')] });
  const both = await createAdcpClient({ transport: seller.transport, extensions: [ns('ext-seller-adjustable-terms'), ns('ext-makegood-units')] });
  const req = { idempotency_key: 'request-enable-aaaaaaa', brief: 'x', brand: { domain: 'brand.example.com' } };
  const a = await only.requestProposals(req);
  const b = await both.requestProposals({ ...req, idempotency_key: 'request-enable-bbbbbbb' });
  assert.deepEqual(a.proposals[0].commercial_terms.extensions.map((t) => t.uri), [SAT]);
  assert.deepEqual(b.proposals[0].commercial_terms.extensions.map((t) => t.uri), [MG, SAT]);
  assert.deepEqual(readFileSync(path.join(ROOT, 'packages/core/src/index.ts')), coreTypesBefore);
  const wrong = { ...ns('ext-makegood-units'), EXTENSION_DIGEST: 'sha256:' + '1'.repeat(64) };
  await assert.rejects(createAdcpClient({ transport: seller.transport, extensions: [wrong] }), (e) => e.code === 'MODULE_MISMATCH');
});

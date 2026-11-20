// The modules map: one optional `modules` entry per standard module and buying layer in
// get_adcp_capabilities (the kernel's capabilities fragment, core/patches.json layer `_assembly`), what
// the mock sellers emit, and the buyer client's check of it against the app's lock (lib/modules.mjs).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { coreUri, loadCoreSchemas } from '../lib/core-schemas.mjs';
import { createAdcpClient } from '../lib/client.mjs';
import { CREATOR_NETWORK_MODULES, createCreatorNetworkSeller } from '../lib/mock-seller.mjs';
import { TV_SELLER_MODULES, createTvSeller } from '../lib/mock-tv-seller.mjs';
import { checkModules, expectedModules, modulePins, modulesMap, taskModules } from '../lib/modules.mjs';
import { buildSdk } from '../scripts/adcp-sdk.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(path.join(ROOT, p), 'utf8'));
const release = read('core/release.json');
const CAPS = '/schemas/protocol/get-adcp-capabilities-response.json';

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
for (const { id, schema } of loadCoreSchemas()) ajv.addSchema({ ...schema, $id: coreUri(id) });
const validCaps = (caps) => ajv.validate(coreUri(CAPS), caps);

const temp = [];
after(() => temp.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A transport that rewrites the seller's capabilities on the way to the buyer. */
const rewriting = (seller, edit) => ({
  ...seller.transport,
  call: async (task, req) => {
    const res = await seller.transport.call(task, req);
    if (task === 'get_adcp_capabilities') edit(res);
    return res;
  },
});

test('modules map: the kernel capabilities fragment declares it, optional and additive; no kernel layer moved', () => {
  const assembly = read('core/patches.json').layers.find((l) => l.layer === '_assembly');
  assert.ok(assembly.patches.some((p) => p.op === 'add' && p.pointer === '/properties/modules'), 'an additive op in the kernel fragment');
  const caps = { status: 'completed', adcp: { major_versions: [3], idempotency: { supported: true, replay_ttl_seconds: 86400 } }, supported_protocols: ['media_buy'] };
  assert.equal(validCaps(caps), true, 'a 3.3 seller without the map still validates');
  const digest = release.layers['buying/pricing'].digest;
  assert.equal(validCaps({ ...caps, modules: { 'buying/pricing': { version: '1.0', digest }, governance: { version: '1.0', digest } } }), true);
  for (const bad of [
    { 'buying/pricing': { version: '1', digest } },
    { 'buying/pricing': { version: '1.0' } },
    { 'buying/pricing': { version: '1.0', digest, notes: 'x' } },
    { 'Buying/Pricing': { version: '1.0', digest } },
    { 'buying/pricing': { version: '1.0', digest: 'sha256:abc' } },
  ]) assert.equal(validCaps({ ...caps, modules: bad }), false, JSON.stringify(bad));
  // The kernel's own schemas didn't move: the map lives in the generated capabilities assembly.
  assert.equal(release.layers.core.digest, 'sha256:3f8ca048231af59939df8178562f25dc5463be856d5fbccc6a2c92334403ac8a');
});

test('the mock sellers list the buying layers they implement, with the release versions and digests', async () => {
  for (const [seller, names] of [[createCreatorNetworkSeller(), CREATOR_NETWORK_MODULES], [createTvSeller(), TV_SELLER_MODULES]]) {
    const caps = await seller.transport.call('get_adcp_capabilities', {});
    assert.equal(validCaps(caps), true);
    assert.deepEqual(Object.keys(caps.modules), [...names].sort());
    for (const [name, m] of Object.entries(caps.modules)) assert.deepEqual(m, { version: release.layers[name].version, digest: release.layers[name].digest });
    assert.ok(caps.modules['buying/offer'] && !caps.modules['buying/catalogs'], 'negotiates proposals, sells from no catalog');
  }
});

test('the client checks the seller modules against a lock that pins the whole bundle', async () => {
  const seller = createCreatorNetworkSeller();
  const client = await createAdcpClient({ transport: seller.transport, lockfile: path.join(ROOT, 'examples/buyer-app/adcp.lock.json') });
  const caps = await client.capabilities();
  assert.equal(caps.moduleCheck.ok, true);
  const by = Object.fromEntries(caps.moduleCheck.entries.map((e) => [e.name, e.status]));
  for (const name of CREATOR_NETWORK_MODULES) assert.equal(by[name], 'same', name);
  assert.equal(by['buying/catalogs'], 'not-offered');
  assert.equal(by.governance, 'not-offered');
  const { proposals } = await client.requestProposals({ idempotency_key: 'modules-request-0001', brief: 'two creator videos', brand: { domain: 'brand.example.com' } });
  assert.ok(proposals.length > 0);
});

test('a governance-only app pins the kernel layer and governance; buying entries are not its concern', async () => {
  const lock = read('test/apps/governance-only/adcp.lock.json');
  assert.deepEqual(Object.keys(lock.core.modules), ['core', 'kernel-types', 'governance']);
  assert.equal(lock.core.bundle_digest, undefined, 'no whole-bundle pin');
  assert.deepEqual(lock.core.modules, modulePins(['governance']));
  assert.deepEqual(Object.keys(expectedModules(lock)), ['governance']);
  const check = checkModules(modulesMap(CREATOR_NETWORK_MODULES), expectedModules(lock));
  assert.equal(check.ok, true);
  assert.deepEqual(check.entries.find((e) => e.name === 'governance'), { name: 'governance', app: '1.0', seller: null, status: 'not-offered' });
  assert.ok(check.entries.filter((e) => e.name.startsWith('buying/')).every((e) => e.status === 'not-used'));
  // The client verifies each pinned layer against the installed core, not the bundle digest.
  const client = await createAdcpClient({ transport: createCreatorNetworkSeller().transport, lockfile: path.join(ROOT, 'test/apps/governance-only/adcp.lock.json') });
  assert.equal((await client.capabilities()).moduleCheck.ok, true);
  const dir = mkdtempSync(path.join(tmpdir(), 'adcp-gov-'));
  temp.push(dir);
  writeFileSync(path.join(dir, 'adcp.lock.json'), JSON.stringify({ ...lock, core: { ...lock.core, modules: { ...lock.core.modules, governance: { version: '1.0', digest: `sha256:${'0'.repeat(64)}` } } } }));
  await assert.rejects(createAdcpClient({ transport: createCreatorNetworkSeller().transport, lockfile: path.join(dir, 'adcp.lock.json') }), (e) => e.code === 'CORE_MISMATCH' && /governance/.test(e.message));
});

test('another minor is compatible; another major or another digest at the same version fails', async () => {
  const app = expectedModules(null);
  const pricing = app['buying/pricing'];
  const newer = checkModules({ ...modulesMap(CREATOR_NETWORK_MODULES), 'buying/pricing': { version: '1.1', digest: `sha256:${'1'.repeat(64)}` } }, app);
  assert.equal(newer.ok, true);
  assert.equal(newer.entries.find((e) => e.name === 'buying/pricing').status, 'seller-newer');
  const older = checkModules({ 'buying/pricing': pricing }, { 'buying/pricing': { version: '1.1', digest: `sha256:${'1'.repeat(64)}` } });
  assert.equal(older.entries[0].status, 'seller-older');
  assert.equal(older.ok, true);

  for (const [edit, code] of [
    [(m) => (m['buying/offer'] = { version: '1.0', digest: m['buying/offer'].digest }), 'MODULE_MAJOR_MISMATCH'], // offer is 0.1 in this release
    [(m) => (m['buying/offer'].digest = `sha256:${'2'.repeat(64)}`), 'MODULE_DIGEST_MISMATCH'],
  ]) {
    const client = await createAdcpClient({ transport: rewriting(createCreatorNetworkSeller(), (caps) => edit(caps.modules)), lockfile: path.join(ROOT, 'examples/buyer-app/adcp.lock.json') });
    const caps = await client.capabilities();
    assert.equal(caps.moduleCheck.ok, false);
    assert.equal(caps.moduleCheck.errors[0].code, code);
    await assert.rejects(client.requestProposals({ idempotency_key: 'modules-request-0002', brief: 'x', brand: { domain: 'brand.example.com' } }), (e) => e.code === code);
  }
});

test('a seller that lists no buying/offer: request_proposals is refused before the call; get_products works; a 3.3 seller is not checked', async () => {
  const noOffer = createTvSeller({ modules: TV_SELLER_MODULES.filter((m) => m !== 'buying/offer') });
  const client = await createAdcpClient({ transport: noOffer.transport, extensions: [] });
  await client.capabilities();
  const { products } = await client.getProducts({ buying_mode: 'brief', brief: 'Prime time 25-54 in March' });
  assert.ok(products.length > 0);
  let called = false;
  const spy = await createAdcpClient({ transport: { ...noOffer.transport, call: async (t, r) => ((called ||= t === 'request_proposals'), noOffer.transport.call(t, r)) }, extensions: [] });
  await spy.capabilities();
  await assert.rejects(spy.requestProposals({ idempotency_key: 'modules-request-0003', brief: 'x', brand: { domain: 'brand.example.com' } }), (e) => e.code === 'MODULE_NOT_OFFERED');
  assert.equal(called, false, 'refused before the call');

  const legacy = createTvSeller({ modules: null });
  const old = await createAdcpClient({ transport: legacy.transport, extensions: [] });
  const caps = await old.capabilities();
  assert.equal(caps.modules, undefined);
  assert.equal(caps.moduleCheck, null);
});

test('npm run sdk writes module pins only for an app that names its modules', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adcp-app-'));
  temp.push(dir);
  writeFileSync(path.join(dir, 'adcp.config.json'), JSON.stringify({ core: '3.3.0', modules: ['buying'], extensions: {} }));
  const { lock } = await buildSdk(dir);
  assert.deepEqual(Object.keys(lock.core.modules), ['core', 'kernel-types', ...Object.keys(release.layers).filter((l) => l.startsWith('buying/')).sort()]);
  assert.equal(read('examples/buyer-app/adcp.lock.json').core.bundle_digest, release.bundle_digest, 'an app that names no modules pins the bundle');
});

test('each core task needs every buying layer its schemas reach; a pricing mismatch stops request_proposals', async () => {
  const t = taskModules();
  const proposal = ['buying/commitment', 'buying/offer', 'buying/pricing', 'buying/supply', 'buying/targeting'];
  assert.deepEqual(t.request_proposals, proposal);
  assert.deepEqual(t.refine_proposals, proposal);
  assert.deepEqual(t.accept_proposal, proposal);
  assert.deepEqual(t.get_products, ['buying/commitment', 'buying/pricing', 'buying/supply', 'buying/targeting'], 'catalogs is opt-in: a seller that sells from no catalog still lists products');
  assert.deepEqual(t.get_media_buys, ['buying/commitment', 'buying/execution', 'buying/pricing', 'buying/supply', 'buying/targeting']);
  for (const [layer, edit, code] of [
    ['buying/pricing', (m) => (m['buying/pricing'] = { ...m['buying/pricing'], version: '2.0' }), 'MODULE_MAJOR_MISMATCH'],
    ['buying/commitment', (m) => (m['buying/commitment'].digest = `sha256:${'3'.repeat(64)}`), 'MODULE_DIGEST_MISMATCH'],
    ['buying/supply', (m) => delete m['buying/supply'], 'MODULE_NOT_OFFERED'],
  ]) {
    let sent = false;
    const seller = createCreatorNetworkSeller();
    const transport = rewriting({ transport: { ...seller.transport, call: async (task, req) => ((sent ||= task === 'request_proposals'), seller.transport.call(task, req)) } }, (caps) => edit(caps.modules));
    const client = await createAdcpClient({ transport, lockfile: path.join(ROOT, 'examples/buyer-app/adcp.lock.json') });
    await client.capabilities();
    await assert.rejects(client.requestProposals({ idempotency_key: 'modules-request-0004', brief: 'x', brand: { domain: 'brand.example.com' } }), (e) => e.code === code && e.message.includes(layer), layer);
    assert.equal(sent, false, `${layer}: refused before the call`);
  }
});

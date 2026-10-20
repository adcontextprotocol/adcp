// A task an extension contributes: makegood-units adds request_makegood, a new MCP tool / A2A skill.
// The kernel holds only the generic mechanism (the `task` union on its own declaration type); the
// extension package holds the task. These tests show that adding the task moves no kernel or
// module digest, how the seller declares it and the buyer discovers it, and that both sides
// validate it against the extension's definitions. Apps call and serve the task through their
// generated layer (client.requestMakegood, server.handle('request_makegood')); the tests that use
// the SDK client's ext() and callTask() exercise the runtime binding underneath, which a runtime
// plug-in uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBuyerValidator, loadModule } from '../lib/buyer-validator.mjs';
import { checkCompat } from '../lib/compat.mjs';
import { createAdcpClient } from '../lib/client.mjs';
import { loadCoreSchemas } from '../lib/core-schemas.mjs';
import { createCreatorNetworkSeller } from '../lib/mock-seller.mjs';
import { createAdcpServer } from '../lib/server.mjs';
import { coreBundleDigest, layerDigests } from '../scripts/build-core.mjs';
import { buildBundle } from '../scripts/build-extensions.mjs';
import * as makegoodUnits from '../packages/ext-makegood-units/src/index.mjs';
import * as buyerApp from '../examples/buyer-app/adcp-sdk/index.ts';
import * as sellerAdjustableTerms from '../packages/ext-seller-adjustable-terms/src/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(path.join(ROOT, p), 'utf8'));
const TASK = makegoodUnits.tasks.requestMakegood;

/** request_proposals -> finalize -> accept, then the media buy id. */
async function buy(client, n) {
  const { proposals: [draft] } = await client.requestProposals({ idempotency_key: `task-request-${n}-aaaaaaaa`, brief: 'two creator videos', brand: { domain: 'brand.example.com' } });
  const { proposals: [committed] } = await client.refineProposals({ idempotency_key: `task-finalize-${n}-aaaaaaa`, refinements: [{ proposal_id: draft.proposal_id, action: 'finalize' }] });
  return (await client.acceptProposal({ proposal: committed, idempotency_key: `task-accept-${n}-aaaaaaaaa`, account: { account_id: 'acc' } })).media_buy_id;
}
const request = (media_buy_id, extra = {}) => ({ idempotency_key: `task-mg-${Math.random().toString(16).slice(2, 10)}`, media_buy_id, rule_id: 'mg_video_2', package_id: 'pkg_video_2', reason: 'deliverable_missed', ...extra });

test('adding a task moves no kernel or module digest: layer digests before and after enabling makegood-units with request_makegood', async () => {
  const release = read('core/release.json');
  const frozen = Object.fromEntries(Object.entries(release.layers).map(([l, e]) => [l, e.digest]));
  const before = layerDigests();
  const coreTypes = readFileSync(path.join(ROOT, 'packages/core/src/index.ts'));
  assert.deepEqual(before, frozen);

  // The version before the task and the version with it check against the same frozen release.
  const index = read('registry/extensions.adcontextprotocol.org/makegood-units/index.json');
  const pre = read(`registry/extensions.adcontextprotocol.org/makegood-units/${index.versions['1.3.0'].digest.slice(7)}.json`)['x-adcp-extension'];
  const cur = read('packages/ext-makegood-units/dist/bundle.json')['x-adcp-extension'];
  assert.equal(pre.extends.some((e) => e.point === 'task'), false);
  assert.deepEqual(cur.extends.find((e) => e.point === 'task'), { point: 'task', branch: 'request_makegood', definition: 'MakegoodRequest', response: 'MakegoodResponse', semantics: cur.extends.at(-1).semantics });
  assert.equal(checkCompat(pre, release).ok, true);
  assert.equal(checkCompat(cur, release).ok, true);
  // What changed between them is in the extension's own manifest: the task registration and the hook it needs.
  assert.deepEqual(cur.requires.points, { ...pre.requires.points, task: 1 });

  // Enable it on both sides and call the task: the buyer app's generated layer gives its client a typed method.
  const seller = createCreatorNetworkSeller();
  const client = await buyerApp.createClient({ transport: seller.transport });
  const answer = await client.requestMakegood(request(await buy(client, 1)));
  assert.equal(answer.outcome, 'accepted');

  // Every layer, the bundle, and the generated core types are byte for byte what they were.
  assert.deepEqual(layerDigests(), before);
  assert.equal(coreBundleDigest(), release.bundle_digest);
  assert.deepEqual(readFileSync(path.join(ROOT, 'packages/core/src/index.ts')), coreTypes);
  // No core schema names the task or the extension; the kernel knows only the `task` union.
  const coreText = loadCoreSchemas().map((s) => JSON.stringify(s.schema)).join('\n');
  for (const s of ['request_makegood', 'makegood-units', 'MakegoodRequest']) assert.equal(coreText.includes(s), false, s);
  assert.deepEqual(release.layers.core.hooks, { capabilities: 1, task: 1 });
});

test('the seller declares a transport name for the task id; the buyer discovers it in capabilities and calls that name', async () => {
  const seller = createCreatorNetworkSeller();
  const client = await createAdcpClient({ transport: seller.transport, extensions: [sellerAdjustableTerms, makegoodUnits] });
  const caps = await client.capabilities();
  const decl = caps.declared_extensions.find((d) => d.uri === makegoodUnits.EXTENSION_URI);
  assert.deepEqual(decl.tasks, [{ name: 'x_request_makegood', task: 'https://extensions.adcontextprotocol.org/makegood-units#request_makegood' }]);
  assert.deepEqual(decl.points, ['commercial_terms', 'media_buy_state', 'task']);
  assert.deepEqual(caps.negotiation.tasks[TASK.id], { name: 'x_request_makegood', uri: makegoodUnits.EXTENSION_URI, digest: makegoodUnits.EXTENSION_DIGEST });
  assert.deepEqual(client.lastReport.extensions.filter((e) => e.point === 'task').map((e) => [e.branch, e.status]), [['request_makegood', 'understood']]);

  // The name is the seller's choice: another agent serves the same task id under another name.
  const agent = createAdcpServer();
  agent.declare(makegoodUnits);
  agent.handle(TASK, (req) => ({ status: 'completed', outcome: 'rejected', rule_id: req.rule_id, rejection: { code: 'RULE_NOT_ACCEPTED', message: 'no buy' } }), { name: 'x_makegood_please' });
  const calls = [];
  const other = await createAdcpClient({
    transport: { call: (name, req) => (calls.push(name), agent.transport.call(name, req)), subscribe: () => () => {} },
    extensions: [makegoodUnits],
  });
  const res = await other.ext(makegoodUnits).requestMakegood(request('mb_none'));
  assert.deepEqual([res.outcome, calls], ['rejected', ['get_adcp_capabilities', 'x_makegood_please']]);
});

test('runtime binding: a buyer without the module ignores the declared task and has no method for it; another digest is not callable', async () => {
  const seller = createCreatorNetworkSeller();
  const plain = await createAdcpClient({ transport: seller.transport, extensions: [sellerAdjustableTerms] });
  const caps = await plain.capabilities();
  assert.deepEqual(plain.lastReport.extensions.filter((e) => e.point === 'task').map((e) => e.status), ['ignored']);
  assert.deepEqual(caps.negotiation.tasks, {});
  assert.throws(() => plain.ext(makegoodUnits), (e) => e.code === 'EXTENSION_NOT_ENABLED');
  await assert.rejects(plain.callTask(TASK, request('mb_1')), (e) => e.code === 'EXTENSION_NOT_ENABLED');

  // The kernel's transport-name rule: a name outside the x_ namespace fails core validation.
  const bad = structuredClone(caps);
  delete bad.negotiation;
  bad.declared_extensions.find((d) => d.tasks).tasks[0].name = 'request_makegood';
  assert.deepEqual([...new Set(createBuyerValidator().validate('/schemas/protocol/get-adcp-capabilities-response.json', bad).errors.map((e) => e.code))], ['CORE_SCHEMA_INVALID']);
  // A task id of another extension under this declaration is refused.
  bad.declared_extensions.find((d) => d.tasks).tasks[0] = { name: 'x_request_makegood', task: `${sellerAdjustableTerms.EXTENSION_URI}#request_makegood` };
  assert.deepEqual(createBuyerValidator().validate('/schemas/protocol/get-adcp-capabilities-response.json', bad).errors.map((e) => e.code), ['EXTENSION_BRANCH_MISMATCH']);

  // A buyer that enabled the module calls only a digest the seller declared for the task.
  const pinned = await createAdcpClient({ transport: seller.transport, extensions: [makegoodUnits] });
  await assert.rejects(pinned.callTask({ ...TASK, digest: `sha256:${'0'.repeat(64)}` }, request('mb_1')), (e) => e.code === 'EXTENSION_NOT_ENABLED');
  const noTask = createAdcpServer();
  noTask.declare(makegoodUnits);
  const silent = await createAdcpClient({ transport: noTask.transport, extensions: [makegoodUnits] });
  await assert.rejects(silent.ext(makegoodUnits).requestMakegood(request('mb_1')), (e) => e.code === 'TASK_NOT_DECLARED');
});

test('both sides validate the task against the extension definitions: the server refuses a bad request and a bad response, the client a bad response', async () => {
  const seller = createCreatorNetworkSeller();
  await assert.rejects(seller.transport.call('x_request_makegood', { media_buy_id: 'mb_1', rule_id: 'mg_video_2' }), (e) => e.code === 'INVALID_REQUEST' && /MakegoodRequest/.test(e.message));

  const sloppy = createAdcpServer();
  sloppy.declare(makegoodUnits);
  sloppy.handle(TASK, (req) => ({ status: 'completed', outcome: 'accepted', rule_id: req.rule_id }));
  await assert.rejects(sloppy.transport.call('x_request_makegood', request('mb_1')), (e) => e.code === 'INVALID_RESPONSE' && /MakegoodResponse/.test(e.message));

  const buyer = createBuyerValidator({ modules: [await loadModule(path.join(ROOT, 'packages/ext-makegood-units'))] });
  const req = request('mb_1');
  const ok = { status: 'completed', outcome: 'accepted', rule_id: 'mg_video_2', makegood_id: 'mg_1', package_id: 'pkg_makegood_2', revision: 2, change_id: 'chg_1' };
  assert.equal(buyer.validateTask(TASK, 'response', ok, { request: req }).ok, true);
  assert.deepEqual(buyer.validateTask(TASK, 'response', { ...ok, outcome: 'maybe' }, { request: req }).errors.map((e) => e.code), ['EXTENSION_DATA_INVALID']);
  assert.match(buyer.validateTask(TASK, 'response', { ...ok, rule_id: 'mg_video_1' }, { request: req }).errors[0].message, /the response is for rule mg_video_1; the request named mg_video_2/);
  assert.deepEqual(createBuyerValidator().validateTask(TASK, 'response', ok).errors.map((e) => e.code), ['EXTENSION_NOT_UNDERSTOOD']);
});

test('codegen: one typed descriptor per task (the generated layer\'s client method and handler use it), runtime-binding writers, and a JavaScript twin', () => {
  const ts = readFileSync(path.join(ROOT, 'packages/ext-makegood-units/src/index.ts'), 'utf8');
  assert.match(ts, /export const tasks = \{[\s\S]*requestMakegood: \{[\s\S]*\} as ContributedTask<MakegoodRequest, MakegoodResponse>,/);
  for (const fn of ['readCommercialTerms', 'commercialTermsEntry', 'readMediaBuyState', 'mediaBuyStateEntry']) assert.match(ts, new RegExp(`export function ${fn}\\(`), fn);
  assert.deepEqual({ ...TASK }, { id: makegoodUnits.REQUEST_MAKEGOOD, uri: makegoodUnits.EXTENSION_URI, digest: makegoodUnits.EXTENSION_DIGEST, branch: 'request_makegood', request: 'MakegoodRequest', response: 'MakegoodResponse' });
  const entry = makegoodUnits.commercialTermsEntry({ rules: [] });
  assert.deepEqual(Object.keys(entry), ['uri', 'digest', 'data']);
  const ltv = readFileSync(path.join(ROOT, 'packages/ext-linear-tv-indexed-cpp/src/index.ts'), 'utf8');
  for (const fn of ['indexedCppBranch', 'mediaBuyStateEntry', 'capabilitiesFragment']) assert.match(ltv, new RegExp(`export function ${fn}\\(`), fn);

  // The build checks a task registration against the kernel's task union: a response definition is required.
  const dir = mkdtempSync(path.join(tmpdir(), 'adcp-task-'));
  try {
    cpSync(path.join(ROOT, 'packages/ext-makegood-units'), dir, { recursive: true });
    const manifest = JSON.parse(readFileSync(path.join(dir, 'extension.json'), 'utf8'));
    manifest.extends.find((e) => e.point === 'task').response = undefined;
    writeFileSync(path.join(dir, 'extension.json'), JSON.stringify(manifest));
    assert.throws(() => buildBundle(dir), /the task union requires response/);
    manifest.extends.find((e) => e.point === 'task').response = 'MakegoodAnswer';
    writeFileSync(path.join(dir, 'extension.json'), JSON.stringify(manifest));
    assert.throws(() => buildBundle(dir), /missing response definition MakegoodAnswer/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

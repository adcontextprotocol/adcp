// The generated binding: each app declares its extensions in adcp.config.json and generates its own
// typed layer (adcp-sdk/), so extension data is a plain attribute at the hook the core declares. The
// wire stays the extension envelope. These tests run the layers of the two examples and of a test app
// that is the superset of what any tenant may enable (test/apps/superset).
//
// Run with --experimental-strip-types (npm test does): the layers are TypeScript.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { BindingError } from '../lib/binding.mjs';
import { termsDigest } from '../lib/digest.mjs';
import { createCreatorNetworkSeller } from '../lib/mock-seller.mjs';
import { INDEXED_BRANCH, createTvSeller } from '../lib/mock-tv-seller.mjs';
import { buildSdk } from '../scripts/adcp-sdk.mjs';
import * as buyerApp from '../examples/buyer-app/adcp-sdk/index.ts';
import * as agentApp from '../examples/sales-agent/adcp-sdk/index.ts';
import * as superset from './apps/superset/adcp-sdk/index.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MG = 'https://extensions.adcontextprotocol.org/makegood-units';
const SAT = 'https://extensions.adcontextprotocol.org/seller-adjustable-terms';
const lockOf = (dir) => JSON.parse(readFileSync(path.join(ROOT, 'packages', dir, 'extension.lock.json'), 'utf8'));
const MG_DIGEST = lockOf('ext-makegood-units').digest;
const brand = { domain: 'brand.example.com' };
let n = 0;
const key = (p) => `${p}-${String(++n).padStart(4, '0')}-generated`;

const temp = [];
after(() => temp.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A transport that keeps a copy of every request and response it carries. */
function recorded(transport) {
  const calls = [];
  return {
    calls,
    transport: {
      async call(name, request) {
        const response = await transport.call(name, request);
        calls.push({ name, request: structuredClone(request), response: structuredClone(response) });
        return response;
      },
      subscribe: transport.subscribe,
    },
  };
}

/** sha256 of every file under the given dirs: what "byte-identical" means here. */
function hashTree(...dirs) {
  const out = {};
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else out[path.relative(ROOT, p)] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  dirs.forEach((d) => walk(path.join(ROOT, d)));
  return out;
}

/** Two sponsored videos with a make-good rule per video, as attributes (the seller side). */
function creatorTerms({ makegoods = true, maxUnits = 1 } = {}) {
  const video = (i) => ({
    product_id: 'creator_video',
    pricing_option_id: 'po_flat',
    pricing: { pricing_option_id: 'po_flat', pricing_model: 'flat_rate', currency: 'EUR', fixed_price: 12000 },
    budget: 12000,
    start_time: ['2027-03-10T17:00:00Z', '2027-03-24T17:00:00Z'][i],
    end_time: ['2027-03-17T17:00:00Z', '2027-03-31T17:00:00Z'][i],
  });
  const terms = { brand, purchases: [video(0), video(1)], start_time: '2027-03-10T17:00:00Z', end_time: '2027-03-31T17:00:00Z' };
  if (makegoods) {
    terms.makegood_units = {
      rules: [0, 1].map((i) => ({ rule_id: `mg_video_${i + 1}`, purchase_index: i, trigger: 'deliverable_missed', max_units: maxUnits, window: { interval: 30, unit: 'days' }, keep_same: ['creator', 'platform'], at_no_cost: true })),
    };
  }
  return terms;
}

/** A seller on a generated layer: request_proposals answers with the rules when the caller understands them. */
function creatorAgent(layer, { maxUnits = 1, always = false, tenants } = {}) {
  const server = layer.createServer({ protocols: ['media_buy'], tenants });
  server.handle('request_proposals', (req, ctx) => {
    const terms = creatorTerms({ makegoods: always || ctx.understands('makegood_units'), maxUnits });
    const proposal = { proposal_id: 'prop_1', proposal_kind: 'new_media_buy', proposal_status: 'draft', name: 'Two sponsored videos', expires_at: '2027-03-03T09:00:00Z', commercial_terms: terms, terms_digest: server.termsDigest(terms) };
    return { status: 'completed', outcome: 'proposed', proposals: [proposal], products: [{ product_id: 'creator_video', name: 'Sponsored creator video', pricing_options: [{ pricing_option_id: 'po_flat', pricing_model: 'flat_rate', currency: 'EUR', fixed_price: 12000 }] }] };
  });
  server.handle('request_makegood', (req) => ({ status: 'completed', outcome: 'rejected', rule_id: req.rule_id, rejection: { code: 'RULE_NOT_ACCEPTED', message: `no accepted rule ${req.rule_id}` } }));
  return server;
}
const ISSUED = { makegood_id: 'mg_8', rule_id: 'mg_video_2', revision: 3, change_id: 'chg_7', issued_at: '2027-03-01T09:00:00Z', reason: 'deliverable_missed', package_id: 'pkg_makegood_2', evidence: { creator: { original: '@maya.cooks', makegood: '@maya.cooks' }, platform: { original: 'youtube', makegood: 'youtube' } } };
const proposalsRequest = (understood) => ({ idempotency_key: key('request'), brief: 'Two sponsored videos', brand, ...(understood ? { understood_extensions: understood } : {}) });

test('generated binding: every layer is up to date with its adcp.config.json (the CI gate); a config edit without a regenerate is stale', async () => {
  for (const app of ['examples/buyer-app', 'examples/sales-agent', 'test/apps/superset']) {
    const { stale } = await buildSdk(path.join(ROOT, app), { check: true });
    assert.deepEqual(stale, [], `${app}: run npm run sdk`);
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'adcp-generated-'));
  temp.push(dir);
  cpSync(path.join(ROOT, 'examples/sales-agent/adcp.config.json'), path.join(dir, 'adcp.config.json'));
  await buildSdk(dir);
  const config = JSON.parse(readFileSync(path.join(dir, 'adcp.config.json'), 'utf8'));
  config.extensions.seller_adjustable_terms = `${SAT}@^1`;
  writeFileSync(path.join(dir, 'adcp.config.json'), JSON.stringify(config));
  const { stale } = await buildSdk(dir, { check: true });
  assert.deepEqual(stale, ['adcp-sdk/GENERATED.json', 'adcp-sdk/bindings.ts', 'adcp-sdk/bundles/seller-adjustable-terms@1.6.0.json', 'adcp-sdk/index.ts', 'adcp-sdk/types.ts', 'adcp.lock.json']);
});

test('generated binding: adding an extension changes only the app layer; the core schemas, the core package, the SDK, and every extension package stay byte-identical', async () => {
  const before = hashTree('core', 'packages', 'lib', 'registry');
  const dir = mkdtempSync(path.join(tmpdir(), 'adcp-generated-'));
  temp.push(dir);
  writeFileSync(path.join(dir, 'adcp.config.json'), JSON.stringify({ core: '3.3.0', extensions: { makegood_units: `${MG}@^1.4` } }));
  await buildSdk(dir);
  const one = readFileSync(path.join(dir, 'adcp-sdk/types.ts'), 'utf8');
  writeFileSync(path.join(dir, 'adcp.config.json'), JSON.stringify({ core: '3.3.0', extensions: { makegood_units: `${MG}@^1.4`, seller_adjustable_terms: `${SAT}@^1` } }));
  await buildSdk(dir);
  const two = readFileSync(path.join(dir, 'adcp-sdk/types.ts'), 'utf8');
  assert.deepEqual(hashTree('core', 'packages', 'lib', 'registry'), before);
  assert.equal(one.includes('seller_adjustable_terms?:'), false);
  assert.match(two, /seller_adjustable_terms\?: seller_adjustable_terms\.SellerAdjustableTerms;/);
});

test('generated binding: the buyer reads plain attributes; the wire stays the envelope and re-encodes to the same bytes and terms_digest', async () => {
  const rec = recorded(createCreatorNetworkSeller().transport);
  const client = await buyerApp.createClient({ transport: rec.transport });
  const { proposals: [draft] } = await client.requestProposals({ idempotency_key: key('request'), brief: 'two creator videos', brand });
  assert.equal(draft.commercial_terms.makegood_units.rules[0].max_units, 1);
  assert.equal(draft.commercial_terms.seller_adjustable_terms.allowances[0].allowance_id, 'slip_v1_end');
  assert.equal('extensions' in draft.commercial_terms, false);
  const wire = rec.calls.at(-1).response.proposals[0];
  assert.deepEqual(wire.commercial_terms.extensions.map((e) => e.uri), [MG, SAT]);
  assert.deepEqual(buyerApp.serialize('proposal', draft), wire);
  assert.equal(buyerApp.termsDigest(draft.commercial_terms), wire.terms_digest);
  // Finalize and accept: the client encodes the proposal back, and the SDK recomputes terms_digest before it signs.
  const { proposals: [committed] } = await client.refineProposals({ idempotency_key: key('finalize'), refinements: [{ proposal_id: draft.proposal_id, action: 'finalize' }] });
  const { media_buy_id } = await client.acceptProposal({ proposal: committed, idempotency_key: key('accept'), account: { account_id: 'acc' } });
  assert.equal(rec.calls.at(-1).request.proposal_terms_digest, committed.terms_digest);
  // The task the extension contributes is a typed method of this app's client.
  const answer = await client.requestMakegood({ idempotency_key: key('makegood'), media_buy_id, rule_id: 'mg_video_2', package_id: 'pkg_video_2', reason: 'deliverable_missed' });
  assert.equal(answer.outcome, 'accepted');
  const { media_buys: [mb] } = await client.getMediaBuys({ media_buy_ids: [media_buy_id] });
  assert.equal(mb.makegood_units.issued[0].rule_id, 'mg_video_2');
  assert.equal('extensions_state' in mb, false);
});

test('generated binding: the seller writes plain attributes, the wire carries the envelope, and data errors come back at wire locations', async () => {
  const understood = agentApp.understoodExtensions();
  const ok = await creatorAgent(agentApp).transport.call('request_proposals', proposalsRequest(understood));
  const ct = ok.proposals[0].commercial_terms;
  assert.deepEqual(Object.keys(ct.extensions[0]), ['uri', 'digest', 'data']);
  assert.deepEqual([ct.extensions[0].uri, ct.extensions[0].digest, 'makegood_units' in ct], [MG, MG_DIGEST, false]);
  assert.equal(termsDigest(ct), ok.proposals[0].terms_digest);
  // Without the extension in understood_extensions, the agent omits the rules.
  const plain = await creatorAgent(agentApp).transport.call('request_proposals', proposalsRequest());
  assert.equal(plain.proposals[0].commercial_terms.extensions, undefined);
  // max_units 0 breaks the pinned schema: the error names the wire location, not the attribute path.
  await assert.rejects(creatorAgent(agentApp, { maxUnits: 0 }).transport.call('request_proposals', proposalsRequest(understood)), (e) => {
    assert.equal(e.code, 'INVALID_RESPONSE');
    assert.deepEqual(e.details.map((i) => i.path), ['/proposals/0/commercial_terms/extensions/0/data/rules/0/max_units', '/proposals/0/commercial_terms/extensions/0/data/rules/1/max_units']);
    return true;
  });
  // Must-understand data for a caller that did not list it is refused before it leaves.
  await assert.rejects(creatorAgent(agentApp, { always: true }).transport.call('request_proposals', proposalsRequest()), (e) => e.code === 'EXTENSION_NOT_AGREED' && e.details[0].path === '/proposals/0/commercial_terms/makegood_units');
});

test('generated binding: an unknown must-understand entry and an unknown digest of a known uri are refused at their wire locations; ignorable entries survive a round trip', async () => {
  const wire = await creatorAgent(agentApp).transport.call('request_proposals', proposalsRequest(agentApp.understoodExtensions()));
  const fancy = { uri: 'https://ext.example.com/fancy-terms', digest: `sha256:${'0'.repeat(64)}`, data: {} };
  const unknown = structuredClone(wire);
  unknown.proposals[0].commercial_terms.extensions.unshift(fancy);
  assert.throws(() => agentApp.parse('request_proposals.response', unknown), (e) => e instanceof BindingError && e.issues[0].code === 'EXTENSION_NOT_UNDERSTOOD' && e.issues[0].path === '/proposals/0/commercial_terms/extensions/0' && /Add it to adcp\.config\.json and run npm run sdk/.test(e.issues[0].message));
  const other = structuredClone(wire);
  other.proposals[0].commercial_terms.extensions[0].digest = `sha256:${'1'.repeat(64)}`;
  assert.throws(() => agentApp.parse('request_proposals.response', other), (e) => e.issues[0].code === 'EXTENSION_VERSION_NOT_UNDERSTOOD' && e.issues[0].path === '/proposals/0/commercial_terms/extensions/0' && /generated for makegood-units 1\.5\.0/.test(e.issues[0].message));
  // media_buy_state is must_understand never: an entry this build does not know is kept out of sight and written back.
  const readback = { media_buys: [{ media_buy_id: 'mb_1', status: 'active', revision: 2, total_budget: 0, packages: [], extensions_state: [fancy, { uri: MG, digest: MG_DIGEST, must_understand: false, data: { issued: [ISSUED] } }] }] };
  const parsed = agentApp.parse('get_media_buys.response', readback);
  assert.deepEqual(parsed.media_buys[0].makegood_units, { issued: [ISSUED] });
  assert.equal('extensions_state' in parsed.media_buys[0], false);
  assert.deepEqual(agentApp.serialize('get_media_buys.response', parsed), readback);
});

test('generated binding: the published JSON Schema is the wire schema (extensions[], never the attributes), annotated with the uri@digest set of this build', async () => {
  const schema = agentApp.wireSchema('request_proposals.response');
  const text = JSON.stringify(schema);
  assert.equal(text.includes('makegood_units'), false);
  const terms = schema.definitions['/schemas/media-buy/commercial-terms.json'];
  assert.deepEqual(terms.properties.extensions['x-adcp-extensions'], [`${MG}@${MG_DIGEST}`]);
  assert.equal(terms.properties.extensions['x-adcp-extension-point'].name, 'commercial_terms');
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(schema); // self-contained: no other schema is registered
  const wire = await creatorAgent(agentApp).transport.call('request_proposals', proposalsRequest(agentApp.understoodExtensions()));
  assert.equal(validate(wire), true, JSON.stringify(validate.errors?.slice(0, 3)));
  // The attribute form is not what a peer may send: commercial_terms is closed.
  assert.equal(validate(agentApp.parse('request_proposals.response', wire)), false);
  assert.ok(validate.errors.some((e) => e.instancePath === '/proposals/0/commercial_terms' && e.params.additionalProperty === 'makegood_units'));
});

test('generated binding: two versions of one uri bind to two attributes, keyed by uri@digest; a message carries one', async () => {
  const seller = createCreatorNetworkSeller();
  const [v1_0, v1_6] = seller.supported.filter((s) => s.uri === SAT);
  assert.deepEqual([v1_0.version, v1_6.version], ['1.0.0', '1.6.0']);
  const client = await superset.createClient({ transport: seller.transport });
  const { proposals: [current] } = await client.requestProposals({ idempotency_key: key('request'), brief: 'two creator videos', brand });
  assert.ok(current.commercial_terms.seller_adjustable_terms);
  assert.equal(current.commercial_terms.seller_adjustable_terms_v1_0, undefined);
  // A seller that agreed 1.0.0 with this caller: the same layer binds it to the other attribute.
  const old = await seller.transport.call('request_proposals', { ...proposalsRequest([{ uri: SAT, digest: v1_0.digest }]) });
  const parsed = superset.parse('request_proposals.response', old);
  assert.equal(parsed.proposals[0].commercial_terms.seller_adjustable_terms_v1_0.allowances[0].allowance_id, 'slip_v1_end');
  assert.equal(parsed.proposals[0].commercial_terms.seller_adjustable_terms, undefined);
  assert.deepEqual(superset.serialize('request_proposals.response', parsed), old);
  const both = { ...parsed.proposals[0].commercial_terms, seller_adjustable_terms: current.commercial_terms.seller_adjustable_terms };
  assert.throws(() => superset.serialize('commercial_terms', both), (e) => e.code === 'EXTENSION_VERSIONS');
});

test('generated binding: the indexed-CPP pricing model is a member of the pricing union, with its data as a plain attribute', async () => {
  const rec = recorded(createTvSeller().transport);
  const client = await superset.createClient({ transport: rec.transport });
  const { products: [prime] } = await client.getProducts({ buying_mode: 'brief', brief: 'Prime time 25-54 in March' });
  const indexed = prime.pricing_options.find((o) => o.pricing_model === INDEXED_BRANCH);
  assert.equal(indexed.linear_tv_indexed_cpp.ceiling_price, 1898);
  assert.equal('extension_model' in indexed, false);
  const cpp = prime.pricing_options.find((o) => o.pricing_model === 'cpp');
  assert.equal(typeof cpp.rate_card_index.base_price, 'number'); // the pricing_option extension point, as an attribute
  const { proposals: [draft] } = await client.requestProposals({ idempotency_key: key('request'), brief: 'Prime time 25-54 in March', brand });
  const pricing = draft.commercial_terms.purchases[0].pricing;
  assert.equal(pricing.pricing_model, INDEXED_BRANCH);
  assert.equal(pricing.linear_tv_indexed_cpp.ceiling_price, 1898);
  assert.deepEqual(rec.calls.at(-1).response.proposals[0].commercial_terms.purchases[0].pricing.extension_model.data, pricing.linear_tv_indexed_cpp);
  const { proposals: [committed] } = await client.refineProposals({ idempotency_key: key('finalize'), refinements: [{ proposal_id: draft.proposal_id, action: 'finalize' }] });
  const { media_buy_id } = await client.acceptProposal({ proposal: committed, idempotency_key: key('accept'), account: { account_id: 'acc' } });
  assert.match(media_buy_id, /^mb_/);
});

test('generated binding: one superset layer for the deployment; per-tenant enablement is data, checked at the boundary after the tenant resolves', async () => {
  const server = creatorAgent(superset, { tenants: { tenant_a: ['makegood_units'], tenant_b: ['seller_adjustable_terms'] } });
  const a = server.transportFor('tenant_a');
  const b = server.transportFor('tenant_b');
  const declared = async (t) => (await t.call('get_adcp_capabilities', {})).declared_extensions.map((d) => d.uri.split('/').pop());
  assert.deepEqual(await declared(a), ['makegood-units']);
  assert.deepEqual(await declared(b), ['seller-adjustable-terms']);
  const understood = [{ uri: MG, digest: MG_DIGEST }];
  assert.equal((await a.call('request_proposals', proposalsRequest(understood))).proposals[0].commercial_terms.extensions.length, 1);
  assert.equal((await b.call('request_proposals', proposalsRequest(understood))).proposals[0].commercial_terms.extensions, undefined);
  const ask = { idempotency_key: key('makegood'), media_buy_id: 'mb_1', rule_id: 'mg_video_1', package_id: 'pkg_video_1', reason: 'deliverable_missed' };
  assert.equal((await a.call('x_request_makegood', ask)).outcome, 'rejected');
  await assert.rejects(b.call('x_request_makegood', ask), (e) => e.code === 'UNSUPPORTED_TASK');
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');
const { artifact, generate, prepare, assess, ROOT } = require('../scripts/sdk-response-conformance/lib.cjs');
const plan = prepare('3.2.0-rc.3');
const art = artifact(plan.protocol.version);
function probe(id, change = {}) {
  return { ...plan, cases: [{ ...plan.cases.find(row => row.id === id), ...change }] };
}
function inspect(selected, payload, extra = {}) {
  return assess(selected, {
    sdk: { language: 'negative-control', package: 'fixture', version: '1' },
    advertised_tools: [selected.cases[0].tool], observations: [{
      id: selected.cases[0].id, handler_called: true, handler_served_version: plan.protocol.wire_selector,
      result: { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, ...(selected.cases[0].kind === 'error' && { isError: true }) },
      ...extra,
    }],
  }).results[0];
}

test('inventory is exactly the selected manifest; every dispatched request is schema-valid', () => {
  assert.equal(plan.inventory.length, Object.keys(art.manifest.tools).length);
  assert.deepEqual(plan.inventory.map(row => row.tool).sort(), Object.keys(art.manifest.tools).sort());
  assert.equal(new Set(plan.cases.map(row => row.id)).size, plan.cases.length);
  assert.equal(plan.cases.filter(row => row.id.startsWith('default:')).length, art.load('enums/error-code.json').enum.length);
  assert.ok(plan.inventory.some(row => row.generation.status === 'unsupported'));
  assert.ok(plan.inventory.some(row => row.fixture.startsWith('unimplemented:')));
  for (const row of plan.cases) assert.deepEqual(art.validate(art.manifest.tools[row.tool].request_schema, row.request), [], row.id);
  assert.equal(plan.protocol.wire_selector, '3.2-rc.3');
  assert.equal(artifact(plan.protocol.version).digest, plan.protocol.sha256);
});

test('invalid candidates are explicit and never promoted to dispatch fixtures', () => {
  const generated = generate(art, 'media-buy/get-products-request.json', { buying_mode: 'invented' });
  assert.equal(generated.status, 'unsupported');
  assert.ok(generated.errors.length);
  assert.equal(generated.request, undefined);
});

test('reference resolution is release-bound and resolves JSON pointers', () => {
  assert.equal(art.resolve('#/properties/code', 'core/error.json').schema.type, 'string');
  for (const ref of ['https://example.org/schema.json', '../../secret.json', '/schemas/3.1.19/core/error.json', '#/missing']) {
    assert.throws(() => art.resolve(ref, 'core/error.json'), undefined, ref);
  }
  assert.throws(() => artifact('latest'), /exact release/);
});

test('union choices and unvisited branches are recorded deterministically', () => {
  const schema = { type: 'object', required: ['mode'], properties: { mode: { oneOf: [{ const: 'first' }, { const: 'second' }] } } };
  const validator = new Ajv().compile(schema);
  const fixtureArtifact = { load: () => schema, validate: (_, value) => validator(value) ? [] : validator.errors };
  const first = generate(fixtureArtifact, 'fixture.json');
  assert.deepEqual(first, generate(fixtureArtifact, 'fixture.json'));
  assert.equal(first.request.mode, 'first');
  assert.deepEqual(first.choices[0].unvisited, [1]);
});

test('published MCP transport vector is validated as an error, never a catalog success', () => {
  const vector = JSON.parse(fs.readFileSync(path.join(ROOT, 'static/test-vectors/transport-error-mapping.json'))).vectors.find(row => row.id === 'mcp-structured-content');
  const result = inspect(probe('default:RATE_LIMITED'), vector.response.structuredContent);
  assert.equal(result.response_kind, 'mcp-tool-error');
  assert.equal(result.schema, 'valid');
  assert.equal(result.semantics, 'passed');
  assert.equal(result.workflow, 'not-tested');
});

test('Go #530 negative controls distinguish invalid enum from wrong valid recovery', () => {
  const invalid = inspect(probe('default:RATE_LIMITED'), { adcp_error: { code: 'RATE_LIMITED', message: 'Fixture', recovery: 'retry' } });
  assert.equal(invalid.schema, 'invalid');
  assert.equal(invalid.semantics, 'failed');
  const wrong = inspect(probe('default:AUTH_REQUIRED'), { adcp_error: { code: 'AUTH_REQUIRED', message: 'Fixture', recovery: 'terminal' } });
  assert.equal(wrong.schema, 'valid');
  assert.equal(wrong.semantics, 'failed');
});

test('explicit extension-code recovery overrides retain their semantics', () => {
  for (const recovery of ['transient', 'correctable', 'terminal']) {
    const result = inspect(probe(`override:${recovery}`), { adcp_error: { code: 'X_ACME_FIXTURE', message: 'Fixture', recovery } });
    assert.equal(result.schema, 'valid');
    assert.equal(result.semantics, 'passed');
  }
});

test('malformed task and transport envelopes fail negative controls', () => {
  const missingProducts = inspect(probe('catalog:get_products'), { status: 'completed', cache_scope: 'public' });
  assert.equal(missingProducts.schema, 'invalid');
  const missingError = inspect(probe('default:RATE_LIMITED'), {});
  assert.equal(missingError.schema, 'invalid');
  assert.ok(missingError.findings.includes('missing-transport-adcp-error'));
  const missingEnvelope = inspect(probe('catalog:get_products'), {}, { result: {} });
  assert.equal(missingEnvelope.schema, 'invalid');
});

test('absence of a served version is unresolved, not manufactured from the request', () => {
  const result = inspect(probe('catalog:get_products'), { status: 'completed', products: [], cache_scope: 'public' }, { handler_served_version: null });
  assert.equal(result.served_version, null);
  assert.equal(result.schema, 'valid');
  assert.equal(result.validation_contract.provisional, true);
  assert.ok(result.findings.includes('served-version-unresolved'));
});

test('the actual served artifact controls validation after a version downshift', () => {
  const payload = { status: 'completed', products: [] };
  const result = inspect(probe('catalog:get_products'), payload, { handler_served_version: '3.0.25' });
  assert.equal(result.validation_contract.version, '3.0.25');
  assert.equal(result.validation_contract.provisional, false);
  assert.equal(result.schema, 'valid');
  assert.ok(result.findings.includes('served-version-mismatch'));
  assert.ok(art.validate('media-buy/get-products-response.json', payload).length, '3.2 requires cache scope');
});

test('unavailable served artifacts, missing observations and unadvertised dispatch do not pass silently', () => {
  const selected = probe('catalog:get_products');
  const payload = { status: 'completed', products: [], cache_scope: 'public' };
  const unknown = inspect(selected, payload, { handler_served_version: '9.0.0' });
  assert.equal(unknown.validation_contract.provisional, true);
  assert.ok(unknown.findings.includes('served-contract-unavailable'));
  const missing = assess(selected, { sdk: {}, advertised_tools: [], observations: [] });
  assert.equal(missing.summary.skipped, 1);
  assert.ok(missing.results[0].findings.includes('missing-observation'));
  const failure = inspect(selected, {}, { transport_error: 'Connection closed', handler_called: false });
  assert.equal(failure.schema, 'transport-failure');
  assert.ok(failure.findings.includes('handler-not-reached'));
});

test('artifact drift after request preparation is a harness error', () => {
  assert.throws(() => assess({ ...plan, protocol: { ...plan.protocol, sha256: 'wrong' } }, { observations: [] }), /artifact changed/);
});

test('regression baseline retains findings and detects changed coverage or SDK pins', () => {
  const { baseline } = require('../scripts/sdk-response-conformance/check-baseline.cjs');
  const result = assess(probe('default:RATE_LIMITED'), {
    sdk: { package: 'fixture', version: '1' }, advertised_tools: ['get_products'],
    observations: [{ id: 'default:RATE_LIMITED', skip: 'Unsupported fixture' }],
  });
  const snapshot = baseline([result]);
  assert.equal(snapshot[0].summary.status, 'incomplete');
  assert.equal(snapshot[0].findings[0].skip, 'Unsupported fixture');
  assert.notDeepEqual(snapshot, baseline([{ ...result, sdk: { package: 'fixture', version: '2' } }]));
});

test('error envelopes validate version fields as well as the inner error', () => {
  const result = inspect(probe('default:RATE_LIMITED'), {
    adcp_version: '3.2.0-rc.3',
    adcp_error: { code: 'RATE_LIMITED', message: 'Fixture', recovery: 'transient' },
  });
  assert.equal(result.schema, 'invalid', 'full semver is not a valid wire selector');
  assert.equal(result.semantics, 'passed');
  assert.ok(result.schema_errors.some(error => error.instancePath === '/adcp_version'));
});

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const readJson = (relativePath) => JSON.parse(read(relativePath));

test('normative async contract covers identity, races, recovery, and composite boundaries', () => {
  const doc = read('docs/building/by-layer/L3/async-identity-and-convergence.mdx');

  for (const requiredText of [
    'MUST NOT\nsubstitute one identity for another',
    'The first authoritative terminal observation wins',
    'Same webhook delivery key and different payload',
    'Crash after B is stored but before A points to B',
    'Crash after A points to B but before B reaches the caller',
    'One durable publication owner',
    'Structural, reference, and routing validation',
    'AdCP 3.2 defines no transport-neutral continuation request',
  ]) {
    assert.ok(doc.includes(requiredText), `missing normative coverage: ${requiredText}`);
  }
});

test('generic examples never fabricate continuation from context_id', () => {
  const docs = [
    read('docs/building/by-layer/L3/async-operations.mdx'),
    read('docs/building/by-layer/L3/task-lifecycle.mdx'),
  ].join('\n');

  assert.doesNotMatch(docs, /sendFollowUp\(response\.context_id/);
  assert.doesNotMatch(docs, /sendMessage\(response\.context_id/);
  assert.doesNotMatch(docs, /retryWithAuth\(credentials\)/);
  assert.match(docs, /verifiedContinuationFor\(response\)/);

  const webhookSchema = readJson('static/schemas/source/core/mcp-webhook-payload.json');
  assert.match(webhookSchema.properties.context_id.description, /not continuation authority/);
  assert.match(webhookSchema.properties.context_id.description, /MUST NOT be used to resume/);
});

test('context_id continuity is transport-native rather than an MCP body contract', () => {
  const envelope = readJson('static/schemas/source/core/protocol-envelope.json');
  const description = envelope.properties.context_id.description;

  assert.match(description, /native Message\/Task `contextId`/);
  assert.match(description, /request-body `context_id`, where admitted by the selected request schema, is a compatibility-only field/);
  assert.match(description, /MUST ignore it/);
  assert.match(description, /MUST NOT select session state, identity, account, authorization, task continuation, or idempotency scope/);

  for (const docPath of [
    'docs/building/by-layer/L0/mcp-guide.mdx',
    'docs/building/by-layer/L2/context-sessions.mdx',
    'docs/building/concepts/protocol-comparison.mdx',
  ]) {
    const doc = read(docPath);
    assert.doesNotMatch(doc, /MCP requires manual context management/);
    assert.doesNotMatch(doc, /must include context_id/i);
    assert.match(doc, /transport session/i);
  }
});

test('the four 3.x request fields are documented compatibility no-ops', () => {
  const requestDir = path.join(root, 'static/schemas/source/media-buy');
  const declarations = fs.readdirSync(requestDir)
    .filter((name) => name.endsWith('-request.json'))
    .filter((name) => readJson(`static/schemas/source/media-buy/${name}`).properties?.context_id)
    .sort();

  assert.deepEqual(declarations, [
    'decline-proposals-request.json',
    'list-products-request.json',
    'refine-proposals-request.json',
    'request-proposals-request.json',
  ]);

  for (const name of declarations) {
    const schema = readJson(`static/schemas/source/media-buy/${name}`);
    assert.ok(!schema.required?.includes('context_id'));
    assert.match(schema.properties.context_id.description, /compatibility field/);
    assert.match(schema.properties.context_id.description, /servers ignore this value/);
    assert.match(schema.properties.context_id.description, /transport-native Message\/Task contextId/);
  }
});

test('webhook retry horizon is bounded, additive, and normative for 3.2 emitters', () => {
  const schema = readJson('static/schemas/source/protocol/get-adcp-capabilities-response.json');
  const signing = schema.properties.webhook_signing;
  const horizon = signing.properties.delivery_retry_horizon_seconds;

  assert.equal(horizon.minimum, 86400);
  assert.equal(horizon.maximum, 604800);
  assert.doesNotMatch(JSON.stringify(signing.required ?? []), /delivery_retry_horizon_seconds/);
  assert.match(horizon.description, /3\.2 agent MUST populate/);
  assert.match(horizon.description, /schema-optional/);
});

test('terminal task webhooks separate delivery and observation identity', () => {
  const schema = readJson('static/schemas/source/core/mcp-webhook-payload.json');
  assert.ok(!schema.required.includes('notification_id'));
  assert.ok(!schema.allOf.some((rule) => rule.then?.required?.includes('notification_id')));
  assert.match(schema.properties.notification_id.description, /Optional event-layer identifier/);
  assert.match(schema.properties.notification_id.description, /authenticated seller plus the bound task_id/);
  assert.match(schema.properties.idempotency_key.description, /503/);
  assert.match(schema.properties.idempotency_key.description, /2xx/);
  assert.match(schema.properties.idempotency_key.description, /409/);
  assert.match(schema.properties.timestamp.description, /MUST repeat this exact body value/);
});

test('accepted webhook registrations always have an emit-able operation identity', () => {
  const schema = readJson('static/schemas/source/core/push-notification-config.json');
  assert.match(schema.properties.operation_id.description, /MUST reject/);
  assert.match(schema.properties.operation_id.description, /required webhook envelope/);
});

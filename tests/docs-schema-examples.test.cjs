'use strict';

// Drives scripts/docs-schema-examples.cjs through its CLI against a fixture
// docs tree and schema tree. Each failing vector breaks one rule.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'docs-schema-examples.cjs');
const SCHEMA_URI = 'https://adcontextprotocol.org/schemas/v3/demo/thing.json';
const EXAMPLE = { thing_id: 'thing_1', tags: ['red', 'blue'], size: { width: 300, height: 250 } };
const RENDERED = [
  '{',
  `  "$schema": "${SCHEMA_URI}",`,
  '  "thing_id": "thing_1",',
  '  "tags": ["red", "blue"],',
  '  "size": {',
  '    "width": 300,',
  '    "height": 250',
  '  }',
  '}',
].join('\n');

function fixture(t, page) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-schema-examples-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'schemas', 'demo'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'schemas', 'demo', 'thing.json'),
    JSON.stringify({ $id: '/schemas/demo/thing.json', type: 'object', examples: [EXAMPLE] }, null, 2),
  );
  fs.mkdirSync(path.join(dir, 'docs'));
  fs.writeFileSync(path.join(dir, 'docs', 'page.mdx'), page);
  return dir;
}

function run(dir, ...flags) {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, ...flags, '--docs-dir', path.join(dir, 'docs'), '--schemas-dir', path.join(dir, 'schemas')],
    { encoding: 'utf8' },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function page(dir) {
  return fs.readFileSync(path.join(dir, 'docs', 'page.mdx'), 'utf8');
}

const bound = (body, indent = '') =>
  [
    `${indent}{/* schema-example: #/examples/0 */}`,
    `${indent}\`\`\`json Request`,
    ...body.split('\n').map((line) => `${indent}${line}`),
    `${indent}\`\`\``,
    '',
  ].join('\n');

test('a bound block that equals its schema example passes', (t) => {
  const dir = fixture(t, `# Page\n\n${bound(RENDERED)}`);
  const result = run(dir, '--check');
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /OK: 1 docs blocks render from schema examples/);
});

test('a stale bound block fails the check and a rewrite renders the example', (t) => {
  const stale = RENDERED.replace('"thing_1"', '"thing_old"');
  const dir = fixture(t, `# Page\n\n${bound(stale)}`);

  const check = run(dir, '--check');
  assert.equal(check.status, 1);
  assert.match(check.output, /page\.mdx:4: stale; the block differs from #\/examples\/0/);
  assert.equal(page(dir), `# Page\n\n${bound(stale)}`, '--check must not write');

  const write = run(dir);
  assert.equal(write.status, 0, write.output);
  assert.equal(page(dir), `# Page\n\n${bound(RENDERED)}`);
  assert.equal(run(dir, '--check').status, 0);
});

test('a rewrite keeps the fence indentation of a block inside a list', (t) => {
  const stale = RENDERED.replace('300', '320');
  const dir = fixture(t, `1. Send it:\n\n${bound(stale, '   ')}`);
  assert.equal(run(dir).status, 0);
  assert.equal(page(dir), `1. Send it:\n\n${bound(RENDERED, '   ')}`);
});

test('a marker that is not directly above a json fence fails', (t) => {
  const dir = fixture(t, `{/* schema-example: #/examples/0 */}\n\nSome prose.\n\n\`\`\`json\n${RENDERED}\n\`\`\`\n`);
  const result = run(dir, '--check');
  assert.equal(result.status, 1);
  assert.match(result.output, /page\.mdx:1: schema-example marker is not directly above a json fence/);
});

test('a bound block without a $schema that names a schema fails', (t) => {
  const body = RENDERED.replace(SCHEMA_URI, 'https://adcontextprotocol.org/schemas/v3/demo/missing.json');
  const dir = fixture(t, bound(body));
  const result = run(dir, '--check');
  assert.equal(result.status, 1);
  assert.match(result.output, /page\.mdx:2: a schema-example block needs a "\$schema" that names a schema/);
});

test('a pointer that names no example fails', (t) => {
  const dir = fixture(t, bound(RENDERED).replace('#/examples/0', '#/examples/1'));
  const result = run(dir, '--check');
  assert.equal(result.status, 1);
  assert.match(result.output, /page\.mdx:2: #\/examples\/1 is not an example of demo\/thing\.json/);
});

test('a payload block with a $schema and no marker fails', (t) => {
  const dir = fixture(t, `\`\`\`json\n${RENDERED.replace('"thing_1"', '"thing_2"')}\n\`\`\`\n`);
  const result = run(dir, '--check');
  assert.equal(result.status, 1);
  assert.match(result.output, /page\.mdx:1: a payload block with a "\$schema" must come from that schema's examples/);
});

test('an unbound block that copies a schema example fails', (t) => {
  const dir = fixture(t, `\`\`\`json\n${JSON.stringify(EXAMPLE, null, 2)}\n\`\`\`\n`);
  const result = run(dir, '--check');
  assert.equal(result.status, 1);
  assert.match(result.output, /page\.mdx:1: the block copies demo\/thing\.json#\/examples\/0/);
});

test('illustrative blocks and blocks without a schema pass', (t) => {
  const illustrative = RENDERED.replace('"thing_1"', '"..."');
  const plain = JSON.stringify({ thing_id: 'thing_9' }, null, 2);
  const dir = fixture(t, `\`\`\`json\n${illustrative}\n\`\`\`\n\n\`\`\`json\n${plain}\n\`\`\`\n`);
  const result = run(dir, '--check');
  assert.equal(result.status, 0, result.output);
});

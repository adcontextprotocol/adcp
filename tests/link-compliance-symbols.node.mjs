// Kept outside Vitest's *.test.* glob because this suite uses node:test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import buildSchemas from '../scripts/build-schemas.cjs';

import {
  classifyUnknown,
  collectSchemaFields,
  discoverTaskAuthorities,
  transformDocument,
  validateIgnoreUsage,
  writeTransactional,
} from '../scripts/link-compliance-symbols.mjs';

const { discoverTools } = buildSchemas;

function fixture(overrides = {}) {
  const authorities = {
    errors: new Map([
      ['KNOWN_ERROR', [{ family: 'standard', target: '/errors#error-code-known-error' }]],
      ['INVALID_STATE', [
        { family: 'controller', target: '/controller#error-codes' },
        { family: 'standard', target: '/errors#error-code-invalid-state' },
      ]],
      ['INTERNAL_ERROR', [{ family: 'controller', target: '/controller#error-codes' }]],
    ]),
    fields: {
      names: new Set(['get_field_value']),
      qualified: new Map([
        ['core/example.json#/properties/get_field_value', {
          name: 'get_field_value',
          target: 'https://adcontextprotocol.org/schemas/v3/core/example.json#/properties/get_field_value',
        }],
      ]),
    },
    storyboards: new Map([
      ['get_products_pagination_integrity', {
        source: 'static/compliance/source/universal/get-products.yaml',
        target: '/compliance/latest/universal/get-products.yaml',
      }],
    ]),
    tasks: new Map([
      ['get_products', { target: '/docs/media-buy/task-reference/get_products' }],
    ]),
  };
  return {
    authorities,
    errors: [],
    file: 'docs/building/verification/example.mdx',
    ignores: new Map(),
    references: [],
    usedIgnores: new Set(),
    warnings: [],
    ...overrides,
  };
}

test('known symbols link once per H2 section without reformatting source', () => {
  const context = fixture();
  const source = [
    '# `get_products` heading is ineligible',
    '',
    '## First',
    'Use `KNOWN_ERROR`, then `KNOWN_ERROR`, with `get_products`.',
    '',
    '## Second',
    'Use `KNOWN_ERROR` again.',
    '',
  ].join('\n');
  assert.equal(transformDocument(source, context), [
    '# `get_products` heading is ineligible',
    '',
    '## First',
    'Use [`KNOWN_ERROR`](/errors#error-code-known-error), then `KNOWN_ERROR`, with ' +
      '[`get_products`](/docs/media-buy/task-reference/get_products).',
    '',
    '## Second',
    'Use [`KNOWN_ERROR`](/errors#error-code-known-error) again.',
    '',
  ].join('\n'));
  assert.deepEqual(context.errors, []);
});

test('existing symbol links are canonicalized while fences, JSX, and comments are untouched', () => {
  const context = fixture();
  const source = [
    '[`get_products`](/deliberate-target)',
    '[`get_products`](/deliberate-target#authored-section)',
    '[`get_products`](/docs/media-buy/task-reference/get_products#pricing)',
    '[`get_products` evidence requirements](/docs/media-buy/task-reference/get_products#audience-evidence)',
    '```md',
    '`KNOWN_ERROR`',
    '```',
    '<Component value={`KNOWN_ERROR`} />',
    '{/* `KNOWN_ERROR` */}',
    '',
  ].join('\n');
  assert.equal(transformDocument(source, context), source.replace(
    '[`get_products`](/deliberate-target)',
    '[`get_products`](/docs/media-buy/task-reference/get_products)',
  ));
  assert.deepEqual(context.errors, []);
});

test('explicit pseudo-links resolve or fail deterministically', () => {
  const resolved = fixture();
  assert.equal(
    transformDocument('[`get_products`](adcp:task/get_products)\n', resolved),
    '[`get_products`](/docs/media-buy/task-reference/get_products)\n',
  );

  const unknown = fixture();
  const source = '[`get_synthetic_unknown`](adcp:task/get_synthetic_unknown)\n';
  assert.equal(transformDocument(source, unknown), source);
  assert.match(unknown.errors[0], /unresolved task symbol `get_synthetic_unknown`/);

  const mismatch = fixture();
  transformDocument('[`get_products`](adcp:task/create_media_buy)\n', mismatch);
  assert.match(mismatch.errors[0], /must match inline code/);
});

test('synthetic unknowns fail only when the prose structurally claims a namespace', () => {
  const context = fixture();
  const source = [
    'The error code is `SYNTHETIC_UNKNOWN_ERROR`.',
    'Call the `get_synthetic_unknown` task.',
    'An environment constant `SYNTHETIC_ENV_VALUE` is not an error claim.',
    'A prose slug `get_unrelated_value` is just a value.',
    '',
  ].join('\n');
  assert.equal(transformDocument(source, context), source);
  assert.equal(context.errors.length, 2);
  assert.match(context.errors[0], /unresolved error_code symbol/);
  assert.match(context.errors[1], /unresolved task symbol/);
});

test('first-column error and task tables are high-confidence contexts', () => {
  const context = fixture();
  const source = [
    '| Error Code | Meaning |',
    '| --- | --- |',
    '| `SYNTHETIC_TABLE_ERROR` | no |',
    '',
    '| Task | Meaning |',
    '| --- | --- |',
    '| `get_synthetic_table_task` | no |',
    '',
  ].join('\n');
  transformDocument(source, context);
  assert.equal(context.errors.length, 2);
});

test('already-linked synthetic claims still fail', () => {
  const context = fixture();
  transformDocument([
    '| Task | Meaning |',
    '| --- | --- |',
    '| [`get_synthetic_linked`](/wrong) | no |',
    '',
  ].join('\n'), context);
  assert.match(context.errors[0], /unresolved task symbol `get_synthetic_linked`/);
});

test('a removed task remains blocking through its generated link target', () => {
  const context = fixture();
  transformDocument(
    'See [`removed_task`](/docs/media-buy/task-reference/removed_task) for details.\n',
    context,
  );
  assert.match(context.errors[0], /unresolved task symbol `removed_task`/);
});

test('storyboard IDs link while unqualified schema fields remain untouched', () => {
  const context = fixture();
  assert.equal(
    transformDocument('Field `get_field_value`; storyboard `get_products_pagination_integrity`\n', context),
    'Field `get_field_value`; storyboard ' +
      '[`get_products_pagination_integrity`](/compliance/latest/universal/get-products.yaml)\n',
  );
  assert.deepEqual(context.errors, []);
  assert.equal(context.warnings.length, 0);

  const advisory = fixture();
  assert.equal(
    transformDocument('Field `unknown_field_name` is implementation-defined.\n', advisory),
    'Field `unknown_field_name` is implementation-defined.\n',
  );
  assert.equal(advisory.warnings.length, 1);

  const qualified = fixture();
  assert.equal(
    transformDocument(
      '[`get_field_value`](adcp:field/core/example.json#/properties/get_field_value)\n',
      qualified,
    ),
    '[`get_field_value`](https://adcontextprotocol.org/schemas/v3/core/example.json#/properties/get_field_value)\n',
  );
});

test('colliding error namespaces use controller context and standard fallback', () => {
  const controller = fixture();
  assert.equal(
    transformDocument('The controller returns `INVALID_STATE`.\n', controller),
    'The controller returns [`INVALID_STATE`](/controller#error-codes).\n',
  );
  const standard = fixture({ file: 'docs/protocol/errors.mdx' });
  assert.equal(
    transformDocument('The response returns `INVALID_STATE`.\n', standard),
    'The response returns [`INVALID_STATE`](/errors#error-code-invalid-state).\n',
  );
});

test('nonstandard errors resolve only in their owning context', () => {
  const controller = fixture();
  assert.equal(
    transformDocument('Controller error code `INTERNAL_ERROR`.\n', controller),
    'Controller error code [`INTERNAL_ERROR`](/controller#error-codes).\n',
  );
  const unrelated = fixture({ file: 'docs/protocol/errors.mdx' });
  transformDocument('| Error Code | Meaning |\n| --- | --- |\n| `INTERNAL_ERROR` | no |\n', unrelated);
  assert.match(unrelated.errors[0], /unresolved error_code symbol `INTERNAL_ERROR`/);
});

test('existing links to scoped errors are removed outside their owning context', () => {
  const context = fixture({ file: 'docs/protocol/errors.mdx' });
  const unlinked = transformDocument(
    'The catalog has no generic [`INTERNAL_ERROR`](/controller#error-codes) error code.\n',
    context,
  );
  assert.equal(unlinked, 'The catalog has no generic `INTERNAL_ERROR` error code.\n');

  const entry = {
    family: 'error_code',
    path: context.file,
    reason: 'Intentional negative claim.',
    symbol: 'INTERNAL_ERROR',
  };
  const key = `${entry.path}\0${entry.family}\0${entry.symbol}`;
  const secondPass = fixture({ file: context.file, ignores: new Map([[key, entry]]) });
  assert.equal(transformDocument(unlinked, secondPass), unlinked);
  assert.deepEqual(secondPass.errors, []);
  assert.deepEqual(
    validateIgnoreUsage(secondPass.ignores, secondPass.usedIgnores, secondPass.authorities),
    [],
  );

  const trustedOnly = fixture();
  trustedOnly.authorities.errors.set('timeout', [
    { family: 'trusted-match', target: '/trusted#error-response' },
  ]);
  assert.equal(
    transformDocument('[`timeout`](/trusted#error-response)\n', trustedOnly),
    '`timeout`\n',
  );
});

test('ignore entries are page-specific, used, and removed when resolvable', () => {
  const entry = {
    family: 'error_code',
    path: 'docs/building/verification/example.mdx',
    reason: 'Fixture-only diagnostic.',
    symbol: 'RUNNER_DIAGNOSTIC',
  };
  const key = `${entry.path}\0${entry.family}\0${entry.symbol}`;
  const context = fixture({ ignores: new Map([[key, entry]]) });
  transformDocument('The error code is `RUNNER_DIAGNOSTIC`.\n', context);
  assert.deepEqual(context.errors, []);
  assert.deepEqual(
    validateIgnoreUsage(context.ignores, context.usedIgnores, context.authorities),
    [],
  );

  assert.match(
    validateIgnoreUsage(context.ignores, new Set(), context.authorities)[0],
    /unused ignore/,
  );
  context.authorities.errors.set('RUNNER_DIAGNOSTIC', [
    { family: 'standard', target: '/errors#error-code-runner-diagnostic' },
  ]);
  assert.match(
    validateIgnoreUsage(context.ignores, new Set([key]), context.authorities)[0],
    /now resolves/,
  );
});

test('unknown classifier distinguishes structural from advisory prose', () => {
  assert.equal(classifyUnknown('SYNTHETIC_ERROR', {
    source: 'Error code: `SYNTHETIC_ERROR`',
    start: 13,
  }), 'error_code');
  assert.equal(classifyUnknown('SYNTHETIC_ERROR', {
    source: 'Environment: `SYNTHETIC_ERROR`',
    start: 14,
  }), null);
});

test('transactional writes preserve modes and reject concurrent changes', t => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-symbol-write-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const relative = 'example.mdx';
  const file = path.join(repoRoot, relative);
  fs.writeFileSync(file, 'before\n', { mode: 0o640 });

  writeTransactional(repoRoot, [{
    after: 'after\n',
    before: 'before\n',
    mode: 0o640,
    relative,
  }]);
  const descriptor = fs.openSync(file, 'r+');
  try {
    const initial = Buffer.alloc(Buffer.byteLength('after\n'));
    assert.equal(fs.readSync(descriptor, initial, 0, initial.length, 0), initial.length);
    assert.equal(initial.toString('utf8'), 'after\n');
    assert.equal(fs.fstatSync(descriptor).mode & 0o777, 0o640);

    const concurrent = Buffer.from('concurrent\n');
    fs.ftruncateSync(descriptor, 0);
    fs.writeSync(descriptor, concurrent, 0, concurrent.length, 0);
    fs.fsyncSync(descriptor);
    assert.throws(() => writeTransactional(repoRoot, [{
      after: 'replacement\n',
      before: 'after\n',
      mode: 0o640,
      relative,
    }]), /changed while/);
    const observed = Buffer.alloc(concurrent.length);
    assert.equal(fs.readSync(descriptor, observed, 0, observed.length, 0), observed.length);
    assert.equal(observed.toString('utf8'), 'concurrent\n');
  } finally {
    fs.closeSync(descriptor);
  }
});

test('transactional writes roll back every destination after a rename failure', t => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-symbol-rollback-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const changes = ['one.mdx', 'two.mdx'].map(relative => {
    fs.writeFileSync(path.join(repoRoot, relative), `${relative}:before\n`);
    return {
      after: `${relative}:after\n`,
      before: `${relative}:before\n`,
      mode: 0o644,
      relative,
    };
  });
  let installs = 0;
  const link = (source, destination) => {
    installs += 1;
    if (installs === 2) throw new Error('injected install failure');
    fs.linkSync(source, destination);
  };
  assert.throws(
    () => writeTransactional(repoRoot, changes, { link }),
    /injected install failure/,
  );
  for (const change of changes) {
    assert.equal(fs.readFileSync(path.join(repoRoot, change.relative), 'utf8'), change.before);
  }
});

test('transactional writes do not clobber a destination recreated after backup', t => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-symbol-race-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const relative = 'example.mdx';
  const destination = path.join(repoRoot, relative);
  fs.writeFileSync(destination, 'before\n');
  let calls = 0;
  const rename = (source, backup) => {
    calls += 1;
    fs.renameSync(source, backup);
    if (calls === 1) fs.writeFileSync(destination, 'concurrent\n');
  };
  assert.throws(
    () => writeTransactional(repoRoot, [{
      after: 'generated\n',
      before: 'before\n',
      mode: 0o644,
      relative,
    }], { rename }),
    /Rollback incomplete/,
  );
  assert.equal(fs.readFileSync(destination, 'utf8'), 'concurrent\n');
  const backup = fs.readdirSync(repoRoot).find(name => name.includes('symbols-backup'));
  assert.ok(backup);
  assert.equal(fs.readFileSync(path.join(repoRoot, backup), 'utf8'), 'before\n');
});

test('transactional writes retain an original when rollback fails', t => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-symbol-recovery-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const changes = ['one.mdx', 'two.mdx'].map(relative => {
    fs.writeFileSync(path.join(repoRoot, relative), `${relative}:before\n`);
    return {
      after: `${relative}:after\n`,
      before: `${relative}:before\n`,
      mode: 0o644,
      relative,
    };
  });
  let links = 0;
  const link = (source, destination) => {
    links += 1;
    if (links === 2) throw new Error('injected commit failure');
    if (links === 3) throw new Error('injected rollback failure');
    fs.linkSync(source, destination);
  };
  assert.throws(
    () => writeTransactional(repoRoot, changes, { link }),
    /Rollback incomplete:[\s\S]*original retained/,
  );
  assert.equal(fs.readFileSync(path.join(repoRoot, 'one.mdx'), 'utf8'), 'one.mdx:before\n');
  assert.equal(fs.existsSync(path.join(repoRoot, 'two.mdx')), false);
  const backup = fs.readdirSync(repoRoot).find(
    name => name.startsWith('.two.mdx.adcp-symbols-backup-'),
  );
  assert.ok(backup);
  assert.equal(fs.readFileSync(path.join(repoRoot, backup), 'utf8'), 'two.mdx:before\n');
});

test('transactional rollback preserves same-inode concurrent edits', t => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-symbol-in-place-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const changes = ['one.mdx', 'two.mdx'].map(relative => {
    fs.writeFileSync(path.join(repoRoot, relative), `${relative}:before\n`);
    return {
      after: `${relative}:after\n`,
      before: `${relative}:before\n`,
      mode: 0o644,
      relative,
    };
  });
  let links = 0;
  const link = (source, destination) => {
    links += 1;
    if (links === 2) throw new Error('injected second install failure');
    fs.linkSync(source, destination);
    if (links === 1) fs.writeFileSync(destination, 'concurrent in-place edit\n');
  };
  assert.throws(
    () => writeTransactional(repoRoot, changes, { link }),
    /Recovery copies/,
  );
  assert.equal(fs.readFileSync(path.join(repoRoot, 'one.mdx'), 'utf8'), 'one.mdx:before\n');
  assert.equal(fs.readFileSync(path.join(repoRoot, 'two.mdx'), 'utf8'), 'two.mdx:before\n');
  const recovery = fs.readdirSync(repoRoot).find(
    name => name.startsWith('.one.mdx.adcp-symbols-recovery-'),
  );
  assert.ok(recovery);
  assert.equal(fs.readFileSync(path.join(repoRoot, recovery), 'utf8'), 'concurrent in-place edit\n');
});

test('transactional staging failures do not leak temporary files', t => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-symbol-staging-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repoRoot, 'example.mdx'), 'before\n');
  assert.throws(() => writeTransactional(repoRoot, [{
    after: 'after\n',
    before: 'before\n',
    mode: -1,
    relative: 'example.mdx',
  }]));
  assert.deepEqual(fs.readdirSync(repoRoot), ['example.mdx']);
});

test('task authority discovery prefers grouped headings and stable released-schema fallbacks', t => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-symbol-authority-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const write = (relative, content) => {
    const target = path.join(repoRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  write('static/schemas/source/media-buy/demo-task-request.json', '{}\n');
  write('static/schemas/source/media-buy/demo-task-response.json', '{}\n');
  write('static/schemas/source/protocol/get-task-status-request.json', '{}\n');
  write('static/schemas/source/protocol/get-task-status-response.json', '{}\n');
  write(
    'docs/media-buy/task-reference/grouped.mdx',
    '---\ntitle: Grouped\n---\n\n## demo_task\n',
  );
  write('dist/schemas/3.1.0/protocol/get-task-status-request.json', '{}\n');

  const tasks = discoverTaskAuthorities(repoRoot);
  assert.equal(
    tasks.get('demo_task').target,
    '/docs/media-buy/task-reference/grouped#demo_task',
  );
  assert.equal(
    tasks.get('get_task_status').target,
    'https://adcontextprotocol.org/schemas/v3/protocol/get-task-status-request.json',
  );
});

test('schema field authority loading fails closed on malformed JSON', t => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-symbol-fields-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const schemaDir = path.join(repoRoot, 'static/schemas/source/core');
  fs.mkdirSync(schemaDir, { recursive: true });
  fs.writeFileSync(path.join(schemaDir, 'bad.json'), '{not-json\n');
  assert.throws(() => collectSchemaFields(repoRoot), /bad\.json/);
});

test('actual tool discovery excludes the creative approval webhook payload', () => {
  const sourceDir = path.resolve('static/schemas/source');
  const tools = discoverTools(sourceDir);
  assert.equal(tools.some(tool => tool.name === 'creative_approval'), false);
});

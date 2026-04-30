// Test harness for remark-schema-links. Run via `npm run test:schema-links`.
//
// Asserts:
//   - bare `/schemas/...` rewrites per mode (prod → absolute, dev → localhost,
//     preview → no-op);
//   - absolute prod URLs rewrite to localhost in dev mode and stay untouched
//     in prod/preview;
//   - non-schema URLs and ref-syntax in code blocks are left alone in every
//     mode.

import assert from 'node:assert/strict';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import remarkMdx from 'remark-mdx';
import remarkSchemaLinks, { resolveSchemaUrl } from './plugin.mjs';

const SAMPLE = `# Schemas demo

See [\`viewability-standard.json\`](/schemas/enums/viewability-standard.json).

After autofix: [\`viewability-standard.json\`](https://adcontextprotocol.org/schemas/v3/enums/viewability-standard.json).

External: [docs](https://example.com/foo).

In-prose code: \`/schemas/enums/foo.json\` should be left alone.

\`\`\`json
{ "$ref": "/schemas/enums/foo.json" }
\`\`\`
`;

async function run(mode) {
  const out = await unified()
    .use(remarkParse)
    .use(remarkMdx)
    .use(remarkSchemaLinks, { mode })
    .use(remarkStringify)
    .process(SAMPLE);
  return String(out);
}

function regexFor(literal) {
  return new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

// 1. AST-level round-trip: bare paths.
const expectations = {
  dev: 'http://localhost:3000/schemas/latest/enums/viewability-standard.json',
  preview: 'https://adcontextprotocol.org/schemas/v3/enums/viewability-standard.json',
  prod: 'https://adcontextprotocol.org/schemas/v3/enums/viewability-standard.json',
};
for (const [mode, expected] of Object.entries(expectations)) {
  const out = await run(mode);
  assert.match(out, regexFor(expected), `[${mode}] expected URL not found:\n${out}`);
  assert.ok(out.includes('https://example.com/foo'), `[${mode}] external link mangled`);
  assert.ok(out.includes('`/schemas/enums/foo.json`'), `[${mode}] inline code rewritten`);
  assert.ok(out.includes('"$ref": "/schemas/enums/foo.json"'), `[${mode}] code block rewritten`);
  console.log(`✓ ${mode}: bare → ${expected}`);
}

// 2. Absolute prod URL handling per mode (the post-autofix common case).
const ABSOLUTE = 'https://adcontextprotocol.org/schemas/v3/enums/viewability-standard.json';
const LOCALHOST = 'http://localhost:3000/schemas/latest/enums/viewability-standard.json';

const devOut = await run('dev');
assert.ok(devOut.includes(LOCALHOST), `dev did not rewrite absolute prod URL to localhost:\n${devOut}`);
assert.ok(!devOut.includes(`(${ABSOLUTE})`), `dev left an absolute prod URL un-rewritten:\n${devOut}`);
console.log(`✓ dev: absolute prod URL → ${LOCALHOST}`);

for (const mode of ['prod', 'preview']) {
  const out = await run(mode);
  assert.ok(out.includes(ABSOLUTE), `[${mode}] absolute prod URL was modified:\n${out}`);
  assert.ok(!out.includes(LOCALHOST), `[${mode}] localhost URL leaked into output:\n${out}`);
  console.log(`✓ ${mode}: absolute prod URL untouched`);
}

// 3. Direct resolver checks (non-link consumers like the linter regex).
assert.equal(resolveSchemaUrl('/schemas/enums/foo.json', 'prod'), 'https://adcontextprotocol.org/schemas/v3/enums/foo.json');
assert.equal(resolveSchemaUrl('https://adcontextprotocol.org/schemas/v3/enums/foo.json', 'prod'), null);
assert.equal(resolveSchemaUrl('/schemas/enums/foo.json', 'dev'), 'http://localhost:3000/schemas/latest/enums/foo.json');
assert.equal(resolveSchemaUrl('https://adcontextprotocol.org/schemas/v3/enums/foo.json', 'dev'), 'http://localhost:3000/schemas/latest/enums/foo.json');
assert.equal(resolveSchemaUrl('https://example.com/other', 'dev'), null);
assert.equal(resolveSchemaUrl('https://example.com/other', 'prod'), null);
console.log('✓ resolveSchemaUrl direct cases');

console.log('\nAll cases pass.');

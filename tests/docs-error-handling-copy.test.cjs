const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('error-handling source keeps one Discriminated rejection arms paragraph', () => {
  const file = path.join(
    __dirname,
    '../docs/building/by-layer/L3/error-handling.mdx'
  );
  const content = fs.readFileSync(file, 'utf8');
  const matches = content.match(/\*\*Discriminated rejection arms\.\*\*/g) || [];

  assert.equal(matches.length, 1);
});

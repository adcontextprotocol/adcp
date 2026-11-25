'use strict';
// Guard fixture: one inner test fails; nothing else is wrong.
const assert = require('node:assert/strict');
const test = require('node:test');

test('passes', () => {});
test('fails on purpose', () => {
  assert.fail('deliberate failure in the guard fixture');
});

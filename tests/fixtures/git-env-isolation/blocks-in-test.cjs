'use strict';
// Guard fixture: a synchronous test that blocks far longer than the guard's
// test timeout. node:test cannot time out a synchronous test, so only the
// guard's progress watchdog can stop it.
const test = require('node:test');

test('passes first', () => {});
test('blocks past the timeout', () => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
});

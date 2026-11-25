'use strict';
// Guard fixture: an inner test that waits far longer than the guard's test
// timeout. The child's own runner must stop it.
const test = require('node:test');

test('waits past the timeout', () => new Promise((resolve) => setTimeout(resolve, 60_000)));

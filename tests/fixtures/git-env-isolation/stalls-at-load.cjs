'use strict';
// Guard fixture: blocks at load, before any test starts, so no test timeout
// applies. It writes its pid first (ISOLATION_FIXTURE_PID_DIR) so the
// meta-test can check that the guard killed it.
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

if (process.env.ISOLATION_FIXTURE_PID_DIR) {
  fs.writeFileSync(path.join(process.env.ISOLATION_FIXTURE_PID_DIR, 'stalls-at-load.pid'), String(process.pid));
}
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);

test('never reached in time', () => {});

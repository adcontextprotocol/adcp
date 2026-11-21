'use strict';
// Guard fixture: passes, but runs git with the inherited hook environment, so
// it writes to the caller repository (the fault the guard exists to catch).
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const test = require('node:test');

test('writes a key through the inherited GIT_DIR', () => {
  execFileSync('git', ['config', 'guard-fixture.wrote', 'yes'], { cwd: os.tmpdir(), stdio: 'ignore' });
});

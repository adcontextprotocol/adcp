'use strict';
// Guard fixture (tests/git-env-isolation-guard.test.cjs): a file that passes
// and touches no repository. Named without `.test.` so no runner collects it.
// It forks itself once: the guard's progress preload must stay inert in a
// forked process, whose stdout would otherwise carry a test report.
const { fork } = require('node:child_process');

if (process.argv[2] === 'forked') {
  process.stdout.write('forked ok\n');
} else {
  const assert = require('node:assert/strict');
  const test = require('node:test');

  test('passes', () => {});
  test('a forked process writes only its own output', async () => {
    const child = fork(__filename, ['forked'], { stdio: ['ignore', 'pipe', 'inherit', 'ipc'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    await new Promise((resolve) => child.once('close', resolve));
    assert.equal(output, 'forked ok\n');
  });
}

'use strict';
/**
 * Preloaded (--require) into a node:test file by tests/git-env-isolation.test.cjs:
 * appends one line to $TEST_PROGRESS_FILE each time a test starts or ends.
 *
 * node:test runs synchronous tests back to back without returning to the
 * event loop, so neither reporter events nor --test-timeout reach a file of
 * synchronous tests until it ends. A root beforeEach/afterEach hook runs
 * between tests regardless, and appendFileSync writes at once, so the guard
 * sees each test start and end as it happens.
 *
 * Only the test file's own process takes part: node --test also loads the
 * preload into its runner, which has no NODE_TEST_CONTEXT, and the variable is
 * removed here so a process the file forks (which inherits --require and the
 * environment) stays inert.
 */

const fs = require('node:fs');

const progressFile = process.env.TEST_PROGRESS_FILE;
if (progressFile && process.env.NODE_TEST_CONTEXT) {
  delete process.env.TEST_PROGRESS_FILE;
  const { afterEach, beforeEach } = require('node:test');
  const mark = (event) => (t) => fs.appendFileSync(progressFile, `${Date.now()} ${event} ${t.name}\n`);
  beforeEach(mark('start'));
  afterEach(mark('end'));
}

// vitest reporter for tests/git-env-isolation.test.cjs: appends one line to
// $TEST_PROGRESS_FILE as each test starts and ends, the vitest counterpart of
// tests/helpers/test-progress-hooks.cjs. It runs in vitest's main process,
// which hears from the test workers as tests start and finish.
import fs from 'node:fs';

export default class ProgressReporter {
  #file = process.env.TEST_PROGRESS_FILE;

  #mark(event, testCase) {
    if (this.#file) fs.appendFileSync(this.#file, `${Date.now()} ${event} ${testCase.name}\n`);
  }

  onTestCaseReady(testCase) {
    this.#mark('start', testCase);
  }

  onTestCaseResult(testCase) {
    this.#mark('end', testCase);
  }
}

'use strict';
/**
 * Preloaded (--require) into `node --test` commands whose per-test results are
 * read (scripts/profile-precommit.mjs instrument()): makes a test file's
 * stdout blocking, so --test-force-exit cannot drop the file's last results.
 *
 * Under `node --test`, each file runs in a child process that sends its test
 * events to the runner over stdout, a non-blocking socket. With
 * --test-force-exit the child calls process.exit() once its reporter has
 * handed the last event to stdout, and any write the runner has not read yet
 * is discarded (up to 64 KiB). The runner then reports fewer tests than ran
 * and still exits 0 (nodejs/node#64833; fix PR nodejs/node#64875). Remove
 * this preload once the pinned Node includes that fix.
 *
 * With stdout blocking, each write completes before the next one starts. A
 * runner that reads slowly makes the file wait instead of losing events.
 * Without the preload, the runner's backpressure already holds the file
 * process until the runner reads, so this adds no new way to stall.
 *
 * Only the test file's own process takes part. The runner also loads the
 * preload, but it has no NODE_TEST_CONTEXT. A process that the file starts
 * inherits NODE_TEST_CONTEXT, so the marker variable keeps it inert.
 */

const MARKER = 'ADCP_NODE_TEST_STDOUT_BLOCKING';

if (process.env.NODE_TEST_CONTEXT === 'child-v8' && !process.env[MARKER]) {
  process.env[MARKER] = '1';
  process.stdout._handle?.setBlocking?.(true);
}

'use strict';

/**
 * Test-only forwarder for the modern storyboard runner.
 *
 * `inline_creatives_without_sync` gates its three canonical paths with
 * `skip_if` expressions that read captured context. The root project's
 * production `@adcp/sdk` 9.6.2 only evaluates `test_kit.*` in `skip_if`, so it
 * cannot execute that storyboard at all. This workspace pins a published
 * 15.9.2 purely for the regression tests; the server keeps 9.6.2.
 *
 * Only the public `/testing` surface is forwarded. Do not add forwarders for
 * anything the regression tests do not need, and never import this from
 * `server/` — runtime code must keep using `@adcp/sdk`.
 */
module.exports = require('@adcp/sdk/testing');

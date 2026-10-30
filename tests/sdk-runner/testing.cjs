'use strict';

/** Test-only runner: production code continues using @adcp/sdk 9.6.2. */
const path = require('node:path');
const testing = require('@adcp/sdk/testing');
const version = require('../../package.json').version;

module.exports = {
  ...testing,
  runStoryboard(agentUrl, storyboard, options = {}) {
    return testing.runStoryboard(agentUrl, storyboard, {
      // Untagged in-process fakes intentionally have no transport pin. The
      // declared server version still selects the real 3.1 schema and wire
      // compatibility rules; real clients receive an explicit release pin.
      ...(options._client ? { _serverAdcpVersion: version } : { adcpVersion: version }),
      schemaRoot: path.join(__dirname, '../../dist/schemas', version),
      ...options,
    });
  },
};

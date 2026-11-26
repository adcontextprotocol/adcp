'use strict';

const fs = require('node:fs');
const path = require('node:path');
const semver = require('semver');

/**
 * The stable `@adcp/sdk` on npm `latest`. Learner- and production-facing
 * guidance names it while the repository runs an SDK prerelease for a
 * protocol beta: the training agent still serves the stable line by default,
 * and its users must not be told to install a beta.
 *
 * When `package.json` returns to a stable SDK, set this to that version;
 * `sdkCheckpoints()` refuses a stale value.
 */
const STABLE_SDK_VERSION = '17.0.0';

function installedSdkVersion() {
  const packageJson = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8'),
  );
  return packageJson.dependencies['@adcp/sdk'];
}

/**
 * `installed`: the exact SDK the repository runs (runtime provenance, beta docs).
 * `stable`: the SDK that learner and production guidance names.
 */
function sdkCheckpoints() {
  const installed = installedSdkVersion();
  const prerelease = semver.prerelease(installed) !== null;
  if (semver.prerelease(STABLE_SDK_VERSION) !== null) {
    throw new Error(`STABLE_SDK_VERSION ${STABLE_SDK_VERSION} must be a stable release`);
  }
  if (!prerelease && STABLE_SDK_VERSION !== installed) {
    throw new Error(
      `package.json installs stable @adcp/sdk ${installed}; set STABLE_SDK_VERSION in tests/helpers/sdk-checkpoint.cjs to match`,
    );
  }
  if (prerelease && semver.major(STABLE_SDK_VERSION) >= semver.major(installed)) {
    throw new Error(
      `STABLE_SDK_VERSION ${STABLE_SDK_VERSION} must be an earlier major than the installed prerelease ${installed}`,
    );
  }
  return { installed, stable: prerelease ? STABLE_SDK_VERSION : installed, prerelease };
}

module.exports = { STABLE_SDK_VERSION, sdkCheckpoints };

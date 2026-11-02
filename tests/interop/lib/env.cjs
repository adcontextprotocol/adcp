'use strict';

/**
 * Where the interop harness finds the SDKs (see tests/interop/setup-env.sh), and
 * how it starts their processes with the pinned time zone data.
 */

const { createRequire } = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const INTEROP = path.resolve(__dirname, '..');
const ENV_DIR = process.env.ADCP_INTEROP_ENV || path.join(os.tmpdir(), 'adcp-interop-env');
/** The IANA release vectors.json pins; both SDK processes are started on it. */
const TZDATA = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'static/compliance/source/test-vectors/reporting-subscriptions/vectors.json'), 'utf8'),
).tzdata.version;

const PYTHON = path.join(ENV_DIR, 'py', 'bin', 'python');
const NODE_PREFIX = path.join(ENV_DIR, 'node');
const ICU_DIR = path.join(ENV_DIR, 'icu', TZDATA);

function readVersion(file) {
  try {
    return fs.readFileSync(path.join(ENV_DIR, file), 'utf8').trim();
  } catch {
    return 'unknown';
  }
}

/** require() from the isolated npm prefix, so the harness never picks up the repository's own packages. */
function sdkRequire() {
  return createRequire(path.join(NODE_PREFIX, 'package.json'));
}

/** Environment for a child process: Node reads ICU zones from ICU_DIR, Python from the tzdata wheel only. */
function childEnv(extra = {}) {
  return {
    ...process.env,
    ICU_TIMEZONE_FILES_DIR: ICU_DIR,
    ADCP_INTEROP_ENV: ENV_DIR,
    ADCP_INTEROP_TZDATA: TZDATA,
    PYTHONTZPATH: '',
    PYTHONDONTWRITEBYTECODE: '1',
    NODE_ENV: 'test',
    ...extra,
  };
}

function checkEnv() {
  const missing = [];
  if (!fs.existsSync(PYTHON)) missing.push(PYTHON);
  if (!fs.existsSync(path.join(NODE_PREFIX, 'node_modules', '@adcp', 'sdk'))) missing.push(`${NODE_PREFIX}/node_modules/@adcp/sdk`);
  if (!fs.existsSync(path.join(ICU_DIR, 'zoneinfo64.res'))) missing.push(`${ICU_DIR}/zoneinfo64.res`);
  if (missing.length) {
    throw new Error(`interop environment incomplete (run tests/interop/setup-env.sh with ADCP_INTEROP_ENV=${ENV_DIR}): missing ${missing.join(', ')}`);
  }
}

module.exports = {
  ROOT,
  INTEROP,
  ENV_DIR,
  TZDATA,
  PYTHON,
  NODE_PREFIX,
  ICU_DIR,
  sdkRequire,
  childEnv,
  checkEnv,
  versions: () => ({ ts: readVersion('node-sdk-version'), py: readVersion('py-sdk-version'), tzdata: TZDATA }),
};

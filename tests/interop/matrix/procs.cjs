'use strict';

/**
 * Process plumbing for the interop matrix (CONTRACT.txt): start a seller, call
 * its control route, run a buyer command.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');
const env = require('../lib/env.cjs');

const SIDES = {
  ts: {
    seller: [process.execPath, [path.join(__dirname, 'ts', 'seller.mjs')]],
    buyer: [process.execPath, [path.join(__dirname, 'ts', 'buyer.mjs')]],
  },
  py: {
    seller: [env.PYTHON, ['-I', path.join(__dirname, 'py', 'seller.py')]],
    buyer: [env.PYTHON, ['-I', path.join(__dirname, 'py', 'buyer.py')]],
  },
};

/** Start a seller; resolves to { sdk, sdkVersion, mcp, control, stop(), stderr() }. */
function startSeller(sdk, start, { stateDir, timeoutMs = 180_000 } = {}) {
  const [command, args] = SIDES[sdk].seller;
  const child = spawn(command, [...args, '--start', start], {
    env: env.childEnv({ ADCP_INTEROP_STATE_DIR: stateDir }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => {
    stderr = (stderr + chunk).slice(-200_000);
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${sdk} seller did not become ready in ${timeoutMs} ms:\n${stderr.slice(-4000)}`));
    }, timeoutMs);
    child.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`${sdk} seller exited ${code} before ready:\n${stderr.slice(-4000)}`));
    });
    readline.createInterface({ input: child.stdout }).on('line', line => {
      let ready;
      try {
        ready = JSON.parse(line);
      } catch {
        return;
      }
      if (!ready.ready) return;
      clearTimeout(timer);
      child.removeAllListeners('exit');
      resolve({
        sdk,
        sdkVersion: ready.sdk_version,
        mcp: ready.mcp,
        control: ready.control,
        stderr: () => stderr,
        stop: () =>
          new Promise(done => {
            if (child.exitCode !== null) return done();
            child.once('exit', () => done());
            child.kill('SIGTERM');
            setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 5000).unref();
          }),
      });
    });
  });
}

async function control(seller, body) {
  const response = await fetch(seller.control, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${seller.sdk} control ${body.op}: HTTP ${response.status} ${text.slice(0, 500)}`);
  }
  if (!json.ok) throw new Error(`${seller.sdk} control ${body.op}: ${json.error}`);
  return json;
}

/** Run one buyer command; resolves to its JSON result (ok or not), with stderr attached on failure. */
function buyer(sdk, command, args, { stateDir, timeoutMs = 180_000 } = {}) {
  const [bin, binArgs] = SIDES[sdk].buyer;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...binArgs, command], {
      env: env.childEnv({ ADCP_INTEROP_STATE_DIR: stateDir }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr = (stderr + chunk).slice(-100_000)));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', reject);
    child.on('exit', code => {
      clearTimeout(timer);
      const line = stdout.trim().split('\n').pop();
      try {
        const result = JSON.parse(line);
        if (!result.ok) result.stderr = stderr.slice(-3000);
        resolve(result);
      } catch {
        resolve({ ok: false, error: `${sdk} buyer ${command} exited ${code} without JSON`, stderr: stderr.slice(-3000) });
      }
    });
    child.stdin.end(JSON.stringify(args));
  });
}

module.exports = { SIDES, startSeller, control, buyer };

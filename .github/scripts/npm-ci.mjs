#!/usr/bin/env node
// CI-only, Linux x64: one normal npm ci retry for the observed 0.9.4 failure.
import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createReadStream, mkdtempSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

async function matchesFailure(log) {
  const root = join(process.cwd(), 'node_modules/@contentauth/c2pa-node');
  // Match npm's contiguous stderr error block, including the package path,
  // exact release/version/platform, download-to-build transition and manifest.
  // Checking for a release alone does NOT establish a failed download.
  const expected = [
    'npm error code 1',
    `npm error path ${root}`,
    'npm error command failed',
    'npm error command sh -c node scripts/postinstall.cjs',
    "npm error Detected { arch: 'x64', platform: 'linux' }",
    'npm error Checking for a release at: https://github.com/contentauth/c2pa-js/releases/download/%40contentauth%2Fc2pa-node%400.9.4/c2pa-node_x86_64-unknown-linux-gnu-v0.9.4.zip',
    'npm error 🦀 Building Rust...',
    `npm error ERROR: Error: Command failed: npx cargo-cp-artifact -nc "${root}/dist/index.node" -- cargo build --message-format=json-render-diagnostics --release --manifest-path="${root}/Cargo.toml"`,
    `npm error error: failed to parse manifest at \`${root}/Cargo.toml\``,
    'npm error',
    'npm error Caused by:',
    "npm error   error inheriting `rust-version` from workspace root manifest's `workspace.package.rust-version`",
    'npm error',
    'npm error Caused by:',
    'npm error   failed to find a workspace root',
    'npm error Did not copy "cdylib:c2pa-node"',
  ];
  let index = 0;
  let codes = 0;
  let paths = 0;
  for await (const raw of createInterface({ input: createReadStream(log), crlfDelay: Infinity })) {
    const line = raw.trimEnd();
    if (line.startsWith('npm error code ')) codes++;
    if (line.startsWith('npm error path ')) paths++;
    if (index === 0 && line !== expected[0]) continue;
    if (index < expected.length) {
      if (line !== expected[index]) return false;
      index++;
    }
  }
  return index === expected.length && codes === 1 && paths === 1;
}

// Injectable clock/randomness for offline tests; the CLI always uses these defaults.
export async function runNpmCi({ jitter = randomInt, sleep = delay } = {}) {
  const outputs = [process.stdout, process.stderr];
  const failedOutputs = new Set();
  const outputHandlers = outputs.map(output => () => failedOutputs.add(output));
  // A disconnected live-log consumer must not crash the wrapper or stop capture.
  outputs.forEach((output, index) => output.on('error', outputHandlers[index]));
  const logDir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'adcp-npm-ci-'));
  console.error(`npm ci logs (runner-local): ${JSON.stringify(logDir)}`);
  const backoff = new AbortController();
  let child;
  let interrupted;
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  function forwardSignal(signal) {
    interrupted ??= signal;
    backoff.abort();
    if (child?.pid) {
      try {
        // npm's lifecycle shell and Cargo must receive cancellation too.
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
  }
  const handlers = signals.map(signal => () => forwardSignal(signal));
  signals.forEach((signal, index) => process.on(signal, handlers[index]));

  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (interrupted) break;
      let captureFailed = false;
      const files = ['stdout', 'stderr'].map(stream => join(logDir, `attempt-${attempt}.${stream}.log`));
      const fds = files.map(file => openSync(file, 'wx', 0o600));
      // Fixed executable/arguments, no shell or flags; inherit ordinary npm config.
      child = spawn('npm', ['ci'], { detached: true, stdio: ['inherit', 'pipe', 'pipe'] });
      const result = new Promise(resolve => {
        child.once('error', error => resolve({ code: error.code === 'ENOENT' ? 127 : 126 }));
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
      const copies = [child.stdout, child.stderr].map((input, index) => pipeline(input, new Writable({
        write(chunk, encoding, callback) {
          try {
            writeFileSync(fds[index], chunk);
          } catch {
            captureFailed = true;
          }
          // Backpressure and completion callbacks preserve live, untruncated output.
          const output = outputs[index];
          if (failedOutputs.has(output)) return callback();
          output.write(chunk, encoding, error => {
            if (error) failedOutputs.add(output);
            // Always keep draining npm into the private log, even after EPIPE.
            callback();
          });
        },
      })));
      const copying = Promise.allSettled(copies);
      const { code, signal } = await result;
      const copied = await copying;
      child = undefined;
      fds.forEach(fd => closeSync(fd));
      captureFailed ||= copied.some(copy => copy.status === 'rejected');
      if (captureFailed || failedOutputs.size) console.error('npm ci log capture/forwarding failed; retry disabled.');
      interrupted ??= signal;
      process.exitCode = code ?? 1;
      if (interrupted || code !== 1 || attempt === 2 || captureFailed || failedOutputs.size || !(await matchesFailure(files[1]))) break;
      const milliseconds = jitter(1000, 5001);
      if (!Number.isInteger(milliseconds) || milliseconds < 1000 || milliseconds > 5000) {
        throw new RangeError('CI install retry delay must be between 1000 and 5000 ms.');
      }
      console.error(`Known C2PA 0.9.4 download/workspace fallback failure; waiting ${milliseconds} ms before retry.`);
      try {
        await sleep(milliseconds, undefined, { signal: backoff.signal });
      } catch (error) {
        if (!interrupted || error.name !== 'AbortError') throw error;
      }
      if (interrupted || failedOutputs.size) break;
      console.error('retrying normal npm ci once (attempt 2/2).');
    }
  } finally {
    // Drain diagnostics while error/signal handlers are still installed. The
    // next event-loop turn also lets write callbacks' pending error events fire.
    await Promise.all(outputs.map(output => new Promise(resolve => {
      if (output.destroyed) resolve();
      else output.write('', resolve);
    })));
    await new Promise(resolve => setImmediate(resolve));
    outputs.forEach((output, index) => output.off('error', outputHandlers[index]));
    signals.forEach((signal, index) => process.off(signal, handlers[index]));
  }
  if (interrupted) process.kill(process.pid, interrupted);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runNpmCi();
}

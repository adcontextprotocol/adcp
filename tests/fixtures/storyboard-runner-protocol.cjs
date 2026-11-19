'use strict';

/**
 * The fake runners' side of the storyboard runner protocol, shared by
 * tests/fixtures/storyboard-isolation-runner.cjs and
 * tests/fixtures/storyboard-matrix-runner.cjs. Each runner supplies only its
 * storyboard behaviors; how a storyboard is framed lives here, once.
 *
 * Single mode (--storyboard-id <id>): run that storyboard and exit 0 when its
 * handler finishes.
 *
 * Worker mode (--storyboard-worker): read storyboard ids from stdin, one per
 * line, and run them in order. Per id:
 *   stdout  ADCP_STORYBOARD_BEGIN {"version":1,"storyboard_id":"<id>"}
 *   stdout  the storyboard's own output (the handler)
 *   stdout  ADCP_STORYBOARD_RESULT <envelope>        (the handler: ctx.result)
 *   stderr  ADCP_STORYBOARD_END {"version":1,"storyboard_id":"<id>","heap_used_bytes":<int>}
 * then the next id. An id the runner does not know makes the worker exit 2;
 * stdin closing makes an idle worker exit 0.
 *
 * handler(id, ctx) may be async; the storyboard is finished when it settles.
 * Then single mode exits 0 and worker mode sends END (unless ctx.end already
 * did) and reads the next id. ctx:
 *   mode               'single' or 'worker'
 *   sequence           1-based position of this storyboard in this process
 *   out(line)          one stdout line
 *   err(line)          one stderr line
 *   write(fd, text)    raw text to fd 1 or 2
 *   result(envelope)   the ADCP_STORYBOARD_RESULT line
 *   end(heapUsedBytes) the END marker now (worker mode only; default: the
 *                      real process.memoryUsage().heapUsed)
 *   hang()             a promise that never settles and keeps the process alive
 *   onNextBegin(fn)    run fn right after the next storyboard's BEGIN line
 *                      (worker mode only): models late async work from this
 *                      storyboard that lands in the next one's window
 *
 * Every write is synchronous (fs.writeSync, retried on EAGAIN), so each pipe
 * carries exactly the order the handler wrote.
 */

const fs = require('node:fs');

const BEGIN_PREFIX = 'ADCP_STORYBOARD_BEGIN ';
const END_PREFIX = 'ADCP_STORYBOARD_END ';
const RESULT_PREFIX = 'ADCP_STORYBOARD_RESULT ';

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function writeAll(fd, text) {
  const buffer = Buffer.from(text);
  let offset = 0;
  while (offset < buffer.length) {
    try {
      offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
    } catch (error) {
      if (error?.code !== 'EAGAIN') throw error;
      sleepSync(1);
    }
  }
}

function hang() {
  return new Promise(() => {
    setInterval(() => {}, 1_000);
  });
}

function storyboardMode(args) {
  if (args.includes('--storyboard-worker')) return 'worker';
  return args.includes('--storyboard-id') ? 'single' : undefined;
}

/**
 * Runs the storyboard(s) the arguments ask for.
 *   args          the runner's argv (after the script)
 *   isApplicable  id => boolean
 *   handler       (id, ctx) => void | Promise
 *   onRun         ({ storyboard_id, sequence }) => void, once per storyboard
 *                 this process starts (before its BEGIN line)
 */
function runStoryboards({ args, isApplicable, handler, onRun = () => {} }) {
  const mode = storyboardMode(args);
  let sequence = 0;
  let nextBegin = [];

  const contextFor = (storyboardId, state) => ({
    mode,
    sequence,
    out: line => writeAll(1, `${line}\n`),
    err: line => writeAll(2, `${line}\n`),
    write: (fd, text) => writeAll(fd, text),
    result: envelope => writeAll(1, `${RESULT_PREFIX}${JSON.stringify(envelope)}\n`),
    end(heapUsedBytes = process.memoryUsage().heapUsed) {
      if (mode !== 'worker' || state.ended) return;
      state.ended = true;
      writeAll(2, `${END_PREFIX}${JSON.stringify({
        version: 1,
        storyboard_id: storyboardId,
        heap_used_bytes: heapUsedBytes,
      })}\n`);
    },
    hang,
    onNextBegin(fn) {
      if (mode === 'worker') nextBegin.push(fn);
    },
  });

  if (mode === 'single') {
    const index = args.indexOf('--storyboard-id');
    const storyboardId = args[index + 1];
    if (!storyboardId || !isApplicable(storyboardId)) process.exit(2);
    sequence = 1;
    onRun({ storyboard_id: storyboardId, sequence });
    Promise.resolve(handler(storyboardId, contextFor(storyboardId, { ended: false })))
      .then(() => process.exit(0));
    return;
  }
  // Neither --storyboard-id nor --storyboard-worker: nothing to run.
  if (mode !== 'worker') process.exit(2);

  const pending = [];
  let buffered = '';
  let busy = false;
  let closed = false;

  const runOne = async (storyboardId) => {
    if (!isApplicable(storyboardId)) process.exit(2);
    sequence += 1;
    onRun({ storyboard_id: storyboardId, sequence });
    writeAll(1, `${BEGIN_PREFIX}${JSON.stringify({ version: 1, storyboard_id: storyboardId })}\n`);
    const callbacks = nextBegin;
    nextBegin = [];
    for (const callback of callbacks) callback();
    const state = { ended: false };
    const ctx = contextFor(storyboardId, state);
    await handler(storyboardId, ctx);
    ctx.end();
  };

  const pump = () => {
    if (busy) return;
    const storyboardId = pending.shift();
    if (storyboardId === undefined) {
      if (closed) process.exit(0);
      return;
    }
    busy = true;
    runOne(storyboardId).then(() => {
      busy = false;
      pump();
    });
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffered += chunk;
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      const storyboardId = line.trim();
      if (storyboardId) pending.push(storyboardId);
    }
    pump();
  });
  process.stdin.on('end', () => {
    closed = true;
    pump();
  });
}

module.exports = {
  BEGIN_PREFIX,
  END_PREFIX,
  RESULT_PREFIX,
  hang,
  runStoryboards,
  sleepSync,
  storyboardMode,
  writeAll,
};

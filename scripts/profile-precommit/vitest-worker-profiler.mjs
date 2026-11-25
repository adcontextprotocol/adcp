// Profiles a vitest forks-pool worker and writes its profiles before vitest
// stops it. A profiling run loads it into each worker with
// --execArgv=--import=<URL>, the URL from vitest-worker-profiler-url.cjs,
// whose query names the CPU and heap profile directories.
//
// Node writes a --cpu-prof or --heap-prof profile at exit. vitest stops a fork
// with SIGTERM as soon as the fork answers its stop request, and with SIGKILL
// 500 ms later; on a loaded machine the exit-time write takes longer than that
// and the profile is lost. This module runs the same samplers through
// node:inspector, with Node's default intervals (1 ms; 512 KiB), and writes
// both profiles under Node's file names when the stop request arrives, before
// vitest answers it. The write is finished before any signal is sent.
//
// --cpu-prof and --heap-prof in NODE_OPTIONS still profile every other
// process and worker thread, the worker's own threads included. In the worker
// itself they run beside this module's samplers, so the worker then stays up
// until vitest's SIGTERM ends it, and Node's exit-time write of a second copy
// never runs. (The heap sampler is one per isolate: this module stops the one
// --heap-prof started and writes its profile.)
//
// Only vitest's fork workers are profiled here. A process the worker forks
// inherits the --import but is left to NODE_OPTIONS.
import { Session } from 'node:inspector';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const encoded = new URL(import.meta.url).searchParams.get('dirs');
const { cpu: cpuDir, heap: heapDir } = encoded ? JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) : {};
const isVitestFork = typeof process.send === 'function'
  && /[\\/]vitest[\\/]dist[\\/]workers[\\/]forks\.js$/.test(process.argv[1] ?? '');

if ((cpuDir || heapDir) && isVitestFork) {
  const session = new Session();
  session.connect();
  // A same-thread session answers each message before post() returns.
  const post = (method, args) => {
    let failure;
    let result;
    session.post(method, args, (error, value) => { failure = error; result = value; });
    if (failure) throw failure;
    return result;
  };
  if (cpuDir) {
    post('Profiler.enable');
    post('Profiler.setSamplingInterval', { interval: 1000 });
    post('Profiler.start');
  }
  if (heapDir) {
    post('HeapProfiler.enable');
    post('HeapProfiler.startSampling', { samplingInterval: 512 * 1024 });
  }

  // Node's file name: <kind>.<yyyymmdd>.<hhmmss>.<pid>.<thread>.<seq>.<ext>
  const fileName = (kind, ext) => {
    const at = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const day = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`;
    const time = `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
    return `${kind}.${day}.${time}.${process.pid}.0.001.${ext}`;
  };
  // A failed write is reported in Node's wording, which profile-precommit
  // lists in report.json as profile_write_errors.
  const save = (dir, kind, ext, take) => {
    const target = path.join(dir, fileName(kind, ext));
    try {
      const { profile } = take();
      mkdirSync(dir, { recursive: true });
      writeFileSync(target, JSON.stringify(profile));
    } catch (error) {
      process.stderr.write(`${error.code ?? 'EPROFILE'}: Failed to write file ${target}: ${error.message}\n`);
    }
  };

  let written = false;
  const writeProfiles = () => {
    if (written) return;
    written = true;
    if (cpuDir) save(cpuDir, 'CPU', 'cpuprofile', () => post('Profiler.stop'));
    if (heapDir) save(heapDir, 'Heap', 'heapprofile', () => post('HeapProfiler.stopSampling'));
    session.disconnect();
  };
  // Registered before vitest's worker code, so it runs first on the stop
  // request (vitest's runtime/workers/init.ts, case "stop").
  process.on('message', (message) => {
    if (message?.__vitest_worker_request__ !== true || message.type !== 'stop') return;
    writeProfiles();
    // Stay up until vitest's SIGTERM; leave if vitest is gone.
    const hold = setInterval(() => {}, 60_000);
    process.once('disconnect', () => clearInterval(hold));
  });
  // A worker that exits before it is stopped (a crash, process.exit).
  process.on('exit', writeProfiles);
}

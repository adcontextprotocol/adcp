'use strict';
/**
 * GNU `timeout` semantics for hosts without coreutils, as the release scripts
 * use it: timeout [--kill-after=DURATION] [--signal=SIGNAL] DURATION COMMAND [ARG]...
 *
 * - DURATION is a number (fractions allowed) with an optional s, m, h or d
 *   suffix; 0 disables the limit.
 * - COMMAND runs in its own process group. At DURATION the group gets SIGNAL
 *   (SIGTERM by default), and SIGKILL after --kill-after if it is still alive.
 * - Exit status: 124 when the limit was hit, 137 when SIGKILL had to be sent,
 *   125 for a usage error, 126 when COMMAND cannot run, 127 when it is not
 *   found, 128+n when COMMAND died of signal n, else COMMAND's own status.
 * - SIGINT, SIGTERM and SIGHUP sent to timeout are passed to the group.
 */

const { spawn } = require('node:child_process');
const os = require('node:os');

const UNITS = { '': 1, s: 1, m: 60, h: 3600, d: 86400 };

function usage(message) {
  process.stderr.write(`timeout: ${message}\n`);
  process.exit(125);
}

function duration(text) {
  const match = /^(\d+(?:\.\d*)?|\.\d+)([smhd]?)$/.exec(text ?? '');
  if (!match) usage(`invalid time interval '${text}'`);
  return Number(match[1]) * UNITS[match[2]] * 1000;
}

function signalName(text) {
  const name = /^\d+$/.test(text)
    ? Object.keys(os.constants.signals).find((key) => os.constants.signals[key] === Number(text))
    : `SIG${text.replace(/^SIG/, '')}`;
  if (!name || !(name in os.constants.signals)) usage(`invalid signal '${text}'`);
  return name;
}

const args = process.argv.slice(2);
let killAfter = null;
let signal = 'SIGTERM';
let index = 0;
for (; index < args.length && args[index].startsWith('-') && args[index] !== '-'; index++) {
  const arg = args[index];
  let match;
  if (arg === '--') { index++; break; }
  if (arg === '--version') { process.stdout.write('timeout (adcp test shim)\n'); process.exit(0); }
  if ((match = /^--kill-after=(.*)$/.exec(arg))) killAfter = duration(match[1]);
  else if (arg === '-k' || arg === '--kill-after') killAfter = duration(args[++index]);
  else if ((match = /^-k(.+)$/.exec(arg))) killAfter = duration(match[1]);
  else if ((match = /^--signal=(.*)$/.exec(arg))) signal = signalName(match[1]);
  else if (arg === '-s' || arg === '--signal') signal = signalName(args[++index] ?? '');
  else if ((match = /^-s(.+)$/.exec(arg))) signal = signalName(match[1]);
  else usage(`unsupported option '${arg}'`);
}
const limit = duration(args[index]);
const [command, ...commandArgs] = args.slice(index + 1);
if (!command) usage('missing operand');

const child = spawn(command, commandArgs, { stdio: 'inherit', detached: true });
let timedOut = false;
let killed = false;
const signalGroup = (name) => {
  try {
    process.kill(-child.pid, name);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
};
child.once('error', (error) => {
  process.stderr.write(`timeout: failed to run command '${command}': ${error.message}\n`);
  process.exit(error.code === 'ENOENT' ? 127 : 126);
});
child.once('spawn', () => {
  if (limit > 0) {
    setTimeout(() => {
      timedOut = true;
      signalGroup(signal);
      if (killAfter !== null) setTimeout(() => { killed = true; signalGroup('SIGKILL'); }, killAfter).unref();
    }, limit).unref();
  }
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(name, () => signalGroup(name));
});
child.once('exit', (code, childSignal) => {
  if (killed) process.exit(128 + os.constants.signals.SIGKILL);
  if (timedOut) process.exit(124);
  process.exit(childSignal ? 128 + os.constants.signals[childSignal] : code);
});

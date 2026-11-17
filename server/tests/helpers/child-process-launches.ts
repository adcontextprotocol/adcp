/**
 * Pass-through recorder for real child-process launches.
 *
 * A test file installs it with
 *
 *   vi.mock('node:child_process', async (importOriginal) =>
 *     (await import('../../helpers/child-process-launches.js')).recordChildProcessLaunches(await importOriginal()));
 *
 * Every launch API still runs the real implementation with the same arguments
 * and returns its real result; the recorder only notes what was launched and
 * when the launched process exited. Tests read the records to assert how many
 * processes a check starts, with which executable and argv, and whether two
 * children were in flight together (the second launched before the first
 * exited). Order comes from the event log, never from clock readings.
 */
import { promisify } from 'node:util';
import type * as ChildProcessModule from 'node:child_process';

export type ChildLaunchApi = 'spawn' | 'spawnSync' | 'execFile' | 'execFileSync' | 'exec' | 'execSync' | 'fork';

export interface ChildLaunch {
  readonly index: number;
  readonly api: ChildLaunchApi;
  /** Executable path, or the shell command line for exec/execSync. */
  readonly command: string;
  /** argv after the executable (for fork: execArgv, module path, args). */
  readonly args: readonly string[];
  /** NODE_OPTIONS the child inherits (explicit options.env, else process.env). */
  readonly nodeOptions: string;
}

export interface ChildLaunchEvent {
  readonly kind: 'launch' | 'exit';
  readonly index: number;
}

export const childLaunches: ChildLaunch[] = [];
export const childLaunchEvents: ChildLaunchEvent[] = [];
const exited = new Set<number>();
const exitWaiters: Array<() => void> = [];

/** Position to diff from: launches recorded so far. */
export function childLaunchMark(): number {
  return childLaunches.length;
}

/** Launches recorded after `mark`, in launch order. */
export function childLaunchesSince(mark: number): ChildLaunch[] {
  return childLaunches.slice(mark);
}

/** Resolves once at least `count` launches after `mark` were recorded and all of them exited. */
export function childLaunchesExited(mark: number, count: number): Promise<ChildLaunch[]> {
  return new Promise((resolve) => {
    const check = (): boolean => {
      const since = childLaunchesSince(mark);
      if (since.length < count || !since.every((launch) => exited.has(launch.index))) return false;
      resolve(since);
      return true;
    };
    if (check()) return;
    const waiter = (): void => {
      if (check()) exitWaiters.splice(exitWaiters.indexOf(waiter), 1);
    };
    exitWaiters.push(waiter);
  });
}

/** True when `later` was launched before `earlier` exited. */
export function launchedBeforeExitOf(later: ChildLaunch, earlier: ChildLaunch): boolean {
  const launchAt = childLaunchEvents.findIndex((event) => event.kind === 'launch' && event.index === later.index);
  const exitAt = childLaunchEvents.findIndex((event) => event.kind === 'exit' && event.index === earlier.index);
  return launchAt >= 0 && (exitAt === -1 || launchAt < exitAt);
}

const TYPESCRIPT_TOOL = /(?:^|[^A-Za-z0-9_-])(?:tsx|npx|tsc)(?:[^A-Za-z0-9_-]|$)/;

/** argv entries (and NODE_OPTIONS) that name tsx, npx or tsc. */
export function typeScriptToolingIn(launch: ChildLaunch): string[] {
  return [...launch.args, launch.nodeOptions].filter((entry) => TYPESCRIPT_TOOL.test(entry));
}

type Options = { env?: NodeJS.ProcessEnv; execPath?: string; execArgv?: string[] } | undefined;

function splitArgs(rest: unknown[]): { args: string[]; options: Options } {
  const args = Array.isArray(rest[0]) ? (rest[0] as unknown[]).map(String) : [];
  const optionsAt = Array.isArray(rest[0]) ? 1 : 0;
  const candidate = rest[optionsAt];
  const options = candidate !== null && typeof candidate === 'object' ? candidate as Options : undefined;
  return { args, options };
}

function record(api: ChildLaunchApi, command: string, args: readonly string[], options: Options): ChildLaunch {
  const launch: ChildLaunch = {
    index: childLaunches.length, api, command, args,
    nodeOptions: (options?.env ?? process.env).NODE_OPTIONS ?? '',
  };
  childLaunches.push(launch);
  childLaunchEvents.push({ kind: 'launch', index: launch.index });
  return launch;
}

function markExited(launch: ChildLaunch): void {
  if (exited.has(launch.index)) return;
  exited.add(launch.index);
  childLaunchEvents.push({ kind: 'exit', index: launch.index });
  for (const waiter of [...exitWaiters]) waiter();
}

function watch<T>(child: T, launch: ChildLaunch): T {
  const emitter = child as unknown as { once?: (event: string, listener: () => void) => void };
  // Only 'exit'/'close' listeners: an 'error' listener would change what an
  // unhandled spawn error does.
  emitter.once?.('exit', () => markExited(launch));
  emitter.once?.('close', () => markExited(launch));
  return child;
}

type Module = typeof ChildProcessModule;
type AnyFunction = (...args: unknown[]) => unknown;

export function recordChildProcessLaunches(actual: Module): Module {
  const original = actual as unknown as Record<ChildLaunchApi, AnyFunction>;
  const forkLaunch = (rest: unknown[]): ChildLaunch => {
    const [modulePath, ...tail] = rest;
    const { args, options } = splitArgs(tail);
    return record('fork', options?.execPath ?? process.execPath,
      [...(options?.execArgv ?? process.execArgv), String(modulePath), ...args], options);
  };
  const wrapped: Record<ChildLaunchApi, AnyFunction> = {
    spawn: (...rest) => {
      const [command, ...tail] = rest;
      const { args, options } = splitArgs(tail);
      return watch(original.spawn(...rest), record('spawn', String(command), args, options));
    },
    execFile: (...rest) => {
      const [file, ...tail] = rest;
      const { args, options } = splitArgs(tail);
      return watch(original.execFile(...rest), record('execFile', String(file), args, options));
    },
    exec: (...rest) => {
      const [command, ...tail] = rest;
      const { args, options } = splitArgs(tail);
      return watch(original.exec(...rest), record('exec', String(command), args, options));
    },
    fork: (...rest) => watch(original.fork(...rest), forkLaunch(rest)),
    spawnSync: (...rest) => {
      const [command, ...tail] = rest;
      const { args, options } = splitArgs(tail);
      const launch = record('spawnSync', String(command), args, options);
      try { return original.spawnSync(...rest); } finally { markExited(launch); }
    },
    execFileSync: (...rest) => {
      const [file, ...tail] = rest;
      const { args, options } = splitArgs(tail);
      const launch = record('execFileSync', String(file), args, options);
      try { return original.execFileSync(...rest); } finally { markExited(launch); }
    },
    execSync: (...rest) => {
      const [command, ...tail] = rest;
      const { args, options } = splitArgs(tail);
      const launch = record('execSync', String(command), args, options);
      try { return original.execSync(...rest); } finally { markExited(launch); }
    },
  };
  // util.promisify(execFile|exec) resolves { stdout, stderr } and exposes
  // .child through the original's custom implementation; keep that contract.
  for (const api of ['execFile', 'exec'] as const) {
    const custom = (original[api] as unknown as Record<symbol, AnyFunction>)[promisify.custom];
    if (typeof custom !== 'function') continue;
    Object.defineProperty(wrapped[api], promisify.custom, {
      value: (...rest: unknown[]) => {
        const [command, ...tail] = rest;
        const { args, options } = splitArgs(tail);
        const launch = record(api, String(command), args, options);
        const promise = custom(...rest) as Promise<unknown> & { child?: unknown };
        watch(promise.child, launch);
        return promise;
      },
    });
  }
  const module = { ...actual, ...wrapped } as unknown as Module;
  return { ...module, default: module } as Module;
}

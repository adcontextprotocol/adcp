// Runs a hook check's command as the pre-commit hook ran it before
// tp-jyw.51: `sh -c <command>` from the repository root, with its
// node_modules/.bin first on PATH (scripts/profile-precommit/runner.mjs,
// leanLauncher). The precommit:checks project's tests assert on the result.
import { spawn } from 'node:child_process';
import path from 'node:path';

export const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

export interface CommandResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  output: string;
}

export function runHookCommand(command: string): Promise<CommandResult> {
  const env = { ...process.env, PATH: `${path.join(REPO_ROOT, 'node_modules', '.bin')}${path.delimiter}${process.env.PATH ?? ''}` };
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
    child.once('error', (error) => resolve({ status: 127, signal: null, output: `${output}${error.message}\n` }));
    child.once('close', (status, signal) => resolve({ status, signal, output }));
  });
}

/** The failure message: the command and its whole output. */
export function failureMessage(command: string, result: CommandResult): string {
  return `${command} exited ${result.status ?? result.signal}\n${result.output}`;
}

/**
 * An advisory check: runs the command; when it fails, prints its output to
 * stdout and records a warning annotation, and returns without failing.
 */
export async function runAdvisoryCheck(
  command: string,
  annotate: (message: string, type?: string) => Promise<unknown>,
): Promise<CommandResult> {
  const result = await runHookCommand(command);
  if (result.status !== 0) {
    const message = `advisory: ${command} exited ${result.status ?? result.signal}; it does not block the commit\n${result.output}`;
    process.stdout.write(`${message}\n`);
    await annotate(message, 'warning');
  }
  return result;
}

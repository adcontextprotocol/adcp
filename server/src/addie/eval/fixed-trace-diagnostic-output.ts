import { closeSync, openSync, writeFileSync } from 'node:fs';

/**
 * Exclusive artifact reservation for the manual diagnostic evaluator. The
 * empty file is an intentional crash marker: paid work must never precede a
 * durable, non-overwritable destination claim.
 */
export function reserveFixedTraceDiagnosticOutput(path: string): { finalize(content: string): void } {
  let descriptor: number;
  try {
    descriptor = openSync(path, 'wx', 0o600);
  } catch (error) {
    throw new Error(`Cannot exclusively reserve fixed-trace output ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let finalized = false;
  return Object.freeze({
    finalize(content: string): void {
      if (finalized) throw new Error('Fixed-trace output reservation is already finalized');
      try {
        writeFileSync(descriptor, content, { encoding: 'utf8' });
        finalized = true;
      } finally {
        closeSync(descriptor);
      }
    },
  });
}

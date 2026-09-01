/**
 * Deterministic, no-network regression evaluation for the observed Addie
 * long-question / long-answer incident shape.
 *
 * Example:
 * npx tsx server/tests/manual/fixed-trace-incident-eval.ts --output=.context/evals/addie-long-form.json
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import {
  FIXED_TRACE_INCIDENT_EVAL_VERSION,
  runFixedTraceIncidentEval,
} from '../../src/addie/eval/fixed-trace-incident-eval.js';

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

const outputArgument = argument('output');
if (!outputArgument?.trim()) throw new Error('--output is required');
const outputPath = resolve(outputArgument);
const sourceFiles = [
  'server/src/addie/eval/fixed-trace-incident-eval.ts',
  'server/src/addie/eval/fixed-trace-suite.ts',
  'server/src/addie/claude-client.ts',
  'server/src/addie/security.ts',
  'server/tests/manual/fixed-trace-incident-eval.ts',
];
const sourceBundleSha256 = createHash('sha256')
  .update(sourceFiles.map((file) => `${file}\0${readFileSync(file, 'utf8')}`).join('\0'), 'utf8')
  .digest('hex');
const artifact = {
  ...(await runFixedTraceIncidentEval()),
  sourceBundleSha256,
  gitCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  gitDirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
console.log(JSON.stringify({
  outputPath,
  artifactVersion: FIXED_TRACE_INCIDENT_EVAL_VERSION,
  traceSuiteVersion: artifact.traceSuiteVersion,
  traceSuiteSha256: artifact.traceSuiteSha256,
  sourceBundleSha256,
  passed: artifact.passed,
  dimensions: artifact.dimensions,
}, null, 2));
if (!artifact.passed) process.exitCode = 1;

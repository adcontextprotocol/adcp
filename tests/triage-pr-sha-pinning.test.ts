import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readRepoFile = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/\r\n/g, '\n');

const workflow = readRepoFile('.github/workflows/claude-issue-triage.yml');
const prompt = readRepoFile('.agents/routines/triage-prompt.md');

const VALID_HEAD_SHA = 'a'.repeat(40);
const VALID_BASE_SHA = '0123456789abcdef0123456789abcdef01234567';

function extractShaGate(): string {
  const match = workflow.match(/^[ \t]*pr_head_sha=[\s\S]*?^[ \t]*done[ \t]*$/m);
  if (!match) throw new Error('SHA validation block not found in claude-issue-triage.yml');
  return match[0];
}

function runShaGate(pr: Record<string, unknown>) {
  const script = `set -euo pipefail\n${extractShaGate()}\necho "PINNED $pr_base_sha...$pr_head_sha"\n`;
  return spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, pr: JSON.stringify(pr), ISSUE_NUMBER: '6962' },
  });
}

const prWith = (head: unknown, base: unknown) => ({
  head: { ref: 'feature', ...(head === undefined ? {} : { sha: head }) },
  base: { ref: 'main', ...(base === undefined ? {} : { sha: base }) },
});

describe('triage bridge pins PR SHAs and fails closed', () => {
  test('passes validated head/base SHAs through', () => {
    const result = runShaGate(prWith(VALID_HEAD_SHA, VALID_BASE_SHA));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`PINNED ${VALID_BASE_SHA}...${VALID_HEAD_SHA}`);
  });

  test.each([
    ['missing head sha', undefined, VALID_BASE_SHA],
    ['missing base sha', VALID_HEAD_SHA, undefined],
    ['null head sha', null, VALID_BASE_SHA],
    ['short sha', 'a'.repeat(39), VALID_BASE_SHA],
    ['long sha', VALID_HEAD_SHA, 'b'.repeat(41)],
    ['non-hex sha', 'g'.repeat(40), VALID_BASE_SHA],
    ['uppercase sha', 'A'.repeat(40), VALID_BASE_SHA],
    ['sha with trailing newline', `${VALID_HEAD_SHA}\nmain`, VALID_BASE_SHA],
  ])('fails closed on %s', (_label, head, base) => {
    const result = runShaGate(prWith(head, base));
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/::error::.*missing or malformed head\/base SHA/);
    expect(result.stdout).not.toContain('PINNED');
  });

  test('payload carries head_sha/base_sha alongside the refs', () => {
    expect(workflow).toMatch(/--arg head_sha "\$pr_head_sha"/);
    expect(workflow).toMatch(/--arg base_sha "\$pr_base_sha"/);
    expect(workflow).toMatch(/head_sha: \$head_sha, base_sha: \$base_sha/);
  });
});

describe('PR-feedback mode is read/respond only and grounded in the pinned range', () => {
  test('payload and prompt agree on one read/respond policy', () => {
    expect(workflow).toMatch(/MODE: PR-feedback \(read\/respond only\)/);
    expect(prompt).toMatch(/PR-feedback is \*\*read\/respond only\*\*/);
    expect(prompt).not.toMatch(/follow-up commit on the PR head branch/i);
    expect(prompt).not.toMatch(/does not currently iterate on/i);
  });

  test('review reads base_sha...head_sha and records the range', () => {
    expect(workflow).toMatch(/Read the PR diff as `base_sha\.\.\.head_sha`/);
    expect(workflow).toMatch(/state that exact range in your reply/);
    expect(prompt).toMatch(/compare\/<base_sha>\.\.\.<head_sha>/);
    expect(prompt).toMatch(/never\s+by branch name/);
    expect(prompt).toMatch(/`--paginate` on large PRs/);
    expect(prompt).toMatch(/never claim the full range after\s+reading a truncated diff/);
    expect(prompt).toMatch(/State the exact `base_sha\.\.\.head_sha` range you reviewed/);
  });

  test('review traces the runtime path, not only schema validity', () => {
    expect(prompt).toMatch(/trace the validator\/runtime path/);
    expect(prompt).toMatch(/schema validity alone does not prove the runtime accepts it/);
  });
});

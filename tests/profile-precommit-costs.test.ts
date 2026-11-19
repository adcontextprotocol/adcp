import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// @ts-expect-error -- plain .mjs module without type declarations
import { costItems } from '../scripts/profile-precommit/cost-items.mjs';

const ROOT = '/app';

// One V8 .cpuprofile: (root) -> run-storyboards.ts -> @adcp/sdk getValidator -> ajv compile,
// plus a spawnSync frame (blocked on a child) and an (idle) leaf.
function profile() {
  const frame = (id: number, functionName: string, url: string, children: number[] = []) => ({
    id,
    callFrame: { functionName, url, lineNumber: 0, columnNumber: 0, scriptId: '0' },
    children,
  });
  return {
    nodes: [
      frame(1, '(root)', '', [2, 5, 6]),
      frame(2, 'main', `file://${ROOT}/server/tests/manual/run-storyboards.ts`, [3]),
      frame(3, 'getValidator', `file://${ROOT}/node_modules/@adcp/sdk/dist/index.mjs`, [4]),
      frame(4, 'compileSchema', `file://${ROOT}/node_modules/ajv/dist/compile/index.js`),
      frame(5, 'spawnSync', 'node:child_process'),
      frame(6, '(idle)', ''),
    ],
    // Every sample is 1 s: 3 in ajv compile, 1 in the SDK itself, 1 in the repo script,
    // 4 blocked in spawnSync, 2 idle.
    samples: [4, 4, 4, 3, 2, 5, 5, 5, 5, 6, 6],
    timeDeltas: Array(11).fill(1_000_000),
  };
}

describe('profile-precommit costs', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'costs-'));
  mkdirSync(path.join(dir, 'step-a'));
  writeFileSync(path.join(dir, 'step-a', 'CPU.1.cpuprofile'), JSON.stringify(profile()));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const result = costItems([dir], { repoRoot: ROOT, groupBy: (file: string, base: string) => path.relative(base, file).split(path.sep)[0] });
  const group = result['step-a'];
  const item = (name: string) => group.items.find((row: { name: string }) => row.name === name)?.cpu_s ?? 0;

  it('keeps idle time and time blocked in a synchronous child out of CPU', () => {
    expect(group.sampled_s).toBeCloseTo(11, 1);
    expect(group.idle_s).toBeCloseTo(2, 1);
    expect(group.blocked_in_sync_child_s).toBeCloseTo(4, 1);
    expect(group.cpu_s).toBeCloseTo(5, 1);
  });

  it('charges each sample to every cost item on its stack', () => {
    expect(item('ajv compile')).toBeCloseTo(3, 1);
    expect(item('@adcp/sdk (all)')).toBeCloseTo(4, 1);
    expect(item('repo source (server/src)')).toBe(0);
  });

  it('counts a function once per sample in its inclusive time', () => {
    const fn = (prefix: string) => group.functions_inclusive.find((row: { name: string }) => row.name.startsWith(prefix))?.cpu_s;
    expect(fn('getValidator ')).toBeCloseTo(4, 1);
    expect(fn('main ')).toBeCloseTo(5, 1);
  });
});

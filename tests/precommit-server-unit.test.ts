import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { pathsFromNameStatus, planServerUnitRun, resolveWorkerCount } = require('../scripts/precommit-server-unit.cjs') as {
  resolveWorkerCount(env?: Record<string, string | undefined>, cpus?: number, totalmem?: number): number;
  pathsFromNameStatus(output: Buffer): string[];
  planServerUnitRun(
    files: string[],
    fileExists?: (file: string) => boolean
  ): { kind: 'skip' | 'files' | 'full'; files: string[] };
};

describe('precommit server unit planner', () => {
  it('skips changes outside server unit dependency roots', () => {
    expect(planServerUnitRun(['mintlify-docs/reference/media-buys.mdx'])).toEqual({
      kind: 'skip',
      files: [],
    });
  });

  it('runs only changed server unit test files when no broad server inputs changed', () => {
    expect(planServerUnitRun([
      'server/tests/unit/slack-escape.test.ts',
      'server/tests/unit/addie/router.spec.ts',
      'tests/lint-test-dynamic-imports.test.cjs',
    ])).toEqual({
      kind: 'files',
      files: [
        'server/tests/unit/addie/router.spec.ts',
        'server/tests/unit/slack-escape.test.ts',
      ],
    });
  });

  it('runs the full server unit suite for server implementation changes', () => {
    expect(planServerUnitRun(['server/src/utils/slack-escape.ts'])).toEqual({
      kind: 'full',
      files: [],
    });
  });

  it('runs the full server unit suite for source schema changes', () => {
    expect(planServerUnitRun(['static/schemas/source/core/brand.json'])).toEqual({
      kind: 'full',
      files: [],
    });
  });

  it('runs the full server unit suite for root vitest config changes', () => {
    expect(planServerUnitRun(['vitest.config.ts'])).toEqual({
      kind: 'full',
      files: [],
    });
  });

  it('runs the full server unit suite for shared server unit helpers', () => {
    expect(planServerUnitRun(['server/tests/unit/helpers/mock-db.ts'])).toEqual({
      kind: 'full',
      files: [],
    });
  });

  it('runs the full server unit suite for deleted broad server inputs', () => {
    expect(planServerUnitRun(['server/src/routes/account-linking.ts'], () => false)).toEqual({
      kind: 'full',
      files: [],
    });
  });

  it('does not try to run deleted server unit test files directly', () => {
    expect(planServerUnitRun(['server/tests/unit/old.test.ts'], () => false)).toEqual({
      kind: 'skip',
      files: [],
    });
  });

  it('runs the full server unit suite for docs read by server unit tests', () => {
    expect(planServerUnitRun(['docs/aao/addie-tools.mdx'])).toEqual({
      kind: 'full',
      files: [],
    });
  });

  it('runs the full server unit suite for public assets read by server unit tests', () => {
    expect(planServerUnitRun(['server/public/dashboard-settings.html'])).toEqual({
      kind: 'full',
      files: [],
    });
  });

  it('runs the full server unit suite for server scripts imported by server unit tests', () => {
    expect(planServerUnitRun(['server/scripts/reprobe-unknown-agents.js'])).toEqual({
      kind: 'full',
      files: [],
    });
  });

  it('runs the full server unit suite for the SDK validator cache helper the vitest configs require', () => {
    expect(planServerUnitRun(['scripts/sdk-validator-cache.cjs'])).toEqual({
      kind: 'full',
      files: [],
    });
  });

  it('runs the full server unit suite for C2PA cert generation helper changes', () => {
    expect(planServerUnitRun(['scripts/generate-c2pa-cert.sh'])).toEqual({
      kind: 'full',
      files: [],
    });
  });

  it('runs the full server unit suite for Addie prompt data changes', () => {
    expect(planServerUnitRun([
      '.agents/current-context.md',
      '.claude/agents/code-reviewer.md',
    ])).toEqual({
      kind: 'full',
      files: [],
    });
  });

  it('includes both sides of renamed staged files', () => {
    const output = Buffer.from(
      [
        'R100',
        'server/src/old-route.ts',
        'src/old-route.ts',
        'M',
        'tests/precommit-server-unit.test.ts',
        '',
      ].join('\0')
    );

    expect(pathsFromNameStatus(output)).toEqual([
      'server/src/old-route.ts',
      'src/old-route.ts',
      'tests/precommit-server-unit.test.ts',
    ]);
    expect(planServerUnitRun(pathsFromNameStatus(output))).toEqual({
      kind: 'full',
      files: [],
    });
  });
});

const { resolveWorkerCount: resolveServerUnitWorkers } = require('../scripts/server-unit-workers.cjs') as {
  resolveWorkerCount(options: { env?: Record<string, string | undefined>; cpus?: number; totalmem?: number; reservedCpus?: number }): number;
};
const GB = 1024 ** 3;

describe('precommit server unit parallelism', () => {
  it('defaults to the CPU count minus two workers, never below one', () => {
    expect(resolveWorkerCount({}, 14, 64 * GB)).toBe(12);
    expect(resolveWorkerCount({}, 8, 64 * GB)).toBe(6);
    expect(resolveWorkerCount({}, 3, 64 * GB)).toBe(1);
    expect(resolveWorkerCount({}, 1, 64 * GB)).toBe(1);
  });

  it('caps workers at half of memory, 2 GiB per worker', () => {
    expect(resolveWorkerCount({}, 10, 16 * GB)).toBe(4);
    expect(resolveWorkerCount({}, 14, 48 * GB)).toBe(12);
    expect(resolveWorkerCount({}, 8, 8 * GB)).toBe(2);
    expect(resolveWorkerCount({}, 8, 2 * GB)).toBe(1);
  });

  it('caps the vitest config default, which reserves one CPU, the same way', () => {
    expect(resolveServerUnitWorkers({ env: {}, cpus: 4, totalmem: 16 * GB, reservedCpus: 1 })).toBe(3);
    expect(resolveServerUnitWorkers({ env: {}, cpus: 10, totalmem: 16 * GB, reservedCpus: 1 })).toBe(4);
  });

  it('honors an explicit worker count over both caps and ignores invalid values', () => {
    expect(resolveWorkerCount({ ADCP_PRECOMMIT_SERVER_UNIT_WORKERS: '1' }, 16, 64 * GB)).toBe(1);
    expect(resolveWorkerCount({ ADCP_PRECOMMIT_SERVER_UNIT_WORKERS: '20' }, 4, 8 * GB)).toBe(20);
    expect(resolveWorkerCount({ ADCP_PRECOMMIT_SERVER_UNIT_WORKERS: '0' }, 8, 64 * GB)).toBe(6);
    expect(resolveWorkerCount({ ADCP_PRECOMMIT_SERVER_UNIT_WORKERS: 'two' }, 8, 64 * GB)).toBe(6);
  });
});

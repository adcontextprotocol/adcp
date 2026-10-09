import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { failedFilesFromReport, pathsFromNameStatus, planServerUnitRun, resolveShardCount } = require('../scripts/precommit-server-unit.cjs') as {
  failedFilesFromReport(reportPath: string, serverDir?: string): string[] | null;
  resolveShardCount(env?: Record<string, string | undefined>, cpus?: number): number;
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

describe('precommit server unit sharding', () => {
  it('defaults to half the CPUs, capped at four shards and never below one', () => {
    expect(resolveShardCount({}, 16)).toBe(4);
    expect(resolveShardCount({}, 8)).toBe(4);
    expect(resolveShardCount({}, 6)).toBe(3);
    expect(resolveShardCount({}, 2)).toBe(1);
    expect(resolveShardCount({}, 1)).toBe(1);
  });

  it('honors an explicit shard count and ignores invalid values', () => {
    expect(resolveShardCount({ ADCP_PRECOMMIT_SERVER_UNIT_SHARDS: '1' }, 16)).toBe(1);
    expect(resolveShardCount({ ADCP_PRECOMMIT_SERVER_UNIT_SHARDS: '6' }, 4)).toBe(6);
    expect(resolveShardCount({ ADCP_PRECOMMIT_SERVER_UNIT_SHARDS: '0' }, 8)).toBe(4);
    expect(resolveShardCount({ ADCP_PRECOMMIT_SERVER_UNIT_SHARDS: 'two' }, 8)).toBe(4);
  });

  it('lists failed files relative to the server root and refuses unreadable reports', () => {
    const dir = mkdtempSync(join(tmpdir(), 'precommit-report-'));
    try {
      const serverDir = join(dir, 'server');
      const report = join(dir, 'shard.json');
      writeFileSync(report, JSON.stringify({
        testResults: [
          { name: join(serverDir, 'tests/unit/b.test.ts'), status: 'failed' },
          { name: join(serverDir, 'tests/unit/ok.test.ts'), status: 'passed' },
          { name: join(serverDir, 'src/a.test.ts'), status: 'failed' },
        ],
      }));
      expect(failedFilesFromReport(report, serverDir)).toEqual(['src/a.test.ts', 'tests/unit/b.test.ts']);
      expect(failedFilesFromReport(join(dir, 'missing.json'), serverDir)).toBeNull();
      writeFileSync(report, '{"not":"a report"}');
      expect(failedFilesFromReport(report, serverDir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { pathsFromNameStatus, planServerUnitRun } = require('../scripts/precommit-server-unit.cjs') as {
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

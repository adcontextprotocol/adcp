import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('owner diagnostic compliance targets', () => {
  it('cannot mutate public badge state when canonical compliance state is skipped', () => {
    const source = readFileSync(
      resolve(__dirname, '../../src/addie/mcp/member-tools.ts'),
      'utf8',
    );
    const start = source.indexOf("} else if (isAgentOwner && result.completeness !== 'timed_out') {");
    const end = source.indexOf('// Legacy write to agent_contexts', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const diagnosticOnlyBranch = source.slice(start, end);
    expect(diagnosticOnlyBranch).toContain("skippedCanonicalWriteReason = 'target'");
    expect(diagnosticOnlyBranch).not.toContain('revokeUnsupportedPublicBadges');
    expect(diagnosticOnlyBranch).not.toContain('runBadgeFanOut');
  });
});

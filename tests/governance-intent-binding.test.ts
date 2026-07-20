import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();

describe('governance intent binding regressions', () => {
  it('keeps the request-signature reference verifier on the real adcp_use field', () => {
    const security = fs.readFileSync(
      path.join(repoRoot, 'docs/building/by-layer/L1/security.mdx'),
      'utf8',
    );

    expect(security).toMatch(/j\.adcp_use\s*!==\s*["']request-signing["']/);
    expect(security).not.toMatch(/j\.example_use/);
  });

  it('keeps governance request phases execution-only', () => {
    const schema = JSON.parse(fs.readFileSync(
      path.join(repoRoot, 'static/schemas/source/enums/governance-phase.json'),
      'utf8',
    ));

    expect(schema.enum).toEqual(['purchase', 'modification', 'delivery']);
  });
});

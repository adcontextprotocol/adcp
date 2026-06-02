import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const GUIDANCE_ROOTS = [
  'docs',
  'server/public',
  'server/src/addie',
] as const;
const GUIDANCE_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.ts', '.tsx']);

function listGuidanceFiles(path: string): string[] {
  const absolutePath = join(ROOT, path);
  const stat = statSync(absolutePath);

  if (stat.isFile()) {
    return GUIDANCE_EXTENSIONS.has(extname(path)) ? [path] : [];
  }

  return readdirSync(absolutePath)
    .flatMap(entry => listGuidanceFiles(join(path, entry)))
    .sort();
}

const GUIDANCE_FILES = GUIDANCE_ROOTS.flatMap(listGuidanceFiles);

function readRepoFile(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

describe('AdCP CLI guidance', () => {
  it('does not point validation users at the stale @adcp/client shim', () => {
    const offenders = GUIDANCE_FILES
      .map(path => ({ path, source: readRepoFile(path) }))
      .filter(({ source }) => /\bnpx\s+@adcp\/client(?:@[\w.-]+)?\b/.test(source))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('pins transient @adcp/sdk CLI commands to @latest', () => {
    const offenders = GUIDANCE_FILES
      .map(path => ({ path, source: readRepoFile(path) }))
      .filter(({ source }) => /\bnpx\s+@adcp\/sdk(?!@[\w.-]+)/.test(source))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('keeps key local validation commands on the current SDK package', () => {
    expect(readRepoFile('docs/registry/maintaining-your-agent.mdx')).toContain(
      'npx @adcp/sdk@latest storyboard run signed_requests --agent-url'
    );
    expect(readRepoFile('docs/building/verification/validate-with-mock-fixtures.mdx')).toContain(
      'npx @adcp/sdk@latest mock-server'
    );
    expect(readRepoFile('server/src/addie/rules/knowledge.md')).toContain(
      'npx @adcp/sdk@latest storyboard run <agent> [storyboard_id]'
    );
  });
});

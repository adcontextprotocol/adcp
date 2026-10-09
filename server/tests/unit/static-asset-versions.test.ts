import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { createStaticAssetVersioner } from '../../src/utils/static-asset-versions.js';

function publicDir(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'assets-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content);
  return dir;
}

describe('createStaticAssetVersioner', () => {
  it('adds a content hash to root-level JS and CSS that exist', () => {
    const dir = publicDir({ 'nav.js': 'console.log(1)', 'design-system.css': 'body{}' });
    const version = createStaticAssetVersioner(dir, { memoize: false });
    const out = version('<link rel="stylesheet" href="/design-system.css"><script src="/nav.js"></script>');
    expect(out).toMatch(/href="\/design-system\.css\?v=[0-9a-f]{8}"/);
    expect(out).toMatch(/src="\/nav\.js\?v=[0-9a-f]{8}"/);
  });

  it('leaves missing, already-versioned, external, and nested references alone', () => {
    const dir = publicDir({ 'nav.js': 'x' });
    const version = createStaticAssetVersioner(dir, { memoize: false });
    const html = '<script src="/missing.js"></script><script src="/csrf.js?v=abc"></script>'
      + '<script src="https://cdn.example/nav.js"></script><script src="/sites/app.js"></script>';
    expect(version(html)).toBe(html);
  });

  it('changes the version when the file content changes', () => {
    const dir = publicDir({ 'nav.js': 'one' });
    const version = createStaticAssetVersioner(dir, { memoize: false });
    const first = version('<script src="/nav.js"></script>');
    writeFileSync(path.join(dir, 'nav.js'), 'two');
    expect(version('<script src="/nav.js"></script>')).not.toBe(first);
  });
});

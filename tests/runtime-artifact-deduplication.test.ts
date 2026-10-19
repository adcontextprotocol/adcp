import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const { deduplicateRuntimeArtifacts } = createRequire(import.meta.url)(
  '../scripts/deduplicate-runtime-artifacts.cjs',
);
const directories: string[] = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-artifact-dedup-'));
  directories.push(root);
  const write = (relative: string, content = 'frozen published bytes') => {
    const filename = path.join(root, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, content);
    return filename;
  };
  return { root, write };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('runtime artifact storage', () => {
  it('retains published paths and exact bytes while sharing identical immutable files', () => {
    const { root, write } = fixture();
    const first = write('compliance/3.2.3/protocols/storyboard.json');
    const second = write('compliance/3.2.4/protocols/storyboard.json');
    const third = write('schemas/3.2.0-rc.7/storyboard.json');
    const before = [first, second, third].map(filename => fs.readFileSync(filename));
    const result = deduplicateRuntimeArtifacts(root);
    expect(result.linkedFiles).toBe(2);
    expect(result.savedBytes).toBe(before[0].length * 2);
    for (const [index, filename] of [first, second, third].entries()) {
      expect(fs.readFileSync(filename)).toEqual(before[index]);
      expect(fs.statSync(filename).ino).toBe(fs.statSync(first).ino);
    }
    expect(deduplicateRuntimeArtifacts(root).linkedFiles).toBe(0);
  });

  it('keeps mutable output independent from identical frozen content', () => {
    const { root, write } = fixture();
    const frozen = write('schemas/3.2.4/core/product.json');
    const mutable = write('schemas/latest/core/product.json');
    const unversioned = write('schemas/registry.json');
    expect(deduplicateRuntimeArtifacts(root).linkedFiles).toBe(0);
    fs.writeFileSync(mutable, 'new development bytes');
    expect(fs.readFileSync(frozen, 'utf8')).toBe('frozen published bytes');
    expect(fs.statSync(unversioned).ino).not.toBe(fs.statSync(frozen).ino);
  });

  it('does not merge different bytes of equal length or different permissions', () => {
    const { root, write } = fixture();
    write('docs/3.2.3/a.mdx', 'first');
    write('docs/3.2.4/a.mdx', 'other');
    const restricted = write('docs/3.2.4/b.mdx', 'first');
    fs.chmodSync(restricted, 0o600);
    expect(deduplicateRuntimeArtifacts(root).linkedFiles).toBe(0);
    expect(fs.statSync(restricted).mode & 0o777).toBe(0o600);
  });

  it('does not follow file or directory symlinks', () => {
    const { root, write } = fixture();
    const original = write('schemas/latest/core.json');
    write('schemas/3.2.4/core.json');
    fs.symlinkSync(original, path.join(root, 'schemas/3.2.4/link.json'));
    fs.symlinkSync(path.dirname(original), path.join(root, 'schemas/3.2.3'));
    expect(deduplicateRuntimeArtifacts(root).linkedFiles).toBe(0);
    expect(fs.lstatSync(path.join(root, 'schemas/3.2.4/link.json')).isSymbolicLink()).toBe(true);
  });

  it('fails without removing either published path when a replacement cannot be created', () => {
    const { root, write } = fixture();
    const first = write('compliance/3.2.3/manifest.json');
    const second = write('compliance/3.2.4/manifest.json');
    write(`compliance/3.2.4/manifest.json.dedup-${process.pid}`, 'occupied');
    expect(() => deduplicateRuntimeArtifacts(root)).toThrow();
    expect(fs.readFileSync(first, 'utf8')).toBe('frozen published bytes');
    expect(fs.readFileSync(second, 'utf8')).toBe('frozen published bytes');
    expect(fs.statSync(first).ino).not.toBe(fs.statSync(second).ino);
  });

  it('rejects a substituted link with different bytes before replacing the published path', () => {
    const { root, write } = fixture();
    const first = write('compliance/3.2.3/manifest.json');
    const second = write('compliance/3.2.4/manifest.json');
    const substituted = write('outside/manifest.json', 'different bytes');
    const link = fs.linkSync;
    vi.spyOn(fs, 'linkSync').mockImplementation((_source, destination) => link(substituted, destination));
    expect(() => deduplicateRuntimeArtifacts(root)).toThrow('Artifact changed before link verification');
    expect(fs.readFileSync(first, 'utf8')).toBe('frozen published bytes');
    expect(fs.readFileSync(second, 'utf8')).toBe('frozen published bytes');
    expect(fs.existsSync(`${second}.dedup-${process.pid}`)).toBe(false);
  });

  it('rejects a symlink substituted during link creation', () => {
    const { root, write } = fixture();
    const first = write('compliance/3.2.3/manifest.json');
    const second = write('compliance/3.2.4/manifest.json');
    vi.spyOn(fs, 'linkSync').mockImplementation((_source, destination) => fs.symlinkSync(first, destination));
    expect(() => deduplicateRuntimeArtifacts(root)).toThrow();
    expect(fs.readFileSync(second, 'utf8')).toBe('frozen published bytes');
    expect(fs.existsSync(`${second}.dedup-${process.pid}`)).toBe(false);
  });
});

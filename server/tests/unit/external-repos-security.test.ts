import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  _testing,
  type ExternalRepo,
  type IndexedExternalDoc,
  type IndexedExternalHeading,
} from '../../src/addie/mcp/external-repos.js';

const SECRET_SENTINEL = 'EXTERNAL_REPO_LOCAL_SECRET_SENTINEL';

type IndexResult = {
  docs: IndexedExternalDoc[];
  headings: IndexedExternalHeading[];
};

let tempDir: string;
let repoDir: string;
let outsideDir: string;
let secretPath: string;

function markdown(title: string, marker = 'ordinary repository content'): string {
  return `# ${title}\n\n## Details\n\n${marker} ${'safe searchable text '.repeat(8)}`;
}

function writeRepoFile(relativePath: string, content = markdown(relativePath)): string {
  const filePath = path.join(repoDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

function writeOutsideFile(relativePath: string, content = markdown('Secret', SECRET_SENTINEL)): string {
  const filePath = path.join(outsideDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

function config(indexPatterns: string[]): ExternalRepo {
  return {
    id: 'security-fixture',
    url: 'https://github.com/example/security-fixture.git',
    name: 'Security fixture',
    description: 'Filesystem security fixture',
    branch: 'main',
    indexPatterns,
  };
}

function index(indexPatterns: string[], root = repoDir): IndexResult {
  return _testing.indexRepo(config(indexPatterns), root);
}

function indexedText(result: IndexResult): string {
  return JSON.stringify({ docs: result.docs, headings: result.headings });
}

function expectSecretAbsent(result: IndexResult): void {
  expect(indexedText(result)).not.toContain(SECRET_SENTINEL);
}

function relativeSymlinkTarget(linkPath: string, targetPath: string): string {
  return path.relative(path.dirname(linkPath), targetPath);
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'external-repos-security-'));
  repoDir = path.join(tempDir, 'repo');
  outsideDir = path.join(tempDir, 'outside');
  fs.mkdirSync(repoDir);
  fs.mkdirSync(outsideDir);
  secretPath = writeOutsideFile('secret.md');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('external repository filesystem boundary', () => {
  describe.each([
    { name: 'exact', link: 'README.md', valid: 'VALID.md', patterns: ['README.md', 'VALID.md'] },
    { name: 'root glob', link: 'leak.md', valid: 'valid.md', patterns: ['*.md'] },
    { name: 'recursive', link: 'docs/leak.md', valid: 'docs/valid.md', patterns: ['docs/**/*.md'] },
  ])('$name discovery', ({ link, valid, patterns }) => {
    it.each(['relative', 'absolute'] as const)(
      'rejects a %s leaf symlink without aborting a valid sibling',
      (targetKind) => {
        const linkPath = path.join(repoDir, link);
        fs.mkdirSync(path.dirname(linkPath), { recursive: true });
        fs.symlinkSync(
          targetKind === 'relative' ? relativeSymlinkTarget(linkPath, secretPath) : secretPath,
          linkPath,
        );
        writeRepoFile(valid);

        const result = index(patterns);

        expect(result.docs.map((doc) => doc.path)).toEqual([valid]);
        expectSecretAbsent(result);
      },
    );
  });

  it('rejects escaping root and nested directory symlinks', () => {
    writeRepoFile('valid.md');
    fs.symlinkSync(relativeSymlinkTarget(path.join(repoDir, 'docs'), outsideDir), path.join(repoDir, 'docs'));

    const rootEscape = index(['docs/**/*.md', 'valid.md']);
    expect(rootEscape.docs.map((doc) => doc.path)).toEqual(['valid.md']);
    expectSecretAbsent(rootEscape);

    fs.unlinkSync(path.join(repoDir, 'docs'));
    fs.mkdirSync(path.join(repoDir, 'docs'));
    writeRepoFile('docs/valid.md');
    fs.symlinkSync(
      relativeSymlinkTarget(path.join(repoDir, 'docs', 'a'), outsideDir),
      path.join(repoDir, 'docs', 'a'),
    );

    const nestedEscape = index(['docs/**/*.md']);
    expect(nestedEscape.docs.map((doc) => doc.path)).toEqual(['docs/valid.md']);
    expectSecretAbsent(nestedEscape);
  });

  it('rejects in-tree links and link chains while indexing the ordinary target', () => {
    const ordinaryPath = writeRepoFile('real/ordinary.md');
    fs.symlinkSync(relativeSymlinkTarget(path.join(repoDir, 'alias.md'), ordinaryPath), path.join(repoDir, 'alias.md'));
    fs.symlinkSync('real', path.join(repoDir, 'alias-dir'));
    fs.symlinkSync('chain-b.md', path.join(repoDir, 'chain-a.md'));
    fs.symlinkSync(relativeSymlinkTarget(path.join(repoDir, 'chain-b.md'), secretPath), path.join(repoDir, 'chain-b.md'));
    const outsideLink = path.join(outsideDir, 'outside-link.md');
    fs.symlinkSync('secret.md', outsideLink);
    fs.symlinkSync(relativeSymlinkTarget(path.join(repoDir, 'outside-chain.md'), outsideLink), path.join(repoDir, 'outside-chain.md'));

    const result = index(['**/*.md']);

    expect(result.docs.map((doc) => doc.path)).toEqual(['real/ordinary.md']);
    expectSecretAbsent(result);
  });

  it('skips broken and cyclic links without throwing or hanging', () => {
    fs.symlinkSync('missing.md', path.join(repoDir, 'broken.md'));
    fs.symlinkSync('cycle-b.md', path.join(repoDir, 'cycle-a.md'));
    fs.symlinkSync('cycle-a.md', path.join(repoDir, 'cycle-b.md'));
    writeRepoFile('valid.md');

    const result = index(['*.md']);

    expect(result.docs.map((doc) => doc.path)).toEqual(['valid.md']);
    expectSecretAbsent(result);
  });

  it('rejects outside and in-tree hardlinks', () => {
    fs.linkSync(secretPath, path.join(repoDir, 'README.md'));
    const target = writeRepoFile('target.md');
    fs.linkSync(target, path.join(repoDir, 'alias.md'));
    writeRepoFile('valid.md');

    const result = index(['README.md', '*.md']);

    expect(result.docs.map((doc) => doc.path)).toEqual(['valid.md']);
    expectSecretAbsent(result);
  });

  it('does not cross nested Git repository or submodule boundaries', () => {
    fs.mkdirSync(path.join(repoDir, '.git'));
    writeRepoFile('valid.md');
    writeRepoFile('nested-file/README.md', markdown('Nested file marker', SECRET_SENTINEL));
    fs.writeFileSync(path.join(repoDir, 'nested-file', '.git'), 'gitdir: ../metadata');
    writeRepoFile('nested-dir/README.md', markdown('Nested directory marker', SECRET_SENTINEL));
    fs.mkdirSync(path.join(repoDir, 'nested-dir', '.git'));
    fs.mkdirSync(path.join(repoDir, 'empty-gitlink'));

    const result = index(['**/*.md']);

    expect(result.docs.map((doc) => doc.path)).toEqual(['valid.md']);
    expectSecretAbsent(result);
  });

  it('rejects traversal, absolute, dot, empty, and sibling-prefix patterns', () => {
    writeRepoFile('valid.md');
    const siblingDir = path.join(tempDir, 'repo-evil');
    fs.mkdirSync(siblingDir);
    fs.writeFileSync(path.join(siblingDir, 'secret.md'), markdown('Sibling secret', SECRET_SENTINEL));

    const unsafePatterns = [
      '../outside/secret.md',
      '../../outside/secret.md',
      '../repo-evil/secret.md',
      secretPath,
      '.',
      '',
      'docs/./guide.md',
      'nested/.git/README.md',
    ];
    for (const pattern of unsafePatterns) {
      expect(_testing.isSafeRelativePattern(pattern)).toBe(false);
    }

    const result = index([...unsafePatterns, 'valid.md']);
    expect(result.docs.map((doc) => doc.path)).toEqual(['valid.md']);
    expectSecretAbsent(result);
  });

  it('rejects a repository root that is itself a symlink', () => {
    writeRepoFile('README.md', markdown('Would otherwise index', SECRET_SENTINEL));
    const linkedRoot = path.join(tempDir, 'repo-link');
    fs.symlinkSync(repoDir, linkedRoot);

    const result = index(['README.md'], linkedRoot);

    expect(result.docs).toEqual([]);
    expect(result.headings).toEqual([]);
    expectSecretAbsent(result);
  });

  it('preserves valid exact, glob, recursive, MDX, Unicode, and metadata behavior', () => {
    writeRepoFile(
      'README.md',
      `---\ntitle: Fixture frontmatter title\n---\n\n## Overview\n\n${'frontmatter content '.repeat(8)}`,
    );
    writeRepoFile('CHANGELOG.md');
    writeRepoFile('Root Guide.md');
    writeRepoFile('docs/a/b/Guide ünicode.mdx');
    writeRepoFile('.hidden/secret.md', markdown('Hidden', SECRET_SENTINEL));
    writeRepoFile('node_modules/secret.md', markdown('Dependency', SECRET_SENTINEL));

    const result = index([
      'README.md',
      'CHANGELOG.md',
      '*.md',
      'docs/**/*.md',
      'docs/**/*.mdx',
      'README.md',
    ]);

    expect(result.docs.map((doc) => doc.path).sort()).toEqual([
      'CHANGELOG.md',
      'README.md',
      'Root Guide.md',
      'docs/a/b/Guide ünicode.mdx',
    ]);
    expect(result.docs.find((doc) => doc.path === 'README.md')?.title).toBe('Fixture frontmatter title');
    expect(result.docs.find((doc) => doc.path === 'README.md')?.id).toBe('external:security-fixture:README');
    expect(result.docs.find((doc) => doc.path === 'Root Guide.md')?.sourceUrl)
      .toBe('https://github.com/example/security-fixture/blob/main/Root Guide.md');
    expect(result.headings.some((heading) => heading.path === 'README.md')).toBe(true);
    expectSecretAbsent(result);
  });

  it('rejects oversized documents without aborting valid siblings', () => {
    fs.writeFileSync(
      path.join(repoDir, 'oversized.md'),
      Buffer.alloc(_testing.MAX_EXTERNAL_DOC_BYTES + 1, 0x61),
    );
    writeRepoFile('valid.md');

    const result = index(['*.md']);

    expect(result.docs.map((doc) => doc.path)).toEqual(['valid.md']);
  });

  it('isolates a simple-glob readdir failure and continues with later patterns', () => {
    writeRepoFile('README.md');
    writeRepoFile('valid.md');
    vi.spyOn(fs, 'readdirSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('directory disappeared'), { code: 'ENOENT' });
    });

    const result = index(['*.md', 'valid.md']);

    expect(result.docs.map((doc) => doc.path)).toEqual(['valid.md']);
  });

  it('isolates a transient root revalidation failure and continues safely', () => {
    writeRepoFile('README.md');
    writeRepoFile('valid.md');
    const originalLstatSync = fs.lstatSync.bind(fs);
    let lstatCalls = 0;
    vi.spyOn(fs, 'lstatSync').mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
      lstatCalls += 1;
      if (lstatCalls === 3) {
        throw Object.assign(new Error('repository root disappeared'), { code: 'ENOENT' });
      }
      return originalLstatSync(...args);
    }) as typeof fs.lstatSync);

    const result = index(['README.md', 'valid.md']);

    expect(result.docs.map((doc) => doc.path)).toEqual(['valid.md']);
  });

  it('rejects a regular file swapped to an outside symlink before open', () => {
    const readmePath = writeRepoFile('README.md');
    writeRepoFile('valid.md');
    const originalOpenSync = fs.openSync.bind(fs);
    vi.spyOn(fs, 'openSync').mockImplementationOnce((filePath, flags, mode) => {
      fs.unlinkSync(readmePath);
      fs.symlinkSync(secretPath, readmePath);
      return originalOpenSync(filePath, flags, mode);
    });

    const result = index(['README.md', 'valid.md']);

    expect(result.docs.map((doc) => doc.path)).toEqual(['valid.md']);
    expectSecretAbsent(result);
  });

  it('rejects and closes a different regular inode swapped in before open', () => {
    const readmePath = writeRepoFile('README.md');
    writeRepoFile('valid.md');
    const originalOpenSync = fs.openSync.bind(fs);
    const originalCloseSync = fs.closeSync.bind(fs);
    vi.spyOn(fs, 'openSync').mockImplementationOnce((filePath, flags, mode) => {
      fs.unlinkSync(readmePath);
      fs.copyFileSync(secretPath, readmePath);
      return originalOpenSync(filePath, flags, mode);
    });
    const closeSpy = vi.spyOn(fs, 'closeSync').mockImplementation(originalCloseSync);

    const result = index(['README.md', 'valid.md']);

    expect(result.docs.map((doc) => doc.path)).toEqual(['valid.md']);
    expect(closeSpy).toHaveBeenCalledTimes(2);
    expectSecretAbsent(result);
  });

  it('reads the validated descriptor if the pathname is replaced after open', () => {
    const validatedMarker = 'VALIDATED_DESCRIPTOR_CONTENT';
    const readmePath = writeRepoFile('README.md', markdown('Validated', validatedMarker));
    const heldPath = path.join(repoDir, 'held-original.md');
    const originalOpenSync = fs.openSync.bind(fs);
    vi.spyOn(fs, 'openSync').mockImplementationOnce((filePath, flags, mode) => {
      const fd = originalOpenSync(filePath, flags, mode);
      fs.renameSync(readmePath, heldPath);
      fs.symlinkSync(secretPath, readmePath);
      return fd;
    });

    const result = index(['README.md']);

    expect(result.docs).toHaveLength(1);
    expect(result.docs[0].content).toContain(validatedMarker);
    expectSecretAbsent(result);
  });

  it('skips special and non-file exact candidates without aborting', () => {
    fs.mkdirSync(path.join(repoDir, 'README.md'));
    writeRepoFile('valid.md');

    const result = index(['README.md', 'valid.md']);

    expect(result.docs.map((doc) => doc.path)).toEqual(['valid.md']);
  });
});

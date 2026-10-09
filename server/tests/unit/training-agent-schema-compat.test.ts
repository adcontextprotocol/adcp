import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  resolveRetainedSchemaRoot,
  RETAINED_SCHEMA_BUNDLE,
  RETAINED_SCHEMA_BUNDLES,
} from '../../src/training-agent/schema-compat.js';

const repoRoot = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const retainedSchemaRoot = path.join(repoRoot, 'dist/schemas/3.2.0-beta.6');

describe('training-agent retained schema bundle resolution', () => {
  it('derives the canonical bundle directory from the retained wire version', () => {
    expect(RETAINED_SCHEMA_BUNDLE).toBe('3.2.0-beta.6');
  });

  it('resolves the bundle when executing from TypeScript source', () => {
    expect(path.resolve(resolveRetainedSchemaRoot())).toBe(retainedSchemaRoot);
  });

  it('resolves the bundle from the compiled production layout', () => {
    const compiledModuleUrl = pathToFileURL(
      path.join(repoRoot, 'dist/training-agent/schema-compat.js'),
    ).href;

    expect(path.resolve(resolveRetainedSchemaRoot(compiledModuleUrl))).toBe(retainedSchemaRoot);
    expect(existsSync(retainedSchemaRoot)).toBe(true);
  });

  it('retains the beta.6 and last 3.2 RC checkpoints the installed SDK does not package', () => {
    expect(RETAINED_SCHEMA_BUNDLES).toEqual({
      '3.2-beta.6': '3.2.0-beta.6',
      '3.2-rc.7': '3.2.0-rc.7',
    });
    expect(path.resolve(resolveRetainedSchemaRoot(undefined, undefined, '3.2.0-rc.7')))
      .toBe(path.join(repoRoot, 'dist/schemas/3.2.0-rc.7'));
  });

  it('reports every checked location when the bundle is absent', () => {
    expect(() => resolveRetainedSchemaRoot(import.meta.url, () => false)).toThrow(
      /Training-agent schema bundle 3\.2\.0-beta\.6 is missing; checked/,
    );
  });
});

import { createRequire } from 'node:module';
import path from 'node:path';
import type { TestProject } from 'vitest/node';

/**
 * Root-suite test files (repository-relative) that validate against the
 * published schema tree, dist/schemas/latest. A file that reads the built
 * tree belongs here instead of building it itself
 * (scripts/lint-test-builds.cjs).
 */
export const BUILT_SCHEMA_FILES = ['tests/addie/compliance-authored-tool-gates.test.ts'];

type EnsureBuiltSchemas = () => string;

function ensureBuiltSchemas(): string {
  const builtSchemas = createRequire(import.meta.url)('../../scripts/built-schemas.cjs') as {
    ensureBuiltSchemas: EnsureBuiltSchemas;
  };
  return builtSchemas.ensureBuiltSchemas();
}

/**
 * The root vitest config's globalSetup: builds dist/schemas/latest once,
 * before any worker starts, when this run includes a file in
 * BUILT_SCHEMA_FILES and the tree's inputs changed since the last build. A
 * run without such a file (a single other file, the git-env-isolation
 * guard's per-file children) builds nothing. vitest has collected this run's
 * files into its state before it starts the global setups.
 */
export default function setup(project: Pick<TestProject, 'config' | 'vitest'>, ensure: EnsureBuiltSchemas = ensureBuiltSchemas): void {
  const wanted = new Set(BUILT_SCHEMA_FILES.map((file) => path.resolve(project.config.root, file)));
  if (project.vitest.state.getPaths().some((file) => wanted.has(path.resolve(file)))) ensure();
}

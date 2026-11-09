import { createRequire } from 'node:module';

/**
 * The training agent validates responses against the published schema tree,
 * dist/schemas/latest, which the runtime image ships. Build it once before
 * the suite when the schema sources changed since the last build.
 */
export default function setup(): void {
  const { ensureBuiltSchemas } = createRequire(import.meta.url)('../../../scripts/built-schemas.cjs') as {
    ensureBuiltSchemas: () => string;
  };
  ensureBuiltSchemas();
}

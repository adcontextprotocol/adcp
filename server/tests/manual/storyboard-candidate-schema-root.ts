import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { registerExternalSchemaRoot } from '@adcp/sdk/testing';

/** Bind the already-validated local candidate for server callbacks as well as
 * buyer calls. Async-local buyer roots do not cross the HTTP server boundary. */
export function registerStoryboardCandidateSchemaRoot(
  version: string,
  schemaRoot: string | undefined,
): void {
  if (process.env.NODE_ENV !== 'test' || process.env.ADCP_STORYBOARD_CANDIDATE_VERSION_MODE !== '1') {
    throw new Error('Candidate server schemas require the explicit test candidate mode');
  }
  if (!schemaRoot) {
    throw new Error('ADCP_STORYBOARD_CANDIDATE_VERSION_MODE=1 requires ADCP_SCHEMA_ROOT');
  }
  const root = resolve(schemaRoot);
  const index = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8')) as { adcp_version?: unknown } | null;
  if (index?.adcp_version !== version) {
    throw new Error('Candidate schema root adcp_version must match the package and compliance bundle version');
  }
  // Register before importing the runtime: the SDK caches its per-release
  // envelope policy, and an unknown future release otherwise defaults to the
  // legacy envelope before any request-local buyer validation is entered.
  registerExternalSchemaRoot(version, root);
  // The SDK's envelope compatibility helper also resolves schemas through
  // its CommonJS graph. Bind the same public entry point there so both
  // module graphs see the candidate, without reaching into SDK internals.
  const commonJsTesting = createRequire(import.meta.url)('@adcp/sdk/testing') as typeof import('@adcp/sdk/testing');
  commonJsTesting.registerExternalSchemaRoot(version, root);
}

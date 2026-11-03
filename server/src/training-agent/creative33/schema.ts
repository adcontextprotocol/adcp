import { createRequire } from 'node:module';
import { registerExternalSchemaRoot } from '@adcp/sdk/testing';
import { resolveRetainedSchemaRoot } from '../schema-compat.js';
import { CREATIVE33_SCHEMA_VERSION } from './catalog.js';

let registered = false;

/** Keep the frozen lab on its published contract when the SDK advances. */
export function ensureCreative33SchemaBundle(): void {
  if (registered) return;
  const root = resolveRetainedSchemaRoot(undefined, undefined, CREATIVE33_SCHEMA_VERSION);
  registerExternalSchemaRoot(CREATIVE33_SCHEMA_VERSION, root);
  // The SDK server envelope resolver and ESM validators own separate roots.
  const cjsTesting = createRequire(import.meta.url)('@adcp/sdk/testing') as {
    registerExternalSchemaRoot: typeof registerExternalSchemaRoot;
  };
  cjsTesting.registerExternalSchemaRoot(CREATIVE33_SCHEMA_VERSION, root);
  registered = true;
}

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SELLER_GOVERNANCE_DISCOVERY_ADCP_VERSION } from './types.js';

const RETAINED_SCHEMA_BUNDLE = '3.2.0-beta.6';

let registration: Promise<void> | undefined;

function retainedSchemaRoot(): string {
  // TypeScript executes from server/src during local development and from
  // dist/server/src after compilation. The committed release bundle lives in
  // dist/schemas in both cases, so check the corresponding module-relative
  // location for each layout.
  const candidates = [
    fileURLToPath(new URL(`../../../schemas/${RETAINED_SCHEMA_BUNDLE}/`, import.meta.url)),
    fileURLToPath(new URL(`../../../dist/schemas/${RETAINED_SCHEMA_BUNDLE}/`, import.meta.url)),
  ];
  const root = candidates.find(candidate => existsSync(candidate));
  if (!root) {
    throw new Error(
      `Training-agent schema bundle ${RETAINED_SCHEMA_BUNDLE} is missing; checked ${candidates.join(', ')}`,
    );
  }
  return root;
}

/**
 * Register the training agent's retained beta.6 checkpoint with SDK builds
 * that only package their own latest prerelease schema.
 *
 * This is deliberately lazy: @adcp/sdk/testing owns the public external-root
 * API, but the rest of that entry point is unnecessary unless the training
 * agent is actually used.
 */
export function ensureTrainingAgentSchemaBundle(): Promise<void> {
  registration ??= import('@adcp/sdk/testing').then(({ registerExternalSchemaRoot }) => {
    registerExternalSchemaRoot(SELLER_GOVERNANCE_DISCOVERY_ADCP_VERSION, retainedSchemaRoot());
  });
  return registration;
}

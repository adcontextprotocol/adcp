import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SELLER_GOVERNANCE_DISCOVERY_ADCP_VERSION } from './types.js';

function canonicalSchemaBundleVersion(version: string): string {
  const match = version.match(/^(\d+)\.(\d+)(?:\.(\d+))?((?:-(?:beta|rc)\.\d+)?)$/);
  if (!match) {
    throw new Error(`Invalid retained training-agent schema version: ${version}`);
  }
  return `${match[1]}.${match[2]}.${match[3] ?? '0'}${match[4]}`;
}

export const RETAINED_SCHEMA_BUNDLE = canonicalSchemaBundleVersion(
  SELLER_GOVERNANCE_DISCOVERY_ADCP_VERSION,
);

let registration: Promise<void> | undefined;

export function resolveRetainedSchemaRoot(
  moduleUrl: string = import.meta.url,
  pathExists: (candidate: string) => boolean = existsSync,
): string {
  // TypeScript executes from server/src/training-agent during local
  // development and from dist/training-agent after compilation. The
  // committed release bundle lives under dist/schemas in both cases.
  const candidates = [
    fileURLToPath(new URL(`../schemas/${RETAINED_SCHEMA_BUNDLE}/`, moduleUrl)),
    fileURLToPath(new URL(`../../../dist/schemas/${RETAINED_SCHEMA_BUNDLE}/`, moduleUrl)),
  ];
  const root = candidates.find(candidate => pathExists(path.join(candidate, 'index.json')));
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
    registerExternalSchemaRoot(SELLER_GOVERNANCE_DISCOVERY_ADCP_VERSION, resolveRetainedSchemaRoot());
  });
  return registration;
}

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SELLER_GOVERNANCE_DISCOVERY_ADCP_VERSION,
  TRAINING_AGENT_RETAINED_RC_ADCP_VERSION,
} from './types.js';

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

/**
 * Prerelease checkpoints the training agent still serves but the installed
 * @adcp/sdk no longer packages, as wire version -> canonical bundle
 * directory. Each is registered with the SDK from the committed dist/schemas
 * bundle.
 */
export const RETAINED_SCHEMA_BUNDLES: Readonly<Record<string, string>> = Object.freeze({
  [SELLER_GOVERNANCE_DISCOVERY_ADCP_VERSION]: RETAINED_SCHEMA_BUNDLE,
  [TRAINING_AGENT_RETAINED_RC_ADCP_VERSION]: canonicalSchemaBundleVersion(TRAINING_AGENT_RETAINED_RC_ADCP_VERSION),
});

let registration: Promise<void> | undefined;

export function resolveRetainedSchemaRoot(
  moduleUrl: string = import.meta.url,
  pathExists: (candidate: string) => boolean = existsSync,
  bundle: string = RETAINED_SCHEMA_BUNDLE,
): string {
  // TypeScript executes from server/src/training-agent during local
  // development and from dist/training-agent after compilation. The
  // committed release bundle lives under dist/schemas in both cases.
  const candidates = [
    fileURLToPath(new URL(`../schemas/${bundle}/`, moduleUrl)),
    fileURLToPath(new URL(`../../../dist/schemas/${bundle}/`, moduleUrl)),
  ];
  const root = candidates.find(candidate => pathExists(path.join(candidate, 'index.json')));
  if (!root) {
    throw new Error(
      `Training-agent schema bundle ${bundle} is missing; checked ${candidates.join(', ')}`,
    );
  }
  return root;
}

/**
 * Register the training agent's retained prerelease checkpoints (beta.6 and
 * the last 3.2 RC) with SDK builds that do not package them.
 *
 * This is deliberately lazy: @adcp/sdk/testing owns the public external-root
 * API, but the rest of that entry point is unnecessary unless the training
 * agent is actually used.
 */
export function ensureTrainingAgentSchemaBundle(): Promise<void> {
  registration ??= import('@adcp/sdk/testing').then(({ registerExternalSchemaRoot }) => {
    for (const [version, bundle] of Object.entries(RETAINED_SCHEMA_BUNDLES)) {
      registerExternalSchemaRoot(version, resolveRetainedSchemaRoot(undefined, undefined, bundle));
    }
  });
  return registration;
}

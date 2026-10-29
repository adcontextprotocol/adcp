import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SELLER_GOVERNANCE_DISCOVERY_ADCP_VERSION,
  TRAINING_AGENT_RETAINED_RC_ADCP_VERSION,
} from './types.js';
import { TRAINING_AGENT_CANDIDATE_ADCP_VERSION } from './candidate-version.js';
import { CREATIVE33_WIRE_VERSION } from './creative33/catalog.js';

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
  // The creative 3.3 beta sandbox serves 3.3.0-beta.0; @adcp/sdk 17.0.0-beta.6
  // packages 3.3.0-beta.1 instead.
  [CREATIVE33_WIRE_VERSION]: canonicalSchemaBundleVersion(CREATIVE33_WIRE_VERSION),
});

/**
 * The source candidate's release key and the built tree that carries it.
 * @adcp/sdk decides from the served release's published schema whether a
 * response keeps `status` (adcp-client#3493): `list_products` and
 * `decline_proposals` keep it only where that schema composes the protocol
 * envelope. The SDK's pinned 3.3.0-beta.1 bundle predates #8547, so a
 * candidate process registers the built `dist/schemas/latest` tree under
 * the candidate's key instead. Only a trusted candidate process does
 * (`candidate-version.ts`: NODE_ENV=test and candidate mode); production
 * and ordinary processes keep the SDK's published pin. Remove this once the
 * SDK pins a protocol release that contains #8547.
 */
export const CANDIDATE_SCHEMA_BUNDLE = TRAINING_AGENT_CANDIDATE_ADCP_VERSION
  ? canonicalSchemaBundleVersion(TRAINING_AGENT_CANDIDATE_ADCP_VERSION)
  : undefined;
const CANDIDATE_SCHEMA_TREE = 'latest';

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
 * Register the training agent's retained prerelease checkpoints (3.2 beta.6,
 * the last 3.2 RC and 3.3 beta.0) with SDK builds that do not package them,
 * and, in a trusted candidate process, the built source tree under the
 * candidate's release key (see CANDIDATE_SCHEMA_BUNDLE).
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
    if (CANDIDATE_SCHEMA_BUNDLE) {
      const root = resolveRetainedSchemaRoot(undefined, undefined, CANDIDATE_SCHEMA_TREE);
      // Only the tree built for this candidate: never shadow a retained
      // checkpoint with a source tree of another release.
      const built = JSON.parse(readFileSync(path.join(root, 'index.json'), 'utf8')) as { adcp_version?: unknown };
      if (built.adcp_version !== CANDIDATE_SCHEMA_BUNDLE) return;
      registerExternalSchemaRoot(CANDIDATE_SCHEMA_BUNDLE, root);
      // The SDK's ESM status rule reads schemas through its CommonJS schema
      // loader (envelope-status-compat.mjs requires ../validation/schema-loader),
      // a separate module instance with its own external roots. Register there
      // too, or the rule reads the published bundle and drops `status`.
      const cjsTesting = createRequire(import.meta.url)('@adcp/sdk/testing') as {
        registerExternalSchemaRoot: (version: string, schemaRoot: string) => void;
      };
      cjsTesting.registerExternalSchemaRoot(CANDIDATE_SCHEMA_BUNDLE, root);
    }
  });
  return registration;
}

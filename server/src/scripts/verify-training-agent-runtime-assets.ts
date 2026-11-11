/**
 * Build/deploy guard for the training agent's retained schema checkpoint.
 *
 * This script deliberately imports the emitted schema-compat module from
 * dist/ when it runs. `npm run build` therefore exercises the same
 * import.meta.url layout as production instead of re-testing TypeScript source
 * paths. The Dockerfile runs it again after the final image has been assembled
 * so a missing COPY or .dockerignore regression also fails the deploy build.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveAdcpVersion } from '@adcp/sdk';
import {
  ensurePreviewSchemaBundle,
  ensureTrainingAgentSchemaBundle,
  PREVIEW_SCHEMA_BUNDLE,
  resolveRetainedSchemaRoot,
  RETAINED_SCHEMA_BUNDLE,
} from '../training-agent/schema-compat.js';
import { TRAINING_AGENT_HOSTED_PREVIEW } from '../training-agent/candidate-version.js';
import { SELLER_GOVERNANCE_DISCOVERY_ADCP_VERSION } from '../training-agent/types.js';
import { coverageModelHasZone, resolveCoverageModelDir } from '../training-agent/reporting-coverage-model.js';

const schemaRoot = resolveRetainedSchemaRoot();
const indexPath = path.join(schemaRoot, 'index.json');
const index = JSON.parse(await readFile(indexPath, 'utf8')) as {
  adcp_version?: unknown;
};

if (index.adcp_version !== RETAINED_SCHEMA_BUNDLE) {
  throw new Error(
    `Training-agent schema index ${indexPath} declares ${String(index.adcp_version)}; ` +
      `expected ${RETAINED_SCHEMA_BUNDLE}`,
  );
}

await ensureTrainingAgentSchemaBundle();
const resolvedVersion = resolveAdcpVersion(SELLER_GOVERNANCE_DISCOVERY_ADCP_VERSION);
if (resolvedVersion !== SELLER_GOVERNANCE_DISCOVERY_ADCP_VERSION) {
  throw new Error(
    `Training-agent schema version ${SELLER_GOVERNANCE_DISCOVERY_ADCP_VERSION} ` +
      `resolved as ${resolvedVersion}`,
  );
}

console.log(
  `Training-agent runtime schema verified: ${resolvedVersion} -> ${schemaRoot}`,
);

// The hosted 3.3 preview validates against its committed published bundle.
// Checked even when the kill switch is set, so the image can always serve it.
const previewRoot = resolveRetainedSchemaRoot(undefined, undefined, TRAINING_AGENT_HOSTED_PREVIEW.bundle);
const previewIndex = JSON.parse(await readFile(path.join(previewRoot, 'index.json'), 'utf8')) as { adcp_version?: unknown };
if (previewIndex.adcp_version !== TRAINING_AGENT_HOSTED_PREVIEW.bundle) {
  throw new Error(
    `Training-agent preview schema index ${previewRoot} declares ${String(previewIndex.adcp_version)}; ` +
      `expected ${TRAINING_AGENT_HOSTED_PREVIEW.bundle}`,
  );
}
if (PREVIEW_SCHEMA_BUNDLE) {
  await ensurePreviewSchemaBundle();
  const previewResolved = resolveAdcpVersion(TRAINING_AGENT_HOSTED_PREVIEW.wireVersion);
  if (previewResolved !== TRAINING_AGENT_HOSTED_PREVIEW.wireVersion && previewResolved !== TRAINING_AGENT_HOSTED_PREVIEW.bundle) {
    throw new Error(
      `Training-agent preview version ${TRAINING_AGENT_HOSTED_PREVIEW.wireVersion} resolved as ${previewResolved}`,
    );
  }
}
console.log(`Training-agent preview schema verified: ${TRAINING_AGENT_HOSTED_PREVIEW.wireVersion} -> ${previewRoot}`);

// Reporting-subscription coverage runs the spec's reference model at runtime.
const coverageModelDir = resolveCoverageModelDir();
if (!coverageModelHasZone('America/New_York')) {
  throw new Error(`Reporting coverage reference model at ${coverageModelDir} is missing its pinned tzdata`);
}
console.log(`Training-agent reporting coverage model verified: ${coverageModelDir}`);

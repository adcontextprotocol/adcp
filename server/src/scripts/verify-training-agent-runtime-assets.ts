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
  ensureTrainingAgentSchemaBundle,
  resolveRetainedSchemaRoot,
  RETAINED_SCHEMA_BUNDLE,
} from '../training-agent/schema-compat.js';
import { SELLER_GOVERNANCE_DISCOVERY_ADCP_VERSION } from '../training-agent/types.js';

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

/**
 * Child entry for warm-caches.ts: registers the training
 * agent's schema roots with @adcp/sdk, exactly as a worker does when it builds
 * the tenant registry (tenants/registry.ts) and the creative 3.3 lab
 * (creative33/platform.ts), so the SDK writes the root-check entries those
 * workers will read from ADCP_VALIDATOR_CACHE_DIR.
 */
import { ensurePreviewSchemaBundle, ensureTrainingAgentSchemaBundle } from '../../src/training-agent/schema-compat.js';
import { ensureCreative33SchemaBundle } from '../../src/training-agent/creative33/schema.js';

await ensureTrainingAgentSchemaBundle();
await ensurePreviewSchemaBundle();
ensureCreative33SchemaBundle();

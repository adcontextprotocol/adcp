import { z } from 'zod';
import { customToolFor } from './custom-tool-helper.js';
import { handleValidateInput, resolveServedAdcpVersionForTool } from '../task-handlers.js';
import type { TrainingContext } from '../types.js';

const ACCOUNT_REF_SCHEMA = z.object({
  account_id: z.string().optional(),
  brand: z.object({ domain: z.string() }).passthrough().optional(),
  operator: z.string().optional(),
  sandbox: z.boolean().optional(),
}).passthrough();

const VALIDATE_INPUT_SCHEMA = {
  adcp_version: z.string().optional(),
  adcp_major_version: z.number().int().optional(),
  account: ACCOUNT_REF_SCHEMA.optional(),
  brand: z.object({
    domain: z.string().optional(),
    name: z.string().optional(),
  }).passthrough().optional(),
  manifest: z.object({}).passthrough(),
  targets: z.array(z.object({
    kind: z.enum(['canonical', 'product', 'third_party_format']),
    id: z.string(),
  }).passthrough()).min(1).optional(),
  context: z.any().optional(),
  ext: z.any().optional(),
};

export function validateInputTool(options: Partial<TrainingContext> = {}) {
  return customToolFor(
    'validate_input',
    'Dry-run a creative manifest against canonical formats, seeded products, or third-party format references without registering a creative.',
    VALIDATE_INPUT_SCHEMA,
    (args, ctx) => {
      const versionResolution = resolveServedAdcpVersionForTool('validate_input', args as unknown as Record<string, unknown>);
      if (!versionResolution.ok) {
        return {
          adcp_version: undefined,
          errors: [{
            code: 'VERSION_UNSUPPORTED',
            message: versionResolution.message,
            field: versionResolution.field,
            details: versionResolution.details,
          }],
        };
      }
      if (versionResolution.servedVersion.startsWith('3.0')) {
        return {
          adcp_version: versionResolution.servedVersion,
          errors: [{
            code: 'INVALID_REQUEST',
            message: 'Unknown tool: validate_input',
          }],
        };
      }
      return Promise.resolve(handleValidateInput(args, ctx)).then(result => ({
        ...result,
        adcp_version: versionResolution.servedVersion,
      }));
    },
    {
      annotations: { readOnlyHint: true, idempotentHint: true },
      trainingContext: options,
    },
  );
}

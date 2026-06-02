import { z } from 'zod';
import { customToolFor } from './custom-tool-helper.js';
import { handleBuildCreative, handlePreviewCreative } from '../task-handlers.js';
import type { TrainingContext } from '../types.js';

const ACCOUNT_REF_SCHEMA = z.object({
  account_id: z.string().optional(),
  brand: z.object({ domain: z.string() }).passthrough().optional(),
  operator: z.string().optional(),
}).passthrough();

const FORMAT_ID_SCHEMA = z.object({
  agent_url: z.string().optional(),
  id: z.string().optional(),
}).passthrough();

export function buildCreativeTool(options: Partial<TrainingContext> = {}) {
  return customToolFor(
    'build_creative',
    'Generate or transform a creative manifest for an advertised creative capability.',
    {
      message: z.string().optional(),
      brief: z.string().optional(),
      creative_id: z.string().optional(),
      media_buy_id: z.string().optional(),
      package_id: z.string().optional(),
      creative_manifest: z.object({}).passthrough().optional(),
      target_format_id: FORMAT_ID_SCHEMA.optional(),
      target_format_ids: z.array(FORMAT_ID_SCHEMA).optional(),
      output_format: z.string().optional(),
      include_preview: z.boolean().optional(),
      account: ACCOUNT_REF_SCHEMA.optional(),
      brand: z.object({ domain: z.string().optional() }).passthrough().optional(),
      quality: z.string().optional(),
      idempotency_key: z.string(),
      context: z.any().optional(),
      ext: z.any().optional(),
    },
    handleBuildCreative,
    {
      annotations: { readOnlyHint: false, idempotentHint: true },
      enforceIdempotency: true,
      payloadErrorsAsSuccess: true,
      trainingContext: options,
    },
  );
}

export function previewCreativeTool(options: Partial<TrainingContext> = {}) {
  return customToolFor(
    'preview_creative',
    'Render a preview for a creative manifest or previously synced creative.',
    {
      account: ACCOUNT_REF_SCHEMA.optional(),
      brand: z.object({ domain: z.string().optional() }).passthrough().optional(),
      creative_id: z.string().optional(),
      creative_manifest: z.object({}).passthrough().optional(),
      request_type: z.string().optional(),
      output_format: z.string().optional(),
      quality: z.string().optional(),
      requests: z.array(z.object({}).passthrough()).optional(),
      context: z.any().optional(),
      ext: z.any().optional(),
    },
    handlePreviewCreative,
    {
      annotations: { readOnlyHint: true, idempotentHint: true },
      trainingContext: options,
    },
  );
}

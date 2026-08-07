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

const PREVIEW_ITEM_COMMON_SCHEMA = {
  target_capability_id: z.string().optional(),
  format_id: FORMAT_ID_SCHEMA.optional(),
  output_format: z.enum(['url', 'html', 'both']).optional(),
  quality: z.enum(['draft', 'production']).optional(),
  template_id: z.string().optional(),
  item_limit: z.number().int().min(1).optional(),
};

const PREVIEW_ITEM_SCHEMA = z.union([
  z.object({
    ...PREVIEW_ITEM_COMMON_SCHEMA,
    creative_manifest: z.object({}).passthrough(),
    creative_id: z.never().optional(),
  }).passthrough(),
  z.object({
    ...PREVIEW_ITEM_COMMON_SCHEMA,
    creative_id: z.string(),
    creative_manifest: z.never().optional(),
  }).passthrough(),
]);

const PREVIEW_COMMON_SCHEMA = {
  account: ACCOUNT_REF_SCHEMA.optional(),
  brand: z.object({ domain: z.string().optional() }).passthrough().optional(),
  target_capability_id: z.string().optional(),
  format_id: FORMAT_ID_SCHEMA.optional(),
  output_format: z.enum(['url', 'html', 'both']).optional(),
  quality: z.enum(['draft', 'production']).optional(),
  template_id: z.string().optional(),
  item_limit: z.number().int().min(1).optional(),
  context: z.any().optional(),
  ext: z.any().optional(),
};

const PREVIEW_INPUT_SCHEMA = z.union([
  z.object({
    ...PREVIEW_COMMON_SCHEMA,
    request_type: z.literal('single').optional(),
    creative_manifest: z.object({}).passthrough(),
    creative_id: z.never().optional(),
  }).passthrough(),
  z.object({
    ...PREVIEW_COMMON_SCHEMA,
    request_type: z.literal('single').optional(),
    creative_id: z.string(),
    creative_manifest: z.never().optional(),
  }).passthrough(),
  z.object({
    ...PREVIEW_COMMON_SCHEMA,
    request_type: z.literal('batch'),
    requests: z.array(PREVIEW_ITEM_SCHEMA).min(1).max(50),
  }).passthrough(),
  z.object({
    ...PREVIEW_COMMON_SCHEMA,
    request_type: z.literal('variant'),
    variant_id: z.string(),
  }).passthrough(),
]);

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
      target_capability_id: z.string().optional(),
      target_capability_ids: z.array(z.string()).optional(),
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
    PREVIEW_INPUT_SCHEMA,
    handlePreviewCreative,
    {
      annotations: { readOnlyHint: true, idempotentHint: true },
      trainingContext: options,
    },
  );
}

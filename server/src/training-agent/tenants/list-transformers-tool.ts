import { z } from "zod";
import { customToolFor } from "./custom-tool-helper.js";
import { handleListTransformers } from "../task-handlers.js";

const FORMAT_ID_SCHEMA = z
  .object({
    agent_url: z.string(),
    id: z.string(),
  })
  .passthrough();

const ACCOUNT_REF_SCHEMA = z
  .object({
    account_id: z.string().optional(),
    brand: z.object({ domain: z.string() }).passthrough().optional(),
    operator: z.string().optional(),
  })
  .passthrough();

const LIST_TRANSFORMERS_SCHEMA = {
  transformer_ids: z.array(z.string()).optional(),
  input_format_ids: z.array(FORMAT_ID_SCHEMA).optional(),
  output_format_ids: z.array(FORMAT_ID_SCHEMA).optional(),
  name_search: z.string().optional(),
  brief: z.string().optional(),
  expand_params: z.array(z.string()).optional(),
  expand_pagination: z
    .array(
      z
        .object({
          transformer_id: z.string().optional(),
          field: z.string().optional(),
          options_cursor: z.string().optional(),
        })
        .passthrough()
    )
    .optional(),
  include_pricing: z.boolean().optional(),
  account: ACCOUNT_REF_SCHEMA.optional(),
  context: z.any().optional(),
  pagination: z
    .object({
      max_results: z.number().optional(),
      cursor: z.string().optional(),
    })
    .passthrough()
    .optional(),
};

export function listTransformersTool() {
  return customToolFor(
    "list_transformers",
    "Discover account-scoped creative transformers (voices, models, render configs) and their typed config params, with optional enumerated option values (expand_params) and per-account pricing (include_pricing).",
    LIST_TRANSFORMERS_SCHEMA,
    handleListTransformers,
    {
      annotations: { readOnlyHint: true, idempotentHint: true },
    }
  );
}

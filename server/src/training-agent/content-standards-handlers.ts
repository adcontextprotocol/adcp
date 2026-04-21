/**
 * Content standards tool definitions and handlers for the training agent.
 *
 * Implements create_content_standards, list_content_standards,
 * get_content_standards, update_content_standards, calibrate_content,
 * and validate_content_delivery. All state is per-session and deterministic.
 */

import { randomUUID } from 'node:crypto';
import type { TrainingContext, ToolArgs, ContentStandardsState } from './types.js';
import { getSession, sessionKeyFromArgs, MAX_CONTENT_STANDARDS_PER_SESSION } from './state.js';

// ── Tool definitions ─────────────────────────────────────────────

export const CONTENT_STANDARDS_TOOLS = [
  {
    name: 'create_content_standards',
    description: 'Create a content standards configuration defining brand safety and suitability policies. Returns a standards_id for subsequent operations.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        scope: {
          type: 'object',
          description: 'Where this standards configuration applies',
          properties: {
            countries_all: { type: 'array', items: { type: 'string' } },
            channels_any: { type: 'array', items: { type: 'string' } },
            languages_any: { type: 'array', items: { type: 'string' } },
            description: { type: 'string' },
          },
          required: ['languages_any'],
        },
        policy: { type: 'string', description: 'Natural language policy describing acceptable content' },
        calibration_exemplars: { type: 'object', description: 'Training examples for calibration' },
        idempotency_key: { type: 'string' },
      },
      required: ['scope', 'policy'],
    },
  },
  {
    name: 'list_content_standards',
    description: 'List all content standards configurations for the current account.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    execution: { taskSupport: 'forbidden' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        channels: { type: 'array', items: { type: 'string' }, description: 'Filter by channel' },
        languages: { type: 'array', items: { type: 'string' }, description: 'Filter by language' },
        countries: { type: 'array', items: { type: 'string' }, description: 'Filter by country (ISO 3166-1 alpha-2)' },
      },
    },
  },
  {
    name: 'get_content_standards',
    description: 'Get a specific content standards configuration by ID.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    execution: { taskSupport: 'forbidden' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        standards_id: { type: 'string', description: 'Content standards identifier' },
      },
      required: ['standards_id'],
    },
  },
  {
    name: 'update_content_standards',
    description: 'Update a content standards configuration — modify policy, scope, or calibration exemplars.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        standards_id: { type: 'string', description: 'Content standards identifier' },
        scope: { type: 'object', description: 'Updated scope' },
        policy: { type: 'string', description: 'Updated policy text' },
        calibration_exemplars: { type: 'object', description: 'Updated calibration exemplars' },
      },
      required: ['standards_id'],
    },
  },
  {
    name: 'calibrate_content',
    description: 'Evaluate a content artifact against a content standard. Returns a pass/fail verdict with feature-level breakdown.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        standards_id: { type: 'string', description: 'Content standards to evaluate against' },
        artifact: { type: 'object', description: 'Content artifact to evaluate' },
      },
      required: ['standards_id', 'artifact'],
    },
  },
  {
    name: 'validate_content_delivery',
    description: 'Validate that delivered creatives met content standards. Returns per-record verdicts.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        standards_id: { type: 'string', description: 'Content standards to validate against' },
        records: {
          type: 'array',
          description: 'Delivery records with creative references',
          items: {
            type: 'object',
            properties: {
              record_id: { type: 'string' },
              artifact: { type: 'object' },
            },
            required: ['record_id'],
          },
        },
      },
      required: ['standards_id', 'records'],
    },
  },
];

// ── Helpers ───────────────────────────────────────────────────────

function toStandardsResponse(state: ContentStandardsState) {
  return {
    standards_id: state.standardsId,
    ...(state.scope.description ? { name: state.scope.description } : {}),
    ...(state.scope.countriesAll ? { countries_all: state.scope.countriesAll } : {}),
    ...(state.scope.channelsAny ? { channels_any: state.scope.channelsAny } : {}),
    ...(state.scope.languagesAny ? { languages_any: state.scope.languagesAny } : {}),
    policy: state.policy,
    ...(state.calibrationExemplars ? { calibration_exemplars: state.calibrationExemplars } : {}),
  };
}

// ── Handlers ─────────────────────────────────────────────────────

export async function handleCreateContentStandards(
  args: ToolArgs,
  ctx: TrainingContext,
) {
  const req = args as {
    scope?: {
      countries_all?: string[];
      channels_any?: string[];
      languages_any?: string[];
      description?: string;
    };
    policy?: string;
    calibration_exemplars?: { pass?: unknown[]; fail?: unknown[] };
  };

  if (!req.scope || typeof req.scope !== 'object' || Array.isArray(req.scope)) {
    return { errors: [{ code: 'INVALID_INPUT', message: "'scope' is required and must be an object with at least 'languages_any'." }] };
  }
  if (!Array.isArray(req.scope.languages_any) || req.scope.languages_any.length === 0) {
    return { errors: [{ code: 'INVALID_INPUT', message: "'scope.languages_any' is required and must be a non-empty array of language codes." }] };
  }
  if (!req.policy || typeof req.policy !== 'string') {
    return { errors: [{ code: 'INVALID_INPUT', message: "'policy' is required and must be a string." }] };
  }

  const session = await getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));

  if (session.contentStandards.size >= MAX_CONTENT_STANDARDS_PER_SESSION) {
    return { errors: [{ code: 'LIMIT_EXCEEDED', message: `Session limit reached (max ${MAX_CONTENT_STANDARDS_PER_SESSION} content standards).` }] };
  }

  const now = new Date().toISOString();
  const standardsId = `cs_${randomUUID().slice(0, 8)}`;

  const state: ContentStandardsState = {
    standardsId,
    scope: {
      countriesAll: req.scope.countries_all,
      channelsAny: req.scope.channels_any,
      languagesAny: req.scope.languages_any,
      description: req.scope.description,
    },
    policy: req.policy,
    calibrationExemplars: req.calibration_exemplars,
    createdAt: now,
    updatedAt: now,
  };

  session.contentStandards.set(standardsId, state);

  return {
    standards_id: standardsId,
  };
}

export async function handleListContentStandards(
  args: ToolArgs,
  ctx: TrainingContext,
) {
  const req = args as { channels?: string[]; languages?: string[]; countries?: string[] };
  const session = await getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));

  let standards = [...session.contentStandards.values()];

  if (req.channels && req.channels.length > 0) {
    standards = standards.filter(s =>
      s.scope.channelsAny?.some(c => req.channels!.includes(c)),
    );
  }

  if (req.languages && req.languages.length > 0) {
    standards = standards.filter(s =>
      s.scope.languagesAny?.some(l => req.languages!.includes(l)),
    );
  }

  if (req.countries && req.countries.length > 0) {
    standards = standards.filter(s =>
      s.scope.countriesAll?.some(c => req.countries!.includes(c)),
    );
  }

  return {
    standards: standards.map(toStandardsResponse),
  };
}

export async function handleGetContentStandards(
  args: ToolArgs,
  ctx: TrainingContext,
) {
  const req = args as { standards_id: string };
  const session = await getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));

  const state = session.contentStandards.get(req.standards_id);
  if (!state) {
    return { errors: [{ code: 'not_found', message: `No content standards with id '${req.standards_id}'` }] };
  }

  return {
    ...toStandardsResponse(state),
  };
}

export async function handleUpdateContentStandards(
  args: ToolArgs,
  ctx: TrainingContext,
) {
  const req = args as {
    standards_id: string;
    scope?: {
      countries_all?: string[];
      channels_any?: string[];
      languages_any?: string[];
      description?: string;
    };
    policy?: string;
    calibration_exemplars?: { pass?: unknown[]; fail?: unknown[] };
  };

  const session = await getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));

  const state = session.contentStandards.get(req.standards_id);
  if (!state) {
    return { errors: [{ code: 'not_found', message: `No content standards with id '${req.standards_id}'` }] };
  }

  if (req.scope) {
    if (req.scope.countries_all !== undefined) state.scope.countriesAll = req.scope.countries_all;
    if (req.scope.channels_any !== undefined) state.scope.channelsAny = req.scope.channels_any;
    if (req.scope.languages_any !== undefined) state.scope.languagesAny = req.scope.languages_any;
    if (req.scope.description !== undefined) state.scope.description = req.scope.description;
  }

  if (req.policy !== undefined) {
    state.policy = req.policy;
  }

  if (req.calibration_exemplars !== undefined) {
    state.calibrationExemplars = req.calibration_exemplars;
  }

  state.updatedAt = new Date().toISOString();

  return {
    success: true as const,
    standards_id: req.standards_id,
  };
}

export async function handleCalibrateContent(
  args: ToolArgs,
  ctx: TrainingContext,
) {
  const req = args as { standards_id: string; artifact: unknown };
  const session = await getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));

  const state = session.contentStandards.get(req.standards_id);
  if (!state) {
    return { errors: [{ code: 'not_found', message: `No content standards with id '${req.standards_id}'` }] };
  }

  return {
    verdict: 'pass',
    confidence: 0.95,
    explanation: 'Sandbox calibration — content evaluated against policy and passes all checks.',
    features: [
      {
        feature_id: 'brand_safety',
        status: 'passed',
        explanation: 'No brand safety violations detected in submitted content.',
      },
      {
        feature_id: 'quality',
        status: 'passed',
        explanation: 'Content meets minimum quality requirements.',
      },
      {
        feature_id: 'policy_compliance',
        status: 'passed',
        explanation: 'Content complies with the defined policy.',
      },
    ],
  };
}

export async function handleValidateContentDelivery(
  args: ToolArgs,
  ctx: TrainingContext,
) {
  const req = args as {
    standards_id: string;
    records: Array<{ record_id: string; artifact?: unknown }>;
  };

  const session = await getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));

  const state = session.contentStandards.get(req.standards_id);
  if (!state) {
    return { errors: [{ code: 'not_found', message: `No content standards with id '${req.standards_id}'` }] };
  }

  const records = req.records || [];

  const results = records.map(record => ({
    record_id: record.record_id,
    verdict: 'pass' as const,
    features: [
      {
        feature_id: 'brand_safety',
        status: 'passed' as const,
        message: 'No brand safety violations.',
      },
      {
        feature_id: 'quality',
        status: 'passed' as const,
        message: 'Meets quality standards.',
      },
    ],
  }));

  return {
    summary: {
      total_records: records.length,
      passed_records: records.length,
      failed_records: 0,
    },
    results,
  };
}

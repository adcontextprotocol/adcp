import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  moduleWithDemo: {
    id: 'A2',
    track_id: 'A',
    title: 'Live demo module',
    description: null,
    format: 'lesson',
    duration_minutes: 30,
    sort_order: 1,
    is_free: true,
    prerequisites: [],
    tenant_ids: ['sales'],
    assessment_criteria: null,
    exercise_definitions: null,
    lesson_plan: {
      objectives: ['Inspect a real protocol response'],
      key_concepts: [],
      discussion_prompts: [],
      demo_scenarios: [{
        description: 'List available products',
        tools: ['get_products'],
        expected_outcome: 'A product catalog response is returned',
      }],
    },
  },
}));

vi.mock('../../src/db/certification-db.js', () => ({
  getModule: vi.fn(async (moduleId: string) => (
    moduleId === 'A2' ? mocks.moduleWithDemo : null
  )),
  getProgress: vi.fn(async () => []),
  getLatestCheckpoint: vi.fn(async () => null),
}));

import {
  buildCertificationContext,
  LIVE_DEMO_CODE_FENCE_ARTIFACT_RULE,
  LIVE_DEMO_NO_RAW_JSON_EXCEPTION,
  LIVE_DEMO_RESULT_FORMATTING_RULE,
  PRIOR_TURN_RESTATEMENT_NO_RAW_JSON_RULE,
} from '../../src/addie/mcp/certification-tools.js';
import { loadRules } from '../../src/addie/rules/index.js';

describe('certification demo formatting prompt rules', () => {
  it('emits live demo formatting and no-raw-JSON scoping rules in active module context', async () => {
    const prompt = await buildCertificationContext([{
      module_id: 'A2',
      started_at: '2026-05-29T00:00:00.000Z',
    }], 'user_123');

    expect(prompt).toContain(LIVE_DEMO_RESULT_FORMATTING_RULE);
    expect(prompt).toContain(LIVE_DEMO_CODE_FENCE_ARTIFACT_RULE);
    expect(prompt).toContain(LIVE_DEMO_NO_RAW_JSON_EXCEPTION);
    expect(prompt).toContain(PRIOR_TURN_RESTATEMENT_NO_RAW_JSON_RULE);
    expect(prompt).toContain('agent_url: "https://test-agent.adcontextprotocol.org/sales/mcp"');
  });

  it('adds a top-level raw JSON exception for certification live demos', () => {
    const rules = loadRules();

    expect(rules).toContain('Exception: certification live demo instructions');
    expect(rules).toContain('preserve its code fence so learners can inspect the protocol message');
    expect(rules).toContain('NEVER echo raw JSON tool output except for certification live demos');
  });
});

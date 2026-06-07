import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getProgress: vi.fn(),
  saveTeachingCheckpoint: vi.fn(),
  getModule: vi.fn(),
}));

vi.mock('../../src/db/certification-db.js', () => ({
  S2_CANONICAL_FORMATS_MODULE_ID: 'S2',
  getProgress: mocks.getProgress,
  saveTeachingCheckpoint: mocks.saveTeachingCheckpoint,
  getModule: mocks.getModule,
}));

import { createCertificationToolHandlers } from '../../src/addie/mcp/certification-tools.js';

describe('checkpoint_teaching_progress handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProgress.mockResolvedValue([
      { module_id: 'A1', status: 'in_progress' },
    ]);
    mocks.saveTeachingCheckpoint.mockImplementation(async checkpoint => ({
      id: 'checkpoint_1',
      ...checkpoint,
    }));
    mocks.getModule.mockResolvedValue({
      id: 'A1',
      assessment_criteria: null,
      exercise_definitions: null,
    });
  });

  it('defaults omitted concept arrays instead of throwing while saving a checkpoint', async () => {
    const handler = createCertificationToolHandlers({
      workos_user: { workos_user_id: 'user_123' },
    } as any).get('checkpoint_teaching_progress');

    const result = await handler?.({
      module_id: 'a1',
      current_phase: 'teaching',
    });

    expect(result).toBe('Teaching checkpoint saved for A1. Phase: teaching. Covered 0 concepts, 0 remaining. Demonstrations verified: 0.');
    expect(mocks.saveTeachingCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      workos_user_id: 'user_123',
      module_id: 'A1',
      concepts_covered: [],
      concepts_remaining: [],
      learner_strengths: [],
      learner_gaps: [],
      demonstrations_verified: [],
    }));
  });

  it('normalizes scalar string array fields from model tool input', async () => {
    const handler = createCertificationToolHandlers({
      workos_user: { workos_user_id: 'user_123' },
    } as any).get('checkpoint_teaching_progress');

    const result = await handler?.({
      module_id: 'A1',
      current_phase: 'assessment',
      concepts_covered: 'auction basics',
      concepts_remaining: 'creative approval',
      learner_strengths: 'explains product discovery',
      learner_gaps: 'needs more error handling practice',
    });

    expect(result).toBe('Teaching checkpoint saved for A1. Phase: assessment. Covered 1 concepts, 1 remaining. Demonstrations verified: 0.');
    expect(mocks.saveTeachingCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      concepts_covered: ['auction basics'],
      concepts_remaining: ['creative approval'],
      learner_strengths: ['explains product discovery'],
      learner_gaps: ['needs more error handling practice'],
    }));
  });

  it('splits comma-separated demonstration IDs before validation', async () => {
    mocks.getModule.mockResolvedValue({
      id: 'A1',
      exercise_definitions: [{
        success_criteria: [
          { id: 'a1_ex1_sc0', text: 'First criterion' },
          { id: 'a1_ex1_sc1', text: 'Second criterion' },
        ],
      }],
    });
    const handler = createCertificationToolHandlers({
      workos_user: { workos_user_id: 'user_123' },
    } as any).get('checkpoint_teaching_progress');

    const result = await handler?.({
      module_id: 'A1',
      current_phase: 'assessment',
      demonstrations_verified: 'a1_ex1_sc0, a1_ex1_sc1',
    });

    expect(result).toBe('Teaching checkpoint saved for A1. Phase: assessment. Covered 0 concepts, 0 remaining. Demonstrations verified: 2.');
    expect(mocks.saveTeachingCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      demonstrations_verified: ['a1_ex1_sc0', 'a1_ex1_sc1'],
    }));
  });
});

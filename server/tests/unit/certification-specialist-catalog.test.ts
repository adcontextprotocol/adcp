import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getModule: vi.fn(),
  getUserCredentials: vi.fn(),
  checkPrerequisites: vi.fn(),
  getModuleProgress: vi.fn(),
  expireStaleAttempts: vi.fn(),
  getActiveAttemptForModule: vi.fn(),
  startModule: vi.fn(),
  createAttempt: vi.fn(),
  getAttemptForUser: vi.fn(),
  getModulesForTrack: vi.fn(),
  hasEffectiveMembershipForUser: vi.fn(),
}));

vi.mock('../../src/db/certification-db.js', () => ({
  ...mocks,
}));

import {
  CERTIFICATION_TOOLS,
  createCertificationToolHandlers,
} from '../../src/addie/mcp/certification-tools.js';

const USER_ID = 'user_specialist_catalog';
const ATTEMPT_ID = '123e4567-e89b-42d3-a456-426614174000';

function memberContext() {
  return {
    workos_user: { workos_user_id: USER_ID },
    is_member: true,
  } as any;
}

describe('specialist certification catalog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserCredentials.mockResolvedValue([{ credential_id: 'practitioner' }]);
    mocks.checkPrerequisites.mockResolvedValue({ met: true, missing: [] });
    mocks.getModuleProgress.mockResolvedValue(null);
    mocks.expireStaleAttempts.mockResolvedValue(0);
    mocks.getActiveAttemptForModule.mockResolvedValue(null);
    mocks.startModule.mockResolvedValue(undefined);
    mocks.createAttempt.mockResolvedValue({
      id: ATTEMPT_ID,
      workos_user_id: USER_ID,
      track_id: 'S',
      module_id: 'S6',
      status: 'in_progress',
      started_at: new Date().toISOString(),
    });
    mocks.hasEffectiveMembershipForUser.mockResolvedValue(true);
  });

  it('advertises all specialist modules including S5 (Sponsored Intelligence) and S6 (Security)', () => {
    const tool = CERTIFICATION_TOOLS.find(candidate => candidate.name === 'start_certification_exam');
    const moduleSchema = tool?.input_schema.properties?.module_id as {
      enum?: string[];
      description?: string;
    } | undefined;

    expect(moduleSchema?.enum).toContain('S5');
    expect(moduleSchema?.enum).toContain('S6');
    expect(moduleSchema?.description).toContain('S5 (Sponsored Intelligence)');
    expect(moduleSchema?.description).toContain('S6 (Security)');
  });

  it('starts S6 with the security credential and updates sandbox module context', async () => {
    mocks.getModule.mockResolvedValue({
      id: 'S6',
      track_id: 'S',
      title: 'Security',
      description: 'Security capstone',
      format: 'capstone',
      lesson_plan: null,
      exercise_definitions: [],
      assessment_criteria: { dimensions: [], passing_threshold: 70 },
    });
    const trainingModuleContext: { moduleId?: string } = {};
    const handler = createCertificationToolHandlers(memberContext(), { trainingModuleContext })
      .get('start_certification_exam');

    const result = await handler?.({ module_id: 'S6' });

    expect(result).toContain('Credential: **AdCP Specialist — Security**');
    expect(result).toContain(`Attempt ID: ${ATTEMPT_ID}`);
    expect(trainingModuleContext.moduleId).toBe('S6');
    expect(mocks.startModule).toHaveBeenCalledWith(USER_ID, 'S6');
    expect(mocks.createAttempt).toHaveBeenCalledWith(USER_ID, 'S', undefined, 'S6');
  });

  describe('prerequisite redirect with an explanation-only key concept', () => {
    const lessonPlan = {
      objectives: ['Objective one'],
      key_concepts: [
        { topic: 'Notes concept', teaching_notes: 'Teaching notes text' },
        { topic: 'Relationship types', explanation: 'Explanation-only text for the redirect' },
        { topic: 'Empty concept' },
      ],
      discussion_prompts: [],
    };
    const missing = [{ moduleId: 'A1', status: 'not_started' }];

    function expectRedirect(result: unknown) {
      expect(result).toContain('Notes concept**: Teaching notes text');
      expect(result).toContain('Relationship types**: Explanation-only text for the redirect');
      expect(result).toContain('Empty concept**: ');
      expect(mocks.startModule).not.toHaveBeenCalled();
    }

    it('start_certification_module returns the redirect instead of throwing', async () => {
      mocks.checkPrerequisites.mockResolvedValue({ met: false, missing });
      mocks.getModule.mockResolvedValue({
        id: 'C2', track_id: 'C', title: 'Buyer', description: 'Desc', format: 'interactive',
        is_free: true, lesson_plan: lessonPlan, exercise_definitions: [],
      });
      const handler = createCertificationToolHandlers(memberContext()).get('start_certification_module');

      const result = await handler?.({ module_id: 'C2' });

      expect(result).not.toContain('Failed');
      expectRedirect(result);
      expect(result).toContain('The learner needs A1 first');
    });

    it('start_certification_exam returns the redirect instead of throwing', async () => {
      mocks.checkPrerequisites.mockResolvedValue({ met: false, missing });
      mocks.getModule.mockResolvedValue({
        id: 'S6', track_id: 'S', title: 'Security', description: 'Desc', format: 'capstone',
        lesson_plan: lessonPlan, exercise_definitions: [],
      });
      const handler = createCertificationToolHandlers(memberContext()).get('start_certification_exam');

      const result = await handler?.({ module_id: 'S6' });

      expectRedirect(result);
      expect(result).toContain('The learner needs to complete A1 first');
    });
  });
});

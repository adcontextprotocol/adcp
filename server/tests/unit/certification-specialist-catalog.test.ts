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
  });

  it('advertises S6 as a specialist module and labels S5 unavailable', () => {
    const tool = CERTIFICATION_TOOLS.find(candidate => candidate.name === 'start_certification_exam');
    const moduleSchema = tool?.input_schema.properties?.module_id as {
      enum?: string[];
      description?: string;
    } | undefined;

    expect(moduleSchema?.enum).toContain('S6');
    expect(moduleSchema?.description).toContain('S5 (Sponsored Intelligence — currently unavailable)');
    expect(moduleSchema?.description).toContain('S6 (Security)');
  });

  it('blocks S5 starts before changing progress or attempts', async () => {
    const handlers = createCertificationToolHandlers(memberContext());

    await expect(handlers.get('start_certification_module')?.({ module_id: 'S5' }))
      .resolves.toContain('not currently available for assessment');
    await expect(handlers.get('start_certification_exam')?.({ module_id: 'S5' }))
      .resolves.toContain('not currently available for assessment');

    expect(mocks.startModule).not.toHaveBeenCalled();
    expect(mocks.createAttempt).not.toHaveBeenCalled();
  });

  it('blocks completion of an existing S5 attempt', async () => {
    mocks.getAttemptForUser.mockResolvedValue({
      id: ATTEMPT_ID,
      workos_user_id: USER_ID,
      track_id: 'S',
      module_id: 'S5',
      status: 'in_progress',
      started_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    });
    mocks.getModule.mockResolvedValue({ id: 'S5', track_id: 'S', format: 'capstone' });

    const result = await createCertificationToolHandlers(memberContext())
      .get('complete_certification_exam')?.({
        attempt_id: ATTEMPT_ID,
        scores: { protocol_mastery: 90 },
      });

    expect(result).toContain('NOT COMPLETED — module S5 is not recorded as complete.');
    expect(result).toContain('not currently available for assessment');
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
});

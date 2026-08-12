import { beforeEach, describe, expect, it, vi } from 'vitest';

// certification-tools.ts imports the certification-db module; stub it so this
// pure-function test never touches a real database.
const certDbMocks = vi.hoisted(() => ({
  checkPrerequisites: vi.fn(),
  cancelAttempt: vi.fn(),
  createAttempt: vi.fn(),
  expireStaleAttempts: vi.fn(),
  getActiveAttemptForModule: vi.fn(),
  getModule: vi.fn(),
  getModuleProgress: vi.fn(),
  getDeltaStatus: vi.fn(),
  getLatestCheckpoint: vi.fn(),
  getProgress: vi.fn(),
  getUserCredentials: vi.fn(),
  hasEffectiveMembershipForUser: vi.fn(),
  startModule: vi.fn(),
}));
vi.mock('../../src/db/certification-db.js', () => certDbMocks);

import {
  buildCertificationContext,
  buildSageOpeningSection,
  buildSageResumeSection,
  createCertificationToolHandlers,
  getSpecialistCapstoneMethodology,
  SAGE_OPENING_HANDOFF,
  SAGE_RESUME_HANDOFF,
  SAGE_VOICE_EXEMPLARS,
  selectModuleMethodology,
} from '../../src/addie/mcp/certification-tools.js';

// Distinctive markers from each methodology block.
const TEACHING_MARKER = 'Teaching approach';
const BUILD_PROJECT_MARKER = 'Build project approach';
const ARTIFACT_SUPPLEMENT_MARKER = 'artifact production is mandatory';
const REQUIRED_FIELD_EXEMPLAR = 'The spec requires this field because';
const PRIOR_KNOWLEDGE_EXEMPLAR = "You've already shipped workflows like this";
const RETRY_EXEMPLAR = 'Not yet. Your approach is close';

const MEMBER_CONTEXT = {
  is_mapped: true,
  is_member: true,
  workos_user: {
    workos_user_id: 'test-user',
    email: 'learner@example.com',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('selectModuleMethodology', () => {
  it('L3 gets the teaching methodology PLUS the decision-artifact capstone supplement', () => {
    const prompt = selectModuleMethodology('L3');
    // The capstone wiring: L3 is taught like an interactive module but supplemented
    // with the mandatory-artifact instruction. This is the regression guard.
    expect(prompt).toContain(TEACHING_MARKER);
    expect(prompt).toContain(ARTIFACT_SUPPLEMENT_MARKER);
    expect(prompt).toContain('necessary but not sufficient');
    // L3 is not a build-project capstone.
    expect(prompt).not.toContain(BUILD_PROJECT_MARKER);
  });

  it.each(['B4', 'C4', 'D4'])(
    'build-project module %s gets the build-project methodology, not the artifact supplement',
    (id) => {
      const prompt = selectModuleMethodology(id);
      expect(prompt).toContain(BUILD_PROJECT_MARKER);
      expect(prompt).not.toContain(ARTIFACT_SUPPLEMENT_MARKER);
    },
  );

  it.each(['L1', 'L2', 'A1', 'A2', 'B1', 'S1'])(
    'standard module %s gets the plain teaching methodology — no capstone supplement',
    (id) => {
      const prompt = selectModuleMethodology(id);
      expect(prompt).toContain(TEACHING_MARKER);
      expect(prompt).not.toContain(ARTIFACT_SUPPLEMENT_MARKER);
      expect(prompt).not.toContain(BUILD_PROJECT_MARKER);
    },
  );

  it.each(['A1', 'B4'])('%s methodology preserves Sage voice exemplars', (id) => {
    const prompt = selectModuleMethodology(id);

    expect(prompt).toContain(REQUIRED_FIELD_EXEMPLAR);
    expect(prompt).toContain(PRIOR_KNOWLEDGE_EXEMPLAR);
    expect(prompt).toContain(RETRY_EXEMPLAR);
  });

  it('specialist capstone methodology preserves Sage voice exemplars', () => {
    const prompt = getSpecialistCapstoneMethodology();

    expect(prompt).toContain(REQUIRED_FIELD_EXEMPLAR);
    expect(prompt).toContain(PRIOR_KNOWLEDGE_EXEMPLAR);
    expect(prompt).toContain(RETRY_EXEMPLAR);
  });

  it('active certification context preserves Sage voice without replaying the opening', async () => {
    certDbMocks.getModule.mockResolvedValue(null);

    const context = await buildCertificationContext([{ module_id: 'A1', started_at: null }]);

    expect(context).toContain(SAGE_VOICE_EXEMPLARS);
    expect(context).not.toContain(SAGE_OPENING_HANDOFF);
    expect(context).toContain('Do NOT call start_certification_module again');
    expect(context).toContain('call start_certification_exam once to recover the existing attempt');
  });

  it('rehydrates recurring Sage context for an active delta after tool history is trimmed', async () => {
    certDbMocks.getActiveAttemptForModule.mockResolvedValue({
      id: 'delta-attempt-1',
      started_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    });
    certDbMocks.getModule.mockResolvedValue({
      id: 'S2',
      tenant_ids: [],
      lesson_plan: null,
      exercise_definitions: null,
      assessment_criteria: null,
    });
    certDbMocks.getProgress.mockResolvedValue([]);
    certDbMocks.getLatestCheckpoint.mockResolvedValue(null);

    const context = await buildCertificationContext([], 'test-user');

    expect(context).toContain('## Active certification modules');
    expect(context).toContain('**S2** (in progress');
    expect(context).toContain(SAGE_VOICE_EXEMPLARS);
    expect(context).not.toContain(SAGE_OPENING_HANDOFF);
  });

  it('does not hydrate stale delta attempts into recurring Sage context', async () => {
    certDbMocks.getActiveAttemptForModule.mockResolvedValue({
      id: 'stale-delta-attempt',
      started_at: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const context = await buildCertificationContext([], 'test-user');

    expect(context).toBeNull();
  });

  it('builds the trusted Sage opening used by module and capstone starts', () => {
    const opening = buildSageOpeningSection();

    expect(opening).toContain('## Required Sage opening');
    expect(opening).toContain(SAGE_OPENING_HANDOFF);
    expect(opening).toContain("Addie's handed you over to me");
  });

  it('includes the Sage opening in a successful standard-module start result', async () => {
    certDbMocks.getModule.mockResolvedValue({
      id: 'A1',
      title: 'Introduction',
      is_free: true,
      lesson_plan: null,
      exercise_definitions: null,
      assessment_criteria: null,
    });
    certDbMocks.checkPrerequisites.mockResolvedValue({ met: true, missing: [] });
    certDbMocks.getModuleProgress.mockResolvedValue(null);
    certDbMocks.startModule.mockResolvedValue(undefined);

    const start = createCertificationToolHandlers(MEMBER_CONTEXT).get('start_certification_module');
    const result = await start!({ module_id: 'A1' });

    expect(result).toContain(buildSageOpeningSection());
  });

  it('includes the Sage opening in a successful specialist-capstone start result', async () => {
    certDbMocks.getModule.mockResolvedValue({
      id: 'S1',
      title: 'Media buy specialist',
      description: 'Specialist capstone',
      format: 'capstone',
      is_free: false,
      track_id: 'specialist',
      lesson_plan: null,
      exercise_definitions: null,
      assessment_criteria: null,
    });
    certDbMocks.hasEffectiveMembershipForUser.mockResolvedValue(true);
    certDbMocks.getUserCredentials.mockResolvedValue([{ credential_id: 'practitioner' }]);
    certDbMocks.checkPrerequisites.mockResolvedValue({ met: true, missing: [] });
    certDbMocks.getModuleProgress.mockResolvedValue(null);
    certDbMocks.expireStaleAttempts.mockResolvedValue(0);
    certDbMocks.getActiveAttemptForModule.mockResolvedValue(null);
    certDbMocks.startModule.mockResolvedValue(undefined);
    certDbMocks.createAttempt.mockResolvedValue({ id: 'attempt-1' });

    const start = createCertificationToolHandlers(MEMBER_CONTEXT).get('start_certification_exam');
    const result = await start!({ module_id: 'S1' });

    expect(result).toContain(buildSageOpeningSection());
  });

  it('keeps Sage without replaying the opening when a specialist capstone resumes', async () => {
    certDbMocks.getModule.mockResolvedValue({
      id: 'S1',
      title: 'Media buy specialist',
      format: 'capstone',
      is_free: false,
      track_id: 'specialist',
    });
    certDbMocks.hasEffectiveMembershipForUser.mockResolvedValue(true);
    certDbMocks.getUserCredentials.mockResolvedValue([{ credential_id: 'practitioner' }]);
    certDbMocks.checkPrerequisites.mockResolvedValue({ met: true, missing: [] });
    certDbMocks.getModuleProgress.mockResolvedValue(null);
    certDbMocks.expireStaleAttempts.mockResolvedValue(0);
    certDbMocks.getActiveAttemptForModule.mockResolvedValue({
      id: 'attempt-1',
      started_at: '2026-08-01T00:00:00.000Z',
    });

    const start = createCertificationToolHandlers(MEMBER_CONTEXT).get('start_certification_exam');
    const result = await start!({ module_id: 'S1' });

    expect(result).toContain(buildSageResumeSection());
    expect(result).toContain(SAGE_RESUME_HANDOFF);
    expect(result).not.toContain(SAGE_OPENING_HANDOFF);
  });

  it('includes the Sage opening in a fresh specialist-delta start result', async () => {
    certDbMocks.getModule.mockResolvedValue({
      id: 'S2',
      title: 'Creative specialist',
      description: 'Creative specialist capstone',
      format: 'capstone',
      is_free: false,
      track_id: 'specialist',
      lesson_plan: null,
      exercise_definitions: [],
      assessment_criteria: null,
    });
    certDbMocks.hasEffectiveMembershipForUser.mockResolvedValue(true);
    certDbMocks.getUserCredentials.mockResolvedValue([{ credential_id: 'practitioner' }]);
    certDbMocks.checkPrerequisites.mockResolvedValue({ met: true, missing: [] });
    certDbMocks.getModuleProgress.mockResolvedValue({ status: 'completed' });
    certDbMocks.getDeltaStatus.mockResolvedValue({
      active: true,
      status: 'delta_available',
      missing_criterion_ids: [],
      delta_window_closes_at: '2026-12-31T00:00:00.000Z',
    });
    certDbMocks.expireStaleAttempts.mockResolvedValue(0);
    certDbMocks.getActiveAttemptForModule.mockResolvedValue(null);
    certDbMocks.createAttempt.mockResolvedValue({ id: 'delta-attempt-1' });

    const start = createCertificationToolHandlers(MEMBER_CONTEXT).get('start_certification_exam');
    const result = await start!({ module_id: 'S2' });

    expect(result).toContain(buildSageOpeningSection());
  });

  it('keeps Sage without replaying the opening when a specialist delta resumes', async () => {
    certDbMocks.getModule.mockResolvedValue({
      id: 'S2',
      title: 'Creative specialist',
      format: 'capstone',
      is_free: false,
      track_id: 'specialist',
    });
    certDbMocks.hasEffectiveMembershipForUser.mockResolvedValue(true);
    certDbMocks.getUserCredentials.mockResolvedValue([{ credential_id: 'practitioner' }]);
    certDbMocks.checkPrerequisites.mockResolvedValue({ met: true, missing: [] });
    certDbMocks.getModuleProgress.mockResolvedValue({ status: 'completed' });
    certDbMocks.getDeltaStatus.mockResolvedValue({ active: true, status: 'delta_available' });
    certDbMocks.expireStaleAttempts.mockResolvedValue(0);
    certDbMocks.getActiveAttemptForModule.mockResolvedValue({
      id: 'delta-attempt-1',
      started_at: '2026-08-01T00:00:00.000Z',
    });

    const start = createCertificationToolHandlers(MEMBER_CONTEXT).get('start_certification_exam');
    const result = await start!({ module_id: 'S2' });

    expect(result).toContain(buildSageResumeSection());
    expect(result).toContain(SAGE_RESUME_HANDOFF);
    expect(result).not.toContain(SAGE_OPENING_HANDOFF);
  });
});

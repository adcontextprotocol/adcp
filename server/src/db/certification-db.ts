import { query } from './client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('certification-db');

// =====================================================
// TYPES
// =====================================================

export interface CertificationTrack {
  id: string;
  name: string;
  description: string | null;
  badge_type: string | null;
  certifier_group_id: string | null;
  sort_order: number;
}

export interface CertificationModule {
  id: string;
  track_id: string;
  title: string;
  description: string | null;
  format: string;
  duration_minutes: number;
  sort_order: number;
  is_free: boolean;
  prerequisites: string[];
  lesson_plan: LessonPlan | null;
  exercise_definitions: ExerciseDefinition[] | null;
  assessment_criteria: AssessmentCriteria | null;
}

export interface LessonPlan {
  objectives: string[];
  key_concepts: Array<{ topic: string; explanation?: string; teaching_notes?: string }>;
  discussion_prompts: string[];
  demo_scenarios?: Array<{ description: string; tools: string[]; expected_outcome: string }>;
}

export interface ExerciseDefinition {
  id: string;
  title: string;
  description: string;
  sandbox_actions: Array<{ tool: string; guidance: string }>;
  success_criteria: string[];
}

export interface AssessmentCriteria {
  dimensions: Array<{
    name: string;
    weight: number;
    description: string;
    scoring_guide: Record<string, string>;
  }>;
  passing_threshold: number;
}

export interface LearnerProgress {
  id: string;
  workos_user_id: string;
  module_id: string;
  status: 'not_started' | 'in_progress' | 'completed' | 'tested_out';
  started_at: string | null;
  completed_at: string | null;
  score: Record<string, number> | null;
  addie_thread_id: string | null;
  attempts: number;
}

export interface CertificationAttempt {
  id: string;
  workos_user_id: string;
  track_id: string;
  module_id: string | null;
  status: 'in_progress' | 'passed' | 'failed';
  started_at: string;
  completed_at: string | null;
  scores: Record<string, number> | null;
  overall_score: number | null;
  passing: boolean | null;
  addie_thread_id: string | null;
  certifier_credential_id: string | null;
  certifier_public_id: string | null;
  created_at: string;
}

export interface CertificationCredential {
  id: string;
  tier: number;
  name: string;
  description: string | null;
  required_modules: string[];
  requires_any_track_complete: boolean;
  requires_credential: string | null;
  certifier_group_id: string | null;
  badge_id: string | null;
  sort_order: number;
}

export interface UserCredential {
  id: string;
  workos_user_id: string;
  credential_id: string;
  awarded_at: string;
  certifier_credential_id: string | null;
  certifier_public_id: string | null;
  certifier_badge_url: string | null;
}

// =====================================================
// TRACKS
// =====================================================

export async function getTracks(): Promise<CertificationTrack[]> {
  const result = await query<CertificationTrack>(
    'SELECT * FROM certification_tracks ORDER BY sort_order'
  );
  return result.rows;
}

export async function getTrack(id: string): Promise<CertificationTrack | null> {
  const result = await query<CertificationTrack>(
    'SELECT * FROM certification_tracks WHERE id = $1',
    [id]
  );
  return result.rows[0] || null;
}

// =====================================================
// MODULES
// =====================================================

export async function getModules(): Promise<CertificationModule[]> {
  const result = await query<CertificationModule>(
    'SELECT * FROM certification_modules ORDER BY track_id, sort_order'
  );
  return result.rows;
}

export async function getModulesForTrack(trackId: string): Promise<CertificationModule[]> {
  const result = await query<CertificationModule>(
    'SELECT * FROM certification_modules WHERE track_id = $1 ORDER BY sort_order',
    [trackId]
  );
  return result.rows;
}

export async function getModule(id: string): Promise<CertificationModule | null> {
  const result = await query<CertificationModule>(
    'SELECT * FROM certification_modules WHERE id = $1',
    [id]
  );
  return result.rows[0] || null;
}

// =====================================================
// LEARNER PROGRESS
// =====================================================

export async function getProgress(userId: string): Promise<LearnerProgress[]> {
  const result = await query<LearnerProgress>(
    'SELECT * FROM learner_progress WHERE workos_user_id = $1',
    [userId]
  );
  return result.rows;
}

export async function getAbandonedModule(userId: string): Promise<{ module_id: string; title: string } | null> {
  const result = await query<{ module_id: string; title: string }>(
    `SELECT lp.module_id, m.title
     FROM learner_progress lp
     JOIN certification_modules m ON m.id = lp.module_id
     WHERE lp.workos_user_id = $1
       AND lp.status = 'in_progress'
       AND COALESCE(
         (SELECT MAX(tc.created_at) FROM teaching_checkpoints tc
          WHERE tc.workos_user_id = lp.workos_user_id AND tc.module_id = lp.module_id),
         lp.started_at
       ) < NOW() - INTERVAL '3 days'
     ORDER BY lp.started_at DESC
     LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
}

export async function getModuleProgress(userId: string, moduleId: string): Promise<LearnerProgress | null> {
  const result = await query<LearnerProgress>(
    'SELECT * FROM learner_progress WHERE workos_user_id = $1 AND module_id = $2',
    [userId, moduleId]
  );
  return result.rows[0] || null;
}

export async function startModule(
  userId: string,
  moduleId: string,
  addieThreadId?: string
): Promise<LearnerProgress> {
  const result = await query<LearnerProgress>(
    `INSERT INTO learner_progress (workos_user_id, module_id, status, started_at, addie_thread_id)
     VALUES ($1, $2, 'in_progress', NOW(), $3)
     ON CONFLICT (workos_user_id, module_id) DO UPDATE
       SET status = CASE
             WHEN learner_progress.status IN ('completed', 'tested_out')
               THEN learner_progress.status
             ELSE 'in_progress'
           END,
           started_at = COALESCE(learner_progress.started_at, NOW()),
           addie_thread_id = COALESCE($3, learner_progress.addie_thread_id),
           attempts = CASE
             WHEN learner_progress.status IN ('completed', 'tested_out')
               THEN learner_progress.attempts
             ELSE learner_progress.attempts + 1
           END,
           updated_at = NOW()
     RETURNING *`,
    [userId, moduleId, addieThreadId || null]
  );
  return result.rows[0];
}

export async function completeModule(
  userId: string,
  moduleId: string,
  score: Record<string, number>
): Promise<LearnerProgress> {
  const result = await query<LearnerProgress>(
    `UPDATE learner_progress
     SET status = 'completed', completed_at = NOW(), score = $3, updated_at = NOW()
     WHERE workos_user_id = $1 AND module_id = $2
     RETURNING *`,
    [userId, moduleId, JSON.stringify(score)]
  );
  if (!result.rows[0]) {
    throw new Error(`No progress record found for user ${userId}, module ${moduleId}`);
  }
  return result.rows[0];
}

/**
 * Mark a module as tested out (user demonstrated knowledge without formal coursework).
 */
export async function testOutModule(
  userId: string,
  moduleId: string,
): Promise<LearnerProgress> {
  const result = await query<LearnerProgress>(
    `INSERT INTO learner_progress (workos_user_id, module_id, status, started_at, completed_at)
     VALUES ($1, $2, 'tested_out', NOW(), NOW())
     ON CONFLICT (workos_user_id, module_id) DO UPDATE
       SET status = CASE
         WHEN learner_progress.status = 'completed' THEN learner_progress.status
         ELSE 'tested_out'
       END,
       completed_at = COALESCE(learner_progress.completed_at, NOW()),
       updated_at = NOW()
     RETURNING *`,
    [userId, moduleId]
  );
  return result.rows[0];
}

/**
 * Check if a user has completed all prerequisites for a module.
 */
export async function checkPrerequisites(userId: string, moduleId: string): Promise<{ met: boolean; missing: string[] }> {
  const mod = await getModule(moduleId);
  if (!mod) throw new Error(`Module ${moduleId} not found`);
  if (!mod.prerequisites || mod.prerequisites.length === 0) return { met: true, missing: [] };

  const result = await query<{ module_id: string }>(
    `SELECT module_id FROM learner_progress
     WHERE workos_user_id = $1 AND module_id = ANY($2) AND status IN ('completed', 'tested_out')`,
    [userId, mod.prerequisites]
  );
  const completed = new Set(result.rows.map(r => r.module_id));
  const missing = mod.prerequisites.filter(p => !completed.has(p));
  return { met: missing.length === 0, missing };
}

// =====================================================
// CERTIFICATION ATTEMPTS
// =====================================================

export async function createAttempt(
  userId: string,
  trackId: string,
  addieThreadId: string | undefined,
  moduleId: string
): Promise<CertificationAttempt> {
  const result = await query<CertificationAttempt>(
    `INSERT INTO certification_attempts (workos_user_id, track_id, addie_thread_id, module_id)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [userId, trackId, addieThreadId || null, moduleId]
  );
  return result.rows[0];
}

export async function completeAttempt(
  attemptId: string,
  scores: Record<string, number>,
  overallScore: number,
  passing: boolean,
  certifierCredentialId?: string,
  certifierPublicId?: string
): Promise<CertificationAttempt> {
  const status = passing ? 'passed' : 'failed';
  const result = await query<CertificationAttempt>(
    `UPDATE certification_attempts
     SET status = $2, completed_at = NOW(), scores = $3, overall_score = $4,
         passing = $5, certifier_credential_id = $6, certifier_public_id = $7
     WHERE id = $1
     RETURNING *`,
    [attemptId, status, JSON.stringify(scores), overallScore, passing,
     certifierCredentialId || null, certifierPublicId || null]
  );
  if (!result.rows[0]) {
    throw new Error(`Certification attempt ${attemptId} not found`);
  }
  return result.rows[0];
}

export async function getAttempt(attemptId: string): Promise<CertificationAttempt | null> {
  const result = await query<CertificationAttempt>(
    'SELECT * FROM certification_attempts WHERE id = $1',
    [attemptId]
  );
  return result.rows[0] || null;
}

export async function getUserAttempts(userId: string): Promise<CertificationAttempt[]> {
  const result = await query<CertificationAttempt>(
    'SELECT * FROM certification_attempts WHERE workos_user_id = $1 ORDER BY created_at DESC',
    [userId]
  );
  return result.rows;
}

export async function getUserCertifications(userId: string): Promise<CertificationAttempt[]> {
  const result = await query<CertificationAttempt>(
    `SELECT * FROM certification_attempts
     WHERE workos_user_id = $1 AND status = 'passed'
     ORDER BY completed_at DESC`,
    [userId]
  );
  return result.rows;
}

/**
 * Get an active (in_progress) attempt for a user and track.
 */
export async function getActiveAttempt(userId: string, trackId: string): Promise<CertificationAttempt | null> {
  const result = await query<CertificationAttempt>(
    `SELECT * FROM certification_attempts
     WHERE workos_user_id = $1 AND track_id = $2 AND status = 'in_progress'
     ORDER BY created_at DESC LIMIT 1`,
    [userId, trackId]
  );
  return result.rows[0] || null;
}

// =====================================================
// CREDENTIALS
// =====================================================

export async function getCredentials(): Promise<CertificationCredential[]> {
  const result = await query<CertificationCredential>(
    'SELECT * FROM certification_credentials ORDER BY sort_order'
  );
  return result.rows;
}

export async function getCredential(id: string): Promise<CertificationCredential | null> {
  const result = await query<CertificationCredential>(
    'SELECT * FROM certification_credentials WHERE id = $1',
    [id]
  );
  return result.rows[0] || null;
}

export async function getUserCredentials(userId: string): Promise<UserCredential[]> {
  const result = await query<UserCredential>(
    'SELECT * FROM user_credentials WHERE workos_user_id = $1 ORDER BY awarded_at DESC',
    [userId]
  );
  return result.rows;
}

/**
 * Check if a user is eligible for a credential based on their completed modules.
 * Returns { eligible, missing } where missing describes what's still needed.
 */
export async function checkCredentialEligibility(
  userId: string,
  credentialId: string
): Promise<{ eligible: boolean; missing: string[] }> {
  const credential = await getCredential(credentialId);
  if (!credential) throw new Error(`Credential ${credentialId} not found`);

  const missing: string[] = [];

  // Check prerequisite credential
  if (credential.requires_credential) {
    const held = await query<{ credential_id: string }>(
      `SELECT credential_id FROM user_credentials
       WHERE workos_user_id = $1 AND credential_id = $2`,
      [userId, credential.requires_credential]
    );
    if (held.rows.length === 0) {
      missing.push(`Requires ${credential.requires_credential} credential`);
    }
  }

  // Check required modules
  if (credential.required_modules.length > 0) {
    const completed = await query<{ module_id: string }>(
      `SELECT module_id FROM learner_progress
       WHERE workos_user_id = $1 AND module_id = ANY($2) AND status IN ('completed', 'tested_out')`,
      [userId, credential.required_modules]
    );
    const completedSet = new Set(completed.rows.map(r => r.module_id));
    const missingModules = credential.required_modules.filter(m => !completedSet.has(m));
    if (missingModules.length > 0) {
      missing.push(`Complete modules: ${missingModules.join(', ')}`);
    }
  }

  // Check if any specialization track is fully completed
  if (credential.requires_any_track_complete) {
    const trackCheck = await query<{ track_id: string; total: string; completed: string }>(
      `SELECT m.track_id,
              COUNT(m.id)::text AS total,
              COUNT(CASE WHEN lp.status IN ('completed', 'tested_out') THEN 1 END)::text AS completed
       FROM certification_modules m
       JOIN certification_tracks t ON t.id = m.track_id
       LEFT JOIN learner_progress lp ON lp.module_id = m.id AND lp.workos_user_id = $1
       WHERE t.badge_type IS NOT NULL
       GROUP BY m.track_id`,
      [userId]
    );
    const anyTrackComplete = trackCheck.rows.some(
      r => parseInt(r.total) > 0 && r.completed === r.total
    );
    if (!anyTrackComplete) {
      missing.push('Complete at least one specialization track');
    }
  }

  return { eligible: missing.length === 0, missing };
}

/**
 * Award a credential to a user. Returns the new record, or existing if already awarded.
 */
export async function awardCredential(
  userId: string,
  credentialId: string,
  certifierCredentialId?: string,
  certifierPublicId?: string,
  certifierBadgeUrl?: string,
): Promise<UserCredential> {
  const result = await query<UserCredential>(
    `INSERT INTO user_credentials (workos_user_id, credential_id, certifier_credential_id, certifier_public_id, certifier_badge_url)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (workos_user_id, credential_id) DO UPDATE
       SET certifier_credential_id = COALESCE(EXCLUDED.certifier_credential_id, user_credentials.certifier_credential_id),
           certifier_public_id = COALESCE(EXCLUDED.certifier_public_id, user_credentials.certifier_public_id),
           certifier_badge_url = COALESCE(EXCLUDED.certifier_badge_url, user_credentials.certifier_badge_url)
     RETURNING *`,
    [userId, credentialId, certifierCredentialId || null, certifierPublicId || null, certifierBadgeUrl || null]
  );
  return result.rows[0];
}

/**
 * Check and auto-award any credentials the user has become eligible for.
 * Returns a list of newly awarded credential IDs.
 */
export async function checkAndAwardCredentials(userId: string): Promise<string[]> {
  const [credentials, existing] = await Promise.all([
    getCredentials(),
    getUserCredentials(userId),
  ]);
  const heldSet = new Set(existing.map(c => c.credential_id));
  const awarded: string[] = [];

  // Process in tier order so prerequisites are checked correctly
  for (const credential of credentials) {
    if (heldSet.has(credential.id)) continue;

    const { eligible } = await checkCredentialEligibility(userId, credential.id);
    if (eligible) {
      await awardCredential(userId, credential.id);
      heldSet.add(credential.id);
      awarded.push(credential.id);
      logger.info({ userId, credentialId: credential.id }, 'Auto-awarded credential');
    }
  }

  return awarded;
}

// =====================================================
// PROGRESS SUMMARIES
// =====================================================

export interface TrackProgress {
  track_id: string;
  total_modules: number;
  completed_modules: number;
  in_progress_modules: number;
}

export async function getTrackProgress(userId: string): Promise<TrackProgress[]> {
  const result = await query<TrackProgress>(
    `SELECT
       m.track_id,
       COUNT(m.id)::int AS total_modules,
       COUNT(CASE WHEN lp.status IN ('completed', 'tested_out') THEN 1 END)::int AS completed_modules,
       COUNT(CASE WHEN lp.status = 'in_progress' THEN 1 END)::int AS in_progress_modules
     FROM certification_modules m
     LEFT JOIN learner_progress lp ON lp.module_id = m.id AND lp.workos_user_id = $1
     GROUP BY m.track_id
     ORDER BY m.track_id`,
    [userId]
  );
  return result.rows;
}

// =====================================================
// PUBLIC MEMBER CREDENTIALS
// =====================================================

export interface PublicUserCredential {
  credential_id: string;
  credential_name: string;
  tier: number;
  awarded_at: string;
}

/**
 * Get a user's earned credentials for public display (no internal IDs or Certifier details).
 */
export async function getPublicUserCredentials(userId: string): Promise<PublicUserCredential[]> {
  const result = await query<PublicUserCredential>(
    `SELECT uc.credential_id, cc.name AS credential_name, cc.tier, uc.awarded_at
     FROM user_credentials uc
     JOIN certification_credentials cc ON cc.id = uc.credential_id
     WHERE uc.workos_user_id = $1
     ORDER BY cc.tier, cc.sort_order`,
    [userId]
  );
  return result.rows;
}

export interface OwnUserCredential extends PublicUserCredential {
  certifier_public_id: string | null;
  certifier_credential_id: string | null;
  certifier_badge_url: string | null;
}

/**
 * Get a user's own earned credentials including Certifier IDs for sharing.
 */
export async function getOwnUserCredentials(userId: string): Promise<OwnUserCredential[]> {
  const result = await query<OwnUserCredential>(
    `SELECT uc.credential_id, cc.name AS credential_name, cc.tier, uc.awarded_at,
            uc.certifier_public_id, uc.certifier_credential_id, uc.certifier_badge_url
     FROM user_credentials uc
     JOIN certification_credentials cc ON cc.id = uc.credential_id
     WHERE uc.workos_user_id = $1
     ORDER BY cc.tier, cc.sort_order`,
    [userId]
  );
  return result.rows;
}

/**
 * Get earned credentials for all members of an organization.
 * Returns the highest tier credential per org for member card badges.
 */
export async function getOrgMemberCredentials(workosOrgId: string): Promise<PublicUserCredential[]> {
  const result = await query<PublicUserCredential>(
    `SELECT DISTINCT ON (cc.tier) uc.credential_id, cc.name AS credential_name, cc.tier, uc.awarded_at
     FROM user_credentials uc
     JOIN certification_credentials cc ON cc.id = uc.credential_id
     JOIN organization_memberships om ON om.workos_user_id = uc.workos_user_id
     WHERE om.workos_organization_id = $1
     ORDER BY cc.tier DESC, uc.awarded_at DESC`,
    [workosOrgId]
  );
  return result.rows;
}

// =====================================================
// ORGANIZATION CERTIFICATION SUMMARY
// =====================================================

export interface OrgMemberCertification {
  user_id: string;
  first_name: string;
  last_name: string;
  credentials: string[];
  modules_completed: number;
  modules_in_progress: number;
}

export interface OrgCertificationSummary {
  total_members: number;
  members_with_credentials: number;
  credentials_earned: Array<{ credential: string; tier: number; count: number }>;
  members: OrgMemberCertification[];
}

/**
 * Get certification summary for all members of an organization.
 */
export async function getOrgCertificationSummary(orgId: string): Promise<OrgCertificationSummary> {
  // Get all org members
  const membersResult = await query<{ workos_user_id: string; first_name: string; last_name: string }>(
    `SELECT om.workos_user_id, u.first_name, u.last_name
     FROM organization_memberships om
     JOIN users u ON u.workos_user_id = om.workos_user_id
     WHERE om.workos_organization_id = $1`,
    [orgId]
  );

  const memberIds = membersResult.rows.map(m => m.workos_user_id);
  if (memberIds.length === 0) {
    return { total_members: 0, members_with_credentials: 0, credentials_earned: [], members: [] };
  }

  // Get credentials for all org members
  const credsResult = await query<{ workos_user_id: string; credential_id: string; credential_name: string; tier: number }>(
    `SELECT uc.workos_user_id, uc.credential_id, cc.name AS credential_name, cc.tier
     FROM user_credentials uc
     JOIN certification_credentials cc ON cc.id = uc.credential_id
     WHERE uc.workos_user_id = ANY($1)`,
    [memberIds]
  );

  // Get progress for all org members
  const progressResult = await query<{ workos_user_id: string; status: string; count: number }>(
    `SELECT workos_user_id, status, COUNT(*)::int AS count
     FROM learner_progress
     WHERE workos_user_id = ANY($1) AND status IN ('completed', 'tested_out', 'in_progress')
     GROUP BY workos_user_id, status`,
    [memberIds]
  );

  // Build per-member data
  const credsByUser = new Map<string, string[]>();
  for (const row of credsResult.rows) {
    const list = credsByUser.get(row.workos_user_id) || [];
    list.push(row.credential_id);
    credsByUser.set(row.workos_user_id, list);
  }

  const progressByUser = new Map<string, { completed: number; in_progress: number }>();
  for (const row of progressResult.rows) {
    const entry = progressByUser.get(row.workos_user_id) || { completed: 0, in_progress: 0 };
    if (row.status === 'completed' || row.status === 'tested_out') entry.completed += row.count;
    if (row.status === 'in_progress') entry.in_progress = row.count;
    progressByUser.set(row.workos_user_id, entry);
  }

  const members: OrgMemberCertification[] = membersResult.rows.map(m => ({
    user_id: m.workos_user_id,
    first_name: m.first_name || '',
    last_name: m.last_name || '',
    credentials: credsByUser.get(m.workos_user_id) || [],
    modules_completed: progressByUser.get(m.workos_user_id)?.completed || 0,
    modules_in_progress: progressByUser.get(m.workos_user_id)?.in_progress || 0,
  }));

  // Aggregate credential counts
  const credCounts = new Map<string, { credential: string; tier: number; count: number }>();
  for (const row of credsResult.rows) {
    const existing = credCounts.get(row.credential_id);
    if (existing) {
      existing.count++;
    } else {
      credCounts.set(row.credential_id, { credential: row.credential_name, tier: row.tier, count: 1 });
    }
  }

  return {
    total_members: memberIds.length,
    members_with_credentials: new Set(credsResult.rows.map(r => r.workos_user_id)).size,
    credentials_earned: [...credCounts.values()].sort((a, b) => a.tier - b.tier),
    members,
  };
}

// =====================================================
// TEACHING CHECKPOINTS
// =====================================================

export interface TeachingCheckpoint {
  id: string;
  workos_user_id: string;
  module_id: string;
  thread_id: string | null;
  concepts_covered: string[];
  concepts_remaining: string[];
  learner_strengths: string[];
  learner_gaps: string[];
  current_phase: string;
  preliminary_scores: Record<string, number> | null;
  notes: string | null;
  created_at: string;
}

export async function saveTeachingCheckpoint(checkpoint: {
  workos_user_id: string;
  module_id: string;
  thread_id?: string;
  concepts_covered: string[];
  concepts_remaining: string[];
  learner_strengths?: string[];
  learner_gaps?: string[];
  current_phase: string;
  preliminary_scores?: Record<string, number>;
  notes?: string;
}): Promise<TeachingCheckpoint> {
  const result = await query<TeachingCheckpoint>(
    `INSERT INTO teaching_checkpoints
       (workos_user_id, module_id, thread_id, concepts_covered, concepts_remaining,
        learner_strengths, learner_gaps, current_phase, preliminary_scores, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      checkpoint.workos_user_id,
      checkpoint.module_id,
      checkpoint.thread_id || null,
      Array.isArray(checkpoint.concepts_covered) ? checkpoint.concepts_covered : [],
      Array.isArray(checkpoint.concepts_remaining) ? checkpoint.concepts_remaining : [],
      Array.isArray(checkpoint.learner_strengths) ? checkpoint.learner_strengths : [],
      Array.isArray(checkpoint.learner_gaps) ? checkpoint.learner_gaps : [],
      checkpoint.current_phase,
      checkpoint.preliminary_scores ? JSON.stringify(checkpoint.preliminary_scores) : null,
      checkpoint.notes || null,
    ]
  );
  return result.rows[0];
}

export async function getLatestCheckpoint(
  userId: string,
  moduleId: string
): Promise<TeachingCheckpoint | null> {
  const result = await query<TeachingCheckpoint>(
    `SELECT * FROM teaching_checkpoints
     WHERE workos_user_id = $1 AND module_id = $2
     ORDER BY created_at DESC LIMIT 1`,
    [userId, moduleId]
  );
  return result.rows[0] || null;
}

// =====================================================
// ADMIN ANALYTICS
// =====================================================

export interface AdminOverviewMetrics {
  totals: {
    learners: number;
    credentials_issued: number;
    modules_completed: number;
    modules_started: number;
    abandoned: number;
    total_sessions: number;
  };
  credentials_by_tier: Array<{ tier: number; name: string; count: number; badges_issued: number }>;
  module_completion: Array<{
    module_id: string;
    title: string;
    started: number;
    completed: number;
    rate: number;
    avg_score: number | null;
    avg_duration_minutes: number | null;
    abandoned: number;
    sessions: number;
    dimensions: Array<{ name: string; avg_score: number }>;
  }>;
}

export async function getAdminOverviewMetrics(): Promise<AdminOverviewMetrics> {
  // Totals
  const totalsResult = await query<{
    learners: string; credentials_issued: string;
    modules_completed: string; modules_started: string; abandoned: string;
    total_sessions: string;
  }>(
    `SELECT
       (SELECT COUNT(DISTINCT workos_user_id) FROM learner_progress)::text AS learners,
       (SELECT COUNT(*) FROM user_credentials)::text AS credentials_issued,
       (SELECT COUNT(*) FROM learner_progress WHERE status IN ('completed', 'tested_out'))::text AS modules_completed,
       (SELECT COUNT(*) FROM learner_progress)::text AS modules_started,
       (SELECT COUNT(*) FROM learner_progress lp WHERE lp.status = 'in_progress'
          AND COALESCE(
            (SELECT MAX(tc.created_at) FROM teaching_checkpoints tc
             WHERE tc.workos_user_id = lp.workos_user_id AND tc.module_id = lp.module_id),
            lp.started_at
          ) < NOW() - INTERVAL '3 days')::text AS abandoned,
       (SELECT COUNT(DISTINCT thread_id) FROM teaching_checkpoints)::text AS total_sessions`
  );
  const t = totalsResult.rows[0];

  // Credentials by tier
  const credResult = await query<{ tier: number; name: string; count: string; badges_issued: string }>(
    `SELECT cc.tier, cc.name, COUNT(uc.id)::text AS count,
            CASE WHEN cc.certifier_group_id IS NULL THEN COUNT(uc.id)
                 ELSE COUNT(CASE WHEN uc.certifier_credential_id IS NOT NULL THEN 1 END)
            END::text AS badges_issued
     FROM certification_credentials cc
     LEFT JOIN user_credentials uc ON uc.credential_id = cc.id
     GROUP BY cc.id, cc.tier, cc.name, cc.sort_order, cc.certifier_group_id
     ORDER BY cc.sort_order`
  );

  // Module completion with dimension averages
  const moduleResult = await query<{
    module_id: string; title: string; started: string; completed: string;
    avg_score: string | null; avg_duration_minutes: string | null; abandoned: string;
    sessions: string;
  }>(
    `SELECT
       m.id AS module_id,
       m.title,
       COUNT(lp.id)::text AS started,
       COUNT(CASE WHEN lp.status IN ('completed', 'tested_out') THEN 1 END)::text AS completed,
       ROUND(AVG(CASE WHEN lp.score IS NOT NULL
         THEN (SELECT AVG(v::numeric) FROM jsonb_each_text(lp.score) AS x(k, v))
       END))::text AS avg_score,
       ROUND(AVG(CASE WHEN lp.status IN ('completed', 'tested_out') AND lp.started_at IS NOT NULL
         THEN EXTRACT(EPOCH FROM (
           COALESCE(
             (SELECT MAX(tc.created_at) FROM teaching_checkpoints tc
              WHERE tc.workos_user_id = lp.workos_user_id AND tc.module_id = lp.module_id),
             lp.completed_at
           ) - lp.started_at
         )) / 60
       END))::text AS avg_duration_minutes,
       COUNT(CASE WHEN lp.status = 'in_progress'
         AND COALESCE(
           (SELECT MAX(tc.created_at) FROM teaching_checkpoints tc
            WHERE tc.workos_user_id = lp.workos_user_id AND tc.module_id = lp.module_id),
           lp.started_at
         ) < NOW() - INTERVAL '3 days' THEN 1
       END)::text AS abandoned,
       COALESCE((SELECT COUNT(DISTINCT tc.thread_id) FROM teaching_checkpoints tc WHERE tc.module_id = m.id), 0)::text AS sessions
     FROM certification_modules m
     LEFT JOIN learner_progress lp ON lp.module_id = m.id
     GROUP BY m.id, m.title, m.track_id, m.sort_order
     ORDER BY m.track_id, m.sort_order`
  );

  // Dimension-level averages for completed modules
  const dimResult = await query<{ module_id: string; dim_name: string; avg_score: string }>(
    `SELECT lp.module_id, x.key AS dim_name, ROUND(AVG(x.value::numeric))::text AS avg_score
     FROM learner_progress lp, jsonb_each_text(lp.score) AS x(key, value)
     WHERE lp.status IN ('completed', 'tested_out') AND lp.score IS NOT NULL
     GROUP BY lp.module_id, x.key
     ORDER BY lp.module_id, x.key`
  );

  const dimsByModule = new Map<string, Array<{ name: string; avg_score: number }>>();
  for (const row of dimResult.rows) {
    const dims = dimsByModule.get(row.module_id) || [];
    dims.push({ name: row.dim_name, avg_score: parseInt(row.avg_score) });
    dimsByModule.set(row.module_id, dims);
  }

  return {
    totals: {
      learners: parseInt(t.learners),
      credentials_issued: parseInt(t.credentials_issued),
      modules_completed: parseInt(t.modules_completed),
      modules_started: parseInt(t.modules_started),
      abandoned: parseInt(t.abandoned),
      total_sessions: parseInt(t.total_sessions),
    },
    credentials_by_tier: credResult.rows.map(r => ({
      tier: r.tier, name: r.name, count: parseInt(r.count), badges_issued: parseInt(r.badges_issued),
    })),
    module_completion: moduleResult.rows.map(r => {
      const started = parseInt(r.started);
      const completed = parseInt(r.completed);
      return {
        module_id: r.module_id,
        title: r.title,
        started,
        completed,
        rate: started > 0 ? Math.round((completed / started) * 100) : 0,
        avg_score: r.avg_score ? parseInt(r.avg_score) : null,
        avg_duration_minutes: r.avg_duration_minutes ? parseInt(r.avg_duration_minutes) : null,
        abandoned: parseInt(r.abandoned),
        sessions: parseInt(r.sessions),
        dimensions: dimsByModule.get(r.module_id) || [],
      };
    }),
  };
}

export interface AdminLearnerSummary {
  workos_user_id: string;
  name: string;
  email: string;
  modules_completed: number;
  modules_in_progress: number;
  credentials: Array<{ name: string; tier: number }>;
  last_active: string | null;
}

export interface AdminLearnerListResult {
  learners: AdminLearnerSummary[];
  total: number;
  page: number;
  limit: number;
}

export async function getAdminLearnerList(options: {
  search?: string;
  status?: 'all' | 'active' | 'stuck' | 'completed';
  page?: number;
  limit?: number;
} = {}): Promise<AdminLearnerListResult> {
  const page = options.page || 1;
  const limit = Math.min(options.limit || 20, 100);
  const offset = (page - 1) * limit;

  let whereClause = 'WHERE lp.id IS NOT NULL'; // has any progress
  const params: (string | number)[] = [];
  let paramIdx = 1;

  if (options.search) {
    whereClause += ` AND (u.first_name ILIKE $${paramIdx} OR u.last_name ILIKE $${paramIdx} OR u.email ILIKE $${paramIdx})`;
    params.push(`%${options.search}%`);
    paramIdx++;
  }

  if (options.status === 'active') {
    whereClause += ` AND EXISTS (SELECT 1 FROM learner_progress lp2 WHERE lp2.workos_user_id = u.workos_user_id AND lp2.status = 'in_progress' AND lp2.started_at >= NOW() - INTERVAL '7 days')`;
  } else if (options.status === 'stuck') {
    whereClause += ` AND EXISTS (SELECT 1 FROM learner_progress lp2 WHERE lp2.workos_user_id = u.workos_user_id AND lp2.status = 'in_progress' AND lp2.started_at < NOW() - INTERVAL '7 days')`;
  } else if (options.status === 'completed') {
    whereClause += ` AND EXISTS (SELECT 1 FROM user_credentials uc WHERE uc.workos_user_id = u.workos_user_id)`;
  }

  // Count total matching
  const countResult = await query<{ count: string }>(
    `SELECT COUNT(DISTINCT u.workos_user_id)::text AS count
     FROM users u
     JOIN learner_progress lp ON lp.workos_user_id = u.workos_user_id
     ${whereClause}`,
    params
  );
  const total = parseInt(countResult.rows[0]?.count || '0');

  // Get paginated learners
  const learnersResult = await query<{
    workos_user_id: string; first_name: string | null; last_name: string | null; email: string;
    modules_completed: string; modules_in_progress: string; last_active: string | null;
  }>(
    `SELECT
       u.workos_user_id,
       u.first_name,
       u.last_name,
       u.email,
       COUNT(CASE WHEN lp.status IN ('completed', 'tested_out') THEN 1 END)::text AS modules_completed,
       COUNT(CASE WHEN lp.status = 'in_progress' THEN 1 END)::text AS modules_in_progress,
       MAX(COALESCE(lp.completed_at, lp.started_at))::text AS last_active
     FROM users u
     JOIN learner_progress lp ON lp.workos_user_id = u.workos_user_id
     ${whereClause}
     GROUP BY u.workos_user_id, u.first_name, u.last_name, u.email
     ORDER BY MAX(COALESCE(lp.completed_at, lp.started_at)) DESC NULLS LAST
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    [...params, limit, offset]
  );

  // Get credentials for these learners
  const learnerIds = learnersResult.rows.map(r => r.workos_user_id);
  let credMap = new Map<string, Array<{ name: string; tier: number }>>();
  if (learnerIds.length > 0) {
    const credsResult = await query<{ workos_user_id: string; name: string; tier: number }>(
      `SELECT uc.workos_user_id, cc.name, cc.tier
       FROM user_credentials uc
       JOIN certification_credentials cc ON cc.id = uc.credential_id
       WHERE uc.workos_user_id = ANY($1)
       ORDER BY cc.tier`,
      [learnerIds]
    );
    for (const row of credsResult.rows) {
      const list = credMap.get(row.workos_user_id) || [];
      list.push({ name: row.name, tier: row.tier });
      credMap.set(row.workos_user_id, list);
    }
  }

  return {
    learners: learnersResult.rows.map(r => ({
      workos_user_id: r.workos_user_id,
      name: [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Unknown',
      email: r.email,
      modules_completed: parseInt(r.modules_completed),
      modules_in_progress: parseInt(r.modules_in_progress),
      credentials: credMap.get(r.workos_user_id) || [],
      last_active: r.last_active,
    })),
    total,
    page,
    limit,
  };
}

export interface AdminLearnerDetail {
  user: { name: string; email: string };
  progress: Array<{
    module_id: string;
    title: string;
    status: string;
    started_at: string | null;
    completed_at: string | null;
    score: Record<string, number> | null;
    attempts: number;
  }>;
  credentials: Array<{ name: string; tier: number; awarded_at: string; certifier_credential_id: string | null }>;
  checkpoints: Array<{
    module_id: string;
    current_phase: string;
    concepts_covered: string[];
    concepts_remaining: string[];
    notes: string | null;
    created_at: string;
  }>;
}

export async function getAdminLearnerDetail(userId: string): Promise<AdminLearnerDetail | null> {
  const userResult = await query<{ first_name: string | null; last_name: string | null; email: string }>(
    'SELECT first_name, last_name, email FROM users WHERE workos_user_id = $1',
    [userId]
  );
  if (userResult.rows.length === 0) return null;
  const u = userResult.rows[0];

  const [progressResult, credsResult, checkpointsResult] = await Promise.all([
    query<{
      module_id: string; title: string; status: string;
      started_at: string | null; completed_at: string | null;
      score: Record<string, number> | null; attempts: number;
    }>(
      `SELECT lp.module_id, m.title, lp.status, lp.started_at, lp.completed_at, lp.score, lp.attempts
       FROM learner_progress lp
       JOIN certification_modules m ON m.id = lp.module_id
       WHERE lp.workos_user_id = $1
       ORDER BY m.track_id, m.sort_order`,
      [userId]
    ),
    query<{ name: string; tier: number; awarded_at: string; certifier_credential_id: string | null }>(
      `SELECT cc.name, cc.tier, uc.awarded_at, uc.certifier_credential_id
       FROM user_credentials uc
       JOIN certification_credentials cc ON cc.id = uc.credential_id
       WHERE uc.workos_user_id = $1
       ORDER BY cc.tier`,
      [userId]
    ),
    query<{
      module_id: string; current_phase: string;
      concepts_covered: string[]; concepts_remaining: string[];
      notes: string | null; created_at: string;
    }>(
      `SELECT DISTINCT ON (module_id) module_id, current_phase, concepts_covered, concepts_remaining, notes, created_at
       FROM teaching_checkpoints
       WHERE workos_user_id = $1
       ORDER BY module_id, created_at DESC`,
      [userId]
    ),
  ]);

  return {
    user: {
      name: [u.first_name, u.last_name].filter(Boolean).join(' ') || 'Unknown',
      email: u.email,
    },
    progress: progressResult.rows,
    credentials: credsResult.rows,
    checkpoints: checkpointsResult.rows,
  };
}

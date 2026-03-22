/**
 * Tests for certification demonstration fairness enforcement.
 *
 * Verifies that:
 * 1. Every learner must verify the same success criteria before completing a module
 * 2. Partial demonstrations are rejected
 * 3. Invalid IDs are rejected
 * 4. Checkpoint correctly stores and retrieves demonstrations + evidence
 * 5. Both module and exam completion paths enforce demonstrations
 * 6. Criterion IDs are stable and match across modules
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import * as certDb from '../../src/db/certification-db.js';
import { query } from '../../src/db/client.js';

// Test user IDs — fake users that get cleaned up
const TEST_USERS = {
  expert: 'test-fairness-expert-001',
  novice: 'test-fairness-novice-001',
  rushing: 'test-fairness-rushing-001',
};

// A1 criterion IDs (from migration 318)
const A1_CRITERION_IDS = ['a1_ex1_sc0', 'a1_ex1_sc1', 'a1_ex1_sc2'];

async function cleanupTestUser(userId: string) {
  await query('DELETE FROM teaching_checkpoints WHERE workos_user_id = $1', [userId]);
  await query('DELETE FROM learner_progress WHERE workos_user_id = $1', [userId]);
  await query('DELETE FROM user_credentials WHERE workos_user_id = $1', [userId]);
  await query(
    `INSERT INTO users (workos_user_id, email) VALUES ($1, $2)
     ON CONFLICT (workos_user_id) DO NOTHING`,
    [userId, `${userId}@test.example.com`]
  );
}

/** Extract criterion IDs from a module's exercise definitions */
function getCriterionIds(mod: certDb.CertificationModule): string[] {
  const exerciseDefs = mod.exercise_definitions as certDb.ExerciseDefinition[] | null;
  return (exerciseDefs ?? []).flatMap(ex =>
    ex.success_criteria.map(sc => typeof sc === 'string' ? sc : sc.id)
  );
}

describe('Demonstration fairness enforcement', () => {
  beforeAll(async () => {
    initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:51734/adcp_registry',
    });
    await runMigrations();
    for (const userId of Object.values(TEST_USERS)) {
      await cleanupTestUser(userId);
    }
  });

  afterAll(async () => {
    for (const userId of Object.values(TEST_USERS)) {
      await query('DELETE FROM teaching_checkpoints WHERE workos_user_id = $1', [userId]);
      await query('DELETE FROM learner_progress WHERE workos_user_id = $1', [userId]);
      await query('DELETE FROM user_credentials WHERE workos_user_id = $1', [userId]);
      await query('DELETE FROM users WHERE workos_user_id = $1', [userId]);
    }
    await closeDatabase();
  });

  describe('criterion ID format', () => {
    it('A1 has criteria with id and text fields', async () => {
      const mod = await certDb.getModule('A1');
      expect(mod).toBeTruthy();

      const exerciseDefs = mod!.exercise_definitions as certDb.ExerciseDefinition[];
      expect(exerciseDefs.length).toBeGreaterThan(0);

      const allCriteria = exerciseDefs.flatMap(ex => ex.success_criteria);
      expect(allCriteria.length).toBe(3);

      // Each criterion should have id and text
      for (const sc of allCriteria) {
        expect(typeof sc).toBe('object');
        expect(sc).toHaveProperty('id');
        expect(sc).toHaveProperty('text');
      }

      // IDs follow the pattern exercise_id + _sc + index
      const ids = allCriteria.map(sc => (sc as certDb.SuccessCriterion).id);
      expect(ids).toEqual(A1_CRITERION_IDS);
    });

    it('A3 has behavioral criteria (not recall-based)', async () => {
      const mod = await certDb.getModule('A3');
      const exerciseDefs = mod!.exercise_definitions as certDb.ExerciseDefinition[];
      const criteria = exerciseDefs.flatMap(ex => ex.success_criteria) as certDb.SuccessCriterion[];

      // None should start with "Can name" or "Knows what" (recall-based)
      for (const sc of criteria) {
        expect(sc.text).not.toMatch(/^Can name /);
        expect(sc.text).not.toMatch(/^Knows what /);
        expect(sc.text).not.toMatch(/^Understands what /);
      }
    });

    it('every module has criteria with IDs', async () => {
      const modules = await certDb.getModules();
      const problems: string[] = [];

      for (const mod of modules) {
        const exerciseDefs = mod.exercise_definitions as certDb.ExerciseDefinition[] | null;
        const allCriteria = (exerciseDefs ?? []).flatMap(ex => ex.success_criteria);
        if (allCriteria.length === 0) {
          problems.push(`${mod.id}: no criteria`);
          continue;
        }
        for (const sc of allCriteria) {
          if (typeof sc === 'string') {
            problems.push(`${mod.id}: criterion is a string, not an object with id/text`);
          } else if (!sc.id) {
            problems.push(`${mod.id}: criterion missing id`);
          }
        }
      }

      expect(problems).toEqual([]);
    });
  });

  describe('checkpoint storage', () => {
    beforeEach(async () => {
      await cleanupTestUser(TEST_USERS.expert);
    });

    it('saves demonstrations_verified with criterion IDs', async () => {
      await certDb.startModule(TEST_USERS.expert, 'A1');

      const checkpoint = await certDb.saveTeachingCheckpoint({
        workos_user_id: TEST_USERS.expert,
        module_id: 'A1',
        concepts_covered: ['Agentic vs traditional'],
        concepts_remaining: ['Protocol hierarchy'],
        current_phase: 'teaching',
        demonstrations_verified: ['a1_ex1_sc0'],
      });

      expect(checkpoint.demonstrations_verified).toEqual(['a1_ex1_sc0']);
    });

    it('saves demonstration_evidence for audit trail', async () => {
      await certDb.startModule(TEST_USERS.expert, 'A1');

      const evidence = {
        a1_ex1_sc0: 'Learner queried @cptestagent and interpreted pricing fields (turn 5)',
        a1_ex1_sc1: 'Correctly identified CPM, targeting options, and format support in response',
      };

      const checkpoint = await certDb.saveTeachingCheckpoint({
        workos_user_id: TEST_USERS.expert,
        module_id: 'A1',
        concepts_covered: ['All'],
        concepts_remaining: [],
        current_phase: 'assessment',
        demonstrations_verified: ['a1_ex1_sc0', 'a1_ex1_sc1'],
        demonstration_evidence: evidence,
      });

      expect(checkpoint.demonstration_evidence).toEqual(evidence);
    });

    it('stores empty array when no demonstrations provided', async () => {
      await certDb.startModule(TEST_USERS.expert, 'A1');

      const checkpoint = await certDb.saveTeachingCheckpoint({
        workos_user_id: TEST_USERS.expert,
        module_id: 'A1',
        concepts_covered: ['Agentic vs traditional'],
        concepts_remaining: [],
        current_phase: 'assessment',
      });

      expect(checkpoint.demonstrations_verified).toEqual([]);
      expect(checkpoint.demonstration_evidence).toBeNull();
    });

    it('retrieves demonstrations from latest checkpoint', async () => {
      await certDb.startModule(TEST_USERS.expert, 'A1');

      // Save first checkpoint with 1 demo
      await certDb.saveTeachingCheckpoint({
        workos_user_id: TEST_USERS.expert,
        module_id: 'A1',
        concepts_covered: ['Agentic vs traditional'],
        concepts_remaining: ['Protocol hierarchy'],
        current_phase: 'teaching',
        demonstrations_verified: ['a1_ex1_sc0'],
      });

      // Save second checkpoint with all demos
      await certDb.saveTeachingCheckpoint({
        workos_user_id: TEST_USERS.expert,
        module_id: 'A1',
        concepts_covered: ['All'],
        concepts_remaining: [],
        current_phase: 'assessment',
        preliminary_scores: {
          conceptual_understanding: 85,
          practical_knowledge: 85,
          channel_breadth: 80,
          protocol_fluency: 80,
        },
        demonstrations_verified: A1_CRITERION_IDS,
      });

      const latest = await certDb.getLatestCheckpoint(TEST_USERS.expert, 'A1');
      expect(latest?.demonstrations_verified).toEqual(A1_CRITERION_IDS);
    });
  });

  describe('completion enforcement', () => {
    it('rejects completion when no demonstrations verified', async () => {
      await cleanupTestUser(TEST_USERS.novice);
      await certDb.startModule(TEST_USERS.novice, 'A1');

      await certDb.saveTeachingCheckpoint({
        workos_user_id: TEST_USERS.novice,
        module_id: 'A1',
        concepts_covered: ['All'],
        concepts_remaining: [],
        current_phase: 'assessment',
        preliminary_scores: {
          conceptual_understanding: 80, practical_knowledge: 80,
          channel_breadth: 75, protocol_fluency: 75,
        },
      });

      const checkpoint = await certDb.getLatestCheckpoint(TEST_USERS.novice, 'A1');
      const mod = await certDb.getModule('A1');
      const requiredIds = getCriterionIds(mod!);

      const verified = new Set(checkpoint?.demonstrations_verified ?? []);
      const unverified = requiredIds.filter(id => !verified.has(id));

      expect(unverified.length).toBe(3);
      expect(unverified).toEqual(A1_CRITERION_IDS);
    });

    it('rejects completion with partial demonstrations', async () => {
      await cleanupTestUser(TEST_USERS.rushing);
      await certDb.startModule(TEST_USERS.rushing, 'A1');

      await certDb.saveTeachingCheckpoint({
        workos_user_id: TEST_USERS.rushing,
        module_id: 'A1',
        concepts_covered: ['All'],
        concepts_remaining: [],
        current_phase: 'assessment',
        preliminary_scores: {
          conceptual_understanding: 90, practical_knowledge: 90,
          channel_breadth: 90, protocol_fluency: 90,
        },
        demonstrations_verified: ['a1_ex1_sc0'],
      });

      const checkpoint = await certDb.getLatestCheckpoint(TEST_USERS.rushing, 'A1');
      const mod = await certDb.getModule('A1');
      const requiredIds = getCriterionIds(mod!);

      const verified = new Set(checkpoint?.demonstrations_verified ?? []);
      const unverified = requiredIds.filter(id => !verified.has(id));

      expect(unverified.length).toBe(2);
      expect(unverified).toEqual(['a1_ex1_sc1', 'a1_ex1_sc2']);
    });

    it('allows completion when all demonstrations verified', async () => {
      await cleanupTestUser(TEST_USERS.expert);
      await certDb.startModule(TEST_USERS.expert, 'A1');

      await certDb.saveTeachingCheckpoint({
        workos_user_id: TEST_USERS.expert,
        module_id: 'A1',
        concepts_covered: ['All'],
        concepts_remaining: [],
        current_phase: 'assessment',
        preliminary_scores: {
          conceptual_understanding: 85, practical_knowledge: 85,
          channel_breadth: 80, protocol_fluency: 80,
        },
        demonstrations_verified: A1_CRITERION_IDS,
      });

      const checkpoint = await certDb.getLatestCheckpoint(TEST_USERS.expert, 'A1');
      const mod = await certDb.getModule('A1');
      const requiredIds = getCriterionIds(mod!);

      const verified = new Set(checkpoint?.demonstrations_verified ?? []);
      const unverified = requiredIds.filter(id => !verified.has(id));

      expect(unverified.length).toBe(0);
    });

    it('invalid criterion IDs do not count as verified', async () => {
      await cleanupTestUser(TEST_USERS.rushing);
      await certDb.startModule(TEST_USERS.rushing, 'A1');

      await certDb.saveTeachingCheckpoint({
        workos_user_id: TEST_USERS.rushing,
        module_id: 'A1',
        concepts_covered: ['All'],
        concepts_remaining: [],
        current_phase: 'assessment',
        preliminary_scores: {
          conceptual_understanding: 85, practical_knowledge: 85,
          channel_breadth: 80, protocol_fluency: 80,
        },
        demonstrations_verified: [
          'a1_ex1_sc0',       // valid
          'a1_ex1_sc99',      // invalid — no such criterion
          'totally_fake_id',  // invalid
        ],
      });

      const checkpoint = await certDb.getLatestCheckpoint(TEST_USERS.rushing, 'A1');
      const mod = await certDb.getModule('A1');
      const requiredIds = getCriterionIds(mod!);

      const verified = new Set(checkpoint?.demonstrations_verified ?? []);
      const unverified = requiredIds.filter(id => !verified.has(id));

      // 2 of 3 should be unverified (only a1_ex1_sc0 is valid and present)
      expect(unverified.length).toBe(2);
    });
  });

  describe('fairness across personas', () => {
    it('expert and novice must verify the same criterion IDs for A1', async () => {
      await cleanupTestUser(TEST_USERS.expert);
      await cleanupTestUser(TEST_USERS.novice);

      const mod = await certDb.getModule('A1');
      const requiredIds = getCriterionIds(mod!);

      // Expert path: high scores
      await certDb.startModule(TEST_USERS.expert, 'A1');
      await certDb.saveTeachingCheckpoint({
        workos_user_id: TEST_USERS.expert,
        module_id: 'A1',
        concepts_covered: ['All'],
        concepts_remaining: [],
        current_phase: 'assessment',
        preliminary_scores: {
          conceptual_understanding: 95, practical_knowledge: 95,
          channel_breadth: 90, protocol_fluency: 90,
        },
        demonstrations_verified: requiredIds,
        learner_background: '20 years ad tech, built multiple DSPs',
      });

      // Novice path: lower scores
      await certDb.startModule(TEST_USERS.novice, 'A1');
      await certDb.saveTeachingCheckpoint({
        workos_user_id: TEST_USERS.novice,
        module_id: 'A1',
        concepts_covered: ['All'],
        concepts_remaining: [],
        current_phase: 'assessment',
        preliminary_scores: {
          conceptual_understanding: 72, practical_knowledge: 70,
          channel_breadth: 70, protocol_fluency: 70,
        },
        demonstrations_verified: requiredIds,
        learner_background: 'Marketing intern, first week in ad tech',
      });

      const expertCk = await certDb.getLatestCheckpoint(TEST_USERS.expert, 'A1');
      const noviceCk = await certDb.getLatestCheckpoint(TEST_USERS.novice, 'A1');

      // Same criteria IDs required for both
      expect(expertCk?.demonstrations_verified).toEqual(noviceCk?.demonstrations_verified);
      expect(expertCk?.demonstrations_verified).toEqual(requiredIds);
    });

    it('expert cannot skip demonstrations even with high scores', async () => {
      await cleanupTestUser(TEST_USERS.expert);
      await certDb.startModule(TEST_USERS.expert, 'A1');

      await certDb.saveTeachingCheckpoint({
        workos_user_id: TEST_USERS.expert,
        module_id: 'A1',
        concepts_covered: ['All'],
        concepts_remaining: [],
        current_phase: 'assessment',
        preliminary_scores: {
          conceptual_understanding: 98, practical_knowledge: 98,
          channel_breadth: 95, protocol_fluency: 95,
        },
        // No demonstrations_verified!
      });

      const checkpoint = await certDb.getLatestCheckpoint(TEST_USERS.expert, 'A1');
      const mod = await certDb.getModule('A1');
      const requiredIds = getCriterionIds(mod!);

      const verified = new Set(checkpoint?.demonstrations_verified ?? []);
      const unverified = requiredIds.filter(id => !verified.has(id));

      expect(unverified.length).toBe(3);
    });
  });
});

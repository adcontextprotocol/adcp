/**
 * Integration test for migration 634: correct the A2 and B1
 * capability-declaration success criteria and teach the rule in A2
 * (issue #8925).
 *
 * Runs the shipped 407 SQL that appended the original criteria, then the 634
 * correction, against minimal module rows in a throwaway schema, so the
 * assertions cover the shipped SQL rather than a paraphrase of it. The full
 * migration chain is covered by the migration smoke test workflow.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';

const CRITERION_IDS_MIGRATION = readFileSync(
  resolve(__dirname, '../../src/db/migrations/407_curriculum_3_0_criterion_ids.sql'),
  'utf8',
);
const CAPABILITY_DECLARATION_MIGRATION = readFileSync(
  resolve(__dirname, '../../src/db/migrations/634_curriculum_capability_declaration_criteria.sql'),
  'utf8',
);
const CAPABILITIES_SCHEMA = JSON.parse(readFileSync(
  resolve(__dirname, '../../../static/schemas/source/protocol/get-adcp-capabilities-response.json'),
  'utf8',
)) as JsonSchema;

// Every module/exercise migration 407 appends to; it raises if one is missing.
const MIGRATION_407_EXERCISES: Readonly<Record<string, readonly string[]>> = {
  A2: ['a2_ex1', 'a2_ex_untouched'],
  B1: ['b1_ex1'],
  B3: ['b3_ex1'],
  C1: ['c1_ex1'],
  C2: ['c2_ex3'],
  S1: ['s1_ex1'],
  S2: ['s2_ex1'],
  S3: ['s3_ex1'],
  S4: ['e4_ex1', 'e4_ex2'],
};

const A2_CRITERION_ID = 'a2_ex1_sc_object_presence_principle';
const B1_CRITERION_ID = 'b1_ex1_sc_object_presence_capabilities';
const CORRECTED_CRITERIA: Readonly<Record<string, { moduleId: string; exerciseId: string }>> = {
  [A2_CRITERION_ID]: { moduleId: 'A2', exerciseId: 'a2_ex1' },
  [B1_CRITERION_ID]: { moduleId: 'B1', exerciseId: 'b1_ex1' },
};
const A2_KEY_CONCEPT_TOPIC = 'Reading capabilities';
const MIGRATION_HELPERS = [
  '_replace_criterion_text(text,text,text,text)',
  '_append_key_concept(text,text,text)',
];
const PRESENCE_ONLY_CLAIM = /presence,? not booleans/i;
const CAPABILITY_PATH = /\b(?:adcp|media_buy)(?:\.[a-z_]+)+/g;

interface JsonSchema {
  properties?: Record<string, JsonSchema>;
  required?: string[];
  oneOf?: JsonSchema[];
  const?: unknown;
}

interface SuccessCriterion {
  id: string;
  text: string;
}

interface Exercise {
  id: string;
  success_criteria: Array<SuccessCriterion | string>;
}

interface KeyConcept {
  topic: string;
  teaching_notes: string;
}

interface ModuleRow {
  id: string;
  exercise_definitions: Exercise[];
  lesson_plan: { key_concepts: KeyConcept[] };
}

function seedExercise(exerciseId: string) {
  return {
    id: exerciseId,
    title: `Exercise ${exerciseId}`,
    description: 'Seeded exercise',
    sandbox_actions: [{ tool: 'get_products', guidance: 'Seeded guidance' }],
    success_criteria: ['Seeded legacy string criterion', { id: `${exerciseId}_sc0`, text: 'Seeded criterion' }],
  };
}

function seedLessonPlan(moduleId: string) {
  return {
    objectives: [`Seeded ${moduleId} objective`],
    key_concepts: [{ topic: 'Seeded topic', teaching_notes: 'Seeded teaching notes' }],
  };
}

async function seedModules(client: PoolClient): Promise<void> {
  await client.query('CREATE TABLE certification_modules (id TEXT PRIMARY KEY, lesson_plan JSONB, exercise_definitions JSONB)');
  for (const [moduleId, exerciseIds] of Object.entries(MIGRATION_407_EXERCISES)) {
    await client.query(
      'INSERT INTO certification_modules (id, lesson_plan, exercise_definitions) VALUES ($1, $2, $3)',
      [moduleId, JSON.stringify(seedLessonPlan(moduleId)), JSON.stringify(exerciseIds.map(seedExercise))],
    );
  }
  await client.query(CRITERION_IDS_MIGRATION);
}

async function readModules(client: PoolClient): Promise<ModuleRow[]> {
  const result = await client.query<ModuleRow>(
    'SELECT id, lesson_plan, exercise_definitions FROM certification_modules ORDER BY id',
  );
  return result.rows;
}

function findCriterion(modules: ModuleRow[], criterionId: string): SuccessCriterion {
  const { moduleId, exerciseId } = CORRECTED_CRITERIA[criterionId];
  const exercise = modules.find(row => row.id === moduleId)?.exercise_definitions.find(ex => ex.id === exerciseId);
  const criterion = exercise?.success_criteria.find(
    (candidate): candidate is SuccessCriterion => typeof candidate !== 'string' && candidate.id === criterionId,
  );
  if (!criterion) throw new Error(`Criterion ${criterionId} not found`);
  return criterion;
}

function findKeyConcept(modules: ModuleRow[], moduleId: string, topic: string): KeyConcept | undefined {
  return modules.find(row => row.id === moduleId)?.lesson_plan.key_concepts.find(concept => concept.topic === topic);
}

function resolveSchemaPath(path: string): JsonSchema | undefined {
  return path.split('.').reduce<JsonSchema | undefined>(
    (schema, segment) => schema?.properties?.[segment],
    CAPABILITIES_SCHEMA,
  );
}

describe('capabilities schema facts the corrected criteria teach', () => {
  const adcp = CAPABILITIES_SCHEMA.properties?.adcp;
  const mediaBuy = CAPABILITIES_SCHEMA.properties?.media_buy;

  it('requires adcp.idempotency and allows it to declare supported: false', () => {
    expect(adcp?.required).toContain('idempotency');
    const arms = adcp?.properties?.idempotency?.oneOf ?? [];
    expect(arms.some(arm => arm.properties?.supported?.const === false)).toBe(true);
  });

  it('keeps presence-signalled feature objects without a boolean gate', () => {
    expect(mediaBuy?.properties?.audience_targeting).toBeDefined();
    expect(mediaBuy?.properties?.content_standards).toBeDefined();
  });
});

describe.skipIf(!process.env.DATABASE_URL)('migration 634: capability-declaration criteria', () => {
  const schema = `capability_criteria_migration_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool;
  let client: PoolClient;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    client = await pool.connect();
  });

  beforeEach(async () => {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema}`);
    await seedModules(client);
  });

  afterEach(async () => {
    await client?.query('ROLLBACK');
  });

  afterAll(async () => {
    client?.release();
    await pool?.end();
  });

  it('rewrites only the two presence-only criteria, keeping ids and every other field', async () => {
    const legacy = await readModules(client);
    for (const criterionId of Object.keys(CORRECTED_CRITERIA)) {
      expect(findCriterion(legacy, criterionId).text).toMatch(PRESENCE_ONLY_CLAIM);
    }

    await client.query(CAPABILITY_DECLARATION_MIGRATION);

    const corrected = await readModules(client);
    const expected = structuredClone(legacy);
    for (const criterionId of Object.keys(CORRECTED_CRITERIA)) {
      const text = findCriterion(corrected, criterionId).text;
      expect(text).not.toMatch(PRESENCE_ONLY_CLAIM);
      findCriterion(expected, criterionId).text = text;
    }
    const keyConcept = findKeyConcept(corrected, 'A2', A2_KEY_CONCEPT_TOPIC);
    if (!keyConcept) throw new Error(`A2 key concept "${A2_KEY_CONCEPT_TOPIC}" was not appended`);
    expect(keyConcept.teaching_notes).not.toMatch(PRESENCE_ONLY_CLAIM);
    expected.find(row => row.id === 'A2')?.lesson_plan.key_concepts.push(keyConcept);
    expect(corrected).toEqual(expected);
  });

  it('cites only capability paths that exist in the schema', async () => {
    await client.query(CAPABILITY_DECLARATION_MIGRATION);

    const corrected = await readModules(client);
    const taughtTexts = [
      ...Object.keys(CORRECTED_CRITERIA).map(criterionId => findCriterion(corrected, criterionId).text),
      findKeyConcept(corrected, 'A2', A2_KEY_CONCEPT_TOPIC)?.teaching_notes ?? '',
    ];
    for (const text of taughtTexts) {
      const paths = text.match(CAPABILITY_PATH) ?? [];
      expect(paths).toContain('adcp.idempotency');
      for (const path of paths) {
        expect(resolveSchemaPath(path), path).toBeDefined();
      }
    }
  });

  it('is idempotent and drops its helper functions', async () => {
    await client.query(CAPABILITY_DECLARATION_MIGRATION);
    const once = await readModules(client);

    await client.query(CAPABILITY_DECLARATION_MIGRATION);

    const twice = await readModules(client);
    expect(twice).toEqual(once);
    const a2Topics = twice.find(row => row.id === 'A2')?.lesson_plan.key_concepts.map(concept => concept.topic);
    expect(a2Topics?.filter(topic => topic === A2_KEY_CONCEPT_TOPIC)).toHaveLength(1);
    for (const helper of MIGRATION_HELPERS) {
      const result = await client.query<{ dropped: boolean }>(
        'SELECT to_regprocedure($1) IS NULL AS dropped',
        [helper],
      );
      expect(result.rows[0].dropped, helper).toBe(true);
    }
  });

  it.each([
    {
      scenario: 'a corrected criterion is missing',
      breakFixture: `UPDATE certification_modules
        SET exercise_definitions = jsonb_set(
          exercise_definitions,
          '{0,success_criteria}',
          (SELECT jsonb_agg(c) FROM jsonb_array_elements(exercise_definitions->0->'success_criteria') c
           WHERE c->>'id' IS DISTINCT FROM '${A2_CRITERION_ID}')
        )
        WHERE id = 'A2'`,
      error: `Criterion ${A2_CRITERION_ID} not found in exercise a2_ex1 of module A2`,
    },
    {
      scenario: 'the A2 lesson plan is missing',
      breakFixture: `UPDATE certification_modules SET lesson_plan = NULL WHERE id = 'A2'`,
      error: 'Module A2 not found or has no lesson_plan object',
    },
  ])('fails instead of silently skipping when $scenario', async ({ breakFixture, error }) => {
    await client.query(breakFixture);

    await client.query('SAVEPOINT before_migration');
    await expect(client.query(CAPABILITY_DECLARATION_MIGRATION)).rejects.toThrow(error);
    await client.query('ROLLBACK TO SAVEPOINT before_migration');
  });
});
